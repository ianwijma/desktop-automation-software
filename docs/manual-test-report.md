# Relay manual verification report template

Copy this template for a real verification run and link the completed report from the [platform support matrix](platform-support.md) and [roadmap](beta-roadmap.md). Leave unexecuted rows as **Not run**. This template itself is not evidence of a successful run.

## Identity

- Date / tester:
- Roadmap IDs / PR:
- Commit / app version:
- Artifact filename / SHA-256:
- OS version / architecture:
- Desktop session / compositor / portal versions:
- Display arrangement / resolutions / scaling:
- Capture/input/accessibility backends:
- Installation type / upgrade-from version:
- Applications and exact versions tested:
- AI provider / endpoint kind / model / runtime version (no keys):

## Preconditions

- Clean user/profile, existing profile, or upgraded installation:
- Linux system prerequisites already present:
- Permissions initially granted/denied:
- Offline checks: network disabled; no developer tools/browser cache/system OCR:
- Local model already installed and running (if applicable):

## Results

Use **Pass**, **Fail**, **Unsupported**, or **Not run** and record observed behavior.

| Scenario                                                     | Result  | Evidence / observed behavior |
| ------------------------------------------------------------ | ------- | ---------------------------- |
| Install and first launch under normal user account           | Not run |                              |
| Offline managed Chromium + OCR for each bundled language     | Not run |                              |
| Launch/attach/focus intended application                     | Not run |                              |
| Capture and coordinate mapping on each display/scale         | Not run |                              |
| Move/resize target; reject stale coordinates                 | Not run |                              |
| Guided recording, review, branch insertion, replay           | Not run |                              |
| Direct recording and target boundaries                       | Not run |                              |
| Semantic locator: unique/missing/ambiguous/stale             | Not run |                              |
| Visual detector: match/no-match/uncertain/error              | Not run |                              |
| Native and GPU-rendered application fixtures                 | Not run |                              |
| Cancel during held key or drag; confirm input released       | Not run |                              |
| Permission denied/revoked; recovery                          | Not run |                              |
| Wayland chooser cancellation, source closure, restoration    | Not run |                              |
| Stop/pause hotkeys and unavailable-registration feedback     | Not run |                              |
| Browser extension pairing and semantic replay                | Not run |                              |
| AI operation checks and unavailable-model feedback           | Not run |                              |
| Chat image upload/paste/drop/window capture                  | Not run |                              |
| Chat review/Apply, conflicts, indirect-trigger copy rule     | Not run |                              |
| Separate manual Run after Apply                              | Not run |                              |
| Sequential/pool/fixed-batch children and desktop exclusivity | Not run |                              |
| Restart: draft/history recovery without replay               | Not run |                              |
| Upgrade preserves workflows/settings/assets/credentials      | Not run |                              |
| Uninstall behavior                                           | Not run |                              |

## Follow-up

- Failures and reproduction steps:
- Unsupported capabilities (visible product behavior):
- Unexecuted scenarios / required hardware:
- Resulting issues/PRs:
- Exact support claims this report establishes:

Use synthetic images and sample inputs. Redact sensitive data before attaching evidence. Confirm no API keys, password values, private screenshots, or raw provider responses are included.
