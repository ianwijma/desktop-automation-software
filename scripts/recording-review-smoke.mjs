import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

/** Renderer acceptance uses a controlled desktop API; native effects are covered by smoke.mjs. */
export async function runRecordingReviewSmoke({
  browser,
  url,
  outputDir = "test-results",
}) {
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1100 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url);
  const fixture = await page.evaluate(async () =>
    (await import("/src/renderer/preview-api.ts")).previewAPI.bootstrap(),
  );
  fixture.flows = fixture.flows.slice(0, 2).map((flow, i) => ({
    ...flow,
    id: `recorder-flow-${i}`,
    name: i ? "Other workflow" : "Recording origin",
    hotkey: undefined,
  }));
  fixture.flows[0] = {
    ...fixture.flows[0],
    inputs: {},
    outputs: {},
    nodes: [
      {
        id: "start",
        kind: "start",
        label: "Start",
        config: {},
        position: { x: 0, y: 0 },
      },
      {
        id: "choice",
        kind: "condition",
        label: "Choose route",
        config: { left: true, operator: "truthy" },
        position: { x: 310, y: 0 },
      },
      {
        id: "yes",
        kind: "end",
        label: "Success",
        config: {},
        position: { x: 620, y: 0 },
      },
      {
        id: "no",
        kind: "end",
        label: "Alternative",
        config: {},
        position: { x: 620, y: 220 },
      },
    ],
    edges: [
      { id: "enter", source: "start", target: "choice", port: "next" },
      { id: "true-edge", source: "choice", target: "yes", port: "true" },
      { id: "false-edge", source: "choice", target: "no", port: "false" },
    ],
  };
  fixture.targets = ["one", "two"].map((id) => ({
    id: `target-${id}`,
    name: `Application ${id}`,
    kind: "desktop",
  }));
  fixture.schedules = [];
  fixture.runs = [];
  fixture.desktop = true;
  fixture.capabilities = {
    ...fixture.capabilities,
    capture: true,
    input: true,
    directRecording: true,
  };
  await page.addInitScript((fixture) => {
    const key = "relay.recording.qa";
    const empty = () => ({
      phase: "idle",
      active: false,
      revision: 0,
      mode: "guided",
      actions: [],
    });
    const prior = sessionStorage.getItem(key);
    const data = prior
      ? JSON.parse(prior)
      : {
          state: fixture,
          counters: { input: 0, capture: 0, start: 0, inserts: 0, updates: 0 },
        };
    const { state, counters } = data;
    if (prior && state.recording.phase !== "idle")
      state.recording = {
        ...state.recording,
        phase: "review",
        active: false,
        recovered: true,
        revision: state.recording.revision + 1,
      };
    const listeners = new Set();
    const persist = () => sessionStorage.setItem(key, JSON.stringify(data));
    const clone = (value) => structuredClone(value);
    const publish = () => {
      persist();
      listeners.forEach((listener) =>
        listener({ type: "recording", recording: clone(state.recording) }),
      );
      return clone(state.recording);
    };
    const session = (id, phase, revision) => {
      if (
        state.recording.sessionId !== id ||
        (phase && state.recording.phase !== phase)
      )
        throw new Error("Stale or inactive recording session.");
      if (revision !== undefined && revision !== state.recording.revision)
        throw new Error("Recording changed; reload it before editing.");
    };
    const advance = (patch) => {
      state.recording = {
        ...state.recording,
        ...patch,
        revision: state.recording.revision + 1,
      };
      return publish();
    };
    const baseGraphs = clone(state.flows);
    window.__recordingQA = { counters, state, baseGraphs };
    persist();
    window.relay = {
      bootstrap: async () => clone(state),
      onEvent: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      validateFlow: async () => [],
      saveFlow: async (flow, options) => {
        const current = state.flows.find((item) => item.id === flow.id);
        if ((current?.revision ?? null) !== options.expectedRevision)
          return {
            status: "conflict",
            current: clone(current),
            reason: "Fixture revision conflict",
          };
        const saved = {
          ...clone(flow),
          revision: (current?.revision ?? 0) + 1,
        };
        state.flows = [
          ...state.flows.filter((item) => item.id !== flow.id),
          saved,
        ];
        persist();
        return { status: "saved", flow: clone(saved) };
      },
      capture: async (targetId) => {
        counters.capture++;
        persist();
        return {
          id: `frame-${counters.capture}`,
          targetId,
          capturedAt: Date.now(),
          width: 400,
          height: 250,
          dataUrl:
            "data:image/svg+xml," +
            encodeURIComponent(
              '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="250"><rect width="400" height="250" fill="#253346"/><rect x="120" y="90" width="160" height="60" rx="10" fill="#9392ff"/><text x="200" y="127" text-anchor="middle" fill="white" font-size="20">Fixture button</text></svg>',
            ),
        };
      },
      startRecording: async (options) => {
        if (state.recording.phase !== "idle")
          throw new Error("Review or discard the existing draft.");
        const flow = state.flows.find((item) => item.id === options.flowId);
        if (!flow || flow.revision !== options.flowRevision)
          throw new Error("Stale flow revision");
        counters.start++;
        state.recording = {
          phase: "capturing",
          active: true,
          sessionId: crypto.randomUUID(),
          revision: 1,
          mode: options.mode,
          targetId: options.targetId,
          destination: {
            flowId: flow.id,
            flowRevision: flow.revision,
            flowName: flow.name,
            ...(options.anchorNodeId
              ? { anchorNodeId: options.anchorNodeId }
              : {}),
            ...(options.anchor ? { anchor: options.anchor } : {}),
          },
          actions: [],
        };
        return publish();
      },
      recordAction: async (id, action, perform) => {
        session(id, "capturing");
        if (perform) counters.input++;
        const next = {
          ...clone(action),
          id: crypto.randomUUID(),
          at: Date.now(),
          config: { ...action.config, targetId: state.recording.targetId },
        };
        return advance({ actions: [...state.recording.actions, next] });
      },
      pauseRecording: async (id) => {
        session(id, "capturing");
        return advance({ phase: "paused", active: false });
      },
      resumeRecording: async (id) => {
        session(id, "paused");
        return advance({ phase: "capturing", active: true });
      },
      setRecordingTarget: async (id, targetId) => {
        session(id, "paused");
        return advance({ targetId });
      },
      stopRecording: async (id) => {
        session(id);
        return advance({ phase: "review", active: false });
      },
      updateRecording: async (id, revision, actions) => {
        session(id, "review", revision);
        if (window.__recordingQA.failNextUpdate) {
          window.__recordingQA.failNextUpdate = false;
          throw new Error("Fixture review write failed");
        }
        counters.updates++;
        return advance({ actions: clone(actions) });
      },
      discardRecording: async (id, revision) => {
        session(id, "review", revision);
        state.recording = empty();
        return publish();
      },
      insertRecording: async (id, revision, options) => {
        session(id, "review", revision);
        const { applyRecording, createRecordingFlow, emptyRecordedFlow } =
          await import("/src/shared/recording.ts");
        const source = state.flows.find(
          (flow) => flow.id === state.recording.destination.flowId,
        );
        const authored =
          options.destination === "bound"
            ? applyRecording(
                source,
                state.recording,
                () => crypto.randomUUID(),
                options.anchor,
              )
            : createRecordingFlow(state.recording, options.name);
        const flow = {
          ...authored,
          revision: options.destination === "bound" ? source.revision + 1 : 1,
        };
        const previousFlow =
          options.destination === "bound"
            ? clone(source)
            : emptyRecordedFlow(flow, () => crypto.randomUUID());
        counters.inserts++;
        state.flows = [
          ...state.flows.filter((item) => item.id !== flow.id),
          flow,
        ];
        state.recording = empty();
        publish();
        return { flow: clone(flow), recording: empty(), previousFlow };
      },
    };
  }, fixture);
  try {
    await page.reload();
    await selectFlow("Recording origin");
    await recordTab();
    await page
      .getByLabel("Recording target", { exact: true })
      .selectOption("target-one");
    await page
      .getByRole("button", { name: "Start recording", exact: true })
      .click();
    const binding = (await snapshot()).recording.destination;
    await type("first action");
    await selectFlow("Other workflow");
    await recordTab();
    assert.deepEqual((await snapshot()).recording.destination, binding);
    await page
      .getByRole("button", { name: "Return to bound workflow", exact: true })
      .waitFor();
    await page
      .getByRole("button", { name: "Pause recording", exact: true })
      .click();
    assert.equal((await snapshot()).recording.phase, "paused");
    const inputsAtPause = await page.evaluate(
      () => window.__recordingQA.counters.input,
    );
    await page
      .getByLabel("Recording target", { exact: true })
      .selectOption("target-two");
    await page
      .getByRole("button", { name: "Switch target", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Resume recording", exact: true })
      .click();
    await type("second action");
    await page
      .getByRole("button", { name: "Stop & review", exact: true })
      .click();
    const reviewed = (await snapshot()).recording;
    assert.equal(reviewed.phase, "review");
    assert.deepEqual(
      reviewed.actions.map((action) => action.config.targetId),
      ["target-one", "target-two"],
    );
    assert.equal(
      await page.evaluate(() => window.__recordingQA.counters.input),
      inputsAtPause + 1,
    );
    const beforeReview = await page.evaluate(() => ({
      ...window.__recordingQA.counters,
    }));
    await page
      .getByRole("button", { name: "Edit step 1", exact: true })
      .click();
    await page
      .getByLabel("Step label", { exact: true })
      .fill("Reviewed first action");
    await page
      .getByRole("button", { name: "Save step changes", exact: true })
      .click();
    // A failed persistence attempt keeps the local candidate and blocks insertion.
    await page.evaluate(() => {
      window.__recordingQA.failNextUpdate = true;
    });
    await page
      .getByRole("button", { name: "Edit step 1", exact: true })
      .click();
    await page
      .getByLabel("Step label", { exact: true })
      .fill("Preserved after save failure");
    await page
      .getByRole("button", { name: "Save step changes", exact: true })
      .click();
    await page.getByText(/The step could not be saved/).waitFor();
    assert.equal(
      await page.getByLabel("Step label", { exact: true }).inputValue(),
      "Preserved after save failure",
    );
    page.once("dialog", (dialog) => void dialog.accept());
    await page
      .getByRole("button", { name: "Cancel step changes", exact: true })
      .click();
    assert.equal(
      await page
        .getByRole("button", { name: "Insert recording", exact: true })
        .isDisabled(),
      true,
    );
    await page
      .getByText("Preserved after save failure", { exact: true })
      .waitFor();
    await selectFlow("Recording origin");
    await page
      .getByRole("button", { name: "Open recording draft", exact: true })
      .click();
    await page
      .getByText("Preserved after save failure", { exact: true })
      .waitFor();
    assert.equal(
      await page
        .getByRole("button", { name: "Insert recording", exact: true })
        .isDisabled(),
      true,
      "Unsaved review must survive leaving the recorder",
    );
    await page
      .getByRole("button", { name: "Retry saving review", exact: true })
      .click();
    assert.equal(
      (await snapshot()).recording.actions[0].label,
      "Preserved after save failure",
    );
    await page
      .getByRole("button", { name: "Duplicate step 1", exact: true })
      .click();
    assert.equal((await snapshot()).recording.actions.length, 3);
    await page
      .getByRole("button", { name: "Move step 3 up", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Delete step 1", exact: true })
      .click();
    await page.getByRole("button", { name: "Editor", exact: true }).click();
    await page
      .getByRole("button", { name: "Open recording draft", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Undo recording edit", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Redo recording edit", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Undo recording edit", exact: true })
      .click();
    assert.equal((await snapshot()).recording.actions.length, 3);
    await page.waitForTimeout(1100);
    const afterReview = await page.evaluate(() => ({
      ...window.__recordingQA.counters,
    }));
    assert.equal(
      await page.getByText(/This recording changed elsewhere/).count(),
      0,
      "Acknowledged review edits must not show a false revision conflict",
    );
    assert.equal(
      afterReview.input,
      beforeReview.input,
      "Review edits must never replay inputs",
    );
    assert.equal(
      afterReview.capture,
      beforeReview.capture,
      "Review must not keep capturing the application",
    );
    await mkdir(outputDir, { recursive: true });
    await page.screenshot({
      path: join(outputDir, "relay-recording-review.png"),
      animations: "disabled",
    });
    page.once("dialog", (dialog) => void dialog.accept());
    await page
      .getByRole("button", { name: "Discard recording", exact: true })
      .click();
    assert.equal((await snapshot()).recording.phase, "idle");
    assert.deepEqual(
      (await snapshot()).flows
        .map((flow) => ({ id: flow.id, nodes: flow.nodes }))
        .sort((left, right) => left.id.localeCompare(right.id)),
      fixture.flows
        .map((flow) => ({ id: flow.id, nodes: flow.nodes }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    );

    // A refresh/restart recovers the latest acknowledged draft, never its listeners.
    await selectFlow("Recording origin");
    await recordTab();
    await page
      .getByLabel("Recording target", { exact: true })
      .selectOption("target-one");
    await page
      .getByRole("button", { name: "Start recording", exact: true })
      .click();
    await type("recover this step");
    const beforeReload = await page.evaluate(() => ({
      ...window.__recordingQA.counters,
    }));
    await page.reload();
    await recordTab();
    await page.getByText(/Recovered recording draft/).waitFor();
    assert.equal((await snapshot()).recording.phase, "review");
    assert.equal(
      await page
        .getByRole("button", { name: "Resume recording", exact: true })
        .count(),
      0,
    );
    await page.waitForTimeout(1100);
    const afterReload = await page.evaluate(() => ({
      ...window.__recordingQA.counters,
    }));
    assert.equal(afterReload.input, beforeReload.input);
    assert.equal(afterReload.start, beforeReload.start);
    assert.equal(afterReload.capture, beforeReload.capture);
    await page
      .getByLabel("Insert recording into", { exact: true })
      .selectOption("new");
    await page
      .getByLabel("New flow name", { exact: true })
      .fill("Recovered reviewed flow");
    await page
      .getByRole("button", { name: "Insert recording", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Recovered reviewed flow", exact: true })
      .waitFor();
    const inserted = await snapshot();
    assert.equal(inserted.recording.phase, "idle");
    assert.equal(inserted.flows.length, 3);
    assert.deepEqual(
      inserted.flows
        .find((flow) => flow.name === "Recovered reviewed flow")
        .nodes.map((node) => node.kind),
      ["start", "type", "end"],
    );
    assert.equal(
      await page.evaluate(() => window.__recordingQA.counters.inserts),
      1,
    );
    // One new-flow insertion is one undoable graph change.
    await page
      .getByRole("button", { name: "Undo (Ctrl+Z)", exact: true })
      .click();
    assert.equal(await page.locator(".react-flow__node").count(), 2);
    await saveGraph();
    assert.deepEqual(
      (await snapshot()).flows
        .find((flow) => flow.name === "Recovered reviewed flow")
        .nodes.map((node) => node.kind),
      ["start", "end"],
    );
    await page
      .getByRole("button", { name: "Redo (Ctrl+Shift+Z)", exact: true })
      .click();
    await saveGraph();
    assert.equal(
      (await snapshot()).flows.find(
        (flow) => flow.name === "Recovered reviewed flow",
      ).nodes.length,
      3,
    );

    // Selecting a canvas edge seeds an explicit branch choice; it never picks a decision branch by node alone.
    await selectFlow("Recording origin");
    await page.locator('.react-flow__edge[data-id="true-edge"]').click();
    await recordTab();
    const truePoint = JSON.stringify(["choice", "true", "true-edge", "yes"]);
    assert.equal(
      await page.getByLabel("Insertion point", { exact: true }).inputValue(),
      truePoint,
    );
    await page
      .getByRole("button", { name: "Start recording", exact: true })
      .click();
    assert.equal((await snapshot()).recording.destination.anchor.port, "true");
    await type("branch action");
    await page
      .getByRole("button", { name: "Stop & review", exact: true })
      .click();
    const originBefore = (await snapshot()).flows.find(
      (flow) => flow.name === "Recording origin",
    );
    await page
      .getByLabel("Insert recording into", { exact: true })
      .selectOption("bound");
    assert.equal(
      await page.getByLabel("Insertion point", { exact: true }).inputValue(),
      truePoint,
    );
    await page.screenshot({
      path: join(outputDir, "relay-recording-insertion.png"),
      animations: "disabled",
    });
    await page
      .getByRole("button", { name: "Insert recording", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Undo (Ctrl+Z)", exact: true })
      .waitFor();
    const branchInserted = (await snapshot()).flows.find(
      (flow) => flow.name === "Recording origin",
    );
    assert.equal(branchInserted.nodes.length, originBefore.nodes.length + 1);
    assert.deepEqual(
      branchInserted.edges.find((edge) => edge.id === "false-edge"),
      originBefore.edges.find((edge) => edge.id === "false-edge"),
    );
    assert.notEqual(
      branchInserted.edges.find((edge) => edge.id === "true-edge").target,
      "yes",
    );
    assert.ok(
      branchInserted.edges.some(
        (edge) =>
          edge.source ===
            branchInserted.edges.find((edge) => edge.id === "true-edge")
              .target && edge.target === "yes",
      ),
    );
    await selectFlow("Other workflow");
    await selectFlow("Recording origin");
    await page
      .getByRole("button", { name: "Undo (Ctrl+Z)", exact: true })
      .click();
    await saveGraph();
    const branchUndone = (await snapshot()).flows.find(
      (flow) => flow.name === "Recording origin",
    );
    assert.deepEqual(branchUndone.nodes, originBefore.nodes);
    assert.deepEqual(branchUndone.edges, originBefore.edges);
    await page
      .getByRole("button", { name: "Redo (Ctrl+Shift+Z)", exact: true })
      .click();
    await saveGraph();
    const branchRedone = (await snapshot()).flows.find(
      (flow) => flow.name === "Recording origin",
    );
    assert.deepEqual(branchRedone.nodes, branchInserted.nodes);
    assert.deepEqual(branchRedone.edges, branchInserted.edges);

    // A decision node alone never silently chooses a branch. Late changes preserve review.
    await page.locator('.react-flow__node[data-id="choice"]').click();
    await recordTab();
    assert.equal(
      await page.getByLabel("Insertion point", { exact: true }).inputValue(),
      "",
    );
    await page
      .getByRole("button", { name: "Start recording", exact: true })
      .click();
    await type("preserve on conflict");
    await page
      .getByRole("button", { name: "Stop & review", exact: true })
      .click();
    await page
      .getByLabel("Insert recording into", { exact: true })
      .selectOption("bound");
    assert.equal(
      await page
        .getByRole("button", { name: "Insert recording", exact: true })
        .isDisabled(),
      true,
    );
    await page
      .getByLabel("Insertion point", { exact: true })
      .selectOption(JSON.stringify(["choice", "false", "false-edge", "no"]));
    await page.evaluate(() => {
      const flow = window.__recordingQA.state.flows.find(
        (item) => item.name === "Recording origin",
      );
      flow.revision++;
    });
    const reviewBeforeConflict = (await snapshot()).recording;
    await page
      .getByRole("button", { name: "Insert recording", exact: true })
      .click();
    await page.getByText(/destination workflow changed/).waitFor();
    assert.deepEqual((await snapshot()).recording, reviewBeforeConflict);
    await page
      .getByLabel("Insert recording into", { exact: true })
      .selectOption("new");
    await page
      .getByLabel("New flow name", { exact: true })
      .fill("Conflict copy");
    await page
      .getByRole("button", { name: "Insert recording", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Conflict copy", exact: true })
      .waitFor();
    await page.reload();
    await recordTab();
    assert.equal((await snapshot()).recording.phase, "idle");
    assert.deepEqual(errors, []);
    console.log(
      "PASS: recording destination across navigation; explicit pause/target switch; review edit/reorder/duplicate/delete/undo without capture/input; discard leaves graphs unchanged; recovery into review; explicit insertion once; branch edge splicing and successor preservation; whole-insertion undo/redo with save/reload; stale destination preserves review.",
    );
  } catch (error) {
    await mkdir(outputDir, { recursive: true });
    await page.screenshot({
      path: join(outputDir, "relay-recording-failure.png"),
      animations: "disabled",
    });
    throw error;
  } finally {
    await context.close();
  }
  async function saveGraph() {
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.waitForFunction(
      () =>
        Array.from(document.querySelectorAll(".toolbar-actions button")).find(
          (button) => button.textContent.trim() === "Save",
        )?.disabled === true,
    );
  }
  async function snapshot() {
    return page.evaluate(() => structuredClone(window.__recordingQA.state));
  }
  async function selectFlow(name) {
    await page.getByRole("button", { name, exact: true }).click();
  }
  async function recordTab() {
    await page.getByRole("button", { name: "Record", exact: true }).click();
  }
  async function type(text) {
    await page.getByLabel("Type into application", { exact: true }).fill(text);
    await page.getByRole("button", { name: "Type", exact: true }).click();
    await page.waitForFunction(
      (value) =>
        window.__recordingQA.state.recording.actions.some(
          (action) => action.config.text === value,
        ),
      text,
    );
  }
}
