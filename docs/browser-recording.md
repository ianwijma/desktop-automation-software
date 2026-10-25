# Browser recording coverage

Choose a browser target and **Direct** recording to teach a flow by using the page. Managed Chromium and the companion extension use the same DOM event normalizer and [structured locators](browser-locators.md). Stop to review the draft before inserting it; insertion and Run remain separate actions.

## Recorded interactions

| Interaction                                           | Stored behavior                                                                                                                                                                      |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Typing, replacement, paste, textarea, contenteditable | A field's final text replaces its value. Adjacent edits coalesce until a boundary; clipboard APIs and contents are not read by the recorder.                                         |
| IME composition                                       | Intermediate composition input coalesces into the final text. A composition still active at Pause/Stop gets a configuration warning.                                                 |
| Checkbox/radio                                        | A Click stores the desired `checked` state. Replaying an already-selected option does not toggle it. Radio deselection requires choosing another option.                             |
| Select                                                | A single value or an array of values for a multiple select. Native click/change duplicates are suppressed.                                                                           |
| Clicks                                                | Left/right/middle, click count, and Control/Alt/Shift/Meta modifiers. Consecutive clicks in a double-click sequence become one action with a count.                                  |
| Shortcuts and held keys                               | Non-text command keys store press or paired down/up actions. Repeated keydown noise is ignored; Stop adds a release for an unfinished pair.                                          |
| Scrolling                                             | Wheel, scroll-key, and scrollbar intent records the resulting element/page position, coalescing adjacent updates. Automatic scrolling alone is ignored.                              |
| Pointer dragging                                      | Source and destination locators, relative hit offsets, button, and duration. Both endpoints must remain visible in the viewport.                                                     |
| Navigation                                            | Main-document navigation and History/fragment changes store an observed destination. Replay waits briefly for a prior action to reach it, then navigates only if needed.             |
| Owned tabs                                            | Popups opened by the selected tab, switching among that tab and its popup descendants, and closing the active owned tab with an explicit return URL. Exact URL matches are required. |

Text is flushed before the next interaction, on blur, navigation, tab changes, Pause, and Stop. Field editing keys such as selection, Backspace, and paste shortcuts are represented by their resulting text; replay does not reproduce every physical keystroke or clipboard operation. Application shortcuts outside that text-editing set retain their key actions. A literal paste into an ordinary field becomes ordinary recorded text, so review the draft before sharing it.

Click sequences coalesce for up to 250 ms; scroll updates coalesce for 160 ms of inactivity. A different interaction flushes the prior pending action first. Recorder acknowledgements distinguish events accepted by Relay from events still in transit. Stop returns pending/unacknowledged actions through the owning cleanup call, and saves them before review is acknowledged. Retried cleanup reuses stable receipts instead of manufacturing duplicate steps. Late callbacks remain fenced by the recording session and epoch.

## Configure before running

Passwords are stored with empty text and a **Configure before running** warning. File paths and file contents are omitted. File-chooser actions and specialized HTML drag-and-drop get replacement/configuration warnings. A target that cannot produce a unique locator also creates a warning step rather than a guessed click.

Warnings appear in recording review and node properties. Edit the action or replace/delete it, then choose **Mark as configured** when appropriate. Password acknowledgement remains disabled until a value is configured. The acknowledgement does not send input. Validation and both adapters reject steps still marked as needing configuration, including when inserted into a workflow.

## Boundaries

- This covers DOM interactions in the selected page and its owned popup chain. It does not record arbitrary unrelated tabs, browser chrome, native file dialogs, restricted pages, closed shadow roots, or operating-system gestures. Managed tab activation also follows trusted interaction when browser focus/visibility events are unavailable; an empty tab visit need not create a step.
- Replay uses exact, unambiguous locators and tab URLs. Duplicate tab URLs fail rather than selecting the first tab. Titles, transient tab IDs, and screen coordinates are not substitutes for tab identity.
- General HTML drag data transfer, cross-document drags, canvas/GPU protocols, and virtualized/custom widget behavior are not promised. Ordinary pointer drags use 20 movement steps; this does not implement arbitrary drag-and-drop protocols.
- Main-document navigation is recorded. Subframe navigation continues to use owner-based locator scopes and application behavior; it is not recorded as a separate general navigation command. Rapid application-driven redirects or unusual history transitions may require review and explicit waits.
- Final field values are replayed using the existing browser control semantics. Applications that require every original input event, intermediate IME state, or native clipboard side effects may need manual steps.
- Pause/Stop must complete before another workflow can use input. A service/process crash or a page closing before an event reaches Relay can still leave an incomplete last interaction; recovered drafts stay in review.
- Workflow/database versions remain 2 and recording metadata envelopes remain version 1. New optional node configuration preserves legacy coordinate/CSS workflows. Existing single-value CSS Select result shapes remain unchanged; array-valued Select returns an array in both adapters.

See [recording lifecycle and insertion](recording.md) and [B02 verification](verification/b02-2026-10-26.md). These browser checks do not establish new native platform or installer support.
