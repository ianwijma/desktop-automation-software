//! Direct in-process bridge to public macOS frameworks; no shell/title scripts.
use super::*;
use std::ffi::{c_char, CStr, CString};
extern "C" {
    fn relay_macos_call(method: *const c_char, params: *const c_char) -> *mut c_char;
    fn relay_macos_free(value: *mut c_char);
}
fn call(method: &str, params: &Value) -> Result<Value> {
    let method = CString::new(method).map_err(|_| "macos:INVALID_REQUEST")?;
    let params = CString::new(params.to_string()).map_err(|_| "macos:INVALID_REQUEST")?;
    let pointer = unsafe { relay_macos_call(method.as_ptr(), params.as_ptr()) };
    if pointer.is_null() {
        return Err("macos:BACKEND_FAILURE".into());
    }
    let text = unsafe { CStr::from_ptr(pointer) }
        .to_string_lossy()
        .into_owned();
    unsafe {
        relay_macos_free(pointer);
    }
    let reply: Value = serde_json::from_str(&text).map_err(|_| "macos:BACKEND_FAILURE")?;
    if let Some(code) = reply["error"].as_str() {
        return Err(format!("macos:{code}"));
    }
    reply
        .get("result")
        .cloned()
        .ok_or_else(|| "macos:BACKEND_FAILURE".into())
}
pub fn windows() -> Result<Value> {
    call("listWindows", &json!({}))
}
pub fn capabilities() -> Result<Value> {
    call("capabilities", &json!({}))
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
pub fn release_keys(p: &Value) -> Result<Value> {
    call("releaseKeys", p)
}
pub fn release_all() -> Result<Value> {
    call("releaseAll", &json!({}))
}
pub fn release_capture() -> Result<Value> {
    call("releaseCapture", &json!({}))
}
pub fn shutdown() {
    let _ = release_capture();
}
pub fn record(_: Value, _: Arc<AtomicBool>) -> Result<thread::JoinHandle<()>> {
    Err("macOS direct recording is unavailable; use guided recording".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn framework_contract_selftest_without_permissions_or_input() {
        assert_eq!(call("selftest", &json!({})).unwrap(), json!(true));
    }
}
