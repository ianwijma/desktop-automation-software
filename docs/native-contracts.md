# Native contracts and desktop verification (N01–N02)

The native helper and TypeScript adapter use protocol **2**, independently of workflow/database version 2 and recording envelope version 1. There is no automatic input retry, backend fallback, or migration of coordinate workflows to semantic targeting.

## Protocol

Requests and responses are newline-delimited JSON. Every request carries `protocolVersion`, a string `id`, a `method`, and an object `params`. The first normal request is `handshake`:

```json
{ "protocolVersion": 2, "id": "hello", "method": "handshake", "params": {} }
```

The reply identifies `protocolVersion`, `helperVersion`, process-lifetime `instanceId`, `platform`, `backend`, and `coordinateSpace`. Missing/future protocol versions and incompatible handshakes fail before capture/input. A matching helper must be rebuilt or installed; the adapter never falls back to the old protocol. `releaseKeys` and `releaseAll` are allowed before handshake so a separate cleanup process can release owned input after the original process exits. Their versioned successful acknowledgements are required before desktop input becomes available again.

Responses carry the same protocol version and request ID and either `result` or a structured `error` with `code`, `message`, `operation`, `backend`, `permission`, and `retryable`. Codes distinguish protocol/request errors, unsupported operations, permission requirements, unavailable/ambiguous targets, stale captures, backend failures, helper exit, timeout, and cancellation. Backend failures use a conservative generic code when the current platform tool cannot identify the cause reliably. Raw tool stderr, typed text, launch arguments, and request bodies are excluded from diagnostic envelopes. No error authorizes automatic input retry.

`NativeServiceError.details` retains the error in the adapter and utility/main boundary. Existing `getCapabilities()` IPC additionally exposes the latest native diagnostic in `capabilities.native.lastError`; Electron's rejected invoke errors themselves retain their existing message-based public API. No new execution IPC is added. Browser preview capabilities contain no native helper or verified desktop state.

## Capabilities and permissions

Existing capability booleans remain for compatibility. `capabilities.native` adds the handshake, per-operation availability, and separately reported permission states. An operation being available means its current prerequisites are advertised/satisfied; it does **not** prove capture pixels or an input effect. Operation verification remains `untested` in this passive probe. The harness below records actual observations separately.

macOS uses its existing Screen Recording/Accessibility preflight checks. Windows input permission remains unknown because an unlocked desktop and target privilege level cannot be established by helper startup. X11 capture has no separate consent permission, while desktop/service availability is reported independently. Wayland grants remain required and operations remain unavailable in the passive probe until separately exercised; portal service discovery is not consent or session qualification. Global shortcuts are still checked by the Electron application.

Current backend identifiers are `x11-command-tools`, `wayland-portal-gstreamer`, `win32-wgc` (capture default), `win32-printwindow` (explicit compatibility), `win32-sendinput` (input errors), and `coregraphics-screencapture`. N02 replaces the Windows implementation; macOS/Wayland backend completion remains N03–N04.

## Identity and coordinates

`NativeWindow.id` is a transient OS handle. `applicationIdentity` is separate: an application identifier with its source (`wm-class`, `process-name`, `owner-name`, or `pid-only`) and owning PID when available. It is not a persisted executable fingerprint, semantic locator, or guarantee against handle reuse within the same process. Coordinate workflows keep their existing application/title configuration. Duplicate unbound window matches fail rather than selecting the first.

Bindings remember application identity, and requests verify expected ownership in the helper immediately before dispatch. Restart/exit clears cached bindings and capture frames. Capture metadata carries helper instance, backend, window handle, application identity, input coordinate space, capture pixel space, bounds kind, and independent pixel-to-input X/Y scales, source bounds and offsets, and Windows DPI. Bounds retain the screen origin, including negative coordinates; input coordinates are window-relative. macOS input uses logical points; X11/Win32 use their current physical-pixel geometry; portal geometry refers to the selected source. Unsupported platform mapping remains a qualification gap rather than a guessed desktop offset.

Protocol 2 adds `releaseCapture`, which stops capture resources without injecting key/button releases. Passive capability probes and disposal use it when no input has been attempted. Input attempts still require acknowledged release before reuse. Windows source/input bounds may differ at invisible resize borders: `inputX = pixelX * scaleX + offsetX`, with the analogous Y transform. Backend changes, DPI changes and failed captures invalidate cached frames. Existing Windows targets require an explicit capture choice; there is no implicit migration from PrintWindow.

The adapter validates finite positive geometry and matching identity/backend/coordinate transforms before retaining a capture. A detector frame from a different helper, owner, handle, or target size is rejected before input. Moving the same window does not invalidate its window-relative coordinates; platform input resolves its current origin. Existing `scale` remains for compatibility, while replay uses both explicit axis scales plus source offsets. Frame IDs and native handles are runtime-only metadata.

## Desktop harness

Build the helper, then explicitly enable fixture input in a disposable desktop session:

```sh
npm run build:native
npm run test:native -- --run --session-label=gnome-x11
```

Without `--run`, the harness writes an **incomplete / not-run** report and performs no capture or input. The harness launches only its own synthetic Electron fixture through the production adapter. Its authenticated local observation endpoint can read fixture state, resize/create a duplicate fixture, and close it; it cannot synthesize clicks/typing or operate another application. Actual input comes from `NativeAdapter`, and capture is checked for known fixture pixels before coordinate input is attempted. Secure values are omitted from observations and reports.

Linux CI uses an isolated Xvfb session and explicitly requests SwiftShader for its animated WebGL fixture:

```sh
RELAY_NATIVE_BINARY=native/target/debug/relay-native xvfb-run -a \
  npm run test:native -- --run --software-gpu --session-label=xvfb
```

This verifies graphics capture with a software renderer, not a hardware GPU or compositor. Omit `--software-gpu` for real graphics qualification; unavailable WebGL fails the graphics check instead of passing it. Wayland produces a not-run result without opening a chooser or injecting input; N04 must add portal source/session qualification. Windows and macOS may run the same source harness manually with the matching helper, an unlocked disposable session, and required permissions. Windows CI now attempts the [N02 matrix](windows-native.md), reporting incomplete cases when no interactive graphics desktop is available. macOS CI does not enable this desktop harness.

The eight checks cover launch/attach/focus; nonblank capture and transforms; observed click/type/secure-field/scroll/drag effects; changing graphics pixels; resize rejection; held-key/drag cancellation and actual release; helper restart/stale-frame rejection/input resumption; and duplicate-window rejection. Duplicate labels and a secure field are included for later semantic/recording slices; N01 does not qualify accessibility or secure-field recording.

Reports and the synthetic pre-input capture are written under ignored `test-results/native-harness/`. `RELAY_NATIVE_REPORT_DIR` changes the destination; `RELAY_NATIVE_BINARY` selects a helper. Reports record OS release/architecture, desktop/session label, displays/scales, helper/backend/protocol/version, helper SHA-256, adapter SHA-256, fixture SHA-256, source commit/dirty state, and Electron/Chromium versions. They omit the desktop window list, endpoint token, credentials, raw requests, and secure values. A failure produces exit code 1. Missing/unsupported cases are incomplete, never pass. Startup and successful capture/input are separate check results.

Attach the report to the [manual test report](manual-test-report.md) for real sessions. Native toolkit fixtures, mixed DPI/secondary displays, hardware GPU behavior, installed-app permissions, permission revocation, portal lifecycles, and installer identity still need N02–N04/D03 evidence. A successful Electron source harness cannot qualify those configurations.
