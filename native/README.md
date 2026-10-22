# Native desktop service

Build with `npm run build:native` (Rust/Cargo required). The Electron runner starts `relay-native` and exchanges JSON lines over stdin/stdout. Commands are serialized. Each response has the request ID and either `result` or `error.message`. Recording events are asynchronous JSON lines. The service never evaluates workflow text as a shell command: application launch takes an executable and argument array.

## Platform coverage

| Platform      | Implementation                                                                                                                                              | Verification in this workspace                                                                                                                |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux X11     | Window lookup/focus/input through `xdotool`, PNG capture through ImageMagick `import`, application class via `xprop`; direct recording through XInput2      | Real capture, geometry guards, focus/key input, direct recording, cancellation and key release tested on an isolated Xvfb display             |
| Linux Wayland | Combined ScreenCast/RemoteDesktop portal session through `ashpd`; restricted PipeWire remote passed to GStreamer; portal pointer and keyboard notifications | Compiles on Linux; unavailable-backend gating tested. Actual compositor consent, PipeWire capture, and input require manual GNOME/KDE testing |
| Windows       | Win32 window enumeration, foreground checks, PrintWindow, SendInput/keyboard/mouse events, WM_CLOSE through an embedded PowerShell/C# helper                | Source implemented; no Windows host was available for build/runtime testing                                                                   |
| macOS         | CoreGraphics window enumeration and events, screencapture PNG, System Events window raise, permission checks                                                | Source implemented; no macOS host was available for build/runtime testing                                                                     |

Native accessibility selectors and passive direct recording on Windows/macOS are not implemented. Use guided preview recording and visual/OCR detectors there. Browser DOM selectors, detection and semantic recording are provided separately by the browser adapter on all platforms.

## Linux dependencies

For X11, install `xdotool`, ImageMagick (`import`), `xprop`, and for direct recording `xinput`, `xmodmap`, and `stdbuf`. Xvfb and xmessage are development test fixtures, not runtime requirements. Ubuntu/Debian package names commonly include `xdotool imagemagick x11-utils x11-xserver-utils xinput coreutils`.

For Wayland, the desktop must provide **both** `org.freedesktop.portal.ScreenCast` and `org.freedesktop.portal.RemoteDesktop`, plus PipeWire. Install GStreamer CLI tools and plugins providing `pipewiresrc`, `videoconvert`, and `pngenc` (commonly `gstreamer1.0-tools gstreamer1.0-pipewire gstreamer1.0-plugins-base gstreamer1.0-plugins-good`). Verify with `gst-inspect-1.0 pipewiresrc` and `gst-inspect-1.0 pngenc`.

Wayland capture/input is granted through the compositor's chooser for each target during the current helper session. Choose a monitor for multi-application workflows. Window sources depend on the compositor. A portal backend offering screenshot/screencast alone cannot grant remote input. Capabilities report unavailable services instead of falling back to XWayland or privileged uinput. There is no universal Wayland window list, programmatic application focus, window close, or passive global recorder. Click the granted source or focus the intended application before typing. A window title in a Wayland target is descriptive; the chooser determines the actual source. Source grants are not persisted across helper restarts.

OCR is provided by the TypeScript detector service using the Tesseract executable and language data. It is separate from this native helper.

## Permissions and limitations

Native input uses the real foreground application, pointer and keyboard. The desktop must be unlocked; users should avoid interacting with it while a flow runs. Preview clicks are translated from capture pixels to window/portal coordinates. The adapter rejects stale capture IDs, changed recording dimensions, ambiguous targets, and unsupported selectors.

macOS requires Screen Recording, Accessibility, and permission for System Events automation. Window titles must be available and uniquely identify the window within its application. Windows cannot inject into higher-integrity applications without matching privileges. PrintWindow can return blank content for some GPU, protected, minimized, or game windows even when the API succeeds; those applications need another capture backend before they can be claimed as supported. Exclusive fullscreen games, anti-cheat-protected software and protected media are not guaranteed on any platform.

The runner cancels native work by terminating the helper process group on Unix and waiting for a separate key/button release pass before reusing desktop input. Explicit held keys are tracked in both layers. Launched applications have independent process groups and remain open when a flow stops. Windows helper subprocess termination and stuck-key recovery still require real-platform validation.

## Protocol

Methods: `capabilities`, `listWindows`, `launch`, `capture`, `focus`, `input`, `close`, `releaseKeys`, `releaseAll`, `startRecording`, `stopRecording`, `ping`. Input kinds: `click`, `move`, `drag`, `scroll`, `type`, `key`. Desktop target matching is done by the TypeScript adapter; the helper receives a window handle or `portal:<targetId>`.

The browser extension uses its own authenticated loopback bridge; it does not use native messaging. See [extension setup](../extension/README.md).
