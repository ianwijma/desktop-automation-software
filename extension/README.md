# Relay Browser Bridge

Run `node extension/install.mjs` for loading/pairing instructions. This is a Chromium Manifest V3 extension using an authenticated loopback bridge; it does not register a native messaging host. Load the directory as an unpacked extension in Chrome or Edge, then copy the port and token from Relay settings into the popup. Pair again after Relay restarts.

Requests require a random per-session bearer token. Relay rejects non-extension web origins, never binds a public network interface, and never enables wildcard CORS. Browser pages cannot access the token, which is stored in extension-local storage. The debugger permission is required to send browser input and capture screenshots; Chrome displays its normal debugging indicator. Pages with an open DevTools debugger or restricted browser pages may reject attachment. Failures are reported to the workflow.

Direct recording captures semantic clicks, completed text changes, select changes and Enter/Tab/Escape in the selected tab. Password values are intentionally left empty for the user to configure. Cross-origin frames, shadow-root selectors and closed DevTools targets require manual nodes. Browser recording is not a system-wide keyboard recorder.

The real extension has been integration-tested in an isolated Chromium profile: popup pairing, DOM actions, element detectors, PNG capture, semantic recording, and cancellation of timed key presses. Capture-pixel coordinates are converted to CSS pixels before CDP input. While a command runs, the extension checks an authenticated cancellation endpoint and releases held keys when a timed press stops. Physical desktop input is not used by browser actions.
