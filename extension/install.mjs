#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import path from "node:path";
// Chrome requires user consent to load unpacked extensions; this installer deliberately does
// not alter a user's browser profile, enterprise policy, registry, or launch flags.
const directory = path.dirname(fileURLToPath(import.meta.url));
console.log(
  `Relay browser bridge source: ${directory}\n\n1. Open chrome://extensions (or edge://extensions).\n2. Enable Developer mode, choose Load unpacked, and select the directory above.\n3. Start Relay, open Settings → Browser bridge.\n4. Open the extension popup and paste Relay's port and pairing token.\n\nThe bridge binds only to 127.0.0.1. Tokens change when Relay restarts.\nNo native messaging host registration is required for this localhost transport.`,
);
