# Relay

A local desktop automation workbench. Build node graphs, teach actions through a window preview, add visual or AI detectors, and coordinate reusable workflows in sequences, rolling pools, or fixed batches.

The agreed [beta implementation roadmap](docs/beta-roadmap.md) tracks follow-up PRs, including image-capable chat authoring and offline installers. See the [verification matrix](docs/platform-support.md) for implemented capabilities versus tested support.

## Run locally

Use Node.js 24 or later and a current Rust toolchain.

```sh
npm install
npm run install:browser
npm run build:native
npm run dev
```

`npm run dev:web` opens an **editor preview** with local browser storage. It can edit flows and themes, but it cannot control applications or run AI. Use the Electron app for automation.

The first workspace contains three examples:

- **Your first workflow** runs safely without controlling any applications.
- **Explore a website** opens a separate Chromium profile and reads a heading.
- **Orchestrate a batch** calls the first flow twelve times in four batches of three.

Open Settings to add desktop targets, configure providers, and check capabilities. Native coordinate actions use the real desktop; F8 stops workflows and F7 pauses by default. Both shortcuts are configurable.

## Desktop prerequisites

- **Linux X11:** `xdotool`, `xwininfo`, `xprop`, and ImageMagick (`import`), with `xinput` for direct recording. Install Tesseract and its language data for OCR. On Debian/Ubuntu: `sudo apt install xdotool x11-utils xinput imagemagick tesseract-ocr`.
- **macOS 14+:** grant Screen Recording and Accessibility to Relay and its bundled helper in System Settings → Privacy & Security. The persistent helper links ScreenCaptureKit and public Accessibility APIs directly. See [macOS setup and qualification](docs/macos-native.md).
- **Windows:** the persistent Rust adapter uses Windows Graphics Capture and checked SendInput. Choose a capture method per target in Settings → Applications; PrintWindow is an explicit compatibility choice. Input requires an unlocked interactive desktop and a target at equal or lower integrity. See [Windows setup and qualification](docs/windows-native.md).
- **Wayland:** support is capability-based and requires a compositor implementing the RemoteDesktop and ScreenCast portals. See the native implementation notes for the current backend requirements. Direct global recording is not universally available. See [Wayland setup and qualification](docs/wayland-native.md).

The app reports available capabilities and explanations in Settings. Platform implementations must be tested on their actual operating systems; a successful Linux build does not verify Windows/macOS behavior. [Native semantic locators and a read-only preview picker](docs/native-locators.md) support Windows UIA and macOS AX read/invoke/value/selection where providers expose those operations. Linux AT-SPI targeting remains planned; coordinate/image targeting is an explicit alternative.

See [native platform setup and limitations](native/README.md) for details, including the Wayland GStreamer requirements and capture restrictions for GPU-rendered applications.

## Browser connection

Managed Chromium profiles are independent from your normal browser profile and keep their own logins. Install the browser with `npm run install:browser` before the first run.

For an existing Chrome/Edge session:

1. Open the browser's extension manager and enable developer mode.
2. Load the `extension/` directory as an unpacked extension.
3. In Relay Settings, reveal the browser pairing details.
4. Enter the local port and pairing token in the extension popup.
5. Add a browser target using the extension connection.

The bridge listens only on loopback and authenticates requests. Pairing is scoped to the running application session; browser extension permissions and restricted pages still apply. The extension uses the browser's debugger permission while controlling a tab. Frame targeting requires Chrome/Chromium 125+ debugger child-session support.

Browser actions and recordings support shared test-attribute, role/name, label, ID, and CSS locators, including frame and open shadow-root scopes. Use **Test match** in node properties or recording review to inspect a target without sending input. See [browser locators](docs/browser-locators.md).

## AI connections

Connections support OpenAI-compatible APIs, OpenRouter, Anthropic, Gemini, Jev, Ollama, and LM Studio. Supply the endpoint and exact model you want to run. Local runtimes are managed outside Relay.

For OpenRouter, select its provider preset, add your OpenRouter API key, and enter the model ID from its model catalog. The default endpoint is `https://openrouter.ai/api/v1`. Enable vision and structured output only for models that support those features.

API keys are encrypted with the operating system's credential service. On Linux, a functioning Secret Service or KWallet is required to persist keys; Relay refuses Electron's plaintext fallback. Keys are never included in workflow exports. Screenshot inference is sent only to the connection selected for that node; there is no automatic cloud fallback.

Jev vision is experimental and must be enabled in its connection. Presence is checked independently before accepting a location. AI generation and detection results are validated; uncertain perception is distinct from a negative result or transport failure.

## Workflow model

Execution follows explicit edges. Use conditions for branches and bounded loop nodes to call child flows repeatedly. Arbitrary cycles and recursive child references are rejected.

Choose **Use value from…** beside a node field to select flow inputs, variables, or earlier node outputs. The picker shows readable names while storing stable references such as `${inputs.name}`, `${vars.name}`, and `${nodes.nodeId}`. Exact references preserve JSON types; embedded references interpolate strings. There is no arbitrary JavaScript evaluation. See [working with values and references](docs/value-references.md).

Use the inspectors to configure duration or detector waits, numeric conditions, count or foreach loops, child-input overrides, and structured AI output schemas. Flow overview edits typed input defaults and output mappings. Advanced JSON remains available. See [structured inspectors and flow interfaces](docs/structured-inspectors.md).

Recording keeps a recoverable local draft: pause to switch targets, stop to review, edit and undo steps without replaying them, then insert into a new flow or a chosen edge/output in the original flow. Connected successors are preserved, decision branches are explicit, and the whole insertion supports graph undo/redo. Restart always opens the draft in review. Direct browser recording covers text/paste/composition, stateful controls, click variants, shortcuts, scrolls, ordinary drags, navigation, and owned popup tabs. Pending text is saved on Pause/Stop; unsupported or omitted interactions require configuration before running. See [recording and reviewing a workflow](docs/recording.md) and [browser recording coverage](docs/browser-recording.md).

To click an image or AI-detected object, connect the detector's **match** output to a Click node. Beside **Detected result**, choose **Use value from…** and select the detector's complete result. Use the same application target for both nodes. Relay clicks the box center and verifies its capture is still fresh and belongs to the selected target. Enable location output for AI detectors; browser element detection uses selectors or structured locators.

A root run snapshots its complete referenced flow tree. Child results preserve input order. Desktop-dependent work reserves the physical desktop across waits; independent browser profiles and AI work can overlap. Nested callers inherit reservations without allowing conflicting siblings to run together.

Schedules use a named timezone and run while Relay remains open, including in the tray. Offline/missed or overlapping occurrences are skipped. Interrupted runs are retained for review and are never automatically replayed. Closing the app does not undo actions already taken in another application.

## Development and verification

```sh
npm run typecheck
npm test
npm run build
npm run test:ui
npm run test:smoke
```

The UI test exercises the editor, history, theme settings, and schedules using an isolated browser context. It starts and stops its own Vite server. The desktop smoke test launches a separate Electron instance with temporary data. On Linux, run it in an isolated X server when testing actual desktop input:

```sh
RELAY_SMOKE_NATIVE=1 xvfb-run -a npm run test:smoke
```

The smoke launcher disables the Chromium sandbox **only for the isolated test process**. Normal application windows keep context isolation and renderer sandboxing enabled.

`npm run package` builds a platform installer. Signing requires the relevant developer credentials. The managed Chromium runtime and external OCR/system utilities must be installed on the destination machine. Do not interpret an unsigned development package as a signed public release.

The CI workflow builds and checks Windows, macOS, and Linux separately. Only tests actually run on a platform validate it; adding the workflow does not establish support for untested native APIs.

Architecture and implementation boundaries are documented in [docs/architecture.md](docs/architecture.md). The [native contract and harness guide](docs/native-contracts.md) explains protocol negotiation, backend/permission diagnostics, coordinate transforms, and explicit desktop qualification runs. Browser and native adapters include platform-specific tests; cloud-provider behavior is tested with mocked requests so the test suite does not require API keys or consume inference credits.

[AI connection checks](docs/ai-connection-checks.md) track text, decision, structured, image and localization evidence separately. Model, endpoint, capability and credential changes make previous results stale; probes run only from labeled actions.

[AI diagnostics and OpenRouter discovery](docs/ai-diagnostics.md) add cancellable checks, provider-reported model/timing/usage metadata, cached model search with manual IDs, and allowlisted JSON exports. Catalog selection never enables or verifies capabilities automatically.
