use super::*;
use std::collections::HashMap;
fn x11() -> Result<()> {
    if std::env::var("WAYLAND_DISPLAY")
        .map(|v| !v.is_empty())
        .unwrap_or(false)
        && std::env::var("XDG_SESSION_TYPE").unwrap_or_default() != "x11"
    {
        return Err("This operation requires X11. On Wayland use portal capture and guided recording; passive global recording is unavailable.".into());
    }
    if std::env::var("DISPLAY").unwrap_or_default().is_empty() {
        return Err("No X11 DISPLAY is available".into());
    }
    Ok(())
}
fn available(s: &str) -> bool {
    std::env::var("PATH")
        .unwrap_or_default()
        .split(':')
        .any(|p| std::path::Path::new(p).join(s).is_file())
}
fn id(p: &Value) -> Result<&str> {
    let id = str_field(p, "windowId");
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_hexdigit() || c == 'x') {
        return Err("A valid window ID is required".into());
    }
    Ok(id)
}
fn geometry(id: &str) -> Result<Value> {
    let out = run("xdotool", &["getwindowgeometry", "--shell", id])?;
    let mut m = HashMap::new();
    for l in out.lines() {
        if let Some((k, v)) = l.split_once('=') {
            m.insert(k, v.parse::<i64>().unwrap_or(0));
        }
    }
    Ok(json!({"x":m.get("X"),"y":m.get("Y"),"width":m.get("WIDTH"),"height":m.get("HEIGHT")}))
}
pub fn capabilities() -> Result<Value> {
    if super::wayland::is_wayland() {
        return super::wayland::capabilities();
    }
    let ok = x11().is_ok();
    let capture = ok && available("import") && available("xdotool");
    let input = ok && available("xdotool");
    let mut reasons = vec![];
    if let Err(e) = x11() {
        reasons.push(e)
    }
    for tool in ["xdotool", "import"] {
        if !available(tool) {
            reasons.push(format!("Missing dependency: {tool}"));
        }
    }
    Ok(
        json!({"platform":"linux","session":if ok{"x11"}else{"wayland-or-headless"},"capture":capture,"input":input,"accessibility":false,"directRecording":input && available("xinput") && available("xmodmap") && available("stdbuf"),"globalShortcuts":ok,"reasons":reasons,"windows":if ok{windows().unwrap_or(json!([]))}else{json!([])}}),
    )
}
pub fn windows() -> Result<Value> {
    if super::wayland::is_wayland() {
        return Ok(json!([]));
    }
    x11()?;
    let listed = run("xdotool", &["search", "--onlyvisible", "--name", "."]).unwrap_or_default();
    let mut result = vec![];
    for id in listed.lines() {
        if let Ok(bounds) = geometry(id) {
            let title = run("xdotool", &["getwindowname", id]).unwrap_or_default();
            if title.is_empty() {
                continue;
            }
            let app = run("xprop", &["-id", id, "WM_CLASS"]).unwrap_or_default();
            let application = app
                .split('"')
                .nth(3)
                .or_else(|| app.split('"').nth(1))
                .unwrap_or("");
            let pid = run("xprop", &["-id", id, "_NET_WM_PID"])
                .ok()
                .and_then(|s| s.split('=').nth(1)?.trim().parse::<u32>().ok());
            let mut window =
                json!({"id":id,"title":title,"application":application,"bounds":bounds});
            if let Some(pid) = pid {
                window["pid"] = json!(pid);
            }
            result.push(window);
        }
    }
    Ok(json!(result))
}
pub fn capture(p: &Value) -> Result<Value> {
    if super::wayland::is_wayland() {
        return super::wayland::capture(p);
    }
    x11()?;
    let id = id(p)?;
    let bounds = geometry(id)?;
    let path = std::env::temp_dir().join(format!(
        "relay-capture-{}-{}.png",
        std::process::id(),
        now()
    ));
    run("import", &["-window", id, path.to_str().unwrap()])?;
    capture_file(&path, bounds)
}
pub fn focus(p: &Value) -> Result<Value> {
    if super::wayland::is_wayland() {
        return Err("Wayland does not allow universal programmatic window focus. Click the selected source or focus the target application before typing.".into());
    }
    x11()?;
    let id = id(p)?; // Xvfb may have no window manager; explicit focus is the fallback.
    if run("xdotool", &["windowactivate", "--sync", id]).is_err() {
        run("xdotool", &["windowraise", id])?;
        run("xdotool", &["windowfocus", "--sync", id])?;
    }
    Ok(json!(true))
}
fn point(p: &Value, id: &str, xkey: &str, ykey: &str) -> Result<(i64, i64)> {
    let g = geometry(id)?;
    let x = num(p, xkey, 0.);
    let y = num(p, ykey, 0.);
    if x < 0. || y < 0. || x >= num(&g, "width", 0.) || y >= num(&g, "height", 0.) {
        return Err("Input coordinates are outside the target window".into());
    }
    Ok((
        num(&g, "x", 0.) as i64 + x.round() as i64,
        num(&g, "y", 0.) as i64 + y.round() as i64,
    ))
}
fn mouse_to(x: i64, y: i64) -> Result<String> {
    run(
        "xdotool",
        &["mousemove", "--sync", &x.to_string(), &y.to_string()],
    )
}
pub fn input(p: &Value) -> Result<Value> {
    if super::wayland::is_wayland() {
        return super::wayland::input(p);
    }
    x11()?;
    let id = id(p)?;
    focus(p)?;
    let kind = str_field(p, "kind");
    let button = match str_field(p, "button") {
        "right" => "3",
        "middle" => "2",
        _ => "1",
    };
    match kind {
        "click" | "move" | "drag" => {
            let (x, y) = point(p, id, "x", "y")?;
            mouse_to(x, y)?;
            if kind == "click" {
                let n = num(p, "clickCount", 1.).clamp(1., 3.) as u32;
                run(
                    "xdotool",
                    &[
                        "click",
                        "--repeat",
                        &n.to_string(),
                        "--delay",
                        "100",
                        button,
                    ],
                )?;
            }
            if kind == "drag" {
                let (tx, ty) = point(p, id, "toX", "toY")?;
                run("xdotool", &["mousedown", button])?;
                let steps = 20;
                for step in 1..=steps {
                    mouse_to(x + (tx - x) * step / steps, y + (ty - y) * step / steps)?;
                    thread::sleep(Duration::from_millis(
                        (num(p, "durationMs", 300.).clamp(20., 10000.) as u64) / steps as u64,
                    ));
                }
                run("xdotool", &["mouseup", button])?;
            }
        }
        "type" => {
            run(
                "xdotool",
                &[
                    "type",
                    "--clearmodifiers",
                    "--delay",
                    "1",
                    "--",
                    str_field(p, "text"),
                ],
            )?;
        }
        "key" => {
            let key = str_field(p, "key");
            if key.is_empty() {
                return Err("Key is required".into());
            }
            let action = match str_field(p, "action") {
                "down" => "keydown",
                "up" => "keyup",
                _ => "key",
            };
            if action == "key" && num(p, "durationMs", 0.) > 0. {
                run("xdotool", &["keydown", "--", key])?;
                thread::sleep(Duration::from_millis(
                    num(p, "durationMs", 0.).clamp(0., 120000.) as u64,
                ));
                run("xdotool", &["keyup", "--", key])?;
            } else {
                run("xdotool", &[action, "--", key])?;
            }
        }
        "scroll" => {
            if p.get("x").is_some() {
                let (x, y) = point(p, id, "x", "y")?;
                mouse_to(x, y)?;
            }
            for (name, negative, positive) in [("deltaY", "4", "5"), ("deltaX", "6", "7")] {
                let delta = num(p, name, 0.);
                if delta != 0. {
                    let count = (delta.abs() / 100.).ceil().clamp(1., 100.) as u32;
                    run(
                        "xdotool",
                        &[
                            "click",
                            "--repeat",
                            &count.to_string(),
                            "--delay",
                            "20",
                            if delta < 0. { negative } else { positive },
                        ],
                    )?;
                }
            }
        }
        _ => return Err(format!("Unsupported native input: {kind}")),
    };
    Ok(json!(true))
}
pub fn close(p: &Value) -> Result<Value> {
    if super::wayland::is_wayland() {
        return Err("Wayland cannot close arbitrary applications; close the window through an explicit workflow action".into());
    }
    x11()?;
    run("xdotool", &["windowclose", id(p)?])?;
    Ok(json!(true))
}
pub fn release_all() -> Result<Value> {
    if super::wayland::is_wayland() {
        return super::wayland::release_all();
    }
    if x11().is_ok() {
        for key in [
            "Shift_L",
            "Shift_R",
            "Control_L",
            "Control_R",
            "Alt_L",
            "Alt_R",
            "Super_L",
            "Super_R",
        ] {
            let _ = run("xdotool", &["keyup", key]);
        }
        for b in ["1", "2", "3"] {
            let _ = run("xdotool", &["mouseup", b]);
        }
    }
    Ok(json!(true))
}
pub fn record(p: Value, active: Arc<AtomicBool>) -> Result<thread::JoinHandle<()>> {
    x11()?;
    let recording_id = str_field(&p, "recordingId").to_string();
    let target = id(&p)?.to_string();
    let mut child = Command::new("stdbuf")
        .args(["-oL", "xinput", "test-xi2", "--root"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    let stdout = child.stdout.take().ok_or("Recorder stream unavailable")?;
    let child = Arc::new(Mutex::new(child));
    let monitor = child.clone();
    let flag = active.clone();
    let monitor_worker = thread::spawn(move || {
        while flag.load(Ordering::SeqCst) {
            thread::sleep(Duration::from_millis(50));
        }
        if let Ok(mut child) = monitor.lock() {
            let _ = child.kill();
        }
    });
    let keys = run("xmodmap", &["-pk"]).unwrap_or_default();
    let keymap: HashMap<String, String> = keys
        .lines()
        .filter_map(|l| {
            let code = l.split_whitespace().next()?.to_string();
            let key = l.split('(').nth(1)?.split(')').next()?.to_string();
            Some((code, key))
        })
        .collect();
    let worker = thread::spawn(move || {
        let mut event = String::new();
        let mut pressed: HashMap<String, (i64, i64)> = HashMap::new();
        for line in io::BufReader::new(stdout).lines() {
            if !active.load(Ordering::SeqCst) {
                break;
            }
            let line = match line {
                Ok(l) => l,
                Err(_) => break,
            };
            if line.starts_with("EVENT type") {
                event = line.clone();
                continue;
            }
            if !line.trim_start().starts_with("detail:") {
                continue;
            }
            let detail = line.split(':').nth(1).unwrap_or("").trim();
            let foreground = run("xdotool", &["getwindowfocus"]).unwrap_or_default();
            if foreground != target {
                continue;
            }
            let g = match geometry(&target) {
                Ok(g) => g,
                Err(_) => continue,
            };
            let pos = run("xdotool", &["getmouselocation", "--shell"]).unwrap_or_default();
            let coords: HashMap<&str, i64> = pos
                .lines()
                .filter_map(|l| {
                    let (k, v) = l.split_once('=')?;
                    Some((k, v.parse().ok()?))
                })
                .collect();
            let x = coords.get("X").copied().unwrap_or(0) - num(&g, "x", 0.) as i64;
            let y = coords.get("Y").copied().unwrap_or(0) - num(&g, "y", 0.) as i64;
            let action = if event.contains("RawButtonPress") {
                if let Ok(b) = detail.parse::<u32>() {
                    if b >= 4 && b <= 7 {
                        Some(
                            json!({"kind":"scroll","label":"Scroll","config":{"x":x,"y":y,"deltaY":if b==4{-100}else if b==5{100}else{0},"deltaX":if b==6{-100}else if b==7{100}else{0}}}),
                        )
                    } else {
                        pressed.insert(detail.to_string(), (x, y));
                        None
                    }
                } else {
                    None
                }
            } else if event.contains("RawButtonRelease") {
                pressed.remove(detail).map(|(sx,sy)|{let drag=(x-sx).abs()+(y-sy).abs()>4;json!({"kind":if drag{"drag"}else{"click"},"label":if drag{"Drag"}else{"Click"},"config":{"x":sx,"y":sy,"toX":x,"toY":y,"button":match detail{"2"=>"middle","3"=>"right",_=>"left"}}})})
            } else if event.contains("RawKeyPress") || event.contains("RawKeyRelease") {
                keymap.get(detail).map(|key|json!({"kind":"key","label":format!("Key {key}"),"config":{"key":key,"action":if event.contains("RawKeyPress"){"down"}else{"up"}}}))
            } else {
                None
            };
            if let Some(mut action) = action {
                if !active.load(Ordering::SeqCst) {
                    break;
                }
                if action["kind"] == "click" || action["kind"] == "drag" {
                    action["config"]["expectedWidth"] = g["width"].clone();
                    action["config"]["expectedHeight"] = g["height"].clone();
                }
                action["at"] = json!(now());
                action["id"] = json!(format!("record-{}", now()));
                emit(json!({"event":"recordedAction","recordingId":recording_id,"action":action}));
            }
        }
        active.store(false, Ordering::SeqCst);
        if let Ok(mut c) = child.lock() {
            let _ = c.kill();
            let _ = c.wait();
        }
        let _ = monitor_worker.join();
        emit(json!({"event":"recordingStopped","recordingId":recording_id}));
    });
    Ok(worker)
}

pub fn release_keys(p: &Value) -> Result<Value> {
    if super::wayland::is_wayland() {
        return super::wayland::release_all();
    }
    if x11().is_ok() {
        if let Some(keys) = p["keys"].as_array() {
            for key in keys.iter().filter_map(Value::as_str) {
                let _ = run("xdotool", &["keyup", "--", key]);
            }
        }
    }
    Ok(json!(true))
}
