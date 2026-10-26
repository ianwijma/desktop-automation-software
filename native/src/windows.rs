//! Persistent Win32 backend. No per-request shells or child processes.
use super::*;
use std::{
    mem::{size_of, size_of_val},
    ptr::null_mut,
    sync::OnceLock,
};
use windows_sys::Win32::{
    Foundation::*,
    Graphics::{Dwm::*, Gdi::*},
    Security::*,
    System::{StationsAndDesktops::*, Threading::*},
    UI::{HiDpi::*, WindowsAndMessaging::*},
};
mod capture;
mod input;
pub mod uia;
const WGC: &str = "win32-wgc";
const PRINT: &str = "win32-printwindow";
pub fn initialize() -> Result<()> {
    static READY: OnceLock<Result<()>> = OnceLock::new();
    READY
        .get_or_init(|| unsafe {
            if SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) == 0
                && AreDpiAwarenessContextsEqual(
                    GetThreadDpiAwarenessContext(),
                    DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
                ) == 0
            {
                return Err(fail("DPI_UNAVAILABLE"));
            }
            ::windows::Win32::System::WinRT::RoInitialize(
                ::windows::Win32::System::WinRT::RO_INIT_MULTITHREADED,
            )
            .map_err(|_| fail("CAPTURE_UNAVAILABLE"))?;
            Ok(())
        })
        .clone()
}
fn fail(code: &str) -> String {
    format!("win32:{code}")
}
struct Handle(HANDLE);
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}
fn desktop_ready() -> bool {
    unsafe {
        let desktop = OpenInputDesktop(0, 0, DESKTOP_READOBJECTS);
        if desktop.is_null() {
            return false;
        }
        fn name(handle: HDESK) -> Option<Vec<u16>> {
            unsafe {
                let mut used = 0;
                let mut text = [0u16; 256];
                if GetUserObjectInformationW(
                    handle,
                    UOI_NAME,
                    text.as_mut_ptr().cast(),
                    size_of_val(&text) as u32,
                    &mut used,
                ) == 0
                {
                    return None;
                }
                Some(text.into_iter().take_while(|c| *c != 0).collect())
            }
        }
        let input = name(desktop);
        let own = name(GetThreadDesktop(GetCurrentThreadId()));
        CloseDesktop(desktop);
        input.is_some() && input == own
    }
}
fn hwnd(p: &Value) -> Result<HWND> {
    let value = str_field(p, "windowId")
        .parse::<usize>()
        .map_err(|_| fail("TARGET_UNAVAILABLE"))?;
    let handle = value as HWND;
    if value == 0 || unsafe { IsWindow(handle) } == 0 {
        return Err(fail("TARGET_UNAVAILABLE"));
    }
    Ok(handle)
}
fn pid(window: HWND) -> Result<u32> {
    let mut value = 0;
    if unsafe { GetWindowThreadProcessId(window, &mut value) } == 0 || value == 0 {
        return Err(fail("TARGET_UNAVAILABLE"));
    }
    Ok(value)
}
fn rect(window: HWND) -> Result<RECT> {
    let mut value = RECT::default();
    if unsafe { GetWindowRect(window, &mut value) } == 0
        || value.right <= value.left
        || value.bottom <= value.top
    {
        return Err(fail("TARGET_UNAVAILABLE"));
    }
    Ok(value)
}
fn visible_rect(window: HWND) -> Result<RECT> {
    let mut value = RECT::default();
    if unsafe {
        DwmGetWindowAttribute(
            window,
            DWMWA_EXTENDED_FRAME_BOUNDS as u32,
            (&mut value as *mut RECT).cast(),
            size_of::<RECT>() as u32,
        )
    } < 0
        || value.right <= value.left
        || value.bottom <= value.top
    {
        return Err(fail("CAPTURE_GEOMETRY"));
    }
    Ok(value)
}
fn bounds(r: RECT) -> Value {
    json!({"x":r.left,"y":r.top,"width":r.right-r.left,"height":r.bottom-r.top})
}
fn same_rect(a: RECT, b: RECT) -> bool {
    a.left == b.left && a.top == b.top && a.right == b.right && a.bottom == b.bottom
}
fn available_window(window: HWND) -> Result<()> {
    if !desktop_ready() {
        return Err(fail("DESKTOP_UNAVAILABLE"));
    }
    if unsafe { IsWindow(window) } == 0 {
        return Err(fail("TARGET_UNAVAILABLE"));
    }
    let mut cloaked = 0u32;
    let result = unsafe {
        DwmGetWindowAttribute(
            window,
            DWMWA_CLOAKED as u32,
            (&mut cloaked as *mut u32).cast(),
            size_of::<u32>() as u32,
        )
    };
    if unsafe { IsIconic(window) } != 0
        || unsafe { IsWindowVisible(window) } == 0
        || (result >= 0 && cloaked != 0)
    {
        return Err(fail("CAPTURE_LOST"));
    }
    Ok(())
}
fn integrity(process: HANDLE) -> Result<u32> {
    unsafe {
        let mut token = null_mut();
        if OpenProcessToken(process, TOKEN_QUERY, &mut token) == 0 {
            return Err(fail("PRIVILEGE_UNKNOWN"));
        }
        let token = Handle(token);
        let mut length = 0;
        GetTokenInformation(token.0, TokenIntegrityLevel, null_mut(), 0, &mut length);
        if length < size_of::<TOKEN_MANDATORY_LABEL>() as u32 || length > 65536 {
            return Err(fail("PRIVILEGE_UNKNOWN"));
        }
        let mut buffer = vec![0usize; (length as usize).div_ceil(size_of::<usize>())];
        if GetTokenInformation(
            token.0,
            TokenIntegrityLevel,
            buffer.as_mut_ptr().cast(),
            length,
            &mut length,
        ) == 0
        {
            return Err(fail("PRIVILEGE_UNKNOWN"));
        }
        let label = &*(buffer.as_ptr().cast::<TOKEN_MANDATORY_LABEL>());
        let count = GetSidSubAuthorityCount(label.Label.Sid);
        if count.is_null() || *count == 0 {
            return Err(fail("PRIVILEGE_UNKNOWN"));
        }
        let rid = GetSidSubAuthority(label.Label.Sid, u32::from(*count) - 1);
        if rid.is_null() {
            return Err(fail("PRIVILEGE_UNKNOWN"));
        }
        Ok(*rid)
    }
}
fn check_privilege(window: HWND) -> Result<()> {
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid(window)?);
        if process.is_null() {
            return Err(fail("PRIVILEGE_UNKNOWN"));
        }
        let process = Handle(process);
        if integrity(process.0)? > integrity(GetCurrentProcess())? {
            return Err(fail("ELEVATED_TARGET"));
        }
        Ok(())
    }
}
unsafe extern "system" fn enumerate(window: HWND, parameter: LPARAM) -> i32 {
    if IsWindowVisible(window) == 0 {
        return 1;
    }
    let count = GetWindowTextLengthW(window);
    if count <= 0 || count > 32767 {
        return 1;
    }
    let mut title = vec![0u16; count as usize + 1];
    let count = GetWindowTextW(window, title.as_mut_ptr(), title.len() as i32);
    if count <= 0 {
        return 1;
    }
    if let (Ok(r), Ok(owner)) = (rect(window), pid(window)) {
        let mut application = String::new();
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, owner);
        if !process.is_null() {
            let process = Handle(process);
            let mut path = vec![0u16; 32768];
            let mut length = path.len() as u32;
            if QueryFullProcessImageNameW(process.0, 0, path.as_mut_ptr(), &mut length) != 0 {
                application =
                    std::path::Path::new(&String::from_utf16_lossy(&path[..length as usize]))
                        .file_stem()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or_default();
            }
        }
        let dpi = GetDpiForWindow(window);
        if dpi == 0 {
            return 1;
        }
        (&mut *(parameter as *mut Vec<Value>)).push(json!({"id":(window as usize).to_string(),"title":String::from_utf16_lossy(&title[..count as usize]),"application":application,"pid":owner,"bounds":bounds(r),"dpi":dpi,"applicationIdentity":{"id":owner.to_string(),"kind":"pid-only","pid":owner}}));
    }
    1
}
pub fn windows() -> Result<Value> {
    initialize()?;
    let mut values = Vec::<Value>::new();
    if unsafe { EnumWindows(Some(enumerate), (&mut values as *mut Vec<Value>) as LPARAM) } == 0 {
        return Err(fail("ENUMERATION_FAILED"));
    }
    Ok(json!(values))
}
pub fn capabilities() -> Result<Value> {
    let initialized = initialize().is_ok();
    let desktop = initialized && desktop_ready();
    let graphics = initialized
        && windows_capture::graphics_capture_api::GraphicsCaptureApi::is_supported()
            .unwrap_or(false)
        && windows_capture::d3d11::create_d3d_device().is_ok();
    Ok(
        json!({"platform":"win32","session":"desktop","capture":desktop&&graphics,"input":desktop,"accessibility":desktop,"directRecording":false,"globalShortcuts":true,"windows":if initialized{windows().unwrap_or(json!([]))}else{json!([])},"reasons":["Choose a Windows capture method for each target. Failed Windows Graphics Capture never falls back to PrintWindow automatically.","Input requires an unlocked interactive desktop and equal or lower target integrity. Partial/rejected SendInput is an error; its return value cannot identify UIPI blocking.","Native controls, GPU applications and display scales need qualification. Direct recording remains unavailable (N08)."],"windowsBackend":{"graphicsCaptureSupported":graphics,"interactiveDesktop":desktop,"perMonitorV2":initialized,"captureLibraryVersion":"windows-capture 2.0.1"}}),
    )
}
pub fn focus(p: &Value) -> Result<Value> {
    initialize()?;
    let window = hwnd(p)?;
    if !desktop_ready() {
        return Err(fail("DESKTOP_UNAVAILABLE"));
    }
    check_privilege(window)?;
    unsafe {
        if IsIconic(window) != 0 {
            ShowWindow(window, SW_RESTORE);
        }
        if GetForegroundWindow() != window {
            SetForegroundWindow(window);
        }
    }
    for _ in 0..20 {
        if unsafe { GetForegroundWindow() } == window {
            return Ok(json!(true));
        }
        thread::sleep(Duration::from_millis(10));
    }
    Err(fail("FOCUS_FAILED"))
}
pub fn capture(p: &Value) -> Result<Value> {
    initialize()?;
    let window = hwnd(p)?;
    if let Err(error) = available_window(window) {
        let _ = capture::stop();
        return Err(error);
    }
    let result = match str_field(p, "captureBackend") {
        "wgc" => capture::graphics(window),
        "printwindow" => {
            capture::stop()?;
            capture::print_window(window)
        }
        _ => Err(fail("BACKEND_REQUIRED")),
    };
    let mut value = match result {
        Ok(value) => value,
        Err(error) => {
            let _ = capture::stop();
            return Err(error);
        }
    };
    value["dpi"] = json!(unsafe { GetDpiForWindow(window) });
    Ok(value)
}
pub fn input(p: &Value) -> Result<Value> {
    initialize()?;
    input::execute(p)
}
pub fn close(p: &Value) -> Result<Value> {
    initialize()?;
    if !desktop_ready() {
        return Err(fail("DESKTOP_UNAVAILABLE"));
    }
    let window = hwnd(p)?;
    check_privilege(window)?;
    if unsafe { PostMessageW(window, WM_CLOSE, 0, 0) } == 0 {
        return Err(fail("CLOSE_FAILED"));
    }
    capture::stop()?;
    Ok(json!(true))
}
pub fn release_all() -> Result<Value> {
    let result = input::release_all();
    let stopped = capture::stop();
    result?;
    stopped?;
    Ok(json!(true))
}
pub fn release_keys(p: &Value) -> Result<Value> {
    input::release_keys(p)?;
    Ok(json!(true))
}
pub fn release_capture() -> Result<Value> {
    capture::stop()?;
    Ok(json!(true))
}
pub fn shutdown() {
    let _ = capture::stop();
}
pub fn record(_: Value, _: Arc<AtomicBool>) -> Result<thread::JoinHandle<()>> {
    Err("Windows direct recording is unavailable; use guided recording".into())
}
