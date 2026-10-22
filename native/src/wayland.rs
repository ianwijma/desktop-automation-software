//! Portal-authorized capture and input. Never fall back to privileged uinput or XWayland.
use super::*;
use ashpd::desktop::{
    remote_desktop::{
        DeviceType, KeyState, NotifyPointerAxisOptions, RemoteDesktop, SelectDevicesOptions,
    },
    screencast::{CursorMode, Screencast, SelectSourcesOptions, SourceType},
    Session,
};
use std::{
    collections::{HashMap, HashSet},
    os::{
        fd::{AsRawFd, OwnedFd},
        unix::process::CommandExt,
    },
    sync::OnceLock,
};
struct PortalSession {
    remote: RemoteDesktop,
    session: Session<RemoteDesktop>,
    fd: OwnedFd,
    stream: u32,
    width: i32,
    height: i32,
    keys: HashSet<i32>,
}
static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
static SESSIONS: OnceLock<Mutex<HashMap<String, PortalSession>>> = OnceLock::new();
fn runtime() -> &'static tokio::runtime::Runtime {
    RUNTIME.get_or_init(|| tokio::runtime::Runtime::new().expect("Tokio runtime"))
}
fn sessions() -> &'static Mutex<HashMap<String, PortalSession>> {
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}
fn error(e: impl std::fmt::Display) -> String {
    format!("Wayland portal: {e}")
}
pub fn is_wayland() -> bool {
    std::env::var("WAYLAND_DISPLAY")
        .map(|v| !v.is_empty())
        .unwrap_or(false)
        && std::env::var("XDG_SESSION_TYPE").unwrap_or_default() != "x11"
}
fn media_available() -> bool {
    run("gst-inspect-1.0", &["pipewiresrc"]).is_ok() && run("gst-inspect-1.0", &["pngenc"]).is_ok()
}
pub fn capabilities() -> Result<Value> {
    let check = runtime().block_on(async {
        tokio::time::timeout(Duration::from_secs(3), async {
            let remote = RemoteDesktop::new().await?;
            let capture = Screencast::new().await?;
            let devices = remote.available_device_types().await?;
            let sources = capture.available_source_types().await?;
            Ok::<_, ashpd::Error>((
                devices.contains(DeviceType::Keyboard) && devices.contains(DeviceType::Pointer),
                !sources.is_empty(),
            ))
        })
        .await
    });
    let (input, capture, reason) = match check {
        Ok(Ok((i, c))) => (i, c, String::new()),
        Ok(Err(e)) => (false, false, error(e)),
        Err(_) => (false, false, "Wayland portal did not respond".to_string()),
    };
    let media = media_available();
    let mut reasons=vec!["Wayland asks you to grant capture and input for each target. Select a monitor for reliable multi-application automation; window source support depends on the compositor.".to_string(),"Wayland does not provide universal window enumeration, application focus, or passive global recording. Use guided recording; focus the target before typing.".to_string()];
    if !reason.is_empty() {
        reasons.push(reason)
    }
    if !media {
        reasons.push(
            "Install GStreamer with pipewiresrc and pngenc plugins for Wayland capture".into(),
        )
    }
    Ok(
        json!({"platform":"linux","session":"wayland","capture":capture&&media,"input":input,"accessibility":false,"directRecording":false,"globalShortcuts":false,"windows":[],"reasons":reasons}),
    )
}
async fn open_session() -> Result<PortalSession> {
    let remote = RemoteDesktop::new().await.map_err(error)?;
    let cast = Screencast::new().await.map_err(error)?;
    let session = remote
        .create_session(Default::default())
        .await
        .map_err(error)?;
    remote
        .select_devices(
            &session,
            SelectDevicesOptions::default().set_devices(DeviceType::Keyboard | DeviceType::Pointer),
        )
        .await
        .map_err(error)?
        .response()
        .map_err(error)?;
    let sources = cast.available_source_types().await.map_err(error)?;
    let requested = if sources.contains(SourceType::Window) {
        SourceType::Monitor | SourceType::Window
    } else {
        SourceType::Monitor.into()
    };
    cast.select_sources(
        &session,
        SelectSourcesOptions::default()
            .set_sources(requested)
            .set_multiple(false)
            .set_cursor_mode(CursorMode::Hidden),
    )
    .await
    .map_err(error)?
    .response()
    .map_err(error)?;
    let selected = remote
        .start(&session, None, Default::default())
        .await
        .map_err(error)?
        .response()
        .map_err(error)?;
    if !selected.devices().contains(DeviceType::Pointer)
        || !selected.devices().contains(DeviceType::Keyboard)
    {
        let _ = session.close().await;
        return Err("Keyboard and pointer access were not granted".into());
    }
    let stream = selected
        .streams()
        .first()
        .ok_or("No capture source was granted")?;
    let (width, height) = stream.size().unwrap_or((0, 0));
    let stream_id = stream.pipe_wire_node_id();
    let fd = cast
        .open_pipe_wire_remote(&session, Default::default())
        .await
        .map_err(error)?;
    Ok(PortalSession {
        remote,
        session,
        fd,
        stream: stream_id,
        width,
        height,
        keys: HashSet::new(),
    })
}
fn with_session<T>(p: &Value, f: impl FnOnce(&mut PortalSession) -> Result<T>) -> Result<T> {
    let id = str_field(p, "windowId");
    if !id.starts_with("portal:") {
        return Err("A Wayland portal target is required".into());
    }
    let mut map = sessions().lock().map_err(error)?;
    if !map.contains_key(id) {
        let session = runtime().block_on(open_session())?;
        map.insert(id.into(), session);
    }
    f(map.get_mut(id).unwrap())
}
pub fn capture(p: &Value) -> Result<Value> {
    if !media_available() {
        return Err("GStreamer pipewiresrc and pngenc are required for Wayland capture".into());
    }
    with_session(p, |session| {
        let path = std::env::temp_dir().join(format!(
            "relay-wayland-{}-{}.png",
            std::process::id(),
            now()
        ));
        // Pass the portal's restricted PipeWire remote over an inherited fd; do not use the unrestricted default remote.
        let fd = session.fd.as_raw_fd();
        let mut command = Command::new("gst-launch-1.0");
        command.args([
            "-q",
            "pipewiresrc",
            "fd=3",
            &format!("path={}", session.stream),
            "num-buffers=1",
            "!",
            "videoconvert",
            "!",
            "pngenc",
            "!",
            "filesink",
            &format!("location={}", path.display()),
        ]);
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        unsafe {
            command.pre_exec(move || {
                if fd != 3 && libc::dup2(fd, 3) < 0 {
                    return Err(io::Error::last_os_error());
                }
                if libc::fcntl(3, libc::F_SETFD, 0) < 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut child = command.spawn().map_err(error)?;
        let started = std::time::Instant::now();
        let status = loop {
            if let Some(status) = child.try_wait().map_err(error)? {
                break status;
            }
            if started.elapsed() > Duration::from_secs(8) {
                let _ = child.kill();
                let _ = child.wait();
                let _ = std::fs::remove_file(&path);
                return Err(
                    "Wayland capture timed out; the selected source may be closed or unavailable"
                        .into(),
                );
            }
            thread::sleep(Duration::from_millis(20));
        };
        if !status.success() {
            let output = child.wait_with_output().map_err(error)?;
            let _ = std::fs::remove_file(&path);
            return Err(format!(
                "PipeWire capture failed: {}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }
        let mut frame = capture_file(
            &path,
            json!({"x":0,"y":0,"width":session.width,"height":session.height}),
        )?;
        if session.width <= 0 || session.height <= 0 {
            session.width = frame["width"].as_i64().unwrap_or(0) as i32;
            session.height = frame["height"].as_i64().unwrap_or(0) as i32;
            frame["bounds"] = json!({"x":0,"y":0,"width":session.width,"height":session.height});
        }
        Ok(frame)
    })
}
fn keysym(key: &str) -> Result<i32> {
    if key.chars().count() == 1 {
        let ch = key.chars().next().unwrap() as u32;
        return Ok(if ch < 256 { ch } else { 0x01000000 | ch } as i32);
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
        _ => return Err(format!("Unsupported Wayland key: {key}")),
    })
}
fn pointer(session: &PortalSession, x: f64, y: f64) -> Result<()> {
    if x < 0. || y < 0. || x >= session.width as f64 || y >= session.height as f64 {
        return Err("Input point is outside the granted Wayland source".into());
    }
    runtime()
        .block_on(session.remote.notify_pointer_motion_absolute(
            &session.session,
            session.stream,
            x,
            y,
            Default::default(),
        ))
        .map_err(error)
}
fn button(session: &PortalSession, button: i32, state: KeyState) -> Result<()> {
    runtime()
        .block_on(session.remote.notify_pointer_button(
            &session.session,
            button,
            state,
            Default::default(),
        ))
        .map_err(error)
}
fn key(session: &mut PortalSession, sym: i32, state: KeyState) -> Result<()> {
    runtime()
        .block_on(session.remote.notify_keyboard_keysym(
            &session.session,
            sym,
            state,
            Default::default(),
        ))
        .map_err(error)?;
    if state == KeyState::Pressed {
        session.keys.insert(sym);
    } else {
        session.keys.remove(&sym);
    }
    Ok(())
}
pub fn input(p: &Value) -> Result<Value> {
    with_session(p, |session| {
        let kind = str_field(p, "kind");
        let b = match str_field(p, "button") {
            "right" => 273,
            "middle" => 274,
            _ => 272,
        };
        match kind {
            "click" | "move" | "drag" => {
                let x = num(p, "x", 0.);
                let y = num(p, "y", 0.);
                pointer(session, x, y)?;
                if kind == "click" {
                    for _ in 0..num(p, "clickCount", 1.).clamp(1., 3.) as u32 {
                        button(session, b, KeyState::Pressed)?;
                        button(session, b, KeyState::Released)?;
                    }
                }
                if kind == "drag" {
                    let tx = num(p, "toX", 0.);
                    let ty = num(p, "toY", 0.);
                    if tx < 0.
                        || ty < 0.
                        || tx >= session.width as f64
                        || ty >= session.height as f64
                    {
                        return Err("Drag destination outside granted source".into());
                    }
                    button(session, b, KeyState::Pressed)?;
                    let result = (|| {
                        for i in 1..=20 {
                            pointer(
                                session,
                                x + (tx - x) * i as f64 / 20.,
                                y + (ty - y) * i as f64 / 20.,
                            )?;
                            thread::sleep(Duration::from_millis(15));
                        }
                        Ok::<_, String>(())
                    })();
                    let released = button(session, b, KeyState::Released);
                    result?;
                    released?;
                }
            }
            "scroll" => {
                if p.get("x").is_some() {
                    pointer(session, num(p, "x", 0.), num(p, "y", 0.))?;
                }
                runtime()
                    .block_on(session.remote.notify_pointer_axis(
                        &session.session,
                        num(p, "deltaX", 0.),
                        num(p, "deltaY", 0.),
                        NotifyPointerAxisOptions::default().set_finish(true),
                    ))
                    .map_err(error)?;
            }
            "type" => {
                for ch in str_field(p, "text").chars() {
                    let sym = keysym(&ch.to_string())?;
                    key(session, sym, KeyState::Pressed)?;
                    key(session, sym, KeyState::Released)?;
                }
            }
            "key" => {
                let keys: Vec<i32> = str_field(p, "key")
                    .split('+')
                    .map(keysym)
                    .collect::<Result<_>>()?;
                if str_field(p, "action") != "up" {
                    for sym in &keys {
                        key(session, *sym, KeyState::Pressed)?;
                    }
                }
                if str_field(p, "action") != "down" {
                    if str_field(p, "action") != "up" {
                        thread::sleep(Duration::from_millis(
                            num(p, "durationMs", 0.).clamp(0., 120000.) as u64,
                        ));
                    }
                    for sym in keys.iter().rev() {
                        key(session, *sym, KeyState::Released)?;
                    }
                }
            }
            _ => return Err(format!("Unsupported Wayland input: {kind}")),
        }
        Ok(json!(true))
    })
}
pub fn release_all() -> Result<Value> {
    if let Ok(mut map) = sessions().lock() {
        for session in map.values_mut() {
            for sym in session.keys.clone() {
                let _ = key(session, sym, KeyState::Released);
            }
            for b in [272, 273, 274] {
                let _ = button(session, b, KeyState::Released);
            }
        }
    }
    Ok(json!(true))
}
