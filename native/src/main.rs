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
#[cfg(target_os = "linux")]
mod wayland;
#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "linux")]
use linux as platform;
#[cfg(target_os = "macos")]
use macos as platform;
#[cfg(target_os = "windows")]
use windows as platform;
static HELD_KEYS: std::sync::OnceLock<Mutex<std::collections::HashSet<String>>> =
    std::sync::OnceLock::new();
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
pub fn emit(value: Value) {
    let mut out = io::stdout().lock();
    let _ = writeln!(out, "{}", value);
    let _ = out.flush();
}
fn dispatch(method: &str, p: &Value, recording: &mut Arc<AtomicBool>) -> Result<Value> {
    match method {
        "capabilities" => platform::capabilities(),
        "listWindows" => platform::windows(),
        "capture" => platform::capture(p),
        "focus" => platform::focus(p),
        "input" => {
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
            if recording.load(Ordering::SeqCst) {
                return Err("Recording is already active".into());
            }
            *recording = Arc::new(AtomicBool::new(true));
            match platform::record(p.clone(), recording.clone()) {
                Ok(()) => Ok(json!(true)),
                Err(e) => {
                    recording.store(false, Ordering::SeqCst);
                    Err(e)
                }
            }
        }
        "stopRecording" => {
            recording.store(false, Ordering::SeqCst);
            Ok(json!(true))
        }
        "ping" => Ok(json!(true)),
        _ => Err(format!("Unsupported native method: {method}")),
    }
}
fn main() {
    let mut recording = Arc::new(AtomicBool::new(false));
    // Commands are processed serially: desktop input is a single shared resource.
    for line in io::stdin().lock().lines() {
        let line = match line {
            Ok(s) => s,
            Err(_) => break,
        };
        let req: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                emit(json!({"id":null,"error":{"message":e.to_string()}}));
                continue;
            }
        };
        let id = req["id"].clone();
        let result = dispatch(str_field(&req, "method"), &req["params"], &mut recording);
        emit(match result {
            Ok(value) => json!({"id":id,"result":value}),
            Err(message) => json!({"id":id,"error":{"message":message}}),
        });
    }
    recording.store(false, Ordering::SeqCst);
    let _ = release_owned();
}
