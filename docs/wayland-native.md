# Wayland portal sessions (N04)

Relay uses the desktop's RemoteDesktop/ScreenCast portals and the restricted PipeWire remote returned for the selected source. It never substitutes XWayland, unrestricted PipeWire, privileged input devices, or another desktop source. An explicit Wayland session stays on this backend even when `WAYLAND_DISPLAY` is missing.

## Setup and permission boundaries

A Wayland desktop needs PipeWire, a working `xdg-desktop-portal` frontend and a GNOME/KDE backend implementing **both RemoteDesktop and ScreenCast**. A screenshot-only portal is insufficient. Install GStreamer CLI tools and plugins providing `pipewiresrc`, `videorate`, `videoconvert`, `pngenc` and `fdsink`. X11 does not acquire these runtime requirements.

Capture the target in the preview or use a Screenshot/detector step before sending input. Capture explicitly opens the chooser; select a monitor for multi-application automation. Typing acts on the currently focused application within the grant. Universal window enumeration, title-based attach/focus/close, and passive global recording remain unsupported. A portal target ID identifies an authorized source, not an application window handle.

Passive capabilities probe interfaces, versions and plugins without creating a session or opening a chooser. Discovery is not consent. Active grants, the chosen input transport, media availability and portal identity are reported separately. Input requires a previously captured source token and never opens or restores a grant itself.

Chooser cancellation closes the request/session and returns Cancelled. A denied grant, lost source, changed geometry, revoked session or changed portal owner stops input. Capture is the explicit recovery action; it may show another chooser. Stop interrupts a pending chooser even when the preview request had no action AbortSignal. No request is replayed after cancellation or helper restart.

## Persistent capture and coordinates

Each grant has one persistent GStreamer process consuming **only the restricted PipeWire FD**, inherited as FD 3. PipeWire buffers are converted to a PNG stream over stdout; a bounded reader retains the latest complete image in memory. There are no per-screenshot processes or temporary desktop image files. The helper caps buffers, drops frames above 15 fps without duplicating idle frames, limits images to 40 million pixels and encoded PNGs to 64 MiB, and kills/reaps the process on closure. The capture process also terminates if its helper parent dies.

Newer portals' `pipewire-serial` targets the nonreusable PipeWire object identity. Older portals use their granted node ID within that session. A version-6 portal missing its promised serial fails explicitly. Returned logical source size is required; it is never guessed from PNG dimensions. Pixel-to-input X/Y ratios use the captured pixels and granted logical size independently.

EIS absolute coordinates require a unique source `mapping_id` match and matching logical region size, including among multiple absolute devices. The region's origin is applied after source-local mapping. Missing/ambiguous mapping fails rather than using an arbitrary monitor or offset. EIS device pause/removal and portal session/owner loss invalidate the grant. A changed capture pixel size invalidates cached geometry; explicit recapture establishes fresh metadata. Legacy backends without enough source-change metadata still need real fractional-scale/hotplug qualification.

A source token binds frames and input to this grant, helper instance and pixel geometry. It is not a permission-restoration credential. Old frames cannot authorize input after regranting/restart. Idle images retain their actual receipt timestamp; source/transport failure invalidates them instead of refreshing their timestamp.

## Input and cleanup

Relay attempts `ConnectToEIS` when the portal supports it. An established EIS socket fixes that session's input transport. Handshake failure, missing devices, pause, disconnect, denial or timeout never switches to legacy notifications. Legacy is used only before EIS exists, for older portal versions or an explicitly unsupported ConnectToEIS method.

EIS sends framed absolute motion, buttons, scrolling and keyboard/text events through the granted devices. UTF-8 text uses `ei_text` when available. Otherwise, characters must exist in the supplied XKB keymap's default layout/levels; unsupported characters, composition or layout state fail explicitly before partial text. Named chords are fully validated before downs. Unicode keysym typing on the legacy transport remains compositor-dependent and requires qualification. No US-layout Unicode guesses or clipboard substitution are used.

Keys and buttons are tracked until release succeeds. EIS cleanup uses a server round trip before closing a used grant. This confirms protocol processing, not application effects; the harness observes effects separately. Any failed release/close blocks further capture/input across targets until cleanup succeeds. An unrecoverable transport loss requires closing the sharing session and restarting Relay.

Cancellation asks the original helper to release input and close its own sessions, and requires its cleanup acknowledgement and successful exit. A replacement helper cannot clean up somebody else's grant and is never used to pretend that it did. A bounded forced termination remains available for an unresponsive helper, but cannot count as acknowledged cleanup. Independently launched applications survive cancellation.

## Restoration and application identity

When RemoteDesktop supports restoration, Relay requests application-lifetime persistence, consumes a single-use restore token before attempting it, and replaces it with the token returned by Start. Tokens stay in bounded helper memory, outside workflows, screenshots, diagnostics and logs. They are not saved across helper/application restarts. Restoration is best-effort: the portal may require selection/consent again or omit persistence altogether.

The Linux package uses `dev.relay.desktop.desktop` as its desktop filename and Electron portal identity. When that matching desktop file is installed, the helper registers `dev.relay.desktop` on its own D-Bus connection before portal calls, if the host Registry interface supports it. Source runs without an installed desktop entry report `unregistered`; they do not qualify installed-app permissions/restoration.

Electron provides the GlobalShortcuts portal integration. Relay preserves Stop/Pause callbacks, registration-failure feedback and the UI/tray Stop action. Accept any desktop shortcut consent and verify that Stop/Pause are actually delivered in the tested session. Registration is not proof of delivery, including when the portal returns before consent completes. Installer/desktop-entry and GNOME/KDE shortcut delivery qualification remain explicit.

## Verification

```sh
npm run build:native
cargo test --manifest-path native/Cargo.toml
npm run check
npm run test:native:wayland
```

The Rust tests use a private D-Bus daemon and a synthetic EI/EIS socket server, never the user's portal/session bus. They cover wire dictionaries, logical geometry/serials, token rotation, cancellation/denial cleanup, session/portal-owner loss, framed EIS input, multiple mapped devices, round-trip release and terminal socket loss. The persistent consumer test uses GStreamer's `videotestsrc`; it is not a real PipeWire/portal grant. The TypeScript tests cover source identity/transforms, revoked/stale frames, Stop during selection, and acknowledged/failed cancellation cleanup.

Without `--run`, the Wayland harness records **incomplete/not-run** and opens no chooser or application. For a real, disposable GNOME or KDE Wayland session:

```sh
npm run test:native:wayland -- --run
```

The harness launches its own native Wayland Electron fixture, asks for explicit source selection and focus, locates the known visible marker instead of trusting window positions, and observes capture, input, graphics, cancellation, explicit regrant and stale-frame rejection. Its authenticated observation endpoint cannot synthesize input. Reports contain source/helper/adapter/fixture hashes and only synthetic observations; full desktop images and secure text are not written. Inspect `test-results/native-wayland/report.json`.

Repeat on GNOME and KDE with exact desktop/portal/PipeWire versions, real fractional and secondary displays, source closure/hotplug, denied/revoked grants while idle and held, compositor restart, restored grants, installed-app identity and actual Stop/Pause delivery. Use the [manual test report](manual-test-report.md). Unexecuted rows remain Not run. See [N04 evidence](verification/n04-2026-10-27.md) for the scope actually exercised.

## References

- [RemoteDesktop portal](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.RemoteDesktop.html)
- [ScreenCast source/coordinate/serial contract](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.ScreenCast.html)
- [Host application registry](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.host.portal.Registry.html)
- [EI/EIS Rust protocol implementation](https://github.com/ids1024/reis)
- [Electron global shortcuts and Linux portal identity](https://www.electronjs.org/docs/latest/api/global-shortcut)
