# Windows capture and input (N02)

Relay's Windows helper is a persistent Rust process. It enumerates Win32 windows, retains one Windows Graphics Capture (WGC) session for the selected window, and sends checked `SendInput` batches. No PowerShell or per-request compiler is used. The Windows-only `windows-capture` dependency is pinned to 2.0.1. The fixture executable is a test tool and is excluded from the application package.

## Configure a target

Build the helper with `npm run build:native`, then open Settings → Applications. A new Windows desktop target shows **Windows Graphics Capture (recommended)**. For an existing target, choose the method explicitly before capturing; Relay preserves unset legacy configuration rather than changing its capture behavior silently.

- **Windows Graphics Capture:** retains a session/frame pool for the selected HWND and owning PID. Keeps the system capture indicator. Returns actual frame timestamps, including a cached frame for static content. Resize, source closure, session failure and inconsistent frame geometry fail or recreate the session on a subsequent explicit request.
- **PrintWindow compatibility:** native GDI capture with bounded buffers and scoped GDI handles. It can return blank GPU/protected content even when Windows reports success. Relay never selects it following a WGC failure. It must be chosen in the target configuration.

The persisted optional `windowsCaptureBackend` is `wgc` or `printwindow`, only for desktop targets. Changing it invalidates the target's cached capture. Workflow/database version 2 and recording envelope version 1 remain unchanged. **Native protocol 2** is required on both sides; rebuild the helper when updating the app.

## Geometry and guards

The helper requests per-monitor-v2 DPI awareness before window APIs. Existing coordinates remain physical pixels relative to `GetWindowRect`. WGC can omit invisible resize borders; the response includes the actual capture source rectangle, offsets into the input rectangle, independent axis scales and DPI. The adapter applies each offset/scale once, then the helper resolves the current screen origin. Absolute pointer normalization uses the full virtual desktop, including negative monitor coordinates.

Capture metadata must match the helper instance, target/backend, owner, dimensions, DPI and validated contained source rectangle. A failed capture clears the previous frame. Old frames cannot be reused after mode changes, resize, DPI change or helper restart. Moving a window preserves window-relative coordinates. Input checks foreground identity, integrity, desktop, geometry and the window under a pointer action; an obscuring window is an error.

Input requires an unlocked interactive desktop and a target at equal or lower integrity. Unknown privilege fails closed. Relay verifies foreground acquisition instead of bypassing foreground restrictions. `SendInput` must acknowledge every event; partial insertion is an error and is never retried as an action. Accepted key/button downs remain owned until their ups are acknowledged. Unicode text uses UTF-16 events, and supported key chords are completely validated before any down event. Cancellation waits for cleanup; a failed cleanup blocks further desktop input.

Passive capability checks describe prerequisites, not verified behavior. Disposing a helper that never attempted input stops capture resources without sending global key/button releases. `releaseCapture` is a protocol-2 operation; emergency input cleanup remains separate. Direct Windows recording and UIA selectors remain N08 and N05 respectively.

## Qualification commands

Run only in an unlocked disposable Windows desktop: these commands send real input to their own fixture windows.

```sh
npm run build:native
npm run test:native:windows -- --run
```

The matrix runs Electron/WebGL at renderer scales 1 and 1.5, native Win32 BUTTON/EDIT/password/scroll/drag/animated-GDI controls at content scales 1 and 1.5, and an explicitly selected PrintWindow native-control case. Hosted Electron fixtures use SwiftShader and software compositing; this is not hardware GPU coverage. Each case tests observed capture pixels, Unicode text, click/scroll/drag, resize, held-input cancellation, helper replacement, duplicate targeting, and minimized capture failure followed by recovery on the same selected backend. Observation endpoints never synthesize input or return secure text. All cases run even if an earlier case fails, and any failure fails the matrix.

Hosted Windows CI uses `--allow-unavailable`: if the interactive desktop, DPI setup or required graphics device is unavailable before input, cases produce **incomplete / not-run** reports. Actual scenario failures still fail the job. Review `test-results/native-windows/report.json` and per-case reports in the Windows verification artifact; a green build with incomplete cases is not native qualification.

Without `--run`, the matrix sends no input. A single case can be selected with:

```sh
npm run test:native -- --run --fixture=win32 --capture-backend=wgc --content-scale=1.5
npm run test:native -- --run --fixture=win32 --capture-backend=printwindow
```

Reports include helper/adapter/fixture hashes, backend/protocol, source revision/dirty state, OS/session/displays and observed DPI. Synthetic renderer/content scales do **not** change Windows display DPI. Before beta platform qualification, repeat on Windows 11 x64 with real 100/150/200% monitor scaling, move across mixed-DPI displays (including negative origins), physical GPU Chromium applications, capture permission/device loss, elevated-target denial, and the installed NSIS artifact. Record those observations in the [manual test report](manual-test-report.md). Protected media, secure desktops and exclusive fullscreen/anti-cheat applications are outside the support guarantee.

## API references

- [Microsoft: SendInput acknowledgements and integrity restrictions](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput)
- [Microsoft: GetWindowRect, DPI and invisible borders](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getwindowrect)
- [Microsoft: per-monitor DPI awareness](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setprocessdpiawarenesscontext)
- [Microsoft: Windows Graphics Capture](https://learn.microsoft.com/en-us/windows/apps/develop/media-authoring-processing/screen-capture)
- [windows-capture crate documentation](https://docs.rs/windows-capture/2.0.1/windows_capture/)
