# Flow assistant images (C02)

Open **Flow assistant** in the left rail. Choose an authoring model that supports text and structured output; image turns also require its vision capability. Configure your own provider/key or local runtime in Settings. Jev remains a detector/decision connection, not an arbitrary workflow-authoring model.

Describe the goal, then add static PNG/JPEG/WebP files, paste an image, or drop files onto the composer. **Application context** explicitly selects a configured target descriptor. **Capture selected window once** takes one image from that desktop target through the existing native backend. It may require an OS permission/Wayland source chooser; it does not start an application, record input, poll continuously or execute a workflow. Browser target descriptions can be selected as context, but this capture action requires a desktop target.

Imports, capture, preview and Reuse are local. Select a thumbnail for a larger prepared-image preview, with Fit/Actual pixels and keyboard dismissal. Check that preview before Send. Send explicitly includes the current draft image IDs; earlier-turn images remain excluded until **Reuse** creates a new draft ID. A text-only connection cannot silently omit attached images. An image without a goal can receive a local clarification without an inference request. Transport/validation failures never retry or switch models automatically.

Generation returns an unsaved candidate or clarification through [C01](chat-authoring-service.md). C03 still adds graph review, inspector editing, resource binding, fresh-preview checks and Apply. No proposal is saved/run by this composer. C04 still adds durable sessions, paginated messages, retention/restart recovery and workflow asset promotion. The current conversation keeps at most ten turns in memory; prepared images are temporary, with earlier-image previews loaded only when opened, six per page. Navigation preserves this temporary session; Clear session or closing the window discards it. Minimizing to tray preserves the open window.

## Bounds and preparation

| Boundary          | Limit                                                            |
| ----------------- | ---------------------------------------------------------------- |
| Source            | Static PNG/JPEG/WebP, 8 MiB, 40 megapixels                       |
| Per Send / draft  | Four images                                                      |
| Prepared output   | PNG, 2,048-pixel longest side, 2 MiB per image                   |
| Preparation       | Two concurrent jobs; pending jobs reserve draft/storage capacity |
| Temporary storage | 256 MiB, 512 records, 256 session identities per app lifetime    |
| Unsent expiry     | 24 hours, checked on attachment operations                       |

The main process validates binary type/size independently of preload; filenames/MIME/renderer-supplied dimensions are not trusted. PNG animation control chunks and WebP animation frames/flags are rejected rather than selecting a first frame. The automation worker performs Sharp decoding, keeping native image processing out of the window process on Electron/Linux. Sharp decodes with a 40-megapixel limit and strict warning failures, applies EXIF orientation, converts to sRGB and strips metadata. Images that do not compress below 2 MiB are reduced further through a bounded sequence down to 512 pixels; the resulting dimensions/bytes are shown before Send. Each encoding has a ten-second processing limit. Originals are not retained.

Prepared files use app-generated UUID names in the dedicated `authoring-images-temporary` user-data directory, separate from runtime captures and workflow assets, with restrictive filesystem modes where supported. The service checks length/digest on bounded reads. It removes this scratch directory on first attachment use in a new process, never workflow/promoted assets. A crash can leave prepared files until that cleanup; C04's durable retention model is not implemented here. Expired drafts are removed on attachment operations; capacity failures request explicit removal/session cleanup rather than deleting active sent material. Deletion failures keep quota accounted.

## Desktop boundary

- `importAuthoringImage({ sessionId, name, source, bytes: Uint8Array })`: one bounded binary upload; source is file/paste/drop. Paths, URLs, base64 inputs, frame IDs and capture provenance are not accepted.
- `captureAuthoringImage({ sessionId, targetId })`: explicit configured desktop target. Target identity/configuration is checked before/after capture and preparation. The worker refuses active workflows/recording and does not register the capture in its actionable frame cache.
- `listAuthoringImages(sessionId)` / `previewAuthoringImage({ sessionId, attachmentId })`: session-scoped metadata / prepared PNG binary.
- `reuseAuthoringImage(...)`: explicit local copy with a fresh draft ID.
- `deleteAuthoringImage(...)` / `closeAuthoringSession(sessionId)`: invalidate dependent in-flight requests and discard late results. Closed sessions reject late uploads/captures.
- `requestFlowProposal({ ...C01Request, attachmentIds })`: resolves only explicit current-session draft IDs, pins immutable prepared bytes, marks those images as sent and returns app-owned attachment associations. Image deletion/session close aborts the request and prevents a late accepted result.

The sandboxed renderer receives local object URLs for previews and releases them when the card closes/unmounts. No file path, native frame ID, geometry/source token or desktop action authority is exposed by an attachment. Model output still cannot manufacture runtime identities or executable commands. C03 must bind image-derived locations/templates to real targets and require fresh runtime evidence; a prepared image is not that evidence.

Browser preview explains that attachments/capture/inference require the desktop app and rejects those APIs. No real provider quality, screenshot grounding, hardware/permission or installer support is qualified by controlled/loopback tests.

See [C02 verification](verification/c02-2026-10-29.md) and the complete [beta roadmap](beta-roadmap.md).

Implementation references: [Sharp constructor limits](https://sharp.pixelplumbing.com/api-constructor/), [orientation operations](https://sharp.pixelplumbing.com/api-operation/#autoorient), [metadata/output defaults](https://sharp.pixelplumbing.com/api-output/).

The application smoke preserves bounded process stderr and worker-exit diagnostics on failure. Electron/Linux can expose GLib symbol conflicts with native image libraries ([upstream notes](https://sharp.pixelplumbing.com/install/#electron-and-linux)); source and packaged smoke retain both attachment preparation and OpenCV regressions.
