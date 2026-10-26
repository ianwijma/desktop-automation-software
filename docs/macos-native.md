# macOS capture, focus and permissions (N03)

Relay supports the macOS backend on macOS 14 or later. Cargo compiles an Objective-C bridge with Xcode Command Line Tools and links it into the existing Rust `relay-native` executable. Runtime capture/focus/input requires no compiler, screenshot command, AppleScript, private AX window-number API or separate service executable.

## Permissions and app identity

Open System Settings → Privacy & Security and grant **Screen Recording** and **Accessibility** to the Relay application/helper identity used for the run. Quit and reopen Relay after changing permissions if macOS requires it. A source Electron launch, a raw helper in a checkout, and a packaged `Relay.app` can have different permission identities; qualifying one does not qualify the others. The helper reports its executable path, bundle identifier, framework and separate permission/session states through existing capabilities IPC.

Capability probes never request consent or open system permission prompts. Every capture/input request rechecks its required permissions and session. Capture denial/revocation invalidates cached frames and stops the stream; an input release that cannot pass Accessibility preflight fails rather than acknowledging cleanup. The adapter keeps its cleanup barrier until permissions and release succeed. CoreGraphics event posting has no insertion-count/application-effect acknowledgement: a successful post is not proof the application responded. The harness checks those effects separately.

The session guard uses the public Window Server on-console/login state and rejects unavailable or loginwindow foreground sessions. Real lock/unlock, fast user switching, permission revocation and OS-version behavior still require explicit machine qualification; passive preflight is not a lock-screen guarantee. Relay does not bypass TCC or inject through a secure session.

## Windows and focus

Runtime window handles are CGWindowIDs, separate from owning PID and application bundle identity (or an owner/PID fallback). Saved coordinate workflows retain their existing target configuration. Unbound duplicate title matches remain ambiguous. Window handles are transient and same-process handle recycling is not universally detectable.

Once a window is selected, focus enumerates its owner's public AX windows and requires exactly one matching position/size. It activates the application, raises that AX window, then verifies the focused window, owner and geometry. It does not use a title to raise a window or call private AX-to-CGWindowID APIs. Duplicate titles with different geometry can be distinguished after binding; overlapping identical-geometry AX windows fail as ambiguous. Nonstandard applications that do not expose usable public AX geometry fail explicitly. General semantic AX selectors and direct macOS recording remain N06/N09.

## Capture and coordinates

The helper retains one `SCStream` for a `desktopIndependentWindow` filter and uses a three-frame queue. It excludes the capture cursor, audio and window shadow, bounds images to 40 million pixels, and keeps only the latest retained complete frame. PNG encoding happens on request. Static content may reuse a frame with its actual capture timestamp. Source loss invalidates it; recovery requires a subsequent explicit request and never switches to another capture backend.

Capture pixels map to **logical window-relative points**, with independent X/Y scales and a reported backing display scale. The helper verifies filter dimensions, current window geometry, owner and display scale before returning a frame. The adapter rejects frames after resize, helper/backend/owner changes or a display-scale change. A window can move without changing its logical local coordinates. Cross-display scale changes recreate the stream. Unsupported or ambiguous scale/geometry is an error, not a guessed offset. Spanning mixed-scale displays needs separate qualification.

Named key chords use physical ANSI key positions and are validated in full before any down event. Use Unicode text typing for layout-independent text; other keyboard layouts need explicit qualification. Modifier flags reflect owned modifiers; UTF-16 typing preserves surrogate pairs and refuses conflicting held modifiers. Long drags check focus/owner/session/geometry between steps. Pointer actions reject off-display or obscured layer-zero window points. Quartz events use the combined session source shared by a replacement helper. Cleanup releases owned/currently held buttons one at a time and requires the session button state to clear within a bounded wait; failure keeps input blocked. Key/button downs stay tracked until an allowed up event is posted; passive disposal only releases capture resources. Cancellation kills the helper, attempts a separate key/button release pass and leaves independently launched applications open.

## Qualification

Build on macOS with Rust and Xcode Command Line Tools:

```sh
npm run build:native
npm run test:native:macos -- --run
```

Run this only in an unlocked disposable session: it sends real input to its own synthetic windows. Without `--run`, it records incomplete/not-run and does not capture or inject input. The four cases are Electron/WebGL at renderer scales 1 and 1.5 and native AppKit button/text/secure/scroll/drag controls at content scales 1 and 1.5. AppKit uses an animated Metal surface when a device is available; its explicitly reported AppKit drawing surface otherwise does not qualify Metal/hardware capture. Synthetic scale is not a replacement for actual Retina or mixed-monitor testing.

The matrix covers observed pixels and input effects, Unicode text, resize/stale-frame rejection, minimize/source loss and explicit recovery, held-input cancellation/release, helper restart and duplicate targeting. Its authenticated local observation endpoint only reads state or manages fixture windows; it never synthesizes input or returns secure text. Reports record source/helper/adapter/fixture hashes and observed OS/session/display/backend identity.

CI uses `--allow-unavailable`: missing Screen Recording/Accessibility or an inactive desktop produces **incomplete/not-run**, never a native pass. It does not grant permissions automatically. Source and unpacked `Relay.app` smoke runs separately assert that the application loads the linked, bundled helper and reports macOS diagnostics. This verifies packaging/IPC/identity without claiming consented native input. Inspect `test-results/native-macos/report.json` and the per-case reports in the macOS verification artifact.

Before beta qualification, run the matrix on the installed application/helper identity with real Retina and secondary displays (including negative origins and mixed backing scales), physical GPU applications, same-title AX windows, denied/revoked permissions, lock/unlock, source closure/device interruption and cancellation. Record exact OS, architecture, signed artifact/path, grants and observations in the [manual test report](manual-test-report.md). DMG installation/upgrade and signing/notarization remain D01–D03 work.

## References

- [Apple ScreenCaptureKit](https://developer.apple.com/documentation/screencapturekit/scstream)
- [Apple capture frame metadata](https://developer.apple.com/documentation/screencapturekit/scstreamframeinfo)
- [Apple AXRaise](https://developer.apple.com/documentation/applicationservices/kaxraiseaction)
- [Apple AX messaging timeout](https://developer.apple.com/documentation/applicationservices/1459345-axuielementsetmessagingtimeout)
- [Apple Quartz event source state](https://developer.apple.com/documentation/coregraphics/cgeventsourcestateid)
- [Apple Window Server session state](https://developer.apple.com/documentation/coregraphics/window-server-session-properties)
