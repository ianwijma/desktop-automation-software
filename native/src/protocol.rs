use super::*;
pub const VERSION: u64 = 1;
static INSTANCE: std::sync::OnceLock<String> = std::sync::OnceLock::new();
pub fn backend() -> &'static str {
    #[cfg(target_os = "linux")]
    {
        if super::wayland::is_wayland() {
            "wayland-portal-gstreamer"
        } else {
            "x11-command-tools"
        }
    }
    #[cfg(target_os = "windows")]
    {
        "win32-powershell-printwindow"
    }
    #[cfg(target_os = "macos")]
    {
        "coregraphics-screencapture"
    }
}
pub fn handshake() -> Value {
    let space = if cfg!(target_os = "macos") {
        "logical-points"
    } else if backend().starts_with("wayland") {
        "portal-source"
    } else {
        "physical-pixels"
    };
    json!({"protocolVersion":VERSION,"helperVersion":env!("CARGO_PKG_VERSION"),
        "instanceId":INSTANCE.get_or_init(|| format!("{}-{}",std::process::id(),now())),
        "platform":if cfg!(target_os="windows"){"win32"}else if cfg!(target_os="macos"){"darwin"}else{"linux"},
        "backend":backend(),"coordinateSpace":space})
}
pub fn error(method: &str, message: String) -> Value {
    let lower = message.to_lowercase();
    let code = if lower.contains("protocol") {
        "PROTOCOL_MISMATCH"
    } else if lower.contains("unsupported")
        || lower.contains("not implemented")
        || lower.contains("unavailable; use guided")
        || lower.contains("wayland does not allow")
        || lower.contains("wayland cannot")
    {
        "UNSUPPORTED_OPERATION"
    } else if lower.contains("no such file")
        || lower.contains("cannot find the file specified")
        || lower.contains("not recognized as")
    {
        "DEPENDENCY_UNAVAILABLE"
    } else if lower.contains("ambiguous") {
        "AMBIGUOUS_TARGET"
    } else if lower.contains("permission") || lower.contains("not authorized") {
        "PERMISSION_DENIED"
    } else if lower.contains("no longer available") || lower.contains("badwindow") {
        "TARGET_UNAVAILABLE"
    } else if lower.contains("required")
        || lower.contains("outside")
        || lower.contains("valid window")
    {
        "INVALID_REQUEST"
    } else {
        "BACKEND_FAILURE"
    };
    let permission = if code == "PERMISSION_DENIED" {
        "required"
    } else {
        "unknown"
    };
    // Diagnostics intentionally exclude raw tool stderr, launch arguments and typed input.
    let safe = match code {
        "PROTOCOL_MISMATCH" => "Native protocol version mismatch; rebuild or reinstall the matching helper",
        "UNSUPPORTED_OPERATION" => "This native operation is unsupported by the selected backend",
        "PERMISSION_DENIED" => "Native permission is required; check system capture and input permissions",
        "TARGET_UNAVAILABLE" => "Target window is no longer available",
        "AMBIGUOUS_TARGET" => "Multiple windows match; choose a unique target",
        "DEPENDENCY_UNAVAILABLE" => "Native dependency or application executable is unavailable; check platform prerequisites",
        "INVALID_REQUEST" => "Invalid native request or coordinates outside the target window",
        _ => "Native backend operation failed; check dependencies, target availability and permissions",
    };
    json!({"code":code,"message":safe,"operation":method,"backend":backend(),"permission":permission,"retryable":false})
}
pub fn windows(mut value: Value) -> Value {
    if let Some(items) = value.as_array_mut() {
        for window in items {
            if let Some(app) = window["application"].as_str().filter(|s| !s.is_empty()) {
                let mut identity = json!({"id":app,"kind":if cfg!(target_os="windows"){"process-name"}else if cfg!(target_os="macos"){"owner-name"}else{"wm-class"}});
                if let Some(pid) = window["pid"].as_u64() {
                    identity["pid"] = json!(pid);
                }
                window["applicationIdentity"] = identity;
            }
        }
    }
    value
}
pub fn capabilities(mut value: Value) -> Value {
    value["windows"] = windows(value["windows"].take());
    let mut operations = serde_json::Map::new();
    let portal = backend().starts_with("wayland");
    let desktop = !portal && (value["session"] == "desktop" || value["session"] == "x11");
    for (name, supported, available) in [
        ("launch", true, true),
        ("listWindows", !portal, desktop),
        ("attach", !portal, desktop),
        ("focus", !portal, desktop && value["input"] == true),
        ("close", !portal, desktop),
        ("capture", true, !portal && value["capture"] == true),
        ("input", true, !portal && value["input"] == true),
        (
            "directRecording",
            cfg!(target_os = "linux") && !portal,
            value["directRecording"] == true,
        ),
        ("accessibility", false, false),
    ] {
        operations.insert(name.to_string(),json!({"availability":if !supported{"unsupported"}else if available{"available"}else{"unavailable"},"verification":"untested","backend":backend()}));
    }
    let capture = if cfg!(target_os = "macos") {
        if value["capture"] == true {
            "granted"
        } else {
            "required"
        }
    } else if portal {
        "required"
    } else {
        "not-required"
    };
    let input = if cfg!(target_os = "macos") {
        if value["input"] == true {
            "granted"
        } else {
            "required"
        }
    } else if portal {
        "required"
    } else {
        "unknown"
    };
    value["native"] = json!({"helper":handshake(),"operations":operations,"permissions":{"capture":capture,"input":input}});
    value
}
pub fn capture(mut value: Value, p: &Value) -> Result<Value> {
    let width = num(&value, "width", 0.);
    let height = num(&value, "height", 0.);
    let bounds = &value["bounds"];
    if width <= 0.
        || height <= 0.
        || num(bounds, "width", 0.) <= 0.
        || num(bounds, "height", 0.) <= 0.
    {
        return Err("Invalid capture geometry".into());
    }
    let info = handshake();
    value["native"] = json!({"helperInstanceId":info["instanceId"],"backend":backend(),"windowId":p["windowId"],
        "geometry":{"inputSpace":info["coordinateSpace"],"captureSpace":"pixels","boundsKind":if backend().starts_with("wayland"){"portal-source"}else{"window"},
        "pixelToInput":{"scaleX":num(bounds,"width",0.)/width,"scaleY":num(bounds,"height",0.)/height}}});
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn geometry_retains_independent_axis_scales_and_negative_origin() {
        let frame = capture(
            json!({"width":400,"height":300,"bounds":{"x":-500,"y":20,"width":200,"height":100}}),
            &json!({"windowId":"1"}),
        )
        .unwrap();
        assert_eq!(frame["native"]["geometry"]["pixelToInput"]["scaleX"], 0.5);
        assert_eq!(
            frame["native"]["geometry"]["pixelToInput"]["scaleY"],
            1. / 3.
        );
        assert_eq!(frame["bounds"]["x"], -500);
        assert!(capture(json!({"width":0}), &json!({})).is_err());
    }
    #[test]
    fn errors_do_not_include_tool_payloads() {
        let e = error("input", "tool failed with secret text".into());
        assert!(!e.to_string().contains("secret"));
        assert_eq!(e["operation"], "input");
        assert_eq!(e["retryable"], false);
    }
}
