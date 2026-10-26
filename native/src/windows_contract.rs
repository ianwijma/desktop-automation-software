//! Pure Windows input/geometry rules, exercised on every CI host.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
pub struct Key {
    pub vk: u16,
    pub extended: bool,
}
pub fn chord(value: &str) -> Result<Vec<Key>, &'static str> {
    value
        .split('+')
        .map(|name| {
            let lower = name.to_ascii_lowercase();
            let (vk, extended) = match lower.as_str() {
                "ctrl" | "control" | "control_l" => (0xa2, false),
                "control_r" => (0xa3, true),
                "shift" | "shift_l" => (0xa0, false),
                "shift_r" => (0xa1, false),
                "alt" | "alt_l" => (0xa4, false),
                "alt_r" | "altgr" => (0xa5, true),
                "meta" | "super" | "super_l" | "command" => (0x5b, true),
                "super_r" => (0x5c, true),
                "enter" | "return" => (13, false),
                "tab" => (9, false),
                "escape" | "esc" => (27, false),
                "backspace" => (8, false),
                "space" => (32, false),
                "delete" => (46, true),
                "insert" => (45, true),
                "home" => (36, true),
                "end" => (35, true),
                "left" | "arrowleft" => (37, true),
                "right" | "arrowright" => (39, true),
                "up" | "arrowup" => (38, true),
                "down" | "arrowdown" => (40, true),
                "pageup" => (33, true),
                "pagedown" => (34, true),
                _ if lower.starts_with('f')
                    && lower[1..]
                        .parse::<u16>()
                        .map(|n| (1..=24).contains(&n))
                        .unwrap_or(false) =>
                {
                    (111 + lower[1..].parse::<u16>().unwrap(), false)
                }
                _ if name.len() == 1 && name.as_bytes()[0].is_ascii_alphanumeric() => {
                    (name.as_bytes()[0].to_ascii_uppercase() as u16, false)
                }
                _ => return Err("Unsupported Windows key; use a named key or Unicode Type action"),
            };
            Ok(Key { vk, extended })
        })
        .collect()
}
pub fn absolute(value: i32, origin: i32, extent: i32) -> Result<i32, &'static str> {
    let relative = i64::from(value) - i64::from(origin);
    if extent <= 1 || relative < 0 || relative >= i64::from(extent) {
        return Err("Coordinates outside the virtual desktop");
    }
    Ok((relative * 65535 / i64::from(extent - 1)) as i32)
}
pub fn local_point(value: f64, extent: i32) -> Result<i32, &'static str> {
    if !value.is_finite() || value < 0. || value >= f64::from(extent) {
        return Err("Coordinates outside target window");
    }
    // Rounding must never move the final fractional pixel outside the window.
    Ok((value.round() as i32).min(extent - 1))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn maps_negative_virtual_desktops_without_clamping_to_primary() {
        assert_eq!(absolute(-1920, -1920, 3840), Ok(0));
        assert_eq!(absolute(1919, -1920, 3840), Ok(65535));
        assert!(absolute(-1921, -1920, 3840).is_err());
        assert_eq!(local_point(99.9, 100), Ok(99));
        assert!(local_point(f64::NAN, 100).is_err());
    }
    #[test]
    fn validates_the_entire_chord_before_any_key_can_be_sent() {
        assert_eq!(chord("Control+Shift+K").unwrap().len(), 3);
        assert!(chord("Control+Invalid").is_err());
        assert!(chord("Control+").is_err());
        assert!(chord("ArrowLeft").unwrap()[0].extended);
        assert_eq!(chord("F24").unwrap()[0].vk, 135);
        assert!(chord("日本語").is_err());
    }
}
