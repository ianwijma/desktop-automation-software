//! Portal grants own capture and input. Capture explicitly opens/restores grants;
//! input never prompts, reopens a lost grant, or falls back from established EIS.
use super::*;
use super::{
    wayland_capture::CaptureStream,
    wayland_eis::Eis,
    wayland_portal::{Grant, Portal},
};
use std::{
    collections::{HashMap, HashSet},
    sync::{atomic::AtomicU64, OnceLock},
};
use zbus::zvariant::Value as BusValue;
static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
static CANCEL: OnceLock<Arc<AtomicBool>> = OnceLock::new();
static SESSIONS: OnceLock<Mutex<HashMap<String, PortalSession>>> = OnceLock::new();
static TOKENS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
static EPOCH: AtomicU64 = AtomicU64::new(1);
static CLEANUP_FAILED: AtomicBool = AtomicBool::new(false);
pub fn runtime() -> &'static tokio::runtime::Runtime {
    RUNTIME.get_or_init(|| tokio::runtime::Runtime::new().expect("Tokio runtime"))
}
fn sessions() -> &'static Mutex<HashMap<String, PortalSession>> {
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}
fn tokens() -> &'static Mutex<HashMap<String, String>> {
    TOKENS.get_or_init(|| Mutex::new(HashMap::new()))
}
pub fn cancelled() -> bool {
    CANCEL
        .get()
        .map(|v| v.load(Ordering::SeqCst))
        .unwrap_or(false)
}
pub fn install_shutdown_hook() -> Result<()> {
    let flag = CANCEL.get_or_init(|| Arc::new(AtomicBool::new(false)));
    signal_hook::flag::register(signal_hook::consts::SIGTERM, flag.clone())
        .map_err(|_| "wayland:CLEANUP_FAILED")?;
    signal_hook::flag::register(signal_hook::consts::SIGINT, flag.clone())
        .map_err(|_| "wayland:CLEANUP_FAILED")?;
    Ok(())
}
fn detect_wayland(session: Option<&str>, display: Option<&str>) -> bool {
    session == Some("wayland") || (session != Some("x11") && display.is_some_and(|v| !v.is_empty()))
}
pub fn is_wayland() -> bool {
    detect_wayland(
        std::env::var("XDG_SESSION_TYPE").ok().as_deref(),
        std::env::var("WAYLAND_DISPLAY").ok().as_deref(),
    )
}

enum Transport {
    Legacy,
    Eis(Eis),
}
struct PortalSession {
    portal: Portal,
    grant: Grant,
    capture: CaptureStream,
    transport: Transport,
    closed: Arc<AtomicBool>,
    ended: Arc<AtomicBool>,
    watcher: tokio::task::JoinHandle<()>,
    epoch: String,
    pixels: Option<(u32, u32)>,
    keys: HashSet<u32>,
    buttons: HashSet<u32>,
    used: bool,
}
impl PortalSession {
    fn check(&self) -> Result<()> {
        if cancelled() {
            return Err("wayland:CANCELLED".into());
        }
        if self.closed.load(Ordering::SeqCst) {
            return Err("wayland:SESSION_CLOSED".into());
        }
        Ok(())
    }
    fn frame(&mut self) -> Result<super::wayland_capture::Frame> {
        self.check()?;
        let frame = self
            .capture
            .frame(|| cancelled() || self.closed.load(Ordering::SeqCst))
            .map_err(|error| {
                self.closed.store(true, Ordering::SeqCst);
                error
            })?;
        if let Some(pixels) = self.pixels {
            if pixels != (frame.width, frame.height) {
                self.closed.store(true, Ordering::SeqCst);
                self.capture.stop();
                return Err("wayland:STALE_CAPTURE".into());
            }
        }
        self.pixels = Some((frame.width, frame.height));
        self.check()?;
        Ok(frame)
    }
    fn token(&self) -> String {
        let (w, h) = self.pixels.unwrap_or((0, 0));
        format!("{}:{w}:{h}", self.epoch)
    }
    fn pointer(&self, x: f64, y: f64) -> Result<()> {
        self.check()?;
        if !x.is_finite()
            || !y.is_finite()
            || x < 0.
            || y < 0.
            || x >= self.grant.size.0 as f64
            || y >= self.grant.size.1 as f64
        {
            return Err("wayland:INVALID_COORDINATES".into());
        }
        match &self.transport {
            Transport::Eis(eis) => {
                eis.pointer(x, y, self.grant.size, self.grant.mapping.as_deref())
            }
            Transport::Legacy => runtime().block_on(self.portal.notify(
                "NotifyPointerMotionAbsolute",
                &(
                    &self.grant.path,
                    HashMap::<&str, BusValue>::new(),
                    self.grant.node,
                    x,
                    y,
                ),
            )),
        }
    }
    fn button(&mut self, code: u32, down: bool) -> Result<()> {
        if down {
            self.buttons.insert(code);
        }
        let result = match &self.transport {
            Transport::Eis(eis) => eis.button(code, down),
            Transport::Legacy => runtime().block_on(self.portal.notify(
                "NotifyPointerButton",
                &(
                    &self.grant.path,
                    HashMap::<&str, BusValue>::new(),
                    code as i32,
                    u32::from(down),
                ),
            )),
        };
        if result.is_ok() && !down {
            self.buttons.remove(&code);
        }
        result
    }
    fn lookup(&self, sym: u32) -> Result<u32> {
        match &self.transport {
            Transport::Eis(eis) => Ok(eis.lookup(sym)?.0),
            Transport::Legacy => Ok(sym),
        }
    }
    fn key(&mut self, code: u32, down: bool) -> Result<()> {
        if down {
            self.keys.insert(code);
        }
        let result = match &self.transport {
            Transport::Eis(eis) => eis.keycode(code, down),
            Transport::Legacy => runtime().block_on(self.portal.notify(
                "NotifyKeyboardKeysym",
                &(
                    &self.grant.path,
                    HashMap::<&str, BusValue>::new(),
                    code as i32,
                    u32::from(down),
                ),
            )),
        };
        if result.is_ok() && !down {
            self.keys.remove(&code);
        }
        result
    }
    fn release(&mut self) -> Result<()> {
        let mut failed = false;
        let held = !self.keys.is_empty() || !self.buttons.is_empty();
        for key in self.keys.clone() {
            failed |= self.key(key, false).is_err();
        }
        for button in self.buttons.clone() {
            failed |= self.button(button, false).is_err();
        }
        if held || (self.used && !self.ended.load(Ordering::SeqCst)) {
            if let Transport::Eis(eis) = &self.transport {
                failed |= eis.sync().is_err();
            }
        }
        if failed {
            return Err("wayland:CLEANUP_FAILED".into());
        }
        self.used = false;
        Ok(())
    }
    fn close(&mut self) -> Result<()> {
        let release = self.release();
        let close = if self.ended.load(Ordering::SeqCst) {
            Ok(())
        } else {
            runtime().block_on(self.portal.close(&self.grant.path))
        };
        self.closed.store(true, Ordering::SeqCst);
        self.capture.stop();
        self.watcher.abort();
        release?;
        close
    }
}
impl Drop for PortalSession {
    fn drop(&mut self) {
        self.watcher.abort();
    }
}
fn target_id(p: &Value) -> Result<&str> {
    let id = str_field(p, "windowId");
    if id.starts_with("portal:") && id.len() > 7 && id.len() < 512 {
        Ok(id)
    } else {
        Err("wayland:INVALID_REQUEST".into())
    }
}
fn open(id: &str) -> Result<PortalSession> {
    if !CaptureStream::available() {
        return Err("wayland:MEDIA_REQUIRED".into());
    }
    // Single-use token is consumed before requesting restoration; never logged,
    // returned to the renderer, saved in workflows, or reused after cancellation.
    let restore = tokens()
        .lock()
        .map_err(|_| "wayland:BACKEND_FAILURE")?
        .remove(id);
    let (portal, grant, fd, eis_fd) = runtime().block_on(async {
        let portal = Portal::new().await?;
        let grant = portal.grant(restore.as_deref()).await?;
        let result: Result<_> = async {
            Ok((
                portal.pipewire(&grant.path).await?,
                portal.eis(&grant.path).await?,
            ))
        }
        .await;
        match result {
            Ok((fd, eis)) => Ok((portal, grant, fd, eis)),
            Err(error) => {
                let _ = portal.close(&grant.path).await;
                Err(error)
            }
        }
    })?;
    let closed = Arc::new(AtomicBool::new(false));
    let ended = Arc::new(AtomicBool::new(false));
    let result = (|| {
        let capture = CaptureStream::start(fd, grant.node, grant.serial, closed.clone())?;
        let watcher = runtime().block_on(portal.watch(
            &grant.path,
            closed.clone(),
            ended.clone(),
            capture.killer(),
        ))?;
        let transport = match eis_fd {
            Some(fd) => match Eis::connect(fd, closed.clone()) {
                Ok(eis) => Transport::Eis(eis),
                Err(error) => {
                    watcher.abort();
                    return Err(error);
                }
            },
            None => Transport::Legacy,
        };
        Ok((capture, watcher, transport))
    })();
    let (capture, watcher, transport) = match result {
        Ok(v) => v,
        Err(error) => {
            let _ = runtime().block_on(portal.close(&grant.path));
            return Err(error);
        }
    };
    if let Some(token) = &grant.token {
        let mut cache = tokens().lock().map_err(|_| "wayland:BACKEND_FAILURE")?;
        if cache.len() >= 64 {
            if let Some(old) = cache.keys().next().cloned() {
                cache.remove(&old);
            }
        }
        cache.insert(id.into(), token.clone());
    }
    Ok(PortalSession {
        portal,
        grant,
        capture,
        transport,
        closed,
        ended,
        watcher,
        epoch: format!(
            "{}-{}",
            std::process::id(),
            EPOCH.fetch_add(1, Ordering::SeqCst)
        ),
        pixels: None,
        keys: HashSet::new(),
        buttons: HashSet::new(),
        used: false,
    })
}
pub fn capabilities() -> Result<Value> {
    let portal = runtime().block_on(Portal::new());
    let media = CaptureStream::available();
    let (remote_version, cast_version, input, source) = portal
        .as_ref()
        .map(|p| {
            (
                p.remote_version,
                p.cast_version,
                p.devices & 3 == 3,
                p.sources & 3 != 0,
            )
        })
        .unwrap_or((0, 0, false, false));
    let map = sessions().lock().map_err(|_| "wayland:BACKEND_FAILURE")?;
    let active = map
        .values()
        .filter(|s| !s.closed.load(Ordering::SeqCst))
        .count();
    let transport = map
        .values()
        .find(|s| !s.closed.load(Ordering::SeqCst))
        .map(|s| match s.transport {
            Transport::Legacy => "legacy",
            Transport::Eis(_) => "eis",
        })
        .unwrap_or("none");
    Ok(
        json!({"platform":"linux","session":"wayland","capture":source&&media,"input":input,"accessibility":false,"directRecording":false,"globalShortcuts":false,"windows":[],
    "reasons":["Capture a target to explicitly grant a portal source and input. Passive capability probes never open a chooser.","Wayland cannot enumerate/focus arbitrary windows or passively record global input. Focus the intended application before typing.",if media{"PipeWire capture uses one persistent restricted stream per grant."}else{"Install GStreamer pipewiresrc, videorate, videoconvert, pngenc and fdsink plugins."},if portal.is_ok(){"Portal service discovered; this is not consent or qualification."}else{"RemoteDesktop/ScreenCast portal is unavailable; check the desktop portal backend."}],
    "waylandBackend":{"remoteDesktopVersion":remote_version,"screenCastVersion":cast_version,"mediaAvailable":media,"activeSessions":active,"inputTransport":transport,"restoration":"application-memory","permissionsGranted":active>0,"portalIdentity":portal.as_ref().map(|p|p.identity).unwrap_or("unregistered")}}),
    )
}
pub fn capture(p: &Value) -> Result<Value> {
    if CLEANUP_FAILED.load(Ordering::SeqCst) {
        return Err("wayland:CLEANUP_FAILED".into());
    }
    let id = target_id(p)?;
    let mut map = sessions().lock().map_err(|_| "wayland:BACKEND_FAILURE")?;
    if map
        .get(id)
        .map(|s| s.closed.load(Ordering::SeqCst))
        .unwrap_or(false)
    {
        if let Some(old) = map.get_mut(id) {
            old.close().map_err(|error| {
                CLEANUP_FAILED.store(true, Ordering::SeqCst);
                error
            })?;
        }
        map.remove(id);
    }
    if !map.contains_key(id) {
        if map.len() >= 4 {
            return Err("wayland:CAPABILITY_MISSING".into());
        }
        map.insert(id.into(), open(id)?);
    }
    let s = map.get_mut(id).unwrap();
    let frame = s.frame()?;
    Ok(
        json!({"width":frame.width,"height":frame.height,"capturedAt":frame.at,"dataUrl":format!("data:image/png;base64,{}",STANDARD.encode(&frame.png)),"bounds":{"x":0,"y":0,"width":s.grant.size.0,"height":s.grant.size.1},"sourceToken":s.token(),"sequence":frame.sequence}),
    )
}
fn keysym(key: &str) -> Result<u32> {
    if key.chars().count() == 1 {
        let ch = key.chars().next().unwrap() as u32;
        return Ok(if ch < 256 { ch } else { 0x01000000 | ch });
    }
    Ok(match key.to_ascii_lowercase().as_str() {
        "enter" | "return" => 0xff0d,
        "tab" => 0xff09,
        "escape" | "esc" => 0xff1b,
        "backspace" => 0xff08,
        "delete" => 0xffff,
        "space" => 32,
        "left" => 0xff51,
        "up" => 0xff52,
        "right" => 0xff53,
        "down" => 0xff54,
        "home" => 0xff50,
        "end" => 0xff57,
        "pageup" => 0xff55,
        "pagedown" => 0xff56,
        "shift" | "shift_l" => 0xffe1,
        "ctrl" | "control" | "control_l" => 0xffe3,
        "alt" | "alt_l" => 0xffe9,
        "meta" | "super" | "super_l" => 0xffeb,
        "plus" => 43,
        "f1" => 0xffbe,
        "f2" => 0xffbf,
        "f3" => 0xffc0,
        "f4" => 0xffc1,
        "f5" => 0xffc2,
        "f6" => 0xffc3,
        "f7" => 0xffc4,
        "f8" => 0xffc5,
        "f9" => 0xffc6,
        "f10" => 0xffc7,
        "f11" => 0xffc8,
        "f12" => 0xffc9,
        _ => return Err("wayland:UNSUPPORTED_KEY".into()),
    })
}
fn pause(s: &PortalSession, millis: f64) -> Result<()> {
    let until = std::time::Instant::now() + Duration::from_millis(millis.clamp(0., 120000.) as u64);
    while std::time::Instant::now() < until {
        s.check()?;
        thread::sleep(Duration::from_millis(10));
    }
    s.check()
}
pub fn input(p: &Value) -> Result<Value> {
    let id = target_id(p)?;
    let mut map = sessions().lock().map_err(|_| "wayland:BACKEND_FAILURE")?;
    let s = map.get_mut(id).ok_or("wayland:SESSION_REQUIRED")?;
    let kind = str_field(p, "kind");
    let result = (|| {
        // Releases never open grants and remain allowed after a cancelled action.
        if kind == "key" && str_field(p, "action") == "up" {
            let codes = str_field(p, "key")
                .split('+')
                .map(|k| keysym(k).and_then(|sym| s.lookup(sym)))
                .collect::<Result<Vec<_>>>()?;
            if codes.is_empty()
                || codes.len() > 16
                || codes.iter().collect::<HashSet<_>>().len() != codes.len()
            {
                return Err("wayland:UNSUPPORTED_KEY".into());
            }
            for code in codes.iter().rev() {
                s.key(*code, false)?;
            }
            return Ok(());
        }
        if CLEANUP_FAILED.load(Ordering::SeqCst) {
            return Err("wayland:CLEANUP_FAILED".into());
        }
        s.frame()?;
        if str_field(p, "sourceToken") != s.token() {
            return Err("wayland:STALE_CAPTURE".into());
        }
        s.used = true;
        let button = match str_field(p, "button") {
            "right" => 273,
            "middle" => 274,
            _ => 272,
        };
        match kind {
            "click" | "move" | "drag" => {
                let (x, y) = (num(p, "x", f64::NAN), num(p, "y", f64::NAN));
                let (tx, ty) = (num(p, "toX", x), num(p, "toY", y));
                if kind == "drag"
                    && (!tx.is_finite()
                        || !ty.is_finite()
                        || tx < 0.
                        || ty < 0.
                        || tx >= s.grant.size.0 as f64
                        || ty >= s.grant.size.1 as f64)
                {
                    return Err("wayland:INVALID_COORDINATES".into());
                }
                s.pointer(x, y)?;
                if kind == "click" {
                    for _ in 0..num(p, "clickCount", 1.).clamp(1., 3.) as u32 {
                        s.button(button, true)?;
                        s.button(button, false)?;
                    }
                }
                if kind == "drag" {
                    s.button(button, true)?;
                    for i in 1..=40 {
                        pause(s, num(p, "durationMs", 300.).clamp(20., 120000.) / 40.)?;
                        s.frame()?;
                        s.pointer(x + (tx - x) * i as f64 / 40., y + (ty - y) * i as f64 / 40.)?;
                    }
                    s.button(button, false)?;
                }
            }
            "scroll" => {
                if p.get("x").is_some() {
                    s.pointer(num(p, "x", f64::NAN), num(p, "y", f64::NAN))?;
                }
                let (x, y) = (num(p, "deltaX", 0.), num(p, "deltaY", 0.));
                if !x.is_finite() || !y.is_finite() || x.abs() > 1_000_000. || y.abs() > 1_000_000.
                {
                    return Err("wayland:INVALID_COORDINATES".into());
                }
                match &s.transport {
                    Transport::Eis(eis) => eis.scroll(x, y)?,
                    Transport::Legacy => runtime().block_on(s.portal.notify(
                        "NotifyPointerAxis",
                        &(
                            &s.grant.path,
                            HashMap::from([("finish", BusValue::from(true))]),
                            x,
                            y,
                        ),
                    ))?,
                }
            }
            "key" => {
                let codes = str_field(p, "key")
                    .split('+')
                    .map(|k| keysym(k).and_then(|v| s.lookup(v)))
                    .collect::<Result<Vec<_>>>()?;
                if codes.is_empty() || codes.iter().collect::<HashSet<_>>().len() != codes.len() {
                    return Err("wayland:UNSUPPORTED_KEY".into());
                }
                for code in &codes {
                    s.key(*code, true)?;
                }
                if str_field(p, "action") != "down" {
                    pause(s, num(p, "durationMs", 0.))?;
                    for code in codes.iter().rev() {
                        s.key(*code, false)?;
                    }
                }
            }
            "type" => {
                if !s.keys.is_empty() {
                    return Err("wayland:INPUT_BUSY".into());
                }
                let text = str_field(p, "text");
                if let Transport::Eis(eis) = &s.transport {
                    eis.sync()?;
                    if !eis.text_ready() {
                        return Err("wayland:INPUT_BUSY".into());
                    }
                    if eis.text_supported() {
                        for ch in text.chars() {
                            s.check()?;
                            eis.text(&ch.to_string())?;
                        }
                        return Ok(());
                    }
                }
                let codes = text
                    .chars()
                    .map(|ch| {
                        let sym = keysym(&ch.to_string())?;
                        match &s.transport {
                            Transport::Legacy => Ok((sym, None)),
                            Transport::Eis(eis) => {
                                let (code, shift) = eis.lookup(sym)?;
                                Ok((
                                    code,
                                    if shift {
                                        Some(eis.lookup(0xffe1)?.0)
                                    } else {
                                        None
                                    },
                                ))
                            }
                        }
                    })
                    .collect::<Result<Vec<_>>>()?;
                for (code, shift) in codes {
                    s.check()?;
                    if let Some(shift) = shift {
                        s.key(shift, true)?;
                    }
                    s.key(code, true)?;
                    s.key(code, false)?;
                    if let Some(shift) = shift {
                        s.key(shift, false)?;
                    }
                }
            }
            _ => return Err("wayland:UNSUPPORTED_OPERATION".into()),
        }
        Ok(())
    })();
    if let Err(error) = result {
        if s.release().is_err() {
            CLEANUP_FAILED.store(true, Ordering::SeqCst);
            return Err("wayland:CLEANUP_FAILED".into());
        }
        return Err(error);
    }
    Ok(json!(true))
}
pub fn release_keys() -> Result<Value> {
    let mut map = sessions().lock().map_err(|_| "wayland:CLEANUP_FAILED")?;
    for s in map.values_mut() {
        s.release().map_err(|error| {
            CLEANUP_FAILED.store(true, Ordering::SeqCst);
            error
        })?;
    }
    Ok(json!(true))
}
pub fn release_all() -> Result<Value> {
    let mut map = sessions().lock().map_err(|_| "wayland:CLEANUP_FAILED")?;
    let mut failed = false;
    let mut complete = Vec::new();
    for (id, s) in map.iter_mut() {
        if s.close().is_err() {
            failed = true;
        } else {
            complete.push(id.clone());
        }
    }
    for id in complete {
        map.remove(&id);
    }
    CLEANUP_FAILED.store(failed, Ordering::SeqCst);
    if failed {
        return Err("wayland:CLEANUP_FAILED".into());
    }
    Ok(json!(true))
}
pub fn shutdown() -> Result<Value> {
    release_all()
}
#[cfg(test)]
mod tests {
    use super::*;
    static MANAGER_TEST: Mutex<()> = Mutex::new(());
    fn test_session() -> (
        super::super::wayland_portal::tests::Bus,
        zbus::Connection,
        Arc<super::super::wayland_portal::tests::Mock>,
        PortalSession,
    ) {
        let (bus, address) = super::super::wayland_portal::tests::bus();
        let mut state = super::super::wayland_portal::tests::Mock::default();
        state.version = 5;
        let state = Arc::new(state);
        let (server, portal) = runtime().block_on(super::super::wayland_portal::tests::setup(
            &address,
            state.clone(),
        ));
        let grant = runtime().block_on(portal.grant(None)).unwrap();
        let capture = CaptureStream::test_source().unwrap();
        let closed = Arc::new(AtomicBool::new(false));
        let ended = Arc::new(AtomicBool::new(false));
        let watcher = runtime()
            .block_on(portal.watch(&grant.path, closed.clone(), ended.clone(), capture.killer()))
            .unwrap();
        (
            bus,
            server,
            state,
            PortalSession {
                portal,
                grant,
                capture,
                transport: Transport::Legacy,
                closed,
                ended,
                watcher,
                epoch: "test-grant".into(),
                pixels: None,
                keys: HashSet::new(),
                buttons: HashSet::new(),
                used: false,
            },
        )
    }
    #[test]
    fn named_key_up_preserves_other_owned_modifiers() {
        let _guard = MANAGER_TEST.lock().unwrap();
        let (_bus, _server, state, session) = test_session();
        let id = "portal:held-modifiers";
        sessions().lock().unwrap().insert(id.into(), session);
        let frame = capture(&json!({"windowId":id})).unwrap();
        for key in ["Shift", "Control"] {
            input(&json!({"windowId":id,"sourceToken":frame["sourceToken"],"kind":"key","key":key,"action":"down"})).unwrap();
        }
        input(&json!({"windowId":id,"kind":"key","key":"Shift","action":"up"})).unwrap();
        assert_eq!(
            sessions().lock().unwrap().get(id).unwrap().keys,
            HashSet::from([0xffe3])
        );
        assert_eq!(state.keys.lock().unwrap().last(), Some(&(0xffe1, 0)));
        release_all().unwrap();
        assert_eq!(state.keys.lock().unwrap().last(), Some(&(0xffe3, 0)));
    }
    #[test]
    fn failed_close_blocks_all_targets_until_cleanup_is_acknowledged() {
        let _guard = MANAGER_TEST.lock().unwrap();
        let (_bus, _server, state, session) = test_session();
        let id = "portal:failed-close";
        sessions().lock().unwrap().insert(id.into(), session);
        state.fail_close.store(true, Ordering::SeqCst);
        assert!(release_all().is_err());
        assert_eq!(
            capture(&json!({"windowId":"portal:another-target"})).unwrap_err(),
            "wayland:CLEANUP_FAILED"
        );
        state.fail_close.store(false, Ordering::SeqCst);
        release_all().unwrap();
        assert_eq!(
            input(&json!({"windowId":id,"kind":"click"})).unwrap_err(),
            "wayland:SESSION_REQUIRED"
        );
    }
    #[test]
    fn wayland_session_never_falls_through_to_xwayland() {
        assert!(detect_wayland(Some("wayland"), None));
        assert!(detect_wayland(Some("wayland"), Some("")));
        assert!(detect_wayland(None, Some("wayland-0")));
        assert!(!detect_wayland(Some("x11"), Some("wayland-0")));
        assert!(!detect_wayland(None, None));
    }
    #[test]
    fn input_never_opens_a_chooser_or_grant() {
        assert_eq!(
            input(&json!({"windowId":"portal:not-granted","kind":"click","x":1,"y":1}))
                .unwrap_err(),
            "wayland:SESSION_REQUIRED"
        );
    }
    #[test]
    fn key_errors_do_not_echo_values() {
        assert_eq!(
            keysym("sensitive-value").unwrap_err(),
            "wayland:UNSUPPORTED_KEY"
        );
        assert_eq!(keysym("😀").unwrap(), 0x0101f600);
    }
}
