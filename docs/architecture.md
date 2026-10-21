# Architecture

Relay separates its renderer, persistence/control process, workflow utility process, and native service.

| Subsystem            | Responsibility                                                                       |
| -------------------- | ------------------------------------------------------------------------------------ |
| `src/renderer`       | React Flow editor, recorder, run history, schedules, targets, AI settings, themes    |
| `src/shared`         | Versioned contracts, Zod input validation, safe starter examples                     |
| `src/main/index.ts`  | Trusted IPC boundary, SQLite, OS-encrypted credentials, shortcuts, import/export     |
| `src/main/runner.ts` | Utility-process orchestration, schedules, recording, adapter routing                 |
| `src/engine`         | Frozen run graphs, validation, safe references, child dispatch, leases, cancellation |
| `src/integrations`   | Browser/native adapters, direct AI adapters, OpenCV and OCR detectors                |
| `native`             | Rust JSON-lines service and OS-specific input/capture implementation                 |
| `extension`          | Existing-browser recording and debugger transport                                    |

## Process boundary

The sandboxed renderer receives only the explicit `RelayAPI` through a context-isolated preload. Main-process requests validate their sender and schemas. Arbitrary filesystem or process APIs are not exposed to the renderer. The workflow engine runs in a separate Electron utility process; a native-process failure does not crash the editor.

The utility process receives selected provider keys from the main process. Keys are never sent to the renderer or exported with flows. The browser extension communicates through an authenticated loopback bridge with extension-origin checks. Browser pages cannot submit application IPC commands.

## Persistence

SQLite stores versioned JSON entities for flows, targets, schedules, and run records, plus settings and encrypted credential bytes. Workflow exports contain the root and its referenced child flows, target definitions, and embedded template images. Import resolves ID collisions and never executes a flow automatically.

Run events include redacted input/output and error evidence. Captures are held in a bounded in-memory cache; template crops explicitly selected by the user are persisted in node configuration. Continuous video is not stored. On restart, unfinished runs become interrupted, preserving evidence without replaying side effects.

## Resource ownership

Pure orchestration frames hold no resource lease. A concrete invocation reserves its transitive desktop and browser-profile resources atomically; nested calls inherit that reservation. Conflicting siblings serialize even under the same parent. Distinct managed browser profiles can run independently; an extension session is a shared resource.

Timeout and cancellation abort adapters, await child cleanup, and release held input before freeing a desktop reservation. Adapters must reject stale completions and avoid retrying a possibly completed input action. Native-process timeout recovery performs a separate input-release cleanup before admitting more input.

## Detection

Capture coordinates are separate from preview display size. Frames identify their target, capture time, source dimensions, and bounds. Region offsets are restored before a detected box becomes an action target. Detected-coordinate actions must include their source `frameId`; stale or moved/resized captures are rejected.

Local detection uses OpenCV template matching, Tesseract OCR, region colors, and image changes. Similar multiple template hits produce uncertain results. AI detection uses schema-validated answers and does not treat transport errors as “no match.” Jev Box results are discarded unless its independent presence answer passes the threshold.

## Current release boundaries

- The Linux X11 implementation is exercised on an isolated X server. Windows/macOS source is present but requires OS-specific runtime validation.
- Native semantic accessibility targeting is not implemented uniformly. Browser DOM targeting is available; native applications use supported pixel/input methods.
- Direct-use desktop recording is capability-gated. Wayland portal support and compositor restrictions differ from X11.
- The companion extension is loaded unpacked during development; store publication is separate.
- Browser executables and OCR/system utilities are external prerequisites for development packages.
- LLM chat-based flow authoring, distributed desktop workers, model hosting/download management, and cloud sync are not part of this version.
