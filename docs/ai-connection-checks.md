# AI connection checks (A01)

AI Connections shows an independent result for **Text**, **Decision**, **Structured**, **Image**, and **Localization**. Enabled capability switches are declarations, not test evidence. A passing text check establishes only the text operation for that saved endpoint/model/credential revision. Changing provider, endpoint, model, enabled capabilities, experimental vision or API key makes previous results stale. Renaming a connection preserves operational evidence. Legacy “Connected” results are not promoted to operation passes.

| State       | Meaning                                                                            |
| ----------- | ---------------------------------------------------------------------------------- |
| Untested    | No result exists for this operation.                                               |
| Passed      | The probe returned the expected content/schema/geometry for the current revisions. |
| Failed      | The selected operation failed or returned invalid/unexpected data.                 |
| Unsupported | The operation is disabled or unsupported by this provider contract.                |
| Stale       | Saved configuration or credentials changed after the recorded result.              |

Choose a labeled **Test Text/Decision/Structured/Image/Localization** button to send that probe. Each button makes one request to the saved provider/model, with a 20-second timeout and no retry or provider fallback. Text/structured probes cap generated output at 256 tokens where the adapter supports that parameter. Image probes send a small generated PNG; they never capture an application or send user workflow data. Image verifies known content; Localization additionally checks overlap with the known target rectangle. Tests may incur provider charges. The browser preview cannot test connections or store keys.

Text validates an exact expected phrase. Structured validates a constrained object. Decision validates a known condition. Image validates a synthetic image response. Localization requires a valid, sufficiently overlapping box; mere presence or a full-image box does not pass. These are narrow conformance probes, not guarantees that every real task/image will succeed.

Jev supports decisions and detection for beta. A fresh Jev connection can test Decision with generic text/structured capabilities disabled. Arbitrary text/schema generation is unsupported, and Jev Image/Localization additionally require enabled vision and experimental vision. Local Ollama/LM Studio connections use the user-configured endpoint and model; Relay neither installs nor starts model servers.

The main process owns evidence and connection/credential revisions. Renderer saves cannot manufacture passing results. Running probes use an immutable connection/key snapshot. The main process discards results after a save/delete, revision change or newer check for the same operation. Independent operations cannot promote one another. Probe messages redact the configured secret before truncation; credentials never enter evidence. Replaced credentials increment an opaque revision, not a hash of the secret.

A03 adds richer cancellation/discovery/diagnostic export. A04 supplies opt-in live provider qualification; ordinary CI uses local mocked HTTP and makes no paid calls. [A02](jev-vision.md) adds bounded Jev image preparation and independent location confidence. See [A01 evidence](verification/a01-2026-10-27.md).
