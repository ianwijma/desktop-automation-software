import { createServer } from "node:http";
import { runAuthoringAttachmentsSmoke } from "./authoring-attachments-smoke.mjs";
import { runAuthoringProposalSmoke } from "./authoring-proposal-smoke.mjs";
import { runConnectionProbeSmoke } from "./connection-probe-smoke.mjs";
import { _electron as electron } from "playwright";
import { expect } from "@playwright/test";
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
let processDiagnostics = "";
function observeProcess(handle) {
  handle.process().stderr?.on("data", (data) => {
    processDiagnostics = (processDiagnostics + data.toString()).slice(-65536);
  });
  return handle;
}
let app = observeProcess(await electron.launch(launchOptions));
const errors = [];
let locatorServer;
try {
  const page = await app.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForFunction(() => Boolean(window.relay));
  const initial = await page.evaluate(() => window.relay.bootstrap());
  assert.equal(initial.desktop, true);
  assert.equal(
    initial.capabilities.native?.helper?.protocolVersion,
    2,
    "The production preload/main/utility boundary must expose the matching native handshake",
  );
  assert.ok(initial.capabilities.native.helper.instanceId);
  assert.ok(initial.capabilities.native.helper.backend);
  if (process.platform === "darwin") {
    assert.equal(
      initial.capabilities.native.helper.backend,
      "macos-screencapturekit",
    );
    assert.equal(
      initial.capabilities.native.macos?.framework,
      "ScreenCaptureKit",
    );
    assert.equal(
      initial.capabilities.native.macos?.focusIdentification,
      "public-ax-owner-geometry",
    );
    if (process.env.RELAY_SMOKE_EXECUTABLE)
      assert.ok(
        initial.capabilities.native.macos.processPath.includes(
          "Relay.app/Contents/Resources/native/relay-native",
        ),
        "Packaged app must use its bundled framework helper",
      );
  }
  assert.ok(
    Object.values(initial.capabilities.native.operations).every(
      (operation) => operation.verification === "untested",
    ),
    "Passive capability lookup cannot qualify desktop capture/input",
  );
  await assert.rejects(
    page.evaluate(() =>
      window.relay.inspectNativeLocator("missing-native-target", {
        locator: {
          version: 1,
          backend: "uia",
          selector: { automationId: "fixture" },
        },
      }),
    ),
    /Choose an application or browser target/,
  );
  await assert.rejects(
    page.evaluate(() =>
      window.relay.inspectNativeLocator("missing-native-target", {
        locator: { version: 1, backend: "uia", selector: { pointer: 42 } },
      }),
    ),
    /Unrecognized key|semantic property/,
  );
  assert.equal(initial.flows.length, 3);
  assert.equal(initial.connections.length, 0);
  await runConnectionProbeSmoke(page, app, dataDir);
  await runAuthoringProposalSmoke(page);
  await runAuthoringAttachmentsSmoke(page);
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
    const fixtureWindow = app.waitForEvent("window");
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
    const fixturePage = await fixtureWindow;
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
    const authoringSession = await page.evaluate(() => crypto.randomUUID());
    const capturedImage = await page.evaluate(
      (sessionId) =>
        window.relay.captureAuthoringImage({
          sessionId,
          targetId: "native-smoke",
        }),
      authoringSession,
    );
    assert.equal(capturedImage.source, "capture");
    assert.equal(capturedImage.state, "draft");
    assert(capturedImage.width > 300);
    assert.equal(capturedImage.frameId, undefined);
    assert.equal(capturedImage.targetId, undefined);
    assert.equal(capturedImage.native, undefined);
    await expect(fixturePage.locator("button")).toHaveText("Test button");
    await expect(fixturePage.locator("textarea")).toHaveValue("");
    await page.evaluate(
      (s) => window.relay.closeAuthoringSession(s),
      authoringSession,
    );
    console.log(
      "PASS: chosen-window authoring capture adds one local image through the real helper without input or exposed runtime frame identity.",
    );
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
    await expect(fixturePage.locator("button")).toHaveText("Clicked");
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
    await expect(fixturePage.locator("button")).toHaveText("Clicked");
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
    // Native completion acknowledges X11 event submission; the target renderer
    // may still be processing those events when recordAction resolves.
    await expect(fixturePage.locator("textarea")).toHaveValue(
      "Relay native test",
    );
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
    app = observeProcess(await electron.launch(launchOptions));
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
  // B01 checks the actual locator inspection IPC and graph preflight/runtime path.
  const browserCommands = [];
  let browserInputAcks = 0;
  locatorServer = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/record-command") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(browserCommands.shift() ?? null));
      return;
    }
    if (url.pathname === "/record-ack") {
      browserInputAcks++;
      response.end("ok");
      return;
    }
    response.setHeader("Content-Type", "text/html");
    response.end(
      `<!doctype html><button data-testid="run">Run task</button><button>Other</button><label>Recorded text<input id="record-text"></label><script>setInterval(async()=>{const command=await(await fetch('/record-command')).json();if(command){const input=document.querySelector('#record-text');input.focus();input.setSelectionRange(input.value.length,input.value.length);document.execCommand('insertText',false,command.text);await fetch('/record-ack');}},50)</script><iframe id="pane" srcdoc="<button data-testid=run onclick=&quot;document.querySelector('#result').textContent='Clicked'&quot;>Run task</button><p id=result>waiting</p>"></iframe>`,
    );
  });
  await new Promise((resolve) => locatorServer.listen(0, "127.0.0.1", resolve));
  const browserTarget = {
    id: "locator-browser-smoke",
    name: "Locator browser",
    kind: "browser",
    browserMode: "managed",
    url: `http://127.0.0.1:${locatorServer.address().port}/`,
  };
  await insertionPage.evaluate(
    (target) => window.relay.saveTarget(target),
    browserTarget,
  );
  const runsBeforeMatch = (
    await insertionPage.evaluate(() => window.relay.bootstrap())
  ).runs.length;
  const match = await insertionPage.evaluate(
    (id) =>
      window.relay.inspectBrowserLocator(id, {
        version: 1,
        selector: { kind: "role", role: "button", name: "Run task" },
      }),
    browserTarget.id,
  );
  assert.equal(match.status, "unique");
  assert.equal(match.element.locator.selector.kind, "testId");
  const ambiguous = await insertionPage.evaluate(
    (id) => window.relay.inspectBrowserLocator(id, "button"),
    browserTarget.id,
  );
  assert.equal(ambiguous.status, "ambiguous");
  assert.equal(ambiguous.count, 2);
  assert.equal(
    (await insertionPage.evaluate(() => window.relay.bootstrap())).runs.length,
    runsBeforeMatch,
    "Test match must not start a run",
  );
  const scopedLocator = {
    version: 1,
    path: [{ kind: "frame", selector: { kind: "id", value: "pane" } }],
    selector: { kind: "testId", attribute: "data-testid", value: "run" },
  };
  const scopedMatch = await insertionPage.evaluate(
    ({ id, locator }) => window.relay.inspectBrowserLocator(id, locator),
    { id: browserTarget.id, locator: scopedLocator },
  );
  assert.equal(scopedMatch.status, "unique");
  assert.deepEqual(scopedMatch.element.locator, scopedLocator);
  const locatorFlow = {
    ...branchFixture,
    id: "locator-graph-smoke",
    name: "Locator graph fixture",
    inputs: {},
    outputs: { result: "${nodes.locator-read}" },
    nodes: [
      {
        id: "locator-start",
        kind: "start",
        label: "Start",
        config: {},
        position: { x: 0, y: 0 },
      },
      {
        id: "locator-click",
        kind: "click",
        label: "Click scoped button",
        config: { targetId: browserTarget.id, locator: scopedLocator },
        position: { x: 310, y: 0 },
      },
      {
        id: "locator-read",
        kind: "read",
        label: "Read scoped result",
        config: {
          targetId: browserTarget.id,
          locator: {
            ...scopedLocator,
            selector: { kind: "css", value: "#result" },
          },
        },
        position: { x: 620, y: 0 },
      },
      {
        id: "locator-end",
        kind: "end",
        label: "Finish",
        config: {},
        position: { x: 930, y: 0 },
      },
    ],
    edges: [
      {
        id: "locator-one",
        source: "locator-start",
        target: "locator-click",
        port: "next",
      },
      {
        id: "locator-two",
        source: "locator-click",
        target: "locator-read",
        port: "next",
      },
      {
        id: "locator-three",
        source: "locator-read",
        target: "locator-end",
        port: "next",
      },
    ],
  };
  assert.deepEqual(
    (
      await insertionPage.evaluate(
        (flow) => window.relay.validateFlow(flow),
        locatorFlow,
      )
    ).filter((issue) => issue.severity === "error"),
    [],
  );
  const savedLocator = await insertionPage.evaluate(
    (flow) => window.relay.saveFlow(flow, { expectedRevision: null }),
    locatorFlow,
  );
  assert.equal(savedLocator.status, "saved");
  const locatorRun = await insertionPage.evaluate(
    (id) => window.relay.runFlow(id),
    locatorFlow.id,
  );
  assert.equal(
    (await waitRun(locatorRun.id, insertionPage)).outputs.result,
    "Clicked",
  );
  // B02 observes real browser editing events and flushes without blur through IPC/SQLite.
  const browserSession = await insertionPage.evaluate(
    ({ flow, targetId }) =>
      window.relay.startRecording({
        flowId: flow.id,
        flowRevision: flow.revision,
        targetId,
        mode: "direct",
      }),
    { flow: savedLocator.flow, targetId: browserTarget.id },
  );
  browserCommands.push({ text: "pending at pause" });
  await expect.poll(() => browserInputAcks, { timeout: 10000 }).toBe(1);
  const browserPaused = await insertionPage.evaluate(
    (id) => window.relay.pauseRecording(id),
    browserSession.sessionId,
  );
  assert.equal(browserPaused.phase, "paused");
  assert.equal(browserPaused.actions.length, 1);
  assert.equal(browserPaused.actions[0].config.text, "pending at pause");
  await insertionPage.evaluate(
    (id) => window.relay.resumeRecording(id),
    browserSession.sessionId,
  );
  browserCommands.push({ text: " after resume" });
  await expect.poll(() => browserInputAcks, { timeout: 10000 }).toBe(2);
  const browserReviewed = await insertionPage.evaluate(
    (id) => window.relay.stopRecording(id),
    browserSession.sessionId,
  );
  assert.equal(browserReviewed.phase, "review");
  assert.deepEqual(
    browserReviewed.actions.map((action) => action.config.text),
    ["pending at pause", "pending at pause after resume"],
  );
  assert.deepEqual(
    (await insertionPage.evaluate(() => window.relay.bootstrap())).recording
      .actions,
    browserReviewed.actions,
  );
  await insertionPage.evaluate(
    (state) => window.relay.discardRecording(state.sessionId, state.revision),
    browserReviewed,
  );
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
          "read-only browser locator inspection IPC",
          "native locator IPC validation and target boundary",
          "structured frame locators validate, persist and run through the engine",
          "direct browser pending text flushes on Pause and Stop through IPC/SQLite",
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
} catch (error) {
  await writeFile("test-results/desktop-smoke-process.log", processDiagnostics);
  console.error("Application process diagnostics:\n" + processDiagnostics);
  throw error;
} finally {
  const forceClose = setTimeout(() => app.process().kill("SIGKILL"), 5000);
  try {
    await app.close();
  } finally {
    clearTimeout(forceClose);
    if (locatorServer)
      await new Promise((resolve) => locatorServer.close(resolve));
  }
  await rm(dataDir, { recursive: true, force: true });
}
