import { _electron as electron } from "playwright";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import sharp from "sharp";
import { DatabaseSync } from "node:sqlite";

const dataDir = await mkdtemp(join(tmpdir(), "relay-smoke-"));
await mkdir("test-results", { recursive: true });
const env = { ...process.env, RELAY_DATA_DIR: dataDir, RELAY_TEST_MODE: "1" };
delete env.ELECTRON_RUN_AS_NODE;
const executablePath = process.env.RELAY_SMOKE_EXECUTABLE;
const launchOptions = {
  executablePath,
  args: ["--no-sandbox", ...(executablePath ? [] : [resolve(".")])],
  env,
  timeout: 30000,
};
let app = await electron.launch(launchOptions);
const errors = [];
try {
  const page = await app.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForFunction(() => Boolean(window.relay));
  const initial = await page.evaluate(() => window.relay.bootstrap());
  assert.equal(initial.desktop, true);
  assert.equal(initial.flows.length, 3);
  assert.equal(initial.connections.length, 0);
  assert.equal(initial.keys, undefined);
  const referenceNode = initial.flows[0].nodes[0];
  await page
    .locator(`.react-flow__node[data-id="${referenceNode.id}"]`)
    .click();
  await page
    .getByRole("button", { name: "Copy node reference", exact: true })
    .click();
  await page.getByText("Reference copied.", { exact: true }).waitFor();
  assert.equal(
    await app.evaluate(({ clipboard }) => clipboard.readText()),
    "${nodes." + referenceNode.id + "}",
    "Copy node reference must work in the sandboxed Electron renderer",
  );
  const revisionFixture = {
    ...initial.flows[0],
    id: "revision-conflict-smoke",
    name: "Revision fixture",
  };
  const createdFlow = await page.evaluate(
    (flow) => window.relay.saveFlow(flow, { expectedRevision: null }),
    revisionFixture,
  );
  assert.equal(createdFlow.status, "saved");
  assert.equal(createdFlow.flow.schemaVersion, 2);
  const updatedFlow = await page.evaluate(
    (flow) =>
      window.relay.saveFlow(
        { ...flow, name: "Saved revision" },
        { expectedRevision: flow.revision },
      ),
    createdFlow.flow,
  );
  assert.equal(updatedFlow.status, "saved");
  const conflict = await page.evaluate(
    (flow) =>
      window.relay.saveFlow(
        { ...flow, name: "Stale edit" },
        { expectedRevision: flow.revision },
      ),
    createdFlow.flow,
  );
  assert.equal(conflict.status, "conflict");
  assert.equal(conflict.current.name, "Saved revision");
  await page.evaluate(() => window.relay.deleteFlow("revision-conflict-smoke"));
  const deletedConflict = await page.evaluate(
    (flow) => window.relay.saveFlow(flow, { expectedRevision: flow.revision }),
    updatedFlow.flow,
  );
  assert.equal(deletedConflict.status, "conflict");
  assert.equal(deletedConflict.current, undefined);
  const aiFixture = {
    id: "provider-switch-smoke",
    name: "Provider switch fixture",
    provider: "openai",
    baseUrl: "https://example.invalid/v1",
    model: "test-model",
    capabilities: { text: true, vision: false, structured: false },
    hasKey: false,
  };
  await page.evaluate(
    (connection) => window.relay.saveConnection(connection),
    aiFixture,
  );
  const fixtureDb = new DatabaseSync(join(dataDir, "relay.sqlite"));
  fixtureDb
    .prepare("INSERT INTO credentials(id,value) VALUES(?,?)")
    .run("provider-switch-smoke", "test-only-encrypted-credential-marker");
  fixtureDb.close();
  assert.equal(
    (
      await page.evaluate(
        (connection) => window.relay.saveConnection(connection),
        aiFixture,
      )
    ).hasKey,
    true,
  );
  const switched = await page.evaluate(
    (connection) => window.relay.saveConnection(connection),
    {
      ...aiFixture,
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
    },
  );
  assert.equal(
    switched.hasKey,
    false,
    "Changing providers must not reuse the previous provider API key",
  );
  await page.evaluate(() =>
    window.relay.deleteConnection("provider-switch-smoke"),
  );
  async function waitRun(id, sourcePage = page) {
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      const current = await sourcePage.evaluate(
        async (id) =>
          (await window.relay.bootstrap()).runs.find((r) => r.id === id),
        id,
      );
      if (current?.status === "succeeded") return current;
      if (
        current &&
        ["failed", "cancelled", "interrupted"].includes(current.status)
      )
        throw new Error(`Run ${current.flowName}: ${current.error}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Run ${id} timed out`);
  }
  const run = await page.evaluate(() => window.relay.runFlow("welcome"));
  await waitRun(run.id);
  const batch = await page.evaluate(() =>
    window.relay.runFlow("batch-starter"),
  );
  await waitRun(batch.id);
  const state = await page.evaluate(() => window.relay.bootstrap());
  assert.equal(
    state.runs.filter(
      (r) => r.parentId === batch.id && r.status === "succeeded",
    ).length,
    12,
  );
  await page.screenshot({ path: "test-results/relay-dark.png" });
  await page.evaluate(async () => {
    const state = await window.relay.bootstrap();
    await window.relay.saveSettings({
      ...state.settings,
      theme: "light",
      accent: "#08756f",
    });
  });
  await page.waitForTimeout(400);
  await page.screenshot({ path: "test-results/relay-light.png" });
  await page.evaluate(async () => {
    const state = await window.relay.bootstrap();
    await window.relay.saveSettings({
      ...state.settings,
      theme: "dark",
      accent: "#9292ff",
    });
  });

  if (
    process.platform === "linux" &&
    process.env.DISPLAY &&
    process.env.RELAY_SMOKE_NATIVE === "1"
  ) {
    await app.evaluate(async ({ BrowserWindow }) => {
      const fixture = new BrowserWindow({
        title: "Relay test target",
        x: 100,
        y: 100,
        width: 440,
        height: 320,
        webPreferences: { nodeIntegration: false, contextIsolation: true },
      });
      await fixture.loadURL(
        "data:text/html," +
          encodeURIComponent(
            "<title>Relay test target</title><style>body{margin:0;background:#fff}button{position:absolute;left:20px;top:20px;width:160px;height:60px}textarea{position:absolute;left:20px;top:120px;width:260px;height:80px}</style><button onclick=\"this.textContent='Clicked'\">Test button</button><textarea></textarea>",
          ),
      );
      fixture.show();
    });
    const target = {
      id: "native-smoke",
      name: "Isolated native test",
      kind: "desktop",
      windowTitle: "Relay test target",
    };
    await page.evaluate((target) => window.relay.saveTarget(target), target);
    const capabilities = await page.evaluate(() =>
      window.relay.getCapabilities(),
    );
    assert.equal(capabilities.input, true, capabilities.reasons.join("; "));
    const frame = await page.evaluate(() =>
      window.relay.capture("native-smoke"),
    );
    assert.ok(frame.width > 300);
    await writeFile(
      "test-results/native-capture.png",
      Buffer.from(frame.dataUrl.split(",")[1], "base64"),
    );
    const detection = await page.evaluate(
      (template) =>
        window.relay.testDetector({
          targetId: "native-smoke",
          detector: "image",
          template,
          threshold: 0.99,
        }),
      frame.dataUrl,
    );
    assert.equal(
      detection.outcome,
      "match",
      "Packaged OpenCV detects the captured fixture",
    );
    const buttonPng = await sharp(
      Buffer.from(frame.dataUrl.split(",")[1], "base64"),
    )
      .extract({ left: 20, top: 20, width: 160, height: 60 })
      .png()
      .toBuffer();
    const foundButton = await page.evaluate(
      (template) =>
        window.relay.testDetector({
          targetId: "native-smoke",
          detector: "image",
          template,
          threshold: 0.99,
        }),
      `data:image/png;base64,${buttonPng.toString("base64")}`,
    );
    assert.equal(foundButton.outcome, "match");
    const detectedClick = {
      ...initial.flows[0],
      id: "detected-click-smoke",
      name: "Detected click smoke",
      inputs: {},
      outputs: {},
      nodes: [
        {
          id: "start",
          kind: "start",
          label: "Start",
          position: { x: 0, y: 0 },
          config: {},
        },
        {
          id: "click",
          kind: "click",
          label: "Click detected button",
          position: { x: 300, y: 0 },
          config: { targetId: "native-smoke", detection: foundButton },
        },
        {
          id: "end",
          kind: "end",
          label: "End",
          position: { x: 600, y: 0 },
          config: {},
        },
      ],
      edges: [
        { id: "one", source: "start", target: "click" },
        { id: "two", source: "click", target: "end" },
      ],
    };
    const savedClick = await page.evaluate(
      (flow) => window.relay.saveFlow(flow, { expectedRevision: null }),
      detectedClick,
    );
    assert.equal(savedClick.status, "saved");
    await waitRun(
      (await page.evaluate(() => window.relay.runFlow("detected-click-smoke")))
        .id,
    );
    assert.equal(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .find((w) => w.getTitle() === "Relay test target")
          .webContents.executeJavaScript(
            'document.querySelector("button").textContent',
          ),
      ),
      "Clicked",
    );
    const session = await page.evaluate(
      (flow) =>
        window.relay.startRecording({
          targetId: "native-smoke",
          mode: "guided",
          flowId: flow.id,
          flowRevision: flow.revision,
        }),
      initial.flows[0],
    );
    assert.equal(session.phase, "capturing");
    assert.ok(session.sessionId);
    assert.equal(session.destination.flowId, initial.flows[0].id);
    await page.evaluate(
      (sessionId) =>
        window.relay.recordAction(
          sessionId,
          {
            kind: "click",
            label: "Click test",
            config: { x: 80, y: 50, button: "left" },
          },
          true,
        ),
      session.sessionId,
    );
    const clicked = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.getTitle() === "Relay test target")
        .webContents.executeJavaScript(
          'document.querySelector("button").textContent',
        ),
    );
    assert.equal(clicked, "Clicked");
    await page.evaluate(
      (sessionId) =>
        window.relay.recordAction(
          sessionId,
          {
            kind: "click",
            label: "Focus textarea",
            config: { x: 80, y: 160, button: "left" },
          },
          true,
        ),
      session.sessionId,
    );
    await page.evaluate(
      (sessionId) =>
        window.relay.recordAction(
          sessionId,
          {
            kind: "type",
            label: "Type test",
            config: { text: "Relay native test" },
          },
          true,
        ),
      session.sessionId,
    );
    const typed = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.getTitle() === "Relay test target")
        .webContents.executeJavaScript(
          'document.querySelector("textarea").value',
        ),
    );
    assert.equal(typed, "Relay native test");
    const forbiddenType = async (sessionId) =>
      page.evaluate(
        (sessionId) =>
          window.relay.recordAction(
            sessionId,
            {
              kind: "type",
              label: "Must not execute",
              config: { text: "UNEXPECTED INPUT" },
            },
            true,
          ),
        sessionId,
      );
    await assert.rejects(forbiddenType("stale-session-id"));
    const paused = await page.evaluate(
      (sessionId) => window.relay.pauseRecording(sessionId),
      session.sessionId,
    );
    assert.equal(paused.phase, "paused");
    assert.equal(paused.active, false);
    await assert.rejects(forbiddenType(session.sessionId));
    const resumed = await page.evaluate(
      (sessionId) => window.relay.resumeRecording(sessionId),
      session.sessionId,
    );
    assert.equal(resumed.phase, "capturing");
    assert.equal(resumed.sessionId, session.sessionId);
    const beforeReview = await page.evaluate(() => window.relay.bootstrap());
    const recording = await page.evaluate(
      (sessionId) => window.relay.stopRecording(sessionId),
      session.sessionId,
    );
    assert.equal(recording.phase, "review");
    assert.equal(recording.actions.length, 3);
    await assert.rejects(forbiddenType(session.sessionId));
    assert.equal(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .find((window) => window.getTitle() === "Relay test target")
          .webContents.executeJavaScript(
            'document.querySelector("textarea").value',
          ),
      ),
      "Relay native test",
      "Stale, paused, and review actions must not reach the target",
    );
    const afterReview = await page.evaluate(() => window.relay.bootstrap());
    assert.deepEqual(
      afterReview.flows,
      beforeReview.flows,
      "Stop enters review without changing a workflow",
    );
    assert.deepEqual(
      afterReview.runs,
      beforeReview.runs,
      "Review must not start a workflow",
    );
    const edited = await page.evaluate(
      ({ id, revision, actions }) =>
        window.relay.updateRecording(id, revision, actions),
      {
        id: recording.sessionId,
        revision: recording.revision,
        actions: recording.actions.map((action, index) =>
          index === 0 ? { ...action, label: "Reviewed click" } : action,
        ),
      },
    );
    assert.equal(edited.actions[0].label, "Reviewed click");
    await app.close();
    app = await electron.launch(launchOptions);
    const reopened = await app.firstWindow();
    reopened.on("pageerror", (error) => errors.push(error.message));
    await reopened.waitForFunction(() => Boolean(window.relay));
    const restored = await reopened.evaluate(() => window.relay.bootstrap());
    assert.equal(restored.recording.phase, "review");
    assert.equal(restored.recording.active, false);
    assert.equal(restored.recording.sessionId, edited.sessionId);
    assert.deepEqual(restored.recording.actions, edited.actions);
    assert.deepEqual(restored.recording.destination, edited.destination);
    assert.deepEqual(restored.flows, afterReview.flows);
    const inserted = await reopened.evaluate(
      ({ id, revision }) =>
        window.relay.insertRecording(id, revision, {
          destination: "new",
          name: "Reviewed native recording",
        }),
      {
        id: restored.recording.sessionId,
        revision: restored.recording.revision,
      },
    );
    assert.equal(inserted.flow.name, "Reviewed native recording");
    assert.equal(
      inserted.flow.nodes.filter(
        (node) => !["start", "end"].includes(node.kind),
      ).length,
      3,
    );
    assert.equal(inserted.recording.phase, "idle");
    await assert.rejects(
      reopened.evaluate(
        ({ id, revision }) =>
          window.relay.insertRecording(id, revision, {
            destination: "new",
            name: "Duplicate recording",
          }),
        {
          id: restored.recording.sessionId,
          revision: restored.recording.revision,
        },
      ),
    );
    const finalState = await reopened.evaluate(() => window.relay.bootstrap());
    assert.equal(finalState.flows.length, restored.flows.length + 1);
    assert.equal(
      finalState.runs.length,
      restored.runs.length,
      "Inserting a recording must not execute it",
    );
  }
  // R02 runs through the real preload/main/utility/SQLite boundary on every OS.
  const insertionPage = await app.firstWindow();
  const insertionBaseline = await insertionPage.evaluate(() =>
    window.relay.bootstrap(),
  );
  const branchFixture = {
    ...insertionBaseline.flows[0],
    id: "recording-branch-smoke",
    name: "Recording branch fixture",
    revision: 1,
    hotkey: undefined,
    inputs: { flag: true },
    outputs: {},
    nodes: [
      {
        id: "r-start",
        kind: "start",
        label: "Start",
        config: {},
        position: { x: 0, y: 0 },
      },
      {
        id: "r-choice",
        kind: "condition",
        label: "Choose branch",
        config: { left: "${inputs.flag}", operator: "truthy" },
        position: { x: 310, y: 0 },
      },
      {
        id: "r-yes",
        kind: "end",
        label: "True finish",
        config: { outputs: { route: "yes" } },
        position: { x: 620, y: 0 },
      },
      {
        id: "r-no",
        kind: "end",
        label: "False finish",
        config: { outputs: { route: "no" } },
        position: { x: 620, y: 220 },
      },
    ],
    edges: [
      { id: "r-enter", source: "r-start", target: "r-choice", port: "next" },
      { id: "r-true", source: "r-choice", target: "r-yes", port: "true" },
      { id: "r-false", source: "r-choice", target: "r-no", port: "false" },
    ],
  };
  const branchSaved = await insertionPage.evaluate(
    (flow) => window.relay.saveFlow(flow, { expectedRevision: null }),
    branchFixture,
  );
  assert.equal(branchSaved.status, "saved");
  const branchReview = await insertionPage.evaluate(
    async ({ flow, targetId }) => {
      const state = await window.relay.startRecording({
        flowId: flow.id,
        flowRevision: flow.revision,
        targetId,
        mode: "guided",
      });
      await window.relay.recordAction(
        state.sessionId,
        {
          kind: "wait",
          label: "Recorded branch wait",
          config: { durationMs: 1 },
        },
        false,
      );
      return window.relay.stopRecording(state.sessionId);
    },
    { flow: branchSaved.flow, targetId: insertionBaseline.targets[0].id },
  );
  const runsBeforeInsertion = (
    await insertionPage.evaluate(() => window.relay.bootstrap())
  ).runs.length;
  const branchInserted = await insertionPage.evaluate(
    ({ state, anchor }) =>
      window.relay.insertRecording(state.sessionId, state.revision, {
        destination: "bound",
        anchor,
      }),
    {
      state: branchReview,
      anchor: {
        sourceNodeId: "r-choice",
        port: "true",
        edgeId: "r-true",
        successorNodeId: "r-yes",
      },
    },
  );
  assert.deepEqual(
    branchInserted.previousFlow,
    JSON.parse(JSON.stringify(branchSaved.flow)),
  );
  assert.deepEqual(
    branchInserted.flow.edges.find((edge) => edge.id === "r-false"),
    branchSaved.flow.edges.find((edge) => edge.id === "r-false"),
  );
  assert.equal(
    (await insertionPage.evaluate(() => window.relay.bootstrap())).runs.length,
    runsBeforeInsertion,
    "Insertion must remain separate from Run",
  );
  const insertedNode = branchInserted.flow.nodes.find(
    (node) => node.label === "Recorded branch wait",
  );
  for (const flag of [true, false]) {
    const submitted = await insertionPage.evaluate(
      ({ id, flag }) => window.relay.runFlow(id, { flag }),
      { id: branchInserted.flow.id, flag },
    );
    const completed = await waitRun(submitted.id, insertionPage);
    assert.equal(completed.outputs.route, flag ? "yes" : "no");
    assert.equal(
      completed.events.some((event) => event.nodeId === insertedNode.id),
      flag,
      "Only the chosen branch traverses the recorded sequence",
    );
  }
  const undoneBranch = await insertionPage.evaluate(
    ({ before, revision }) =>
      window.relay.saveFlow(before, { expectedRevision: revision }),
    {
      before: branchInserted.previousFlow,
      revision: branchInserted.flow.revision,
    },
  );
  assert.equal(undoneBranch.status, "saved");
  assert.deepEqual(undoneBranch.flow.nodes, branchSaved.flow.nodes);
  assert.deepEqual(undoneBranch.flow.edges, branchSaved.flow.edges);
  const redoneBranch = await insertionPage.evaluate(
    ({ after, revision }) =>
      window.relay.saveFlow(after, { expectedRevision: revision }),
    { after: branchInserted.flow, revision: undoneBranch.flow.revision },
  );
  assert.equal(redoneBranch.status, "saved");
  assert.deepEqual(redoneBranch.flow.nodes, branchInserted.flow.nodes);
  assert.deepEqual(redoneBranch.flow.edges, branchInserted.flow.edges);
  await insertionPage.reload();
  await insertionPage
    .getByRole("button", { name: "Recording branch fixture", exact: true })
    .click();
  assert.equal(await insertionPage.locator(".react-flow__node").count(), 5);
  await insertionPage
    .getByRole("button", { name: "Hide properties", exact: true })
    .click();
  await insertionPage.locator(".react-flow__controls-fitview").click();
  await insertionPage.screenshot({
    path: "test-results/relay-recording-inserted.png",
  });
  assert.deepEqual(errors, [], "Renderer errors");
  console.log(
    JSON.stringify(
      {
        ok: true,
        packaged: Boolean(executablePath),
        checks: [
          "Electron launch",
          "IPC isolation",
          "SQLite bootstrap",
          "provider credential isolation",
          "revision conflicts and deleted-flow protection",
          "node reference clipboard",
          "real welcome execution",
          "12-child fixed batch",
          "theme switching",
          "recording branch insertion preserves successor and other branch",
          "inserted branch executes through the real engine",
          "recording graph undo/redo saves through revision checks",
          ...(process.env.RELAY_SMOKE_NATIVE === "1"
            ? [
                "X11 capture",
                "OpenCV detection",
                "detector-result click",
                "guided native click",
                "native typing",
                "recording session isolation and pause/review input guard",
                "recording review persists across desktop restart",
                "recording insertion happens once without execution",
              ]
            : []),
        ],
      },
      null,
      2,
    ),
  );
} finally {
  const forceClose = setTimeout(() => app.process().kill("SIGKILL"), 5000);
  try {
    await app.close();
  } finally {
    clearTimeout(forceClose);
  }
  await rm(dataDir, { recursive: true, force: true });
}
