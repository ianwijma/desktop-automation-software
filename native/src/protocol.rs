use super::*;
pub const VERSION: u64 = 2;
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
        "win32-wgc"
    }
    #[cfg(target_os = "macos")]
    {
        "macos-screencapturekit"
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
    if let Some(code) = message.strip_prefix("uia:") {
        let safe = match code {
            "INVALID_REQUEST" => "Invalid semantic locator or UIA request",
            "ELEMENT_NOT_FOUND" => "No realized control matches; reveal virtualized items or update the locator",
            "AMBIGUOUS_ELEMENT" => "Multiple controls match; refine the locator or ancestor scope",
            "ELEMENT_DISABLED" => "The matched control is disabled",
            "ELEMENT_OFFSCREEN" => "The matched control is not visible; reveal it before acting",
            "SECURE_ELEMENT" => "Secure controls cannot be read or changed through semantic actions",
            "VIRTUALIZED_ELEMENT" => "Virtualized controls must be realized by the application before use",
            "STALE_ELEMENT" => "The control disappeared or changed during UIA access; inspect it again",
            "UNSUPPORTED_PATTERN" => "The control does not support this semantic action; coordinate mode must be selected explicitly",
            "MODAL_BLOCKED" => "A modal window blocks this target; select the modal as a separate target",
            "SEARCH_LIMIT" => "The control tree exceeded the bounded search; choose a narrower target",
            "TIMEOUT" => "The UIA worker timed out; restart the helper before further semantic actions",
            "UNSUPPORTED_OPERATION" => "Native semantic targeting is currently available only through Windows UIA",
            _ => "UIA provider failed; no coordinate fallback or action replay was attempted",
        };
        let code = if [
            "INVALID_REQUEST",
            "ELEMENT_NOT_FOUND",
            "AMBIGUOUS_ELEMENT",
            "ELEMENT_DISABLED",
            "ELEMENT_OFFSCREEN",
            "SECURE_ELEMENT",
            "VIRTUALIZED_ELEMENT",
            "STALE_ELEMENT",
            "UNSUPPORTED_PATTERN",
            "MODAL_BLOCKED",
            "SEARCH_LIMIT",
            "TIMEOUT",
            "UNSUPPORTED_OPERATION",
        ]
        .contains(&code)
        {
            code
        } else {
            "BACKEND_FAILURE"
        };
        return json!({"code":code,"message":safe,"operation":method,"backend":"windows-uia","permission":"unknown","retryable":false});
    }
    if let Some(kind) = message.strip_prefix("wayland:") {
        let (code, safe, permission) = match kind {
            "CANCELLED" => ("CANCELLED", "The Wayland chooser or operation was cancelled; no grant was reopened", "required"),
            "PERMISSION_DENIED" => ("PERMISSION_DENIED", "The portal did not grant keyboard, pointer and capture access", "required"),
            "SESSION_REQUIRED" => ("PERMISSION_DENIED", "Capture this Wayland target to explicitly select and grant a source before input", "required"),
            "SESSION_CLOSED" | "EIS_LOST" => ("CAPTURE_LOST", "The Wayland grant, portal owner or EIS device was lost; input stopped. Explicitly recapture to request a new session", "required"),
            "STALE_CAPTURE" | "GEOMETRY_UNKNOWN" => ("STALE_CAPTURE", "Wayland source geometry changed or could not be mapped exactly; explicitly recapture and detect again", "unknown"),
            "CAPTURE_LOST" => ("CAPTURE_LOST", "The granted PipeWire stream ended; no other source was selected", "unknown"),
            "CAPTURE_TIMEOUT" | "PORTAL_TIMEOUT" => ("TIMEOUT", "The Wayland portal or capture stream did not respond in time", "unknown"),
            "MEDIA_REQUIRED" | "PORTAL_UNAVAILABLE" => ("DEPENDENCY_UNAVAILABLE", "Wayland RemoteDesktop/ScreenCast and GStreamer PipeWire/PNG plugins are required", "unknown"),
            "CAPABILITY_MISSING" | "EIS_UNAVAILABLE" => ("UNSUPPORTED_OPERATION", "The portal or EIS connection lacks the required capability; no transport fallback was attempted", "unknown"),
            "UNSUPPORTED_KEY" | "UNSUPPORTED_OPERATION" => ("UNSUPPORTED_OPERATION", "This Wayland operation, key, text character or keyboard layout is unsupported", "not-required"),
            "INPUT_BUSY" => ("INPUT_REJECTED", "Wayland text input conflicts with held keys, modifiers or a nondefault keyboard layout", "unknown"),
            "CLEANUP_FAILED" => ("INPUT_REJECTED", "Wayland input release or session closure was not acknowledged; further input remains blocked", "unknown"),
            "INVALID_REQUEST" | "INVALID_COORDINATES" => ("INVALID_REQUEST", "Invalid Wayland request or coordinates outside the granted source", "unknown"),
            _ => ("BACKEND_FAILURE", "A Wayland portal operation failed", "unknown"),
        };
        return json!({"code":code,"message":safe,"operation":method,"backend":backend(),"permission":permission,"retryable":false});
    }
    if let Some(kind) = message.strip_prefix("macos:") {
        let (code, safe, permission) = match kind {
            "SCREEN_REQUIRED" => ("PERMISSION_DENIED", "Screen Recording permission is required for Relay and its helper; grant it in System Settings > Privacy & Security, then restart Relay", "required"),
            "AX_REQUIRED" => ("PERMISSION_DENIED", "Accessibility permission is required for Relay and its helper; cleanup cannot be acknowledged while permission is revoked", "required"),
            "SESSION_INACTIVE" => ("PERMISSION_DENIED", "The user session is locked, inactive, or unavailable; unlock and select an interactive desktop", "required"),
            "AX_AMBIGUOUS" => ("AMBIGUOUS_TARGET", "Multiple Accessibility windows match the selected owner's geometry; no window title fallback was attempted", "unknown"),
            "AX_WINDOW_UNAVAILABLE" => ("TARGET_UNAVAILABLE", "The selected window could not be identified uniquely through public Accessibility attributes", "unknown"),
            "TARGET_UNAVAILABLE" => ("TARGET_UNAVAILABLE", "The selected macOS window or owning application is no longer available", "unknown"),
            "TARGET_OBSCURED" => ("TARGET_UNAVAILABLE", "Another window obscures the selected input point", "unknown"),
            "CAPTURE_GEOMETRY" => ("STALE_CAPTURE", "Window geometry or display scale changed; capture and detect again", "unknown"),
            "CAPTURE_UNAVAILABLE" => ("CAPTURE_UNAVAILABLE", "ScreenCaptureKit could not capture the selected window; no backend fallback was attempted", "unknown"),
            "CAPTURE_TIMEOUT" => ("TIMEOUT", "ScreenCaptureKit did not acknowledge the operation or provide a matching complete frame in time", "unknown"),
            "CAPTURE_LOST" => ("CAPTURE_LOST", "The ScreenCaptureKit stream stopped or lost its source", "unknown"),
            "FOCUS_FAILED" => ("FOCUS_FAILED", "Accessibility could not raise and verify the exact selected window", "unknown"),
            "INPUT_REJECTED" | "INPUT_BUSY" => ("INPUT_REJECTED", "A macOS input event could not be posted, or a key/modifier is already held outside this action. Input was not repeated", "unknown"),
            "INVALID_REQUEST" | "INVALID_COORDINATES" => ("INVALID_REQUEST", "Invalid macOS request or coordinates outside the selected window/displays", "unknown"),
            "UNSUPPORTED_KEY" | "UNSUPPORTED_OPERATION" => ("UNSUPPORTED_OPERATION", "This macOS operation or named key is unsupported; use Unicode Type for text", "not-required"),
            _ => ("BACKEND_FAILURE", "A macOS framework operation failed", "unknown"),
        };
        return json!({"code":code,"message":safe,"operation":method,"backend":backend(),"permission":permission,"retryable":false});
    }
    if let Some(kind) = message.strip_prefix("win32:") {
        let (code, safe, permission) = match kind {
            "ELEVATED_TARGET" => ("PERMISSION_DENIED", "The target runs at a higher integrity level; use an unelevated target or matching privileges", "denied"),
            "PRIVILEGE_UNKNOWN" => ("PERMISSION_DENIED", "Target integrity could not be checked; no input was sent", "unknown"),
            "DESKTOP_UNAVAILABLE" => ("PERMISSION_DENIED", "The interactive desktop is locked, secure, or unavailable", "required"),
            "DPI_UNAVAILABLE" => ("CAPTURE_UNAVAILABLE", "Per-monitor DPI awareness could not be established; native coordinates are unavailable", "unknown"),
            "CAPTURE_UNAVAILABLE" => ("CAPTURE_UNAVAILABLE", "Windows capture is unavailable or the source refused capture; no compatibility fallback was attempted", "unknown"),
            "CAPTURE_LOST" | "CAPTURE_STOP_FAILED" => ("CAPTURE_LOST", "The capture source or graphics session was lost or could not be closed", "unknown"),
            "CAPTURE_TIMEOUT" => ("TIMEOUT", "Windows Graphics Capture did not return a frame matching the current window geometry", "unknown"),
            "CAPTURE_GEOMETRY" => ("STALE_CAPTURE", "Target geometry changed or cannot be mapped exactly; capture and detect again", "unknown"),
            "TARGET_UNAVAILABLE" => ("TARGET_UNAVAILABLE", "Target window is no longer available", "unknown"),
            "TARGET_OBSCURED" => ("TARGET_UNAVAILABLE", "Another window obscures the input point; no pointer action was sent", "unknown"),
            "FOCUS_FAILED" => ("FOCUS_FAILED", "Windows did not grant foreground focus to the selected target", "unknown"),
            "INPUT_REJECTED" => ("INPUT_REJECTED", "SendInput rejected all or part of the input; check desktop access and target privileges. Input was not repeated", "unknown"),
            "INPUT_BUSY" => ("INPUT_REJECTED", "A modifier or requested key is already held outside this action; release it before retrying", "unknown"),
            "INVALID_COORDINATES" => ("INVALID_REQUEST", "Input coordinates are outside the target or virtual desktop", "unknown"),
            "UNSUPPORTED_KEY" => ("UNSUPPORTED_OPERATION", "Unsupported Windows key; use a named key or Unicode Type action", "not-required"),
            "BACKEND_REQUIRED" => ("CAPTURE_UNAVAILABLE", "Choose a Windows capture method for this application in Settings before capturing", "unknown"),
            _ => ("BACKEND_FAILURE", "A Windows backend operation failed", "unknown"),
        };
        return json!({"code":code,"message":safe,"operation":method,"backend":backend(),"permission":permission,"retryable":false});
    }
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
            if window["applicationIdentity"]["kind"] == "bundle-id" {
                continue;
            }
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
        (
            "capture",
            true,
            value["capture"] == true
                && (!portal || value["waylandBackend"]["permissionsGranted"] == true),
        ),
        (
            "input",
            true,
            value["input"] == true
                && (!portal || value["waylandBackend"]["permissionsGranted"] == true),
        ),
        (
            "directRecording",
            cfg!(target_os = "linux") && !portal,
            value["directRecording"] == true,
        ),
        (
            "accessibility",
            cfg!(target_os = "windows"),
            value["accessibility"] == true,
        ),
    ] {
        operations.insert(name.to_string(),json!({"availability":if !supported{"unsupported"}else if available{"available"}else{"unavailable"},"verification":"untested","backend":backend()}));
    }
    let capture = if cfg!(target_os = "macos") {
        if value["macosBackend"]["screenRecording"] == "granted" {
            "granted"
        } else {
            "required"
        }
    } else if portal {
        if value["waylandBackend"]["permissionsGranted"] == true {
            "granted"
        } else {
            "required"
        }
    } else if cfg!(target_os = "windows") {
        "unknown"
    } else {
        "not-required"
    };
    let input = if cfg!(target_os = "macos") {
        if value["macosBackend"]["accessibility"] == "granted" {
            "granted"
        } else {
            "required"
        }
    } else if portal {
        if value["waylandBackend"]["permissionsGranted"] == true {
            "granted"
        } else {
            "required"
        }
    } else {
        "unknown"
    };
    value["native"] = json!({"helper":handshake(),"operations":operations,"permissions":{"capture":capture,"input":input}});
    if value["windowsBackend"].is_object() {
        value["native"]["windows"] = value["windowsBackend"].take();
    }
    if value["waylandBackend"].is_object() {
        value["native"]["wayland"] = value["waylandBackend"].take();
    }
    if value["macosBackend"].is_object() {
        value["native"]["macos"] = value["macosBackend"].take();
    }
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
    let source = if value["captureBounds"].is_object() {
        value["captureBounds"].clone()
    } else {
        bounds.clone()
    };
    let selected_backend =
        if cfg!(target_os = "windows") && str_field(p, "captureBackend") == "printwindow" {
            "win32-printwindow"
        } else {
            backend()
        };
    if value["backend"].is_string() && value["backend"] != selected_backend {
        return Err("win32:CAPTURE_UNAVAILABLE".into());
    }
    value["native"] = json!({"helperInstanceId":info["instanceId"],"backend":selected_backend,"windowId":p["windowId"],
        "geometry":{"inputSpace":info["coordinateSpace"],"captureSpace":"pixels","boundsKind":if backend().starts_with("wayland"){"portal-source"}else{"window"},
        "captureBounds":source,"pixelToInput":{"scaleX":num(&source,"width",0.)/width,"scaleY":num(&source,"height",0.)/height,"offsetX":num(&source,"x",0.)-num(&value["bounds"],"x",0.),"offsetY":num(&source,"y",0.)-num(&value["bounds"],"y",0.)}}});
    if value["sourceToken"].is_string() {
        value["native"]["sourceToken"] = value["sourceToken"].take();
    }
    if let Some(dpi) = value["dpi"].as_u64() {
        value["native"]["geometry"]["dpi"] = json!(dpi);
    }
    if let Some(scale) = value["displayScale"].as_f64() {
        value["native"]["geometry"]["displayScale"] = json!(scale);
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn wayland_errors_keep_recovery_boundaries_and_redact_payloads() {
        for (kind, expected) in [
            ("CANCELLED", "CANCELLED"),
            ("SESSION_CLOSED", "CAPTURE_LOST"),
            ("STALE_CAPTURE", "STALE_CAPTURE"),
            ("CLEANUP_FAILED", "INPUT_REJECTED"),
        ] {
            let value = error("input", format!("wayland:{kind}"));
            assert_eq!(value["code"], expected);
            assert_eq!(value["retryable"], false);
        }
        let value = error(
            "input",
            "wayland:UNSUPPORTED_KEY private-key-or-typed-text".into(),
        );
        assert!(!value.to_string().contains("private-key-or-typed-text"));
    }
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
    fn macos_errors_fail_closed_without_raw_payloads() {
        for (kind, code) in [
            ("SCREEN_REQUIRED", "PERMISSION_DENIED"),
            ("AX_REQUIRED", "PERMISSION_DENIED"),
            ("SESSION_INACTIVE", "PERMISSION_DENIED"),
            ("AX_AMBIGUOUS", "AMBIGUOUS_TARGET"),
            ("CAPTURE_LOST", "CAPTURE_LOST"),
            ("CAPTURE_GEOMETRY", "STALE_CAPTURE"),
        ] {
            let e = error("capture", format!("macos:{kind}"));
            assert_eq!(e["code"], code);
            assert_eq!(e["retryable"], false);
        }
        assert!(!error("input", "macos:private typed secret".into())
            .to_string()
            .contains("secret"));
    }
    #[test]
    fn bundle_identity_is_distinct_from_owner_label() {
        let list = windows(
            json!([{"id":"1", "application":"Same visible label", "applicationIdentity":{"id":"dev.relay.fixture", "kind":"bundle-id", "pid":7}}]),
        );
        assert_eq!(list[0]["applicationIdentity"]["id"], "dev.relay.fixture");
    }
    #[test]
    fn errors_do_not_include_tool_payloads() {
        let e = error("input", "tool failed with secret text".into());
        assert!(!e.to_string().contains("secret"));
        assert_eq!(e["operation"], "input");
        assert_eq!(e["retryable"], false);
    }
}

pub fn error_for(method: &str, message: String, p: &Value) -> Value {
    let mut value = error(method, message);
    if cfg!(target_os = "windows") {
        value["backend"] = json!(match method {
            "nativeElement" | "inspectNativeLocator" => "windows-uia",
            "input" | "releaseKeys" | "releaseAll" => "win32-sendinput",
            "capture" if str_field(p, "captureBackend") == "printwindow" => "win32-printwindow",
            _ => backend(),
        });
    }
    value
}
