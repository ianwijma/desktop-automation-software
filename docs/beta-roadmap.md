# Relay beta completion roadmap — after PR #1

This is the agreed implementation plan for completing Relay's personal/friends beta. It builds on [PR #1](https://github.com/ianwijma/desktop-automation-software/pull/1), including OpenRouter support. Work-item IDs are permanent references for future PRs, independent of GitHub PR numbers.

## Goal and agreed decisions

Deliver a usable desktop automation app with manual graph authoring, teach-by-doing recording, and **image-capable AI chat authoring**. Preserve the existing visual direction, themes, configurable accents, local execution model, and bring-your-own AI connections.

| Area                | Decision                                                                                                                                |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Audience            | Personal use and a small group of friends.                                                                                              |
| Platforms           | Windows 11 x64; macOS 14+ on Apple Silicon; Ubuntu 24.04 x64 with GNOME/KDE session checks.                                             |
| Verification        | Hosted CI plus documented manual tests in real desktop sessions.                                                                        |
| Chat                | Required for beta. Review generated changes before Apply; Run remains separate.                                                         |
| Chat images         | Paste, drag/drop, file upload, and explicit capture of a selected application window.                                                   |
| Existing-flow edits | Update an unchanged manual flow after review. If schedules/hotkeys can reach it, directly or through parents, save an unscheduled copy. |
| Distribution        | Offline installers bundling Chromium, OCR, and application runtimes. Document unavoidable Linux system prerequisites.                   |
| OCR                 | English and orientation detection bundled; additional language packs importable offline.                                                |
| AI ownership        | User-provided API keys or user-managed local runtimes. No bundled model server or LLM weights.                                          |

Capability claims distinguish **implemented**, **automatically tested**, and **manually verified**. Compilation alone never establishes desktop automation support.

## Tracking and implementation order

Statuses: `planned`, `in progress`, `implemented`, `verified`. `Implemented` means code exists; `verified` requires the item's specified evidence, including manual evidence where applicable. A missing test machine is a verification gap, not a passing result.

| ID  | Work item                                        | Dependencies                                        | Status      | Implementation / evidence                                                                                                                                                      |
| --- | ------------------------------------------------ | --------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F01 | Roadmap and verification baseline                | PR #1 baseline                                      | verified    | [Baseline](platform-support.md), [report template](manual-test-report.md), [foundation evidence](verification/foundations-2026-10-22.md).                                      |
| F02 | Shared schemas, migrations, revision-safe writes | F01                                                 | verified    | Shared registry, schema 2 migration, transactional saves, conflict UI; [tests and limits](verification/foundations-2026-10-22.md).                                             |
| U01 | Output/reference picker and typed values         | F02                                                 | verified    | Keyboard reference picker, typed values, branch warnings; [guide](value-references.md) and [verification](verification/u01-2026-10-22.md).                                     |
| U02 | Structured inspectors and flow interfaces        | U01                                                 | verified    | Mode controls, flow interfaces, child mappings, and AI schema builder; [guide](structured-inspectors.md) and [verification](verification/u02-2026-10-22.md).                   |
| R01 | Recording drafts, pause, review                  | F02, U02                                            | verified    | Session-bound drafts, pause/target switch, review editing, recovery, and explicit insertion; [guide](recording.md) and [verification](verification/r01-2026-10-25.md).         |
| R02 | Predictable graph insertion                      | R01                                                 | verified    | Explicit edge/output anchors, successor splicing, branch choice, and graph undo/redo; [guide](recording.md) and [verification](verification/r02-2026-10-25.md).                |
| B01 | Shared browser locators and event extraction     | F02                                                 | verified    | Shared runtime, structured locator controls, frame/shadow replay, and Test match; [guide](browser-locators.md) and [verification](verification/b01-2026-10-25.md).             |
| B02 | Broader browser recording coverage               | B01, R01                                            | verified    | Shared event normalization, stateful replay, pending-input cleanup, owned tabs and warnings; [guide](browser-recording.md) and [verification](verification/b02-2026-10-26.md). |
| N01 | Native contracts and real desktop test harness   | F02                                                 | implemented | Versioned handshake/errors, application identity, capture transforms and real fixture harness; [guide](native-contracts.md) and [evidence](verification/n01-2026-10-26.md).    |
| N02 | Windows capture/input backend                    | N01                                                 | implemented | Persistent WGC/checked SendInput, explicit PrintWindow, protocol 2 and Windows fixture matrix; [guide](windows-native.md), [evidence](verification/n02-2026-10-26.md).         |
| N03 | macOS capture/focus/permissions                  | N01                                                 | implemented | Persistent ScreenCaptureKit/public AX, permission/session guards and AppKit/Electron matrix; [guide](macos-native.md), [evidence](verification/n03-2026-10-27.md).             |
| N04 | Wayland session completion                       | N01                                                 | implemented | Persistent restricted capture, fixed EIS/legacy transport, explicit grants/recovery and cleanup barriers; [guide](wayland-native.md), [evidence](verification/n04-2026-10-27.md).                                                                                                                                                                              |
| N05 | Element picker and Windows UIA                   | N02, U01                                            | planned     | —                                                                                                                                                                              |
| N06 | macOS AX targeting                               | N03, N05                                            | planned     | —                                                                                                                                                                              |
| N07 | Linux AT-SPI targeting                           | N01, N05; N04 for Wayland integration               | planned     | —                                                                                                                                                                              |
| N08 | Windows direct recording / shared normalization  | N05, R01                                            | planned     | —                                                                                                                                                                              |
| N09 | macOS direct recording / X11 parity              | N06, N07, N08, R01                                  | planned     | —                                                                                                                                                                              |
| A01 | Accurate connection checks                       | F02                                                 | planned     | —                                                                                                                                                                              |
| A02 | Jev image preparation/localization confidence    | A01                                                 | planned     | —                                                                                                                                                                              |
| A03 | AI diagnostics / OpenRouter discovery            | A01, U01                                            | planned     | —                                                                                                                                                                              |
| A04 | Live provider/local-model conformance            | A02, A03                                            | planned     | —                                                                                                                                                                              |
| C01 | Chat service and proposal contract               | F02, U02, A01                                       | planned     | —                                                                                                                                                                              |
| C02 | Image attachments / chosen-window capture        | C01, N01                                            | planned     | —                                                                                                                                                                              |
| C03 | Graph review, binding, Apply                     | C02, U01, F02                                       | planned     | —                                                                                                                                                                              |
| C04 | Chat history / authoring acceptance              | C03, A04                                            | planned     | —                                                                                                                                                                              |
| D01 | Bundled runtimes / offline installers            | N01, F02; completed backends for final verification | planned     | —                                                                                                                                                                              |
| D02 | First-run setup / diagnostics                    | D01, A03, R02, B02                                  | planned     | —                                                                                                                                                                              |
| D03 | Beta qualification / release artifacts           | All required items                                  | planned     | —                                                                                                                                                                              |

Intended sequence: land PR #1; complete F01 → F02; start U01/U02, N01, and A01/A02 in parallel; develop recording/browser, native backends, AI diagnostics, and packaging as independent tracks. Chat can begin once schemas and AI checks are stable without waiting for every native enhancement. Finish onboarding after diagnostics/recording stabilize, then qualify actual installers and live models.

PR #1 through PR #4 landed on 2026-10-22, PR #5 and PR #6 landed on 2026-10-25, and PR #8, PR #9, and PR #10 landed on 2026-10-26 (Sydney). F01/F02, U01, U02, R01, R02, B01, and B02 are implemented and locally verified. N01 is implemented and its eight-scenario harness is locally verified on isolated X11 with software graphics; native Windows/macOS and real-session qualification remain pending. N02 is implemented with 45/45 hosted Windows desktop scenarios passing across five Win32/Electron/WGC/PrintWindow cases; real Windows 11/mixed-DPI/hardware-GPU/installer qualification remains open. PR #11 landed on 2026-10-27 (Sydney). N03 is implemented with linked ScreenCaptureKit/public AX, 36/36 permission-granted hosted AppKit/Electron scenarios and source/packaged helper smoke passing; real Retina/secondary-display, revocation/locking and installed-app qualification remain explicit. PR #12 landed on 2026-10-27 (Sydney). N04 is implemented with persistent restricted capture, portal/EIS lifecycle and cleanup contracts, and an opt-in compositor harness; real GNOME/KDE qualification remains pending. The next slice is N05: element picker and Windows UIA; A01 can start independently. These statuses do not imply beta completion or new platform qualification.

Each item is intended as a focused PR. Larger items may be split into suffixed PRs, such as N02a/N02b, without losing their acceptance criteria. Each implementation PR references IDs and updates this table with evidence. Changes to agreed scope must be recorded here explicitly.

## Shared architecture and compatibility

Introduce a common node-definition registry containing configuration validation/defaults, typed input/output metadata, execution ports, target/provider requirements, and metadata shared by inspectors, reference pickers, and chat generation. Keep icons and visual styling in the renderer.

Preserve `${inputs.name}`, `${vars.name}`, and `${nodes.nodeId}`. Exact references retain JSON types; interpolation remains text. Do not add arbitrary JavaScript evaluation.

| Contract             | Planned addition                                                                          |
| -------------------- | ----------------------------------------------------------------------------------------- |
| Workflow persistence | Revision-aware saves and atomic graph changes with explicit conflicts.                    |
| Workflow format      | Version 2; version 1 import/migration remains supported.                                  |
| Node definitions     | Shared schemas, output metadata, capability requirements.                                 |
| Targeting            | Typed browser/native locators alongside coordinate/detector targeting.                    |
| Native protocol      | Handshake, structured errors/capabilities, capture identity and coordinate transforms.    |
| Recording            | Session IDs, capture/pause/review phases, recoverable drafts, explicit insertion anchors. |
| AI diagnostics       | Results per operation tied to connection and credential revisions.                        |
| Chat                 | Sessions, attachment IDs, proposals, events, cancellation, revision-checked Apply.        |

Every IPC change needs preload exposure, main-process validation, desktop behavior, and explicit browser-preview behavior. The web preview remains an editor preview, not native execution.

Compatibility requirements:

- Preserve workflow/node IDs, references, advanced configuration, and execution semantics during migration.
- Make a consistent database backup before migration and migrate transactionally. Failed migration must preserve the original database.
- Reject unsupported future versions rather than partially interpreting them.
- Keep API keys out of workflows, exports, chat context, and diagnostics.
- Preserve resource leases, immutable run snapshots, cancellation cleanup, bounded loops, and distinct match/no-match/uncertain/error outcomes.
- Never silently change coordinate workflows to semantic targeting or another capture backend.

## PR implementation specifications

### Foundation

#### F01 — Roadmap and verification baseline

Record this plan, a [platform support matrix](platform-support.md), a [manual report template](manual-test-report.md), baseline fixtures/examples, and a PR template with roadmap references, validation evidence, and limitations.

**Acceptance:** Every work item has status, dependencies, acceptance criteria, and linked evidence. Limitations remain visible until their corresponding tests close them.

#### F02 — Shared schemas, migrations, revision-safe writes

Introduce the shared node registry and authoritative runtime validation, workflow-format migration, and revision-aware persistence. Provide reusable atomic full-graph updates for the editor, recorder, and chat. Validate reference roots/missing nodes, required configuration, target kinds, and conflicting targeting modes. Saving an unfinished draft remains possible; execution rejects validation errors.

**Acceptance:** Version 1 fixtures migrate without changed behavior; failed migrations preserve the original database; concurrent saves cannot silently overwrite; deleted workflows cannot be resurrected by stale saves; renderer and runtime report consistent validation errors.

### Editor and authoring

#### U01 — Output/reference picker and typed values

Add **Use value from…** beside eligible fields, grouping flow inputs, variables, prior node outputs, and loop values. Show friendly names while storing stable references. Add full node IDs and **Copy node reference**. Support literal/reference modes for strings, numbers, booleans, objects, arrays, and null. Warn when a referenced output may not execute on the current branch.

**Acceptance:** Detector-to-click targeting needs no JSON export; references survive renaming/reload; objects/numbers retain types; deleted references produce useful errors; the picker is keyboard accessible.

#### U02 — Structured inspectors and flow interfaces

Add normal controls for duration/detector waits, conditions, variables, count/foreach loops, child mappings, flow input/output properties, and independent group-child inputs. Add an AI-output schema builder for objects, arrays, required fields, descriptions, and enums. Retain advanced JSON/schema editing and preserve unsupported features. Mode changes remove conflicting active values.

**Acceptance:** Build a detector wait, numeric condition, foreach child workflow, and structured AI mapping without JSON. Import/export and mode changes preserve intended types and behavior.

### Recording

#### R01 — Recording drafts, pause, review

Use **Record → Stop → Review → Insert**, with session IDs and capturing/paused/reviewing states. Support edit/delete/duplicate/reorder/undo for steps and explicit target switches while paused. Keep one recoverable local draft; restart recovers into review, never capture. Review edits never replay actions.

**Acceptance:** Stop releases listeners/held input before review; Relay navigation cannot change the draft destination; restart does not resume recording; editing performs no application actions; discard leaves the graph unchanged.

**R01 delivery boundary:** New-flow insertion is the default. R01 initially permitted only an explicitly selected unused ordinary next output. R02 extends that contract with edge splicing, branch selection, successor preservation, and whole-insertion undo. Stop never inserts automatically.

#### R02 — Predictable graph insertion

Insert on an edge, after an explicitly selected output port, or into a new workflow. Splice the existing successor after the sequence. Require branch selection for decisions. Recheck anchor and revision at Apply. One insertion is one undoable graph transaction.

**Acceptance:** Successors remain connected; only the selected branch changes; no silent disconnected sequences; insertion after Finish is rejected; stale anchors preserve the draft; Undo restores the prior graph.

### Browser

#### B01 — Shared locators and event extraction

Support structured locators using test attributes, role/name, labels, IDs, CSS, frame paths, and open shadow roots. Preserve existing selectors. Resolve exactly one element and distinguish missing/ambiguous results. Share event extraction between managed browser and extension. Add locator inspection and **Test match**.

**Acceptance:** Both modes generate equivalent actions; stable locators survive changing CSS classes; frame/shadow cases replay; ambiguous matches do not choose the first result; old selector workflows still run.

#### B02 — Broader browser recording coverage

Capture click variants, typing/replacement/paste/composition, checkbox/radio changes, selections, shortcuts/held keys, scrolling, drags, navigation, and supported tab changes. Coalesce noise without reordering. Flush pending text on blur/pause/navigation/stop. Suppress duplicate click/change/composition actions, omit password values, and flag manual configuration needs.

**Acceptance:** Both adapters record/replay a fixture covering each interaction with correct state/order/final text, no duplicates, and no passwords. Browser chrome, native file dialogs, closed shadow roots, restricted pages, and specialized drag protocols remain explicitly outside general coverage.

### Native desktop

#### N01 — Contracts and real desktop harness

Add native protocol versioning, structured errors, permission/operation/backend details, application identity separate from transient handles, and explicit coordinate/scale/geometry metadata. Fixtures include buttons, text, duplicate labels, secure fields, scrolling, and animated/GPU surfaces. Reports include OS/session/backend/version/artifact identity.

**Acceptance:** Distinguish app startup from actual capture/input. Test launch/attach/focus, click/type/drag, resize, held-input cancellation, helper restart, and duplicate-window handling.

#### N02 — Windows capture and input

Replace per-request PowerShell with a persistent native backend. Use Windows Graphics Capture and checked SendInput. PrintWindow remains an explicitly chosen compatibility backend. Handle DPI, negative coordinates, lifecycle, helper cleanup, elevated-target restrictions, and capture failure.

**Acceptance:** Native controls, Chromium, and a GPU fixture pass at multiple scales; resize/capture loss/cancellation/key cleanup pass. References: [capture](https://learn.microsoft.com/en-us/windows/uwp/audio-video-camera/screen-capture), [SendInput](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput).

#### N03 — macOS capture, focus, permissions

Use persistent ScreenCaptureKit streams and Accessibility window identification/focus in place of title-dependent AppleScript. Correct Retina mapping, Unicode/modifiers, and permission diagnostics. Test the installed app and helper together.

**Acceptance:** AppKit/GPU fixtures, Retina/secondary displays, duplicate titles, denied/revoked permissions, locking, interrupted streams, and helper restart. Reference: [ScreenCaptureKit](https://developer.apple.com/documentation/screencapturekit/scstream).

#### N04 — Wayland sessions

Use persistent capture of the granted PipeWire stream. Prefer EIS when available; use legacy notifications only when EIS was not established. Handle chooser cancellation, revoked grants, source closure, scale changes, compositor restart, portal shortcuts, and supported permission restoration.

**Acceptance:** GNOME/KDE manual tests cover available grants, fractional scaling, missing portal capabilities, revocation, and emergency stop. Never mix legacy input with an established EIS connection. Universal enumeration/focus/passive recording remain unpromised. Reference: [RemoteDesktop portal](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.RemoteDesktop.html).

#### N05 — Element picker and Windows UIA

Add a native picker, locator inspector/tester, persisted semantic locators, and supported read/invoke/value/selection operations. Never persist object pointers. Use a dedicated UIA worker. Coordinate fallback is explicit.

**Acceptance:** Duplicate/stale/disabled/virtualized/secure controls and modals have defined outcomes; moving a control does not break its semantic locator.

#### N06 — macOS AX targeting

Implement the same locator/actions through AX, verify application/window ownership, and expose unsupported operations individually.

**Acceptance:** AppKit fixtures cover matching, reading, invoking, value-setting, stale references, secure controls, and permission revocation.

#### N07 — Linux AT-SPI targeting

Implement the semantic contract through AT-SPI with GTK/Qt coverage and application identity. Accessibility availability remains separate from capture/input.

**Acceptance:** GTK/Qt fixtures pass on supported sessions; absent services, incomplete trees, ambiguous matches, and disappearing controls produce specific errors.

#### N08 — Windows recording and shared normalization

Add recording hooks with minimal callbacks and asynchronous processing. Normalize typing, shortcuts, scroll bursts, drags, and key/button boundaries. Suppress injected events; scope recording to the selected target/session. Suppress secure values and represent needed user input without retaining the value.

**Acceptance:** Replay is correct; focus changes do not capture unrelated apps; permission loss/startup-stop clean up hooks; cancellation releases input; secure values do not enter drafts/logs.

#### N09 — macOS recording and X11 parity

Implement event-tap/AX recording on macOS and apply shared normalization/review to X11. Handle layouts, composition, injected events, and target boundaries; report unsupported composition rather than inventing accurate recordings.

**Acceptance:** The same fixture suite passes on Windows/macOS/X11 with documented, visible platform exceptions.

### AI

#### A01 — Accurate connection checks

Track text/decision/structured/image/localization checks separately with passed/failed/unsupported/untested/stale states. Tie results to connection and credential revisions; invalidate on edits and discard late responses. Validate returned probes. Jev is decision/detection-only for beta, not arbitrary text/schema generation.

**Acceptance:** Model/key changes cannot retain green results; text success cannot imply vision; a fresh Jev connection can test decisions independently of generic structured output.

#### A02 — Jev image preparation and confidence

Resize/pad to supported dimensions with invertible source-coordinate mapping. Validate formats/sizes, use unique asset references, restore crop offsets once, retain separate presence/location confidence, and expose boxes only after both checks pass.

**Acceptance:** Test 4K/portrait/tiny/narrow inputs, padding and boundary geometry; absent/invalid/low-confidence localization cannot produce usable coordinates. Keep vision experimental. References: [images](https://docs.typesafe.ai/images), [Box](https://docs.typesafe.ai/primitives/box).

#### A03 — Diagnostics and OpenRouter discovery

Provide explicit cancellable text/schema/synthetic-image/localization checks with model identity and actionable errors. Add OpenRouter search while retaining manual IDs. Separate advertised/enabled/verified capabilities. Export allowlisted metadata, not secrets/prompts/images/raw responses. Never silently change provider/model.

**Acceptance:** Offline/manual entry works; stale metadata is labeled; incompatible models are explained; errors do not leak keys; selection does not enable unverified capabilities.

#### A04 — Live conformance

Add opt-in live tests using production adapters and explicit provider/model/request bounds. Missing keys skip rather than pass. Exercise each provider's supported operations; qualify text/structured and vision combinations for Ollama/LM Studio with exact versions. Evaluate Jev across themes/scales/absent/duplicate/obscured targets. Record latency, returned model, available usage, and outcomes.

**Acceptance:** Ordinary PR CI makes no paid calls. Results identify exact configurations; untested combinations stay unverified; cold starts/cancellation/malformed output/unavailable servers are covered.

### Image-capable chat

#### C01 — Service and proposal contract

Use one explicitly selected connection with text+structured capabilities, plus vision for images. Return clarification or a full candidate graph. Preserve IDs/positions during edits; application code owns flow IDs/revisions/timestamps/triggers. Supply selected graph/schema and deliberately selected target/connection/child descriptors. Add cancellation and progress events.

**Defaults:** One call per Send, no automatic fallback/repair. One workflow, at most 200 nodes/400 edges per proposal. Existing children may be referenced but not silently edited.

**Acceptance:** Invalid/truncated output, unknown nodes, missing references, cycles, large context, cancellation, and late responses cannot change saved flows. No execution tools are available to the model.

#### C02 — Attachments and explicit window capture

Support paste/drop/file selection/one-time selected-window capture. Store attachment IDs separately from runtime CaptureFrames. Use bounded binary IPC. Normalize orientation, strip metadata, and preview prepared images. Import/capture is local until Send; history images require explicit reuse.

**Defaults:** Static PNG/JPEG/WebP, four images per turn, source at most 8 MiB/40 megapixels, prepared at most 2,048 pixels longest side/2 MiB each.

**Acceptance:** Corrupt/oversized/animated images, unavailable capture, wrong-session/deleted attachments have clear errors. Text-only models never silently drop images. Image-only requests may ask what to automate.

#### C03 — Review, binding, Apply

Show proposal graph/explanation/diff and allow inspector edits. Validate configurations, references, capabilities, loops, detector branches, and existing user-configured targets. The model cannot create executable launch commands. Image-derived coordinates/templates need target binding and fresh-preview validation. Promote accepted templates into durable workflow storage.

**Apply rules:** New flows have no schedule/hotkey. Unchanged manual flows update through a revision check. Flows reachable from enabled schedules/hotkeys, including through parents, become unscheduled copies. Conflicts preserve proposals and offer refreshed review or a copy. Apply never starts a run. Attachments cannot manufacture fresh runtime frame IDs.

**Acceptance:** Concurrent/unsaved edits, dependency changes, duplicate Apply, indirect triggers, and stale review state cannot cause overwrite/execution. Existing-flow updates are one reversible graph change.

#### C04 — History and authoring acceptance

Store sessions/messages/proposals locally with paginated history and lazy thumbnails. Follow history retention (30-day default), expire abandoned unsent attachments after 24 hours, and cap image storage at 256 MiB. Prune expired/unreferenced files first; request cleanup instead of deleting active material. Interrupted requests never resend automatically. Deleting chat preserves applied workflows/promoted assets.

**Acceptance:** Text-to-flow, image+goal, image-only clarification, iterative edits, unavailable models, restart/retention/deletion work. Screenshot instructions cannot gain execution or credential access.

### Installation and onboarding

#### D01 — Offline runtimes and installers

Bundle native helper, matching full Chromium, Tesseract/libraries, English/orientation data, OpenCV/image dependencies, extension files, and local assets. Resolve immutable resource paths explicitly. Build Windows NSIS, Apple Silicon DMG, Linux deb/AppImage; include versions/hashes/licenses/language inventory and offline OCR language import. No LLM weights/server.

**Acceptance:** Clean machines without development tools/browser cache/system OCR launch managed Chromium and OCR offline. Document/check Linux system prerequisites. References: [Playwright browsers](https://playwright.dev/docs/browsers), [Tesseract data](https://tesseract-ocr.github.io/tessdoc/Data-Files-in-tessdata_fast.html).

#### D02 — Setup and reusable diagnostics

Add skippable/resumable capability/permission/target/browser/optional-AI/recording setup. Reuse Ready/Needs setup/Unsupported here in Settings and empty states. Bundle offline test fixtures. Explain extension pairing and Linux prerequisites. Control/inference checks start only from labeled actions.

**Acceptance:** AI can be skipped; native limitations don't block browser setup; permission/pairing failures have recovery steps; readiness depends on successful checks rather than clicking Next.

#### D03 — Qualification and beta artifacts

Run actual installer compatibility/acceptance, upgrades preserving workspace data, artifact-hash/environment reports, installation instructions, and beta limitations. Include signing support but public signing/notarization/store publication are not beta gates.

**Acceptance:** Every advertised capability has evidence; untested configurations remain provisional; real installer/upgrade/offline checks pass. Green CI alone is insufficient.

## Tests and beta gates

### Automated checks

- Type checking, focused unit/integration tests, production build, UI smoke.
- PR #1 migration fixtures and shared validation/reference tests.
- Mocked provider protocols without paid requests.
- Managed-browser/actual-extension parity, Linux X11 integration.
- Packaging/runtime-path/resource checks.
- Regression tests that demonstrate behavior, not tests merely mirroring implementation.

### Manual matrix

| Environment                          | Required checks                                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Windows 11 x64                       | Capture/input, UIA, recording, mixed DPI, GPU fixture, cancellation, installation/upgrade.              |
| macOS 14+ Apple Silicon              | Capture/input, AX, recording, Retina, permissions, installation/upgrade.                                |
| Ubuntu 24.04 GNOME X11               | Capture/input, AT-SPI, recording, hotkeys, installation/upgrade.                                        |
| Supported GNOME/KDE Wayland sessions | Portal capture/input, scale, consent/revocation, shortcuts/recovery, explicit unsupported capabilities. |

Reports identify exact compositor/session versions; one Wayland result is not proof for another.

### Required journeys

1. Install offline; create target; record/review/insert into an existing branch; replay.
2. Detect visually or semantically; branch on state; act on a match.
3. Run sequential/pool/fixed-batch children while preserving desktop exclusivity.
4. Configure OpenRouter/local AI; test operations and understand failures.
5. Attach chat image; describe goal; resolve bindings; review; Apply; separately Run.
6. Chat-edit a manual flow without losing unrelated changes.
7. Chat-edit a child of a scheduled parent and receive an unscheduled copy.
8. Cancel held keys/drags and verify input release.
9. Upgrade and reopen flows/settings/assets/history.

### Exit criteria

- Required items complete or scope changes explicitly accepted and recorded.
- Focused matrix has installer and real-session evidence.
- Common authoring/recording no longer needs routine JSON editing.
- Image-capable chat creates/edits valid flows without execution.
- Bundled Chromium/OCR work offline on the supported baseline.
- AI qualification is accurate; restrictions are visible in product/release notes.

## Outside this beta

Autonomous chat execution/debugging; continuous screenshot access; LLM runtime/model installation; cloud sync; distributed workers; universal passive Wayland recording; protected capture/secure desktops/anti-cheat/exclusive-fullscreen guarantees; Intel Mac and Windows/Linux ARM qualification; public signing/notarization; automatic updates; extension-store publication.

Task-level game automation uses normal input/detector capabilities, with compatibility documented per tested application. Public distribution follows the reliable personal/friends beta.
