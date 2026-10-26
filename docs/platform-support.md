# Platform support and verification baseline

This matrix describes evidence, not a promise that all applications work. It is the F01 baseline for the [beta roadmap](beta-roadmap.md). Update it only with a linked test report or CI run identifying the tested revision.

Baseline source: PR #1 at `18b3839613460b83d6fd7207f06f1daaa6e31bc2`. Its [cross-platform CI run](https://github.com/ianwijma/desktop-automation-software/actions/runs/39596804571) passed on Ubuntu, Windows, and macOS. CI's Windows/macOS smoke checks start the app and exercise IPC, persistence, orchestration, and themes; their native capture/input block is **not** enabled.

| Environment / capability                                  | Implemented in PR #1            | Automated evidence                                                                                                            | Manual verification / gap                                                            |
| --------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Electron app: Linux, Windows, macOS                       | Yes                             | Build, UI, app smoke, unpacked packaging on all three CI hosts                                                                | Actual installers/upgrade and focused beta OS versions pending                       |
| Linux X11 input/capture                                   | Yes                             | Isolated Xvfb capture, targeting, input, recording, cancellation; source and packaged Linux smoke                             | Real desktop / mixed displays / representative applications pending                  |
| Windows input/capture                                     | Yes, Rust WGC/SendInput backend | Native compilation/contract tests; 45/45 hosted Win32/Electron scenarios pass; [N02 evidence](verification/n02-2026-10-26.md) | Real Windows 11, hardware GPU, mixed OS DPI and installed-artifact tests pending     |
| macOS input/capture                                       | Yes, CoreGraphics/system tools  | Native compilation; application smoke only                                                                                    | Installed-app permissions, actual capture/input, Retina tests pending (N03)          |
| Wayland portal input/capture                              | Yes, capability gated           | Linux compilation and unavailable-backend behavior                                                                            | GNOME and KDE compositor consent/capture/input/revocation pending (N04)              |
| Native accessibility locators                             | No                              | Unsupported state only                                                                                                        | N05–N07                                                                              |
| Direct recording: Windows/macOS                           | No                              | Unsupported state only                                                                                                        | N08–N09                                                                              |
| Direct recording: X11                                     | Yes                             | XInput fixture recording                                                                                                      | Layout/composition/security-field parity pending (N09)                               |
| Managed browser / existing-browser extension              | Yes                             | Playwright/bridge/real extension integration tests                                                                            | B01/B02 locator/event fixture evidence; real application breadth remains provisional |
| AI providers, including OpenRouter/local runtime adapters | Yes                             | Mocked provider protocol tests                                                                                                | Live model qualification and operation diagnostics pending (A01–A04)                 |
| Jev vision                                                | Experimental                    | Mocked presence/location protocol                                                                                             | Image preparation/confidence and live visual evaluation pending (A02/A04)            |
| Image-capable chat authoring                              | No                              | None                                                                                                                          | C01–C04; required for beta                                                           |
| Offline bundled installers                                | No                              | Unpacked app packaging; Linux packaged smoke                                                                                  | Chromium/OCR bundling and actual installer tests pending (D01–D03)                   |

## Focused beta verification targets

- Windows 11 x64.
- macOS 14 or later on Apple Silicon.
- Ubuntu 24.04 x64: GNOME X11, plus supported GNOME/KDE Wayland sessions recorded separately with exact desktop/portal versions.
- Other distributions/architectures and Intel Macs remain provisional until independently qualified.

## Stable regression journeys

Preserve the seeded **Your first workflow**, **Explore a website**, and **Orchestrate a batch** examples. The batch must still produce twelve ordered child results in four batches of three. Preserve physical desktop exclusivity while allowing independent browser profiles/AI work to overlap.

Retain PR #1 workflow-format fixtures for migration and import tests, including nested children, detector references, user configuration extensions, schedules, and targets. Existing tests cover cancellation/input cleanup, screenshot geometry guards, detector-result clicks, theme/accent persistence, provider credential isolation, and interrupted-run recovery. New PRs add evidence rather than replacing these checks with weaker assertions.

## Updating this matrix

The [2026-10-22 foundation verification](verification/foundations-2026-10-22.md) adds migration, revision-conflict, validation, UI, and source Electron evidence. It does not expand the platform support claims above.

The [2026-10-25 recording verification](verification/r01-2026-10-25.md) adds recoverable drafts, pause/review editing, explicit insertion, and listener/input cleanup regression evidence using the source app and isolated X11 fixtures. It does not expand the platform qualification above.

Use the [manual test report](manual-test-report.md) for real-desktop/installer results. Store synthetic artifacts only; do not commit provider credentials, private desktop captures, or personal input. A skipped test is not a pass. Record unsupported cases and the scope actually exercised, rather than claiming all OS applications or all provider models work.

The [2026-10-26 N01 evidence](verification/n01-2026-10-26.md) adds protocol/identity/transform contracts and a reusable native desktop harness with isolated X11 and software-rendered WebGL observations. It does not qualify hardware GPUs, Windows/macOS native behavior, Wayland sessions, mixed DPI, or installed artifacts.

N02 replaces the Windows PowerShell helper with persistent WGC and checked SendInput. PrintWindow requires explicit target configuration. Hosted matrix cases that cannot access an interactive graphics desktop are incomplete, not qualified. See [Windows qualification](windows-native.md).
