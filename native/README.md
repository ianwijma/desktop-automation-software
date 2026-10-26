# Native desktop service

Build with `npm run build:native` (Rust/Cargo required). The Electron runner starts `relay-native` and negotiates protocol 2 over JSON lines on stdin/stdout. Commands are serialized. Each response has the protocol version, request ID and either `result` or a structured error. Recording events are asynchronous JSON lines. The service never evaluates workflow text as a shell command: application launch takes an executable and argument array. See the [contract and desktop harness guide](../docs/native-contracts.md) for handshake, diagnostics, identities, transforms and qualification commands.

## Platform coverage

| Platform      | Implementation                                                                                                                                         | Verification in this workspace                                                                                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux X11     | Window lookup/focus/input through `xdotool`, PNG capture through ImageMagick `import`, application class via `xprop`; direct recording through XInput2 | Real capture, geometry guards, focus/key input, direct recording, cancellation and key release tested on an isolated Xvfb display                                                            |
| Linux Wayland | Persistent restricted PipeWire/GStreamer capture; EIS input or explicitly unsupported-method legacy notifications; grant/owner/geometry guards         | Private D-Bus/EI/EIS and persistent test-source coverage; [real GNOME/KDE qualification](../docs/wayland-native.md) remains pending                                                          |
| Windows       | Persistent Rust Win32 backend: Windows Graphics Capture, explicit PrintWindow, checked SendInput, DPI/foreground/integrity guards                      | Windows CI compiles/tests the backend and attempts the opt-in fixture matrix; see the N02 evidence for observed coverage                                                                     |
| macOS         | In-process ScreenCaptureKit streams, public AX owner/geometry focus, CoreGraphics events, permission/session guards                                    | 36/36 permission-granted hosted AppKit/Electron scenarios, WebGL/Metal pixels and source/packaged helper smoke; [qualification gaps](../docs/verification/n03-2026-10-27.md) remain explicit |

Windows semantic locators, read-only preview picking and supported UIA read/invoke/value/selection operations are implemented; see [native locators](../docs/native-locators.md). macOS AX/Linux AT-SPI targeting and passive Windows/macOS recording remain planned. Use guided preview recording and visual/OCR detectors where semantic operations are unavailable. Browser DOM selectors, detection and semantic recording are provided separately by the browser adapter on all platforms.

## Linux dependencies

For X11, install `xdotool`, ImageMagick (`import`), `xprop`, and for direct recording `xinput`, `xmodmap`, and `stdbuf`. Xvfb and xmessage are development test fixtures, not runtime requirements. Ubuntu/Debian package names commonly include `xdotool imagemagick x11-utils x11-xserver-utils xinput coreutils`.

For Wayland, the desktop must provide **both** `org.freedesktop.portal.ScreenCast` and `org.freedesktop.portal.RemoteDesktop`, plus PipeWire. Install GStreamer CLI tools and plugins providing `pipewiresrc`, `videorate`, `videoconvert`, `pngenc` and `fdsink` (commonly `gstreamer1.0-tools gstreamer1.0-pipewire gstreamer1.0-plugins-base gstreamer1.0-plugins-good`). Verify with `gst-inspect-1.0 pipewiresrc` and `gst-inspect-1.0 pngenc`.

Wayland capture/input is granted through the compositor's chooser for each target during the current helper session. Choose a monitor for multi-application workflows. Window sources depend on the compositor. A portal backend offering screenshot/screencast alone cannot grant remote input. Capabilities report unavailable services instead of falling back to XWayland or privileged uinput. There is no universal Wayland window list, programmatic application focus, window close, or passive global recorder. Click the granted source or focus the intended application before typing. A window title in a Wayland target is descriptive; the chooser determines the actual source. Source grants are not persisted across helper restarts. Capture explicitly grants the source before input; source loss requires explicit recapture. See [N04 setup, cleanup and qualification](../docs/wayland-native.md).

OCR is provided by the TypeScript detector service using the Tesseract executable and language data. It is separate from this native helper.

## Permissions and limitations

Native input uses the real foreground application, pointer and keyboard. The desktop must be unlocked; users should avoid interacting with it while a flow runs. Preview clicks are translated from capture pixels to window/portal coordinates. The adapter rejects stale capture IDs, changed recording dimensions, ambiguous targets, and unsupported selectors.

macOS 14+ requires Screen Recording and Accessibility for the running app/helper identity. No System Events or Automation permission is used. Public AX focus requires a unique owner/geometry match; duplicate titles alone do not choose a window, and identical geometry is rejected as ambiguous. Windows cannot inject into higher-integrity applications without matching privileges. PrintWindow can return blank content for some GPU, protected, minimized, or game windows even when the API succeeds; those applications need another capture backend before they can be claimed as supported. Exclusive fullscreen games, anti-cheat-protected software and protected media are not guaranteed on any platform.

The runner cancels native work by terminating the helper process group on Unix or the persistent helper alone on Windows, then waits for a separate key/button release pass before reusing desktop input. Explicit held keys are tracked in both layers. Launched applications remain open when a flow stops. Windows cancellation/recovery is exercised by the opt-in matrix and still needs real Windows 11 qualification.

## Protocol

Methods: `handshake`, `capabilities`, `listWindows`, `launch`, `capture`, `focus`, `input`, `close`, `releaseKeys`, `releaseAll`, `releaseCapture`, `startRecording`, `stopRecording`, `ping`. Input kinds: `click`, `move`, `drag`, `scroll`, `type`, `key`. Desktop target matching is done by the TypeScript adapter; the helper receives a window handle or `portal:<targetId>`, plus expected application identity when known. Both binaries must use the same protocol; unsupported versions fail closed.

The browser extension uses its own authenticated loopback bridge; it does not use native messaging. See [extension setup](../extension/README.md).

Windows targets must choose a capture method in Settings → Applications. New targets show Windows Graphics Capture by default; existing targets require an explicit selection. Protocol 2 adds capture-source offsets, DPI guards and input-free capture cleanup. See [Windows backend and qualification](../docs/windows-native.md).

On macOS, Cargo invokes Xcode Command Line Tools to compile the Objective-C bridge and unbundled AppKit/Metal fixture. The runtime remains a single `relay-native` binary; no Objective-C compiler, screenshot command, AppleScript or extra sidecar is invoked during automation. See [macOS backend and qualification](../docs/macos-native.md).
