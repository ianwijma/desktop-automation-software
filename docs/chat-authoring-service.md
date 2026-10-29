# Chat authoring service and proposal contract (C01)

C01 supplies the desktop service/IPC contract for later chat UI work. It returns an **unsaved proposal**, a clarification, a cancelled result or a rejection. It cannot save/apply a workflow, create targets/connections/children/triggers, launch an application, inspect/capture a window or submit a run. [C02](chat-attachments.md) adds attachment import/capture and a temporary composer; C03 adds graph review/binding/Apply; C04 adds local history. The full user-facing chat journey is not implemented by this slice.

## Explicit Send and selected context

`requestFlowProposal` takes a request UUID, session UUID, explicit authoring connection ID, prompt, and explicit arrays of target/connection/child-flow IDs. No default authoring model is used. An optional source contains a saved flow ID/revision and an explicitly supplied unsaved graph draft. Source drafts contain graph fields only, with no flow identity, timestamps, folder or trigger authority.

```js
const request = {
  requestId: crypto.randomUUID(),
  sessionId: crypto.randomUUID(),
  connectionId: selectedConnectionId,
  attachmentIds: selectedDraftImageIds, // C02: explicit current-session image IDs only
  prompt: "Create a flow that opens my browser and waits for the login form.",
  targetIds: selectedTargetIds,
  connectionIds: selectedNodeConnectionIds,
  childFlowIds: selectedChildFlowIds,
};
const result = await window.relay.requestFlowProposal(request);
```

The selected transport must support text and structured output, plus vision when [C02 attachment IDs](chat-attachments.md) resolve to trusted prepared images. Jev remains a detector/decision provider and cannot author arbitrary graphs. Cloud transports require the configured key; Ollama/LM Studio may use a key when configured. One Send makes at most one POST through the existing production adapter, with no repair/retry/model fallback. Duplicate request UUIDs do not call a provider again during the app session. There are at most four active requests, retained until the underlying operation settles; an in-memory cap of 10,000 handled request IDs bounds deduplication state for one application session.

Model context includes the selected graph, the shared node registry/ports/output/reference contract, selected target ID/name/kind/browser mode, selected connection ID/name/provider/model/capabilities, and selected child ID/name/input/output interfaces. Target launch commands, endpoints/key metadata and child implementation graphs are omitted. Transitive children and their configured resources are checked locally for validity/freshness, without adding their graphs to the model context.

Credential-named literal string fields (password/API key/authorization/access-token/credential variants) in selected graph values and child interfaces are projected as protected markers. References such as `${inputs.password}` remain references. Retained nodes and flow interfaces recover their original owned values in app code; arrays with private entries are preserved as a whole so reordering cannot rebind a secret. These owned fields cannot be edited by the model, and markers cannot be introduced as executable workflow values. Ordinary graph literals are deliberately selected user content; this is not a general secret detector. The selected transport key is also removed from prompt text, and a provider result echoing that key is rejected. App keyring contents are never supplied as model descriptors.

## Provider output and graph validation

The provider returns a strict envelope: `kind`, explanation, questions, and a nullable full graph. Clarification requires 1–5 questions and no graph. A graph proposal requires an empty question list. The graph contains name/description, nodes, edges, JSON-string configurations/interfaces, explicit resource binding requests and explicit lists of removed source node/edge IDs. JSON strings keep the wire schema portable across provider structured-output implementations; they are parsed, bounded and validated locally before any candidate is returned.

The model cannot specify flow IDs/revisions/timestamps/folders/hotkeys/schedules, executable launch overrides or runtime frame IDs. Node kinds, identifiers, branch ports, configuration types, native/browser locators, references, bounded child/loop graphs, uniqueness/reachability and graph/child cycles use the shared app schemas/validator. Unknown nodes, unsafe properties, fabricated inline detection evidence and unselected literal resource IDs are rejected. Existing child implementations remain read-only.

New candidates get an app-generated UUID, timestamps, revision 1 and an AI drafts folder. Existing candidates retain the source identity/folder/creation time/base revision, retained node IDs/positions/breakpoints and owned launch/frame/secret fields. Omitted source node/edge IDs must be explicitly declared, preventing accidental wholesale ID replacement. Candidate hotkeys are absent. These normalization rules do not save the candidate or grant execution authority.

## Bindings and later review

A clear task may still need an application or node AI connection. The graph can leave `targetId`/`connectionId` empty and declare `{nodeId, field, hint}` in `bindings`. App code checks that each binding targets a unique supported empty field, assigns opaque binding receipt IDs, and validates the remaining graph against temporary **validator-only** resource descriptors. Those descriptors never enter the real workspace. Unselected invented literal IDs remain invalid.

The returned candidate keeps empty resource IDs and includes binding warnings and explicit receipts. It cannot pass ordinary execution validation until real resources are bound. C03 must resolve every binding to an existing user-configured resource, revalidate its actual capabilities/configuration and require fresh preview evidence for image-derived positions/templates. A binding receipt never creates a launch command, application target, credential or child workflow. Binding allows review to finish without another model call.

All proposals carry `requiresReview: true`. C03 must compare the source graph stamp/current draft and saved revision, recheck dependencies, implement trigger-aware copy/revision/duplicate-Apply rules, and perform an explicit user Apply. Apply must remain separate from Run. C01 provides no Apply endpoint and does not establish that those later rules are implemented.

## Cancellation, freshness and progress

`cancelFlowProposal(sessionId, requestId)` cancels only that exact active request. A newer Send supersedes the older request in the same session; other sessions remain independent. Closing the window or quitting cancels requests. Provider AbortSignals are best effort after acceptance and do not establish billing refunds.

Selected connection/credential revisions, source saved revision, explicit draft snapshot, selected resources, transitive children and their static resource/default-connection dependencies are fingerprinted. Workspace writes invalidate changed active dependencies. Late successful responses are checked again before acceptance, including when a provider ignores abort. Unrelated workspace changes do not invalidate a request. Source draft stamps let C03 detect subsequent unsent renderer edits that a service cannot observe itself.

`authoring-progress` events contain only session ID, request ID and stage: preparing/generating/validating/completed/cancelled/rejected. Consumers must match their active session/request; closing a future chat view should call cancellation. The existing app does not refresh the workspace for each progress event. A superseded/cancelled/stale result cannot emit a late completed stage. Progress never includes prompt text, screenshots, raw provider errors or token content.

## Bounds and evidence

The limits are one graph, 200 nodes, 400 edges, up to 30 selected resources per type, an 8,000-character prompt, 256 KiB text context, 512 KiB decoded candidate, 32 KiB per JSON-string configuration/interface, 24 levels of JSON nesting, a 2 MiB provider response and a 90-second deadline. The trusted host can shorten that deadline; it cannot extend it. Requests reject redirects and calls outside the explicitly configured origin/path, including production Ollama endpoint aliases. Output is capped at 16,384 tokens; truncation is rejected with no automatic resend.

The internal prepared-image path supports up to four 2 MiB PNG/JPEG/WebP images, longest side 2,048 pixels, with explicit vision requirements. Image content is separate from runtime CaptureFrames and never supplies usable frame identities. The public proposal IPC accepts C02 attachment IDs, never arbitrary image bodies or runtime frames. C02 owns source decoding, normalization, binary import IPC, attachment ownership and one-time capture. An image-only internal request asks for a goal without making an unnecessary provider request.

Results expose available model/timing/usage metadata and curated error categories. Raw provider error bodies are not returned. No session/message/proposal is persisted and no request is replayed after restart in this slice. See [C01 evidence](verification/c01-2026-10-27.md). Controlled protocol fixtures do not qualify live model output quality; [A04](ai-conformance.md) remains the live qualification track.
