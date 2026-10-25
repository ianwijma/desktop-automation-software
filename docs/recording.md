# Recording and reviewing a workflow

Recording follows **Record → Stop & review → Insert**. Relay keeps one local recording draft independently of the workflow currently open in the editor. Stopping does not change a graph or start a run.

## Capture actions

1. Open a workflow and select **Record**. Optionally select a connection in the canvas first, or choose an **Insertion point** in the recorder. Relay saves this workflow when recording starts and binds the session to that saved revision.
2. Choose an application target and recording mode. **Guided** mode lets you interact through the preview and action controls. **Direct** mode observes actions in the selected application where the adapter supports it.
3. Select **Start recording**, then perform the actions you want to teach. Guided actions marked for execution affect the application immediately and are added to the draft.
4. Select **Pause recording** to stop accepting actions. To change applications, choose a target while paused and select **Switch target**, then **Resume recording**. Previously captured steps keep their original targets.
5. Select **Stop & review**. Relay stops the recording listeners, drains accepted events, and releases held input before entering review. If cleanup fails, retry Stop; workflow execution stays blocked until cleanup succeeds.

The sidebar's recording entry opens the same session from elsewhere in Relay. Navigating between flows does not change its bound destination. The pause and stop shortcuts also affect an active recording. Paused sessions require an explicit Resume; recovered sessions cannot resume.

## Review without replay

Review shows the recorded sequence and each step's target. Edit a step's label and configuration, duplicate or delete it, or move it up/down. **Save step changes** commits the edit. Review has its own undo/redo history, retained across navigation while Relay remains open; the latest saved sequence survives restart.

Editing, reordering, undo, and redo never send input to an application. Preview polling stops while paused and in review. A failed review save keeps the edited sequence available across navigation for retry; resolve the failure before inserting or closing Relay. An action interrupted during execution may already have affected the application, so Relay preserves it with an uncertainty warning for you to inspect.

One draft is stored locally in SQLite. Relaunching Relay recovers the latest acknowledged sequence into **review**, even if the app closed during capture. Recovery never installs recording listeners or replays actions. An action interrupted before its save was acknowledged may be absent or incomplete; check the sequence before running it.

## Insert or discard

**New workflow** is the default insertion destination. Give it a name and select **Insert recording** to create a connected Start → recorded steps → Finish sequence. Insertion saves the flow and consumes the draft together. Running the result is a separate action.

To insert into the original workflow, select it under **Insert recording into**, then choose an **Insertion point**. You can make this choice during review, even if none was chosen when recording started. Each choice names the source node, its exact output port, and the existing successor or a new Finish. Selecting a connection in the canvas before recording carries that edge into review. Selecting a decision node alone never chooses a branch.

For example, choosing **Check ready · true → Continue** replaces that connection with Check ready → recorded steps → Continue. The false branch stays connected as it was. An unused output gets a new Finish after the sequence. Original nodes, IDs, references, configurations, and positions are preserved; added cards use available space. The canvas shows the same normal, detector, fallback, and error outputs offered by the selector.

Only outputs reachable from Start can receive steps. Finish nodes, missing successors, and outputs with multiple competing edges are excluded. Relay checks the workflow revision and exact source/port/edge/successor again when you insert. If the workflow changes or is deleted, the draft is preserved so you can create a new workflow instead. Existing unsaved editor changes must be saved first; saving changes to the bound workflow makes the old recording revision stale.

## Undo an insertion

One insertion creates one entry in the editor's graph history. **Undo (Ctrl+Z)** restores the complete prior nodes and edges, including the original successor connection. **Redo** restores the inserted sequence with the same IDs. Save the restored graph to persist it; Run remains a separate action. Undo of insertion into a new workflow clears the recorded steps and leaves an editable Start → Finish workflow.

The most recent insertion can also be undone after navigating away and returning during the same app session, provided the saved workflow revision is unchanged. Graph history does not survive restarting Relay. A concurrent save still produces a revision conflict; Undo never bypasses it. Retrying a completed insertion does not create another graph change, and if the destination has since changed Relay shows the current version without offering an undo that would overwrite the later changes.

**Discard recording** removes the draft after confirmation and leaves workflow nodes and edges unchanged. Starting a recording may already have saved the source workflow's editor changes.

## Current boundaries

- The browser-only editor preview cannot record or control desktop applications; use the Electron app.
- Capture and direct recording depend on the selected adapter's capabilities. This workflow does not add new platform support or broader browser event coverage.
- A draft is limited to 2,000 steps, and insertion must also fit the workflow's 2,000-node and 4,000-edge limits. A new flow needs two additional nodes for Start and Finish.
- An insertion only changes one explicitly chosen output. Recordings cannot silently add disconnected sequences or insert after Finish.
- Guided preview coordinates retain the current adapter behavior. Stronger capture identity/coordinate contracts and platform qualification remain tracked in N01 and the native backend items.
