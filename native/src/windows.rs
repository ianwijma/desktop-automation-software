use super::*;
fn call(method: &str, p: &Value) -> Result<Value> {
    let mut child = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            include_str!("windows.ps1"),
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    if let Some(mut stdin) = child.stdin.take() {
        write!(stdin, "{}", json!({"method":method,"params":p})).map_err(|e| e.to_string())?;
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    serde_json::from_slice(&out.stdout).map_err(|e| format!("Native Windows response: {e}"))
}
pub fn capabilities() -> Result<Value> {
    Ok(
        json!({"platform":"win32","session":"desktop","capture":true,"input":true,"accessibility":false,"directRecording":false,"globalShortcuts":true,"windows":windows().unwrap_or(json!([])),"reasons":["Direct global recording is not implemented on Windows; use guided recording.","Capture uses PrintWindow; protected or GPU-rendered windows may not produce usable frames. Native input requires an unlocked desktop and matching privilege level."]}),
    )
}
pub fn windows() -> Result<Value> {
    call("listWindows", &json!({}))
}
pub fn capture(p: &Value) -> Result<Value> {
    call("capture", p)
}
pub fn focus(p: &Value) -> Result<Value> {
    call("focus", p)
}
pub fn input(p: &Value) -> Result<Value> {
    call("input", p)
}
pub fn close(p: &Value) -> Result<Value> {
    call("close", p)
}
pub fn release_all() -> Result<Value> {
    call("releaseAll", &json!({}))
}
pub fn record(_: Value, _: Arc<AtomicBool>) -> Result<()> {
    Err("Windows direct recording is unavailable; use guided recording".into())
}

pub fn release_keys(p: &Value) -> Result<Value> {
    if let Some(keys) = p["keys"].as_array() {
        for key in keys.iter().filter_map(Value::as_str) {
            let _ = call(
                "input",
                &json!({"windowId":"0","kind":"key","key":key,"action":"up"}),
            );
        }
    }
    Ok(json!(true))
}
