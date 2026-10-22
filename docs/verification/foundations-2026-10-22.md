# F01/F02 foundation verification — 2026-10-22

Scope: the foundation follow-up to [PR #1](https://github.com/ianwijma/desktop-automation-software/pull/1), based on its head `18b3839613460b83d6fd7207f06f1daaa6e31bc2`. The associated follow-up PR identifies the implementation revision. This report covers automated local checks; it is not an installer or real-user desktop qualification.

Environment: Linux x64, Node 26.11.1, Electron 45.0.0, Playwright 1.64.1. Desktop automation checks run on an isolated Xvfb X11 server. The native helper was built from the unchanged PR #1 native source.

| Check                                                 | Result                              | Evidence                                                                                                                                                                                                     |
| ----------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm test`                                            | Pass: 173 tests, 15 files, no skips | Engine, browser/actual extension, native X11, AI mocks, storage, shared validators, preview persistence.                                                                                                     |
| `npm run build`                                       | Pass                                | TypeScript, production renderer, main/preload/runner bundles. Existing renderer chunk-size advisory remains.                                                                                                 |
| `npm run test:ui`                                     | Pass                                | Graph editing, settings/themes, schedules, cross-tab conflicts, Undo after save, future-schema refusal, saved-revision acknowledgement after refresh failure.                                                |
| `RELAY_SMOKE_NATIVE=1 xvfb-run -a npm run test:smoke` | Pass                                | Real Electron launch/IPC/SQLite, provider credential isolation, CAS and deleted-flow guards, welcome flow, 12-child fixed batch, themes, X11 capture, OpenCV detector-result click, guided click and typing. |
| Prettier and `git diff --check`                       | Pass                                | Changed source, tests, scripts, and documentation.                                                                                                                                                           |

## Behavioral evidence

- [Original PR #1 workflow fixtures](../../tests/fixtures/pr1-workflows-v1.json) retain IDs, references, advanced configuration, and execution results after migration. The welcome and twelve-child examples execute; the website example uses mocked browser operations.
- [Migration tests](../../tests/storage-migration.test.ts) cover committed WAL backup data, malformed JSON/settings/entities, unknown versions, run-recovery failure rollback, and byte-identical rejection before writes.
- [Storage tests](../../tests/storage.test.ts) cover transactional compare-and-swap across two SQLite connections, create-only writes, stale edits, and deletion without resurrection.
- [Persistence tests](../../tests/flow-persistence.test.ts) cover schema migration and complete bundle parsing, including future versions, duplicate IDs, missing roots, and size bounds.
- [Registry tests](../../tests/node-definitions.test.ts) and [graph tests](../../tests/flow-validation.test.ts) cover configuration, references, targets/provider defaults, resolved-value validation before adapters, frozen targets, child input shapes, and matching graph-size limits.
- [Save synchronization tests](../../tests/flow-sync.test.ts) prove a committed revision remains acknowledged if runner synchronization fails, with no raw transport diagnostics returned.
- [Preview tests](../../src/renderer/preview-api.test.ts) and [UI smoke](../../scripts/smoke-ui.mjs) cover migration, atomic cross-tab saves, preserved local drafts, version-2 bundle round-trips, and committed-save warnings that block automatic Run.

## Remaining limits

No fresh Windows, macOS, or Wayland manual verification was performed. These checks do not establish installer upgrade/offline behavior, live provider/model compatibility, semantic native targeting, or chat authoring. AI calls remain mocked. Use the [platform matrix](../platform-support.md) and [roadmap](../beta-roadmap.md) for those outstanding requirements.
