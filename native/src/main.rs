use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};
use std::{
    io::{self, BufRead, Write},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
mod protocol;
#[cfg(target_os = "linux")]
mod wayland;
#[cfg(target_os = "windows")]
mod windows;
#[cfg(any(target_os = "windows", test))]
mod windows_contract;
#[cfg(target_os = "linux")]
use linux as platform;
#[cfg(target_os = "macos")]
use macos as platform;
#[cfg(target_os = "windows")]
use windows as platform;
static HELD_KEYS: std::sync::OnceLock<Mutex<std::collections::HashSet<String>>> =
    std::sync::OnceLock::new();
static INPUT_USED: AtomicBool = AtomicBool::new(false);
fn held_keys() -> &'static Mutex<std::collections::HashSet<String>> {
    HELD_KEYS.get_or_init(|| Mutex::new(std::collections::HashSet::new()))
}
fn release_owned() -> Result<Value> {
    let keys: Vec<String> = held_keys()
        .lock()
        .map_err(|e| e.to_string())?
        .drain()
        .collect();
    platform::release_keys(&json!({"keys":keys}))?;
    platform::release_all()
}
pub type Result<T> = std::result::Result<T, String>;
pub fn run(program: &str, args: &[&str]) -> Result<String> {
    let out = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("{program}: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "{program}: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}
pub fn str_field<'a>(p: &'a Value, name: &str) -> &'a str {
    p[name].as_str().unwrap_or("")
}
pub fn num(p: &Value, name: &str, default: f64) -> f64 {
    p[name].as_f64().unwrap_or(default)
}
pub fn now() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}
pub fn capture_file(path: &std::path::Path, bounds: Value) -> Result<Value> {
    let data = std::fs::read(path).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(path);
    if data.len() < 24 || &data[..8] != b"\x89PNG\r\n\x1a\n" {
        return Err("Capture did not return a valid PNG".into());
    }
    let width = u32::from_be_bytes(data[16..20].try_into().unwrap());
    let height = u32::from_be_bytes(data[20..24].try_into().unwrap());
    Ok(
        json!({"width":width,"height":height,"dataUrl":format!("data:image/png;base64,{}",STANDARD.encode(data)),"bounds":bounds,"capturedAt":now()}),
    )
}
pub fn emit(mut value: Value) {
    value["protocolVersion"] = json!(protocol::VERSION);
    let mut out = io::stdout().lock();
    let _ = writeln!(out, "{}", value);
    let _ = out.flush();
}
struct Recording {
    active: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}
impl Recording {
    fn stop(&mut self) -> Result<()> {
        self.active.store(false, Ordering::SeqCst);
        if let Some(worker) = self.worker.take() {
            worker
                .join()
                .map_err(|_| "Recorder worker failed during shutdown".to_string())?;
        }
        Ok(())
    }
}
fn dispatch(method: &str, p: &Value, recording: &mut Recording) -> Result<Value> {
    if p["applicationIdentity"].is_object() {
        let windows = protocol::windows(platform::windows()?);
        if !windows
            .as_array()
            .map(|items| {
                items.iter().any(|w| {
                    w["id"] == p["windowId"] && w["applicationIdentity"] == p["applicationIdentity"]
                })
            })
            .unwrap_or(false)
        {
            return Err("Target window identity is no longer available".into());
        }
    }
    match method {
        "handshake" => Ok(protocol::handshake()),
        "capabilities" => platform::capabilities().map(protocol::capabilities),
        "listWindows" => platform::windows().map(protocol::windows),
        "capture" => protocol::capture(platform::capture(p)?, p),
        "focus" => platform::focus(p),
        "input" => {
            INPUT_USED.store(true, Ordering::SeqCst);
            if str_field(p, "kind") == "key" && str_field(p, "action") != "up" {
                held_keys()
                    .lock()
                    .map_err(|e| e.to_string())?
                    .insert(str_field(p, "key").to_string());
            }
            let value = platform::input(p)?;
            if str_field(p, "kind") == "key" && str_field(p, "action") != "down" {
                held_keys()
                    .lock()
                    .map_err(|e| e.to_string())?
                    .remove(str_field(p, "key"));
            }
            Ok(value)
        }
        "close" => platform::close(p),
        "releaseAll" => release_owned(),
        "releaseCapture" => {
            #[cfg(any(target_os = "windows", target_os = "macos"))]
            {
                return platform::release_capture();
            }
            #[cfg(not(any(target_os = "windows", target_os = "macos")))]
            {
                Ok(json!(true))
            }
        }
        "releaseKeys" => platform::release_keys(p),
        "launch" => {
            let command = str_field(p, "command");
            if command.is_empty() {
                return Err("An application command is required".into());
            }
            let args: Vec<&str> = p["args"]
                .as_array()
                .map(|a| a.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            let mut launch = Command::new(command);
            launch
                .args(args)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            #[cfg(unix)]
            {
                use std::os::unix::process::CommandExt;
                launch.process_group(0);
            }
            let child = launch.spawn().map_err(|e| e.to_string())?;
            let pid = child.id();
            thread::spawn(move || {
                let mut c = child;
                let _ = c.wait();
            });
            Ok(json!({"pid":pid}))
        }
        "startRecording" => {
            if recording.active.load(Ordering::SeqCst) {
                return Err("Recording is already active".into());
            }
            recording.stop()?;
            recording.active = Arc::new(AtomicBool::new(true));
            match platform::record(p.clone(), recording.active.clone()) {
                Ok(worker) => {
                    recording.worker = Some(worker);
                    Ok(json!(true))
                }
                Err(e) => {
                    recording.active.store(false, Ordering::SeqCst);
                    Err(e)
                }
            }
        }
        "stopRecording" => {
            recording.stop()?;
            Ok(json!(true))
        }
        "ping" => Ok(json!(true)),
        _ => Err(format!("Unsupported native method: {method}")),
    }
}
fn main() {
    let mut recording = Recording {
        active: Arc::new(AtomicBool::new(false)),
        worker: None,
    };
    let mut negotiated = false;
    // Commands are processed serially: desktop input is a single shared resource.
    for line in io::stdin().lock().lines() {
        let line = match line {
            Ok(s) => s,
            Err(_) => break,
        };
        let req: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => {
                emit(
                    json!({"id":null,"protocolVersion":protocol::VERSION,"error":protocol::error("parse","Invalid request required".into())}),
                );
                continue;
            }
        };
        let id = req["id"].clone();
        let method = str_field(&req, "method");
        let result = if req["protocolVersion"].as_u64() != Some(protocol::VERSION) {
            Err("Native protocol mismatch".into())
        } else if !req["params"].is_object() || !req["id"].is_string() {
            Err("A valid request ID and params object are required".into())
        } else if !negotiated && !matches!(method, "handshake" | "releaseKeys" | "releaseAll") {
            Err("Native protocol handshake is required".into())
        } else {
            dispatch(method, &req["params"], &mut recording)
        };
        if method == "handshake" && result.is_ok() {
            negotiated = true;
        }
        emit(match result {
            Ok(value) => json!({"id":id,"protocolVersion":protocol::VERSION,"result":value}),
            Err(message) => {
                json!({"id":id,"protocolVersion":protocol::VERSION,"error":protocol::error_for(method,message,&req["params"])})
            }
        });
    }
    let _ = recording.stop();
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    platform::shutdown();
    if INPUT_USED.load(Ordering::SeqCst) {
        let _ = release_owned();
    }
}
