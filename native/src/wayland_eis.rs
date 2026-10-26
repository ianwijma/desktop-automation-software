//! EI sender bound exclusively to the portal's authorized EIS socket.
use super::*;
use futures_util::StreamExt;
use reis::{
    ei,
    event::{Connection, Device, DeviceCapability, EiEvent},
};
use std::{
    collections::HashMap,
    io::Read,
    os::{fd::OwnedFd, unix::net::UnixStream},
};
fn micros() -> u64 {
    let mut time = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    unsafe {
        libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut time);
    }
    (time.tv_sec as u64) * 1_000_000 + (time.tv_nsec as u64) / 1000
}
struct Entry {
    device: Device,
    active: bool,
    keymap: HashMap<u32, (u32, bool)>,
}
#[derive(Default)]
struct State {
    connection: Option<Connection>,
    devices: Vec<Entry>,
    modifiers_busy: bool,
    sync: HashMap<ei::Callback, Arc<AtomicBool>>,
}
pub struct Eis {
    state: Arc<Mutex<State>>,
    stop: Arc<AtomicBool>,
    closed: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}
fn keymap(device: &Device) -> HashMap<u32, (u32, bool)> {
    let Some(map) = device.keymap() else {
        return HashMap::new();
    };
    if map.size == 0 || map.size > 1_048_576 || map.type_ != ei::keyboard::KeymapType::Xkb {
        return HashMap::new();
    }
    let Some(xkb) = xkbcommon_dl::xkbcommon_option() else {
        return HashMap::new();
    };
    let Ok(fd) = map.fd.try_clone() else {
        return HashMap::new();
    };
    let mut text = String::new();
    if std::fs::File::from(fd)
        .take(map.size.into())
        .read_to_string(&mut text)
        .is_err()
    {
        return HashMap::new();
    }
    let Ok(text) = std::ffi::CString::new(text.trim_end_matches('\0')) else {
        return HashMap::new();
    };
    let mut keys = HashMap::new();
    unsafe {
        let context =
            (xkb.xkb_context_new)(xkbcommon_dl::xkb_context_flags::XKB_CONTEXT_NO_DEFAULT_INCLUDES);
        if context.is_null() {
            return keys;
        }
        let parsed = (xkb.xkb_keymap_new_from_string)(
            context,
            text.as_ptr(),
            xkbcommon_dl::xkb_keymap_format::XKB_KEYMAP_FORMAT_TEXT_V1,
            xkbcommon_dl::xkb_keymap_compile_flags::XKB_KEYMAP_COMPILE_NO_FLAGS,
        );
        if !parsed.is_null() {
            let min = (xkb.xkb_keymap_min_keycode)(parsed).max(8);
            let max = (xkb.xkb_keymap_max_keycode)(parsed).min(767);
            for code in min..=max {
                for level in 0..=1 {
                    let mut syms = std::ptr::null();
                    let len =
                        (xkb.xkb_keymap_key_get_syms_by_level)(parsed, code, 0, level, &mut syms);
                    if len > 0 && len < 128 && !syms.is_null() {
                        for sym in std::slice::from_raw_parts(syms, len as usize) {
                            keys.entry(*sym).or_insert((code - 8, level == 1));
                        }
                    }
                }
            }
            (xkb.xkb_keymap_unref)(parsed);
        }
        (xkb.xkb_context_unref)(context);
    }
    keys
}
impl Eis {
    pub fn connect(fd: OwnedFd, closed: Arc<AtomicBool>) -> Result<Self> {
        let state = Arc::new(Mutex::new(State::default()));
        let shared = state.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = stop.clone();
        let lost = closed.clone();
        let transport_closed = Arc::new(AtomicBool::new(false));
        let transport_lost = transport_closed.clone();
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        let worker = thread::spawn(move || {
            let result = super::wayland::runtime().block_on(async {
                let context = ei::Context::new(UnixStream::from(fd)).map_err(|_| ())?;
                let mut events =
                    reis::tokio::EiEventStream::new(context.clone()).map_err(|_| ())?;
                let handshake = tokio::time::timeout(
                    Duration::from_secs(3),
                    reis::tokio::ei_handshake(
                        &mut events,
                        "Relay",
                        ei::handshake::ContextType::Sender,
                    ),
                )
                .await
                .map_err(|_| ())?
                .map_err(|_| ())?;
                let mut converter = reis::event::EiEventConverter::new(&context, handshake);
                let connection = converter.connection().clone();
                shared.lock().map_err(|_| ())?.connection = Some(connection.clone());
                let _ = tx.send(true);
                let mut sequence = 1;
                while !stopping.load(Ordering::SeqCst) {
                    let event = match tokio::time::timeout(Duration::from_millis(25), events.next())
                        .await
                    {
                        Err(_) => continue,
                        Ok(Some(Ok(reis::PendingRequestResult::Request(event)))) => event,
                        _ => return Err(()),
                    };
                    if let ei::Event::Callback(ref callback, ei::callback::Event::Done { .. }) =
                        event
                    {
                        if let Some(ack) = shared.lock().map_err(|_| ())?.sync.remove(callback) {
                            ack.store(true, Ordering::SeqCst);
                        }
                    }
                    converter.handle_event(event).map_err(|_| ())?;
                    while let Some(event) = converter.next_event() {
                        match event {
                            EiEvent::SeatAdded(e) => {
                                e.seat.bind_capabilities(
                                    DeviceCapability::PointerAbsolute
                                        | DeviceCapability::Button
                                        | DeviceCapability::Keyboard
                                        | DeviceCapability::Scroll
                                        | DeviceCapability::Text,
                                );
                                connection.flush().map_err(|_| ())?;
                            }
                            EiEvent::DeviceAdded(e) => {
                                let keys = keymap(&e.device);
                                shared.lock().map_err(|_| ())?.devices.push(Entry {
                                    device: e.device,
                                    active: false,
                                    keymap: keys,
                                });
                            }
                            EiEvent::DeviceResumed(e) => {
                                e.device
                                    .device()
                                    .start_emulating(connection.serial(), sequence);
                                sequence += 1;
                                connection.flush().map_err(|_| ())?;
                                if let Some(entry) = shared
                                    .lock()
                                    .map_err(|_| ())?
                                    .devices
                                    .iter_mut()
                                    .find(|v| v.device == e.device)
                                {
                                    entry.active = true;
                                }
                            }
                            EiEvent::DevicePaused(e) => {
                                if shared
                                    .lock()
                                    .map_err(|_| ())?
                                    .devices
                                    .iter()
                                    .any(|v| v.device == e.device && v.active)
                                {
                                    return Err(());
                                }
                            }
                            EiEvent::DeviceRemoved(_)
                            | EiEvent::SeatRemoved(_)
                            | EiEvent::Disconnected(_) => return Err(()),
                            EiEvent::KeyboardModifiers(e) => {
                                shared.lock().map_err(|_| ())?.modifiers_busy = e.depressed != 0
                                    || e.locked != 0
                                    || e.latched != 0
                                    || e.group != 0;
                            }
                            _ => {}
                        }
                    }
                }
                Ok(())
            });
            transport_lost.store(true, Ordering::SeqCst);
            if let Ok(mut state) = shared.lock() {
                state.devices.clear();
                state.connection = None;
                state.sync.clear();
            }
            if result.is_err() {
                lost.store(true, Ordering::SeqCst);
                let _ = tx.send(false);
            }
        });
        let result = Self {
            state,
            stop,
            closed: transport_closed,
            worker: Some(worker),
        };
        if rx.recv_timeout(Duration::from_secs(4)) != Ok(true) {
            result.stop.store(true, Ordering::SeqCst);
            return Err("wayland:EIS_UNAVAILABLE".into());
        }
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        loop {
            if closed.load(Ordering::SeqCst) {
                return Err("wayland:EIS_LOST".into());
            }
            if result
                .state
                .lock()
                .map_err(|_| "wayland:EIS_LOST")?
                .devices
                .iter()
                .any(|e| e.active)
            {
                return Ok(result);
            }
            if std::time::Instant::now() >= deadline {
                return Err("wayland:EIS_UNAVAILABLE".into());
            }
            thread::sleep(Duration::from_millis(10));
        }
    }
    pub fn sync(&self) -> Result<()> {
        if self.closed.load(Ordering::SeqCst) {
            return Err("wayland:EIS_LOST".into());
        }
        let ack = Arc::new(AtomicBool::new(false));
        {
            let mut state = self.state.lock().map_err(|_| "wayland:EIS_LOST")?;
            let connection = state.connection.clone().ok_or("wayland:EIS_LOST")?;
            let callback = connection.connection().sync(1);
            state.sync.insert(callback, ack.clone());
            connection.flush().map_err(|_| "wayland:EIS_LOST")?;
        }
        let until = std::time::Instant::now() + Duration::from_millis(750);
        while !ack.load(Ordering::SeqCst) {
            if std::time::Instant::now() >= until {
                return Err("wayland:CLEANUP_FAILED".into());
            }
            thread::sleep(Duration::from_millis(5));
        }
        Ok(())
    }
    fn action<T>(
        &self,
        cap: DeviceCapability,
        f: impl FnOnce(&Entry, &Connection) -> Result<T>,
    ) -> Result<T> {
        self.action_filtered(cap, |_| true, f)
    }
    fn action_filtered<T>(
        &self,
        cap: DeviceCapability,
        select: impl Fn(&Entry) -> bool,
        f: impl FnOnce(&Entry, &Connection) -> Result<T>,
    ) -> Result<T> {
        if self.closed.load(Ordering::SeqCst) {
            return Err("wayland:EIS_LOST".into());
        }
        let state = self.state.lock().map_err(|_| "wayland:EIS_LOST")?;
        let matches: Vec<_> = state
            .devices
            .iter()
            .filter(|d| d.active && d.device.has_capability(cap) && select(d))
            .collect();
        if matches.len() != 1 {
            return Err("wayland:CAPABILITY_MISSING".into());
        }
        let conn = state.connection.as_ref().ok_or("wayland:EIS_LOST")?;
        let result = f(matches[0], conn)?;
        matches[0].device.device().frame(conn.serial(), micros());
        conn.flush().map_err(|_| "wayland:EIS_LOST")?;
        Ok(result)
    }
    pub fn pointer(&self, x: f64, y: f64, size: (i32, i32), mapping: Option<&str>) -> Result<()> {
        if mapping.is_none() {
            return Err("wayland:GEOMETRY_UNKNOWN".into());
        }
        self.action_filtered(
            DeviceCapability::PointerAbsolute,
            |e| {
                e.device
                    .regions()
                    .iter()
                    .any(|r| r.mapping_id.as_deref() == mapping)
            },
            |e, _| {
                let matches: Vec<_> = e
                    .device
                    .regions()
                    .iter()
                    .filter(|r| mapping.is_some() && r.mapping_id.as_deref() == mapping)
                    .collect();
                if matches.len() != 1
                    || matches[0].width != size.0 as u32
                    || matches[0].height != size.1 as u32
                {
                    return Err("wayland:GEOMETRY_UNKNOWN".into());
                }
                let region = matches[0];
                e.device
                    .interface::<ei::PointerAbsolute>()
                    .ok_or("wayland:CAPABILITY_MISSING")?
                    .motion_absolute(region.x as f32 + x as f32, region.y as f32 + y as f32);
                Ok(())
            },
        )
    }
    pub fn button(&self, code: u32, down: bool) -> Result<()> {
        self.action(DeviceCapability::Button, |e, _| {
            e.device
                .interface::<ei::Button>()
                .ok_or("wayland:CAPABILITY_MISSING")?
                .button(
                    code,
                    if down {
                        ei::button::ButtonState::Press
                    } else {
                        ei::button::ButtonState::Released
                    },
                );
            Ok(())
        })
    }
    pub fn keycode(&self, code: u32, down: bool) -> Result<()> {
        self.action(DeviceCapability::Keyboard, |e, _| {
            e.device
                .interface::<ei::Keyboard>()
                .ok_or("wayland:CAPABILITY_MISSING")?
                .key(
                    code,
                    if down {
                        ei::keyboard::KeyState::Press
                    } else {
                        ei::keyboard::KeyState::Released
                    },
                );
            Ok(())
        })
    }
    pub fn lookup(&self, sym: u32) -> Result<(u32, bool)> {
        self.action(DeviceCapability::Keyboard, |e, _| {
            e.keymap
                .get(&sym)
                .copied()
                .ok_or("wayland:UNSUPPORTED_KEY".into())
        })
    }
    pub fn text_supported(&self) -> bool {
        self.state
            .lock()
            .map(|s| {
                s.devices
                    .iter()
                    .any(|e| e.active && e.device.has_capability(DeviceCapability::Text))
            })
            .unwrap_or(false)
    }
    pub fn text(&self, text: &str) -> Result<()> {
        self.action(DeviceCapability::Text, |e, _| {
            e.device
                .interface::<ei::Text>()
                .ok_or("wayland:CAPABILITY_MISSING")?
                .utf8(text);
            Ok(())
        })
    }
    pub fn text_ready(&self) -> bool {
        self.state
            .lock()
            .map(|s| !s.modifiers_busy)
            .unwrap_or(false)
    }
    pub fn scroll(&self, x: f64, y: f64) -> Result<()> {
        self.action(DeviceCapability::Scroll, |e, _| {
            let scroll = e
                .device
                .interface::<ei::Scroll>()
                .ok_or("wayland:CAPABILITY_MISSING")?;
            scroll.scroll(x as f32, y as f32);
            scroll.scroll_stop(1, 1, 0);
            Ok(())
        })
    }
}
impl Drop for Eis {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

#[cfg(test)]
#[path = "wayland_eis_tests.rs"]
mod tests;
