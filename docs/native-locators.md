# Native semantic locators (N05)

Windows UI Automation supports desktop controls that expose supported patterns. The node inspector and recording review editor offer **Windows semantic locator** for Click (Invoke), Type (replace the full Value), Read, Select (select the matched item), and element Detect/Wait nodes. Coordinate/focused-app mode remains an explicit choice for Click/Type. A failed semantic action never falls back to pointer or keyboard input.

## Authoring and picking

Choose a desktop target with a unique application/window identity, then choose semantic targeting. Enter Automation ID, exact accessible name, native class and/or control type. Optional ancestor scopes are ordered from outermost to innermost, with exactly one match required at each scope. Test native match is read-only and reports missing, unique or ambiguous controls, enabled/offscreen/secure/virtualized state and supported actions.

**Pick native control** captures the selected window, then opens a read-only preview. Clicking the image inspects the smallest unique control rectangle at that point within the selected window's UIA control tree. It sends no desktop click and does not move focus. Keyboard users can enter preview-pixel X/Y and choose Inspect preview point. Apply the inspected locator explicitly. Refresh after moving/resizing/changing DPI or losing the helper; stale frame identity/geometry is rejected. The picker searches the target tree so Relay overlapping the application cannot cause a different application to be inspected.

A locator contains no coordinates, HWNDs, runtime IDs, PIDs or COM pointers:

```json
{
  "version": 1,
  "backend": "uia",
  "selector": { "automationId": "apply", "controlType": "button" },
  "ancestors": [{ "automationId": "settings-panel" }]
}
```

Known native locator fields are strictly validated at workflow save/import, recording and IPC boundaries. Ordinary value references can supply property strings or a complete locator; resolved locators are validated again before native access. Changing to semantic targeting clears conflicting browser/detected-location options. Tests never invoke or read field values. Supported Type/Read actions can contain/return nonsecure application values just like other workflow data; secure controls are blocked.

## Worker and action boundaries

One dedicated, windowless COM MTA worker owns every UIA interface. Only JSON crosses its bounded channel. Each request reacquires the root/control; no object pointer survives a request or enters a workflow. Searches are scoped to the selected top-level window and process, bounded to 2048 visited nodes and depth 40 across at most eight ancestor scopes. UIA connection/transaction timeouts are 500 ms, with a four-second cooperative search deadline and five-second worker response limit. An unresponsive worker is poisoned until helper restart, and timed-out requests are never replayed. A provider call already in progress may have effects even if it later times out; these effects cannot be rolled back or acknowledged as absent.

Inspection requires no active workflow/recording capture. Read/invoke/value/selection operations validate the window/process, interactive desktop and integrity level. Controls are checked again before provider access. No elevated/UIAccess/secure-desktop bypass is introduced. An owned visible popup or disabled root blocks the target; configure that dialog as its own target.

| Situation                           | Defined outcome                                                                             |
| ----------------------------------- | ------------------------------------------------------------------------------------------- |
| No realized match                   | Inspector: missing; action: `ELEMENT_NOT_FOUND`                                             |
| Duplicate match / ancestor          | Ambiguous result/error; no first-match/index heuristic                                      |
| Control moves                       | Semantic properties resolve again; no saved coordinates                                     |
| Removed/stale provider object       | Re-resolve produces missing, or `STALE_ELEMENT` during access                               |
| Disabled                            | Inspect/read where available; mutation: `ELEMENT_DISABLED`                                  |
| Offscreen                           | Inspect state; action: `ELEMENT_OFFSCREEN`; no automatic scroll                             |
| Virtualized placeholder             | `VIRTUALIZED_ELEMENT`; absent unrealized items are missing; no automatic realization/scroll |
| Password/secure                     | Name redacted, no value inspection, no supported semantic actions; `SECURE_ELEMENT`         |
| Unsupported pattern/read-only value | `UNSUPPORTED_PATTERN`; no coordinate/clipboard fallback                                     |
| Modal/owned popup                   | `MODAL_BLOCKED`; choose the dialog target                                                   |
| Provider/search stalls              | Bounded timeout/search-limit error; no retry or late fallback                               |

Invoke supports a single semantic activation, not right/middle/repeated clicks or pointer modifiers. Value sets the complete string, not appended keystrokes/composition. Read uses Value when available, otherwise the control's accessible name; this is not a document-wide text extractor. Select uses SelectionItem on the **matched item**, not a browser option value. Toggle, drag, scroll, arbitrary key actions and virtualized realization are outside N05's semantic operation set. Their separate coordinate/browser flows remain available explicitly. AX and AT-SPI implementations follow in N06/N07.

## Verification

```sh
npm run check
cargo test --manifest-path native/Cargo.toml
npm run test:ui
npm run build
npm run test:smoke
# In a disposable, unlocked Windows desktop with the Windows helper:
npm run test:native:windows -- --run
```

The Windows matrix adds four UIA cases to each Win32 fixture variant: read-only preview pick + moving control/invoke, Unicode Value/read/SelectionItem effects, duplicate/disabled/secure/read-only policies, and modal/removed-control behavior. The observation endpoint can move/destroy its own synthetic controls, but cannot perform the UIA actions being tested. Renderer tests use a controlled API and are not native provider qualification. Linux builds/cross-compilation cannot qualify Windows UIA; see the [N05 report](verification/n05-2026-10-27.md).

Real Windows 11, WPF/WinUI/Electron/provider variants, actual virtualized lists, multi-process hosted controls, high integrity, locked desktops, mixed displays and installed-app operation remain manual qualification targets. Unsupported or absent provider functionality is reported rather than inferred from a successful Win32 case.

## References

- [Microsoft UIA threading](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-threading)
- [Obtaining/scoping UIA elements](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-obtainingelements)
- [Virtualized items](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-workingwithvirtualizeditems)
- [UIA security](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-securityoverview)
