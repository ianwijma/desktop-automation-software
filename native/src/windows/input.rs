use super::*;
use crate::windows_contract::{absolute, chord, local_point, Key};
use std::collections::HashSet;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::*;
#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
struct KeyState {
    vk: u16,
    scan: u16,
    flags: u32,
}
#[derive(Default)]
struct Owned {
    keys: HashSet<KeyState>,
    buttons: HashSet<u32>,
}
static OWNED: OnceLock<Mutex<Owned>> = OnceLock::new();
fn owned() -> &'static Mutex<Owned> {
    OWNED.get_or_init(|| Mutex::new(Owned::default()))
}
fn keyboard(key: KeyState, up: bool) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: key.vk,
                wScan: key.scan,
                dwFlags: key.flags | if up { KEYEVENTF_KEYUP } else { 0 },
                time: 0,
                dwExtraInfo: 0x52454c4159,
            },
        },
    }
}
fn key(value: Key) -> KeyState {
    KeyState {
        vk: value.vk,
        scan: 0,
        flags: if value.extended {
            KEYEVENTF_EXTENDEDKEY
        } else {
            0
        },
    }
}
fn mouse(flags: u32, data: u32, x: i32, y: i32) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx: x,
                dy: y,
                mouseData: data,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0x52454c4159,
            },
        },
    }
}
fn update(state: &mut Owned, event: &INPUT, before: bool) {
    unsafe {
        if event.r#type == INPUT_KEYBOARD {
            let k = event.Anonymous.ki;
            let value = KeyState {
                vk: k.wVk,
                scan: k.wScan,
                flags: k.dwFlags & !KEYEVENTF_KEYUP,
            };
            if k.dwFlags & KEYEVENTF_KEYUP == 0 {
                if before {
                    state.keys.insert(value);
                }
            } else if !before {
                state.keys.remove(&value);
            }
        } else if event.r#type == INPUT_MOUSE {
            let flags = event.Anonymous.mi.dwFlags;
            for (down, up) in [
                (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
                (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
                (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
            ] {
                if before && flags & down != 0 {
                    state.buttons.insert(up);
                }
                if !before && flags & up != 0 {
                    state.buttons.remove(&up);
                }
            }
        }
    }
}
fn inject_with(
    state: &mut Owned,
    events: &[INPUT],
    emit: impl FnOnce(&[INPUT]) -> usize,
) -> Result<()> {
    for event in events {
        update(state, event, true);
    }
    let count = emit(events);
    for event in events.iter().take(count.min(events.len())) {
        update(state, event, false);
    }
    if count != events.len() {
        return Err(fail("INPUT_REJECTED"));
    }
    Ok(())
}
fn send(events: &[INPUT]) -> Result<()> {
    if events.is_empty() {
        return Ok(());
    }
    let mut state = owned().lock().map_err(|_| fail("INPUT_REJECTED"))?;
    inject_with(&mut state, events, |events| unsafe {
        SendInput(
            events.len() as u32,
            events.as_ptr(),
            size_of::<INPUT>() as i32,
        )
    } as usize)
}

fn guard(window: HWND, owner: u32, original: RECT) -> Result<()> {
    available_window(window)?;
    if pid(window)? != owner {
        return Err(fail("TARGET_UNAVAILABLE"));
    }
    if !same_rect(original, rect(window)?) {
        return Err(fail("CAPTURE_GEOMETRY"));
    }
    if unsafe { GetForegroundWindow() } != window {
        return Err(fail("FOCUS_FAILED"));
    }
    Ok(())
}
fn point(p: &Value, window: HWND, xkey: &str, ykey: &str, original: RECT) -> Result<INPUT> {
    let x = local_point(num(p, xkey, f64::NAN), original.right - original.left)
        .map_err(|_| fail("INVALID_COORDINATES"))?;
    let y = local_point(num(p, ykey, f64::NAN), original.bottom - original.top)
        .map_err(|_| fail("INVALID_COORDINATES"))?;
    let sx = original
        .left
        .checked_add(x)
        .ok_or_else(|| fail("INVALID_COORDINATES"))?;
    let sy = original
        .top
        .checked_add(y)
        .ok_or_else(|| fail("INVALID_COORDINATES"))?;
    let hit = unsafe { WindowFromPoint(POINT { x: sx, y: sy }) };
    if hit.is_null() || unsafe { GetAncestor(hit, GA_ROOT) } != window {
        return Err(fail("TARGET_OBSCURED"));
    }
    let dx = absolute(sx, unsafe { GetSystemMetrics(SM_XVIRTUALSCREEN) }, unsafe {
        GetSystemMetrics(SM_CXVIRTUALSCREEN)
    })
    .map_err(|_| fail("INVALID_COORDINATES"))?;
    let dy = absolute(sy, unsafe { GetSystemMetrics(SM_YVIRTUALSCREEN) }, unsafe {
        GetSystemMetrics(SM_CYVIRTUALSCREEN)
    })
    .map_err(|_| fail("INVALID_COORDINATES"))?;
    Ok(mouse(
        MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
        0,
        dx,
        dy,
    ))
}
fn check_unowned(keys: &[KeyState]) -> Result<()> {
    let state = owned().lock().map_err(|_| fail("INPUT_REJECTED"))?;
    if keys.iter().any(|k| {
        k.vk != 0 && unsafe { GetAsyncKeyState(i32::from(k.vk)) } < 0 && !state.keys.contains(k)
    }) {
        return Err(fail("INPUT_BUSY"));
    }
    Ok(())
}
pub fn execute(p: &Value) -> Result<Value> {
    let kind = str_field(p, "kind");
    let action = str_field(p, "action");
    if kind == "key" && action == "up" {
        let keys = chord(str_field(p, "key")).map_err(|_| fail("UNSUPPORTED_KEY"))?;
        send(
            &keys
                .into_iter()
                .rev()
                .map(|k| keyboard(key(k), true))
                .collect::<Vec<_>>(),
        )?;
        return Ok(json!(true));
    }
    let keys = if kind == "key" {
        chord(str_field(p, "key"))
            .map_err(|_| fail("UNSUPPORTED_KEY"))?
            .into_iter()
            .map(key)
            .collect::<Vec<_>>()
    } else {
        vec![]
    };
    if !["click", "move", "drag", "scroll", "type", "key"].contains(&kind) {
        return Err("Unsupported native input".into());
    }
    let modifiers = [0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0x5b, 0x5c].map(|vk| KeyState {
        vk,
        scan: 0,
        flags: if [0xa3, 0xa5, 0x5b, 0x5c].contains(&vk) {
            KEYEVENTF_EXTENDEDKEY
        } else {
            0
        },
    });
    check_unowned(&modifiers)?;
    let window = hwnd(p)?;
    super::focus(p)?;
    available_window(window)?;
    let owner = pid(window)?;
    let original = rect(window)?;
    guard(window, owner, original)?;
    let (down, up) = match str_field(p, "button") {
        "right" => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
        "middle" => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
        _ => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
    };
    let result = (|| {
        match kind {
            "click" | "move" | "drag" => {
                if kind != "move" {
                    let vk = match str_field(p, "button") {
                        "right" => VK_RBUTTON,
                        "middle" => VK_MBUTTON,
                        _ => VK_LBUTTON,
                    };
                    if unsafe { GetAsyncKeyState(i32::from(vk)) } < 0
                        && !owned()
                            .lock()
                            .map_err(|_| fail("INPUT_REJECTED"))?
                            .buttons
                            .contains(&up)
                    {
                        return Err(fail("INPUT_BUSY"));
                    }
                }
                let start = point(p, window, "x", "y", original)?;
                // Validate both drag endpoints before pressing any button.
                if kind == "drag" {
                    point(p, window, "toX", "toY", original)?;
                }
                send(&[start])?;
                if kind == "click" {
                    for index in 0..num(p, "clickCount", 1.).clamp(1., 3.) as u32 {
                        if index > 0 {
                            thread::sleep(Duration::from_millis(80));
                        }
                        guard(window, owner, original)?;
                        send(&[mouse(down, 0, 0, 0), mouse(up, 0, 0, 0)])?;
                    }
                } else if kind == "drag" {
                    send(&[mouse(down, 0, 0, 0)])?;
                    let duration = num(p, "durationMs", 300.).clamp(20., 120000.) as u64;
                    for step in 1..=40 {
                        thread::sleep(Duration::from_millis(duration / 40));
                        guard(window, owner, original)?;
                        let fraction = f64::from(step) / 40.;
                        let mut next = p.clone();
                        next["x"] = json!(
                            num(p, "x", 0.) + (num(p, "toX", 0.) - num(p, "x", 0.)) * fraction
                        );
                        next["y"] = json!(
                            num(p, "y", 0.) + (num(p, "toY", 0.) - num(p, "y", 0.)) * fraction
                        );
                        send(&[point(&next, window, "x", "y", original)?])?;
                    }
                    send(&[mouse(up, 0, 0, 0)])?;
                }
            }
            "type" => {
                let modifiers = [0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0x5b, 0x5c];
                if modifiers
                    .iter()
                    .any(|vk| unsafe { GetAsyncKeyState(*vk) } < 0)
                {
                    return Err(fail("INPUT_BUSY"));
                }
                for units in str_field(p, "text")
                    .encode_utf16()
                    .collect::<Vec<_>>()
                    .chunks(32)
                {
                    guard(window, owner, original)?;
                    let mut events = vec![];
                    for unit in units {
                        let k = KeyState {
                            vk: 0,
                            scan: *unit,
                            flags: KEYEVENTF_UNICODE,
                        };
                        events.extend([keyboard(k, false), keyboard(k, true)]);
                    }
                    send(&events)?;
                }
            }
            "key" => {
                check_unowned(&keys)?;
                send(&keys.iter().map(|k| keyboard(*k, false)).collect::<Vec<_>>())?;
                if action != "down" {
                    thread::sleep(Duration::from_millis(
                        num(p, "durationMs", 0.).clamp(0., 120000.) as u64,
                    ));
                    send(
                        &keys
                            .iter()
                            .rev()
                            .map(|k| keyboard(*k, true))
                            .collect::<Vec<_>>(),
                    )?;
                }
            }
            "scroll" => {
                if p.get("x").is_some() {
                    send(&[point(p, window, "x", "y", original)?])?;
                }
                for (field, flag, sign) in [
                    ("deltaY", MOUSEEVENTF_WHEEL, -1.),
                    ("deltaX", MOUSEEVENTF_HWHEEL, 1.),
                ] {
                    let delta = num(p, field, 0.);
                    if !delta.is_finite() || delta.abs() > 1_000_000. {
                        return Err(fail("INVALID_COORDINATES"));
                    }
                    if delta != 0. {
                        guard(window, owner, original)?;
                        send(&[mouse(flag, (delta * sign).round() as i32 as u32, 0, 0)])?;
                    }
                }
            }
            _ => unreachable!(),
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = release_all();
    }
    result?;
    Ok(json!(true))
}
pub fn release_keys(p: &Value) -> Result<()> {
    let mut events = Vec::new();
    for value in p["keys"].as_array().into_iter().flatten() {
        let Ok(keys) = chord(value.as_str().ok_or_else(|| fail("UNSUPPORTED_KEY"))?) else {
            continue;
        };
        events.extend(keys.into_iter().rev().map(|k| keyboard(key(k), true)));
    }
    send(&events)
}
pub fn release_all() -> Result<()> {
    let mut events = {
        let state = owned().lock().map_err(|_| fail("INPUT_REJECTED"))?;
        let mut values = state
            .keys
            .iter()
            .map(|k| keyboard(*k, true))
            .collect::<Vec<_>>();
        values.extend(state.buttons.iter().map(|up| mouse(*up, 0, 0, 0)));
        values
    };
    // A replacement cleanup helper also releases known modifiers/buttons after a killed helper.
    for vk in [0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0x5b, 0x5c] {
        events.push(keyboard(
            KeyState {
                vk,
                scan: 0,
                flags: if vk == 0xa3 || vk == 0xa5 || vk == 0x5b || vk == 0x5c {
                    KEYEVENTF_EXTENDEDKEY
                } else {
                    0
                },
            },
            true,
        ));
    }
    for flag in [
        MOUSEEVENTF_LEFTUP,
        MOUSEEVENTF_RIGHTUP,
        MOUSEEVENTF_MIDDLEUP,
    ] {
        events.push(mouse(flag, 0, 0, 0));
    }
    send(&events)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn partial_keyboard_input_and_failed_compensation_remain_owned() {
        let mut state = Owned::default();
        let k = key(Key {
            vk: 0xa2,
            extended: false,
        });
        assert!(inject_with(&mut state, &[keyboard(k, false), keyboard(k, true)], |_| 1).is_err());
        assert!(state.keys.contains(&k));
        assert!(inject_with(&mut state, &[keyboard(k, true)], |_| 0).is_err());
        assert!(state.keys.contains(&k));
        inject_with(&mut state, &[keyboard(k, true)], |_| 1).unwrap();
        assert!(state.keys.is_empty());
    }
    #[test]
    fn partial_click_requires_a_confirmed_button_release() {
        let mut state = Owned::default();
        assert!(inject_with(
            &mut state,
            &[
                mouse(MOUSEEVENTF_LEFTDOWN, 0, 0, 0),
                mouse(MOUSEEVENTF_LEFTUP, 0, 0, 0)
            ],
            |_| 1
        )
        .is_err());
        assert!(state.buttons.contains(&MOUSEEVENTF_LEFTUP));
        assert!(inject_with(&mut state, &[mouse(MOUSEEVENTF_LEFTUP, 0, 0, 0)], |_| 0).is_err());
        assert!(state.buttons.contains(&MOUSEEVENTF_LEFTUP));
        inject_with(&mut state, &[mouse(MOUSEEVENTF_LEFTUP, 0, 0, 0)], |_| 1).unwrap();
        assert!(state.buttons.is_empty());
    }
}
