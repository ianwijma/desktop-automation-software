# Opt-in AI conformance (A04)

`npm run test:ai:live` runs explicit configurations through Relay's production `AIService` adapters. It does not read the app database/keyring, update saved connections, start a local server, download a model, or grant app verification. The harness is implemented; **no real cloud/local model configuration has been qualified by this PR**. Controlled fixtures establish the harness behavior only.

## Configure and preview

Copy [the example](examples/ai-conformance.example.json) to a local ignored file such as `test-results/ai-conformance/local.json`. Remove profiles you do not intend to run, replace every `YOUR_…` placeholder, choose exact model IDs, and explicitly list operations/capability switches. Place credentials in the environment variable named by each profile's `keyEnv`, using your normal secret-management tool. Never put keys in the JSON, command arguments or committed files. The example intentionally fails validation until model placeholders are replaced.

```sh
npm run test:ai:live -- --config test-results/ai-conformance/local.json
```

This is an **offline plan** even when credentials exist. It records `not-run`, makes zero HTTP requests and exits 0. Inspect the generated `test-results/ai-conformance/report.json`. This is not a successful model test.

The schema is strict. Each profile requires a unique ID, one of `openai`, `openrouter`, `anthropic`, `gemini`, `ollama`, `lmstudio`, `jev`, an explicit endpoint/model/capability configuration and 1–5 distinct operations. Unknown fields, unsafe model IDs, duplicate profiles/operations and unbounded settings are rejected before any request. Endpoints must use HTTPS or loopback HTTP without embedded credentials, query strings or fragments. The example uses the same endpoint defaults as Relay; custom HTTPS endpoints may behave differently.

Ollama and LM Studio profiles additionally require exact `runtime.name`, `runtime.version` and `runtime.modelRevision` to run. Record the server version and loaded model digest/build in the local runtime itself. These fields are labeled **operator-attested**, not independently verified by an extra version endpoint. Separate profiles should describe text-only versus text+structured+vision models and different runtime/model versions. Missing/unknown local identity remains skipped. Never use a floating `latest` value as qualification evidence.

## Run an explicit bounded selection

After reviewing the configuration, enable both gates:

```sh
RELAY_AI_LIVE=1 npm run test:ai:live -- --config test-results/ai-conformance/local.json --run
```

For PowerShell, set `$env:RELAY_AI_LIVE = '1'` before the same npm command. Omit either gate to prevent live requests. Live runs may incur provider charges. Request limits are not a monetary budget, and cancellation does not guarantee an accepted request was unbilled.

- Required `maxRequests`: 1–100 attempted HTTP POSTs across the whole run. Every selected case gets at most one POST. No retries, repair, fallback model or automatic warmup is added. The production OpenRouter adapter requests provider fallback disabled; server-side provider policy is outside the harness's control.
- Required `requestTimeoutMs`: 100–20,000 ms; production connection probes also retain their 20-second ceiling. Required `totalTimeoutMs`: 100–900,000 ms. After the run deadline/cancellation, remaining cases are skipped. SIGINT/SIGTERM abort the active request and save the partial report.
- The wrapper accepts only the explicitly configured origin/path (including the production Ollama `/v1`/`/api` alias normalization), forces redirect rejection and bounds response bodies to 8 MiB. Redirects cannot spend a second request or forward a key to a different endpoint.
- SDK/Ollama probes use a 256 output-token limit. Jev's API uses fixed presence/location questions and has no token-cap parameter; its response is still size/time bounded. No application image, arbitrary prompt or user desktop data is sent.

Missing keys, exhausted budgets, missing exact local identity and unselected operations remain explicitly unverified. Disabled/unsupported operations are not called and cannot pass. A live report exits 0 only for `pass-selected`, 1 for a failing assertion/provider/transport, and 2 for incomplete results/configuration/runner errors. `pass-selected` applies only to the requested synthetic cases for that exact configuration; it is never a general provider/model qualification.

## Operations, cold starts and cancellation

`text`, `structured`, `decision`, `image`, `localization` reuse the production connection probes and their expected phrase/schema/synthetic images/IoU assertions. A successful text check does not verify vision or a different operation. Provider-reported returned model and available usage are recorded; missing identity or counts stay unavailable rather than copied from SDK defaults. Production adapters and their pinned SDK dependencies are used without a second protocol implementation.

Set `coldStartExpected: true` only after deliberately unloading/stopping the model through the runtime's own controls. The first selected attempt is labeled `operator-expects-cold-start`; Relay does not restart/unload anything or prove the model was cold. Record a separate warm profile/run for comparison. A cold-start timeout is a failed attempt and cannot become a pass through an automatic retry. A 20-second probe timeout does not prove the runtime can never load that model.

Optional `cancellation: { "operation": "text", "afterMs": 500 }` adds one separately budgeted request. The delay must be 10–19,000 ms. It passes only when a provider request was dispatched, cancellation was requested and the production adapter returned cancelled. A model that finishes first is **skipped/incomplete**, requiring a separately chosen timing/run to observe cancellation. Cancellation before provider dispatch cannot establish provider cancellation. No call is automatically repeated to obtain a preferred result.

## Jev visual cases

Explicitly select `visualCases` on an experimental-vision-enabled Jev profile. Seven deterministic PNG cases cover light/dark at 1×/2×, absent, duplicate and obscured targets. The target is exactly one complete red rectangular button with a cyan circular center. Positive cases require a match with a valid source-image box and IoU ≥0.5. Absent/duplicate/obscured cases accept only no-match/uncertain without a usable box. Each case sends one request through production image preparation and independent presence/location confidence validation.

Reports store image SHA-256, dimensions, expectation and outcome, with no image payload or raw model evidence. These synthetic shapes do not establish general desktop accuracy, representative application support, injection resistance or a false-positive rate. Broader tasks, confidence thresholds, real themes and additional scales need separate evidence.

## Reports and regression checks

Reports include the exact selected model/configuration hash, operator-attested runtime/model revision, available returned model/usage, elapsed time, curated failure category, attempted request counts and unselected operations. Environment metadata identifies Node/OS/architecture, AI SDK/sharp versions, Git revision/dirty state and bundled adapter hash. Reports exclude key values, configured endpoints, environment dumps, arbitrary error messages, prompts, images, raw response bodies and Jev free-text evidence. Known configured credential values are scrubbed from string metadata. Reports are written with mode `0600` where supported; inspect them before sharing.

`npm run check` tests all seven adapters with controlled responses, all local operations, budget/skip/error/deadline/cancellation behavior, image evaluation and report privacy. `npm run test:ai:harness` additionally starts a private loopback HTTP fixture and exercises the actual bundled CLI, both opt-in gates independently, real request cancellation and redirect rejection. Ordinary PR CI runs these fixtures only, with no paid/provider inference. Its `harness-acceptance.json` explicitly states `liveProviderQualified: false`.

Live qualification remains pending until an operator executes selected real configurations and records their reports. Do not convert missing keys/servers/models or unrun combinations into passing rows. See [implementation evidence](verification/a04-2026-10-27.md) and the [roadmap](beta-roadmap.md#A04--live-conformance).
