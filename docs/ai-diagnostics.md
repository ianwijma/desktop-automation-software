# AI diagnostics and OpenRouter discovery (A03)

AI Connections provides explicit Text, Decision, Structured, Image and Localization checks. Each check sends one small synthetic request to the saved connection/model. It never captures an application. Results remain tied to connection/credential revisions as described in [connection checks](ai-connection-checks.md).

## Cancellation and results

While a check runs, **Cancel check** sends cancellation for that request ID. It cannot cancel a newer request with a different ID. Provider calls receive an AbortSignal; late successful responses after cancellation cannot become passing evidence. Changing/deleting a connection aborts its active diagnostic requests and discards stale evidence. Closing a model-discovery editor cancels its active refresh. At most four diagnostics may be active, with 20-second probe and 15-second catalog deadlines. Already accepted provider requests may still be billed; cancellation does not promise a refund or undo inference.

Results show requested model, provider-reported returned model when available, elapsed time and available usage counts. Missing fields remain unavailable; SDK defaults are not treated as reported model/usage evidence. Usage copies top-level provider fields rather than estimating costs or filling absent counts with zero. Token accounting differs by provider (for example candidate text versus reasoning/cache tokens), so these fields are not a complete billing report. No response body, prompt, image, authorization header or raw error payload is retained in diagnostics.

Error categories distinguish configuration, authentication, rate/credit limit, network, unsupported operation/model, invalid response, provider failure, timeout and cancellation. Messages provide a next action without echoing provider response text or credentials. The SDK error formatter also keeps raw provider failure bodies out of workflow error messages. Cancelled results are separate from failed/passed checks. Ordinary probe validation still checks known text/schema/image/geometry, not just HTTP success.

## OpenRouter model search

Open an OpenRouter connection and search its public catalog. **Refresh model catalog** performs one credential-free GET to the fixed official endpoint; merely opening the editor, typing or selecting a model reads the local cache. Custom configured inference endpoints remain unchanged and may advertise different support. Manual Model ID entry always remains available, including offline or when discovery fails.

Catalog metadata and enabled/verified capabilities are separate:

- **Advertised** comes from input/output modalities and supported parameters. Missing metadata is unknown. Generic JSON mode does not establish strict structured-output support.
- **Enabled** is the user's saved capability switches. Selecting a result changes only Model ID; it never enables a switch or marks a probe passed.
- **Verified** comes only from the corresponding revision-bound check. Saving a different model makes old check evidence stale.

The selected model's metadata is looked up independently of the current search filter. Incompatible enabled capabilities are explained. Cached metadata includes its fetch time and is labeled stale after 24 hours, a backwards clock jump, or a failed refresh. A cancelled refresh leaves its cache unchanged. Late/superseded responses cannot replace newer catalog state or the user's chosen model.

The fetch bounds the response stream to 8 MiB and at most 20,000 model records. Search returns at most 50 matches plus the selected model's metadata. Only ID, name, optional context length and advertised capability flags are cached; descriptions, pricing, endpoint URLs and arbitrary provider fields are discarded. Discovery performs no inference or paid request.

## Export

**Export diagnostics** opens a native JSON save dialog for the selected saved connection. The main process builds an allowlisted snapshot; the renderer cannot supply arbitrary export contents. It contains provider/model identifiers where safe, revision counters, enabled flags, per-operation state/date, elapsed time, available token counts and curated error codes/HTTP status.

Exports exclude connection names/IDs/endpoints, credentials and their hashes, messages, prompts, screenshots/assets, request/response bodies and raw provider metadata. Returned/configured model identifiers are bounded, filtered, and omit known secrets. The web preview cannot test, refresh remote metadata or export native diagnostic files; manual connection editing remains available.

Live provider/runtime qualification remains [A04](beta-roadmap.md#A04--live-conformance). See [A03 evidence](verification/a03-2026-10-27.md).

References: [OpenRouter model catalog](https://openrouter.ai/docs/api/api-reference/models/get-models), [API overview and structured-output contract](https://openrouter.ai/docs/api_reference/overview). SDK extraction uses the installed AI SDK 7 provider adapters and their version-matched source.
