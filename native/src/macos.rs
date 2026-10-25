use super::*;
use std::{
    ffi::{c_void, CStr},
    ptr,
};
type CF = *const c_void;
#[repr(C)]
#[derive(Clone, Copy)]
struct Point {
    x: f64,
    y: f64,
}
#[repr(C)]
#[derive(Clone, Copy)]
struct Size {
    width: f64,
    height: f64,
}
#[repr(C)]
struct Rect {
    origin: Point,
    size: Size,
}
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFArrayGetCount(a: CF) -> isize;
    fn CFArrayGetValueAtIndex(a: CF, i: isize) -> CF;
    fn CFDictionaryGetValue(d: CF, key: CF) -> CF;
    fn CFNumberGetValue(n: CF, kind: isize, out: *mut i64) -> bool;
    fn CFStringGetCString(s: CF, out: *mut i8, size: isize, encoding: u32) -> bool;
    fn CFRelease(v: CF);
}
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGWindowListCopyWindowInfo(options: u32, id: u32) -> CF;
    fn CGRectMakeWithDictionaryRepresentation(d: CF, r: *mut Rect) -> bool;
    static kCGWindowNumber: CF;
    static kCGWindowName: CF;
    static kCGWindowOwnerName: CF;
    static kCGWindowOwnerPID: CF;
    static kCGWindowBounds: CF;
    static kCGWindowLayer: CF;
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGEventCreate(source: CF) -> CF;
    fn CGEventGetLocation(event: CF) -> Point;
    fn CGEventCreateMouseEvent(source: CF, t: u32, p: Point, b: u32) -> CF;
    fn CGEventSetIntegerValueField(event: CF, field: u32, value: i64);
    fn CGEventPost(tap: u32, event: CF);
    fn CGEventCreateKeyboardEvent(source: CF, key: u16, down: bool) -> CF;
    fn CGEventKeyboardSetUnicodeString(event: CF, len: usize, text: *const u16);
    fn CGEventCreateScrollWheelEvent(source: CF, units: u32, count: u32, ...) -> CF;
}
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
}
unsafe fn text(d: CF, key: CF) -> String {
    let v = CFDictionaryGetValue(d, key);
    if v.is_null() {
        return String::new();
    }
    let mut buffer = [0i8; 4096];
    if CFStringGetCString(v, buffer.as_mut_ptr(), 4096, 0x08000100) {
        CStr::from_ptr(buffer.as_ptr())
            .to_string_lossy()
            .into_owned()
    } else {
        String::new()
    }
}
unsafe fn integer(d: CF, key: CF) -> i64 {
    let v = CFDictionaryGetValue(d, key);
    let mut n = 0;
    if !v.is_null() {
        CFNumberGetValue(v, 4, &mut n);
    }
    n
}
pub fn windows() -> Result<Value> {
    unsafe {
        let list = CGWindowListCopyWindowInfo(1 | 16, 0);
        if list.is_null() {
            return Err("Window list unavailable; grant Screen Recording permission".into());
        }
        let mut result = vec![];
        for i in 0..CFArrayGetCount(list) {
            let d = CFArrayGetValueAtIndex(list, i);
            if integer(d, kCGWindowLayer) != 0 {
                continue;
            }
            let mut r = Rect {
                origin: Point { x: 0., y: 0. },
                size: Size {
                    width: 0.,
                    height: 0.,
                },
            };
            let b = CFDictionaryGetValue(d, kCGWindowBounds);
            if !b.is_null() && CGRectMakeWithDictionaryRepresentation(b, &mut r) {
                let title = text(d, kCGWindowName);
                if r.size.width < 20. || r.size.height < 20. {
                    continue;
                }
                result.push(json!({"id":integer(d,kCGWindowNumber).to_string(),"pid":integer(d,kCGWindowOwnerPID),"title":title,"application":text(d,kCGWindowOwnerName),"bounds":{"x":r.origin.x,"y":r.origin.y,"width":r.size.width,"height":r.size.height}}));
            }
        }
        CFRelease(list);
        Ok(json!(result))
    }
}
fn window(p: &Value) -> Result<Value> {
    let id = str_field(p, "windowId");
    windows()?
        .as_array()
        .and_then(|a| a.iter().find(|w| w["id"] == id))
        .cloned()
        .ok_or("Target window is no longer available".into())
}
pub fn capabilities() -> Result<Value> {
    unsafe {
        Ok(
            json!({"platform":"darwin","session":"desktop","capture":CGPreflightScreenCaptureAccess(),"input":AXIsProcessTrusted(),"accessibility":false,"directRecording":false,"globalShortcuts":true,"windows":windows().unwrap_or(json!([])),"reasons":["Enable Screen Recording and Accessibility for Relay in System Settings > Privacy & Security.","Direct global recording is not implemented on macOS; use guided recording."]}),
        )
    }
}
pub fn capture(p: &Value) -> Result<Value> {
    if !unsafe { CGPreflightScreenCaptureAccess() } {
        return Err("Screen Recording permission is required".into());
    }
    let w = window(p)?;
    let path = std::env::temp_dir().join(format!(
        "relay-capture-{}-{}.png",
        std::process::id(),
        now()
    ));
    run(
        "/usr/sbin/screencapture",
        &[
            "-x",
            "-l",
            str_field(p, "windowId"),
            "-t",
            "png",
            path.to_str().unwrap(),
        ],
    )?;
    capture_file(&path, w["bounds"].clone())
}
pub fn focus(p: &Value) -> Result<Value> {
    let w = window(p)?;
    let title = str_field(&w, "title");
    if title.is_empty() {
        return Err("The target window title is unavailable; grant Screen Recording and Accessibility permission".into());
    }
    run("/usr/bin/osascript",&["-e","on run argv\ntell application \"System Events\"\ntell first application process whose unix id is (item 1 of argv as integer)\nset frontmost to true\nset candidates to every window whose name is item 2 of argv\nif (count of candidates) is not 1 then error \"Target window is missing or ambiguous\"\nperform action \"AXRaise\" of item 1 of candidates\nend tell\nend tell\nend run",&w["pid"].to_string(),title])?;
    thread::sleep(Duration::from_millis(100));
    if windows()?
        .as_array()
        .and_then(|windows| windows.first())
        .map(|window| window["id"] != w["id"])
        .unwrap_or(true)
    {
        return Err("The target window could not be brought to the foreground".into());
    }
    Ok(json!(true))
}
unsafe fn post(e: CF) -> Result<()> {
    if e.is_null() {
        return Err("Could not create input event".into());
    }
    CGEventPost(0, e);
    CFRelease(e);
    Ok(())
}
fn keycode(key: &str) -> Option<u16> {
    Some(match key.to_ascii_lowercase().as_str() {
        "a" => 0,
        "s" => 1,
        "d" => 2,
        "f" => 3,
        "h" => 4,
        "g" => 5,
        "z" => 6,
        "x" => 7,
        "c" => 8,
        "v" => 9,
        "b" => 11,
        "q" => 12,
        "w" => 13,
        "e" => 14,
        "r" => 15,
        "y" => 16,
        "t" => 17,
        "1" => 18,
        "2" => 19,
        "3" => 20,
        "4" => 21,
        "6" => 22,
        "5" => 23,
        "9" => 25,
        "7" => 26,
        "8" => 28,
        "0" => 29,
        "o" => 31,
        "u" => 32,
        "i" => 34,
        "p" => 35,
        "enter" | "return" => 36,
        "l" => 37,
        "j" => 38,
        "k" => 40,
        "n" => 45,
        "m" => 46,
        "tab" => 48,
        "space" => 49,
        "backspace" => 51,
        "escape" | "esc" => 53,
        "super" | "super_l" | "meta" | "command" => 55,
        "shift" | "shift_l" => 56,
        "alt" | "alt_l" | "option" => 58,
        "ctrl" | "control" | "control_l" => 59,
        "home" => 115,
        "pageup" => 116,
        "delete" => 117,
        "end" => 119,
        "pagedown" => 121,
        "left" => 123,
        "right" => 124,
        "down" => 125,
        "up" => 126,
        _ => return None,
    })
}
fn point(p: &Value, b: &Value, x: &str, y: &str) -> Result<Point> {
    let px = num(p, x, 0.);
    let py = num(p, y, 0.);
    if px < 0. || py < 0. || px >= num(b, "width", 0.) || py >= num(b, "height", 0.) {
        return Err("Coordinates outside target window".into());
    }
    Ok(Point {
        x: num(b, "x", 0.) + px,
        y: num(b, "y", 0.) + py,
    })
}
pub fn input(p: &Value) -> Result<Value> {
    if !unsafe { AXIsProcessTrusted() } {
        return Err("Accessibility permission is required".into());
    }
    let w = window(p)?;
    focus(p)?;
    let b = &w["bounds"];
    let button = match str_field(p, "button") {
        "right" => 1,
        "middle" => 2,
        _ => 0,
    };
    let down = if button == 0 {
        1
    } else if button == 1 {
        3
    } else {
        25
    };
    let up = down + 1;
    let kind = str_field(p, "kind");
    unsafe {
        match kind {
            "move" | "click" | "drag" => {
                let start = point(p, b, "x", "y")?;
                post(CGEventCreateMouseEvent(ptr::null(), 5, start, button))?;
                if kind == "click" {
                    for count in 1..=(num(p, "clickCount", 1.).clamp(1., 3.) as i64) {
                        for event_type in [down, up] {
                            let event =
                                CGEventCreateMouseEvent(ptr::null(), event_type, start, button);
                            if event.is_null() {
                                return Err("Mouse event unavailable".into());
                            }
                            CGEventSetIntegerValueField(event, 1, count);
                            post(event)?;
                        }
                        thread::sleep(Duration::from_millis(70));
                    }
                }
                if kind == "drag" {
                    let end = point(p, b, "toX", "toY")?;
                    post(CGEventCreateMouseEvent(ptr::null(), down, start, button))?;
                    for i in 1..=20 {
                        let pt = Point {
                            x: start.x + (end.x - start.x) * i as f64 / 20.,
                            y: start.y + (end.y - start.y) * i as f64 / 20.,
                        };
                        post(CGEventCreateMouseEvent(
                            ptr::null(),
                            if button == 0 {
                                6
                            } else if button == 1 {
                                7
                            } else {
                                27
                            },
                            pt,
                            button,
                        ))?;
                        thread::sleep(Duration::from_millis(15));
                    }
                    post(CGEventCreateMouseEvent(ptr::null(), up, end, button))?;
                }
            }
            "type" => {
                for character in str_field(p, "text").chars() {
                    let mut buffer = [0u16; 2];
                    let chunk = character.encode_utf16(&mut buffer);
                    for down in [true, false] {
                        let event = CGEventCreateKeyboardEvent(ptr::null(), 0, down);
                        if event.is_null() {
                            return Err("Keyboard event unavailable".into());
                        }
                        CGEventKeyboardSetUnicodeString(event, chunk.len(), chunk.as_ptr());
                        post(event)?;
                    }
                }
            }
            "key" => {
                let keys: Vec<u16> = str_field(p, "key")
                    .split('+')
                    .map(|k| keycode(k).ok_or(format!("Unsupported key: {k}")))
                    .collect::<Result<_>>()?;
                if str_field(p, "action") != "up" {
                    for k in &keys {
                        post(CGEventCreateKeyboardEvent(ptr::null(), *k, true))?;
                    }
                }
                if str_field(p, "action") != "down" {
                    if str_field(p, "action") != "up" {
                        thread::sleep(Duration::from_millis(
                            num(p, "durationMs", 0.).clamp(0., 120000.) as u64,
                        ));
                    }
                    for k in keys.iter().rev() {
                        post(CGEventCreateKeyboardEvent(ptr::null(), *k, false))?;
                    }
                }
            }
            "scroll" => {
                post(CGEventCreateScrollWheelEvent(
                    ptr::null(),
                    0,
                    2,
                    -num(p, "deltaY", 0.) as i32,
                    -num(p, "deltaX", 0.) as i32,
                ))?;
            }
            _ => return Err(format!("Unsupported native input: {kind}")),
        }
    }
    Ok(json!(true))
}
pub fn close(p: &Value) -> Result<Value> {
    let mut p = p.clone();
    p["kind"] = json!("key");
    p["key"] = json!("Command+w");
    input(&p)
}
pub fn release_all() -> Result<Value> {
    if unsafe { AXIsProcessTrusted() } {
        unsafe {
            for k in [55, 56, 58, 59, 60, 61, 62] {
                let _ = post(CGEventCreateKeyboardEvent(ptr::null(), k, false));
            }
            let event = CGEventCreate(ptr::null());
            if !event.is_null() {
                let location = CGEventGetLocation(event);
                CFRelease(event);
                for (button, event_type) in [(0, 2), (1, 4), (2, 26)] {
                    let _ = post(CGEventCreateMouseEvent(
                        ptr::null(),
                        event_type,
                        location,
                        button,
                    ));
                }
            }
        }
    }
    Ok(json!(true))
}
pub fn record(_: Value, _: Arc<AtomicBool>) -> Result<thread::JoinHandle<()>> {
    Err("macOS direct recording is unavailable; use guided recording".into())
}

pub fn release_keys(p: &Value) -> Result<Value> {
    if unsafe { AXIsProcessTrusted() } {
        if let Some(keys) = p["keys"].as_array() {
            for item in keys.iter().filter_map(Value::as_str) {
                for name in item.split('+') {
                    if let Some(code) = keycode(name) {
                        unsafe {
                            let _ = post(CGEventCreateKeyboardEvent(ptr::null(), code, false));
                        }
                    }
                }
            }
        }
    }
    Ok(json!(true))
}
