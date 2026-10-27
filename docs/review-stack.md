# Active implementation review stack

This stack implements the remaining [beta roadmap](beta-roadmap.md) without waiting for a merge after each item. Each PR compares against its immediate parent so its review stays focused. Review/merge from the bottom upward; no PR is merged automatically.

| Order | Slice                              | Branch                           | Base                        | Review                                                                    |
| ----- | ---------------------------------- | -------------------------------- | --------------------------- | ------------------------------------------------------------------------- |
| 1     | N06 — macOS AX targeting           | `codex/macos-ax-locators`        | `develop`                   | [PR #15](https://github.com/ianwijma/desktop-automation-software/pull/15) |
| 2     | A01 — AI operation checks          | `codex/ai-operation-checks`      | `codex/macos-ax-locators`   | [PR #16](https://github.com/ianwijma/desktop-automation-software/pull/16) |
| 3     | A02 — Jev image mapping/confidence | `codex/jev-image-mapping`        | `codex/ai-operation-checks` | [PR #17](https://github.com/ianwijma/desktop-automation-software/pull/17) |
| 4     | A03 — diagnostics/model discovery  | `codex/ai-diagnostics-discovery` | `codex/jev-image-mapping`   | This branch’s PR                                                          |

N06 and A01 are separate roadmap tracks; the base relationship records review order, not a runtime dependency. Later fixes to a parent must be carried into descendants before final verification. If a parent is squash-merged, descendants must be restacked/retargeted against the resulting base before merging; do not treat duplicated parent commits as part of a child's change.

Implemented code and passing hosted fixture checks are separate from actual platform/provider/installer qualification. Evidence and explicit gaps live in each work item's report. The full roadmap remains active: N07–N09, A04, C01–C04 and D01–D03 still require implementation/qualification. Existing real-session gaps in N01–N06 also remain open. This stack does not establish beta completion.
