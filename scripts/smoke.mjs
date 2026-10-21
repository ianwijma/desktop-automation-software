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
const app = await electron.launch({
  executablePath,
  args: ["--no-sandbox", ...(executablePath ? [] : [resolve(".")])],
  env,
  timeout: 30000,
});
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
  async function waitRun(id) {
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      const current = await page.evaluate(
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
    await page.evaluate((flow) => window.relay.saveFlow(flow), detectedClick);
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
    await page.evaluate(() =>
      window.relay.startRecording("native-smoke", "guided"),
    );
    await page.evaluate(() =>
      window.relay.recordAction(
        {
          kind: "click",
          label: "Click test",
          config: { x: 80, y: 50, button: "left" },
        },
        true,
      ),
    );
    const clicked = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.getTitle() === "Relay test target")
        .webContents.executeJavaScript(
          'document.querySelector("button").textContent',
        ),
    );
    assert.equal(clicked, "Clicked");
    await page.evaluate(() =>
      window.relay.recordAction(
        {
          kind: "click",
          label: "Focus textarea",
          config: { x: 80, y: 160, button: "left" },
        },
        true,
      ),
    );
    await page.evaluate(() =>
      window.relay.recordAction(
        {
          kind: "type",
          label: "Type test",
          config: { text: "Relay native test" },
        },
        true,
      ),
    );
    const typed = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.getTitle() === "Relay test target")
        .webContents.executeJavaScript(
          'document.querySelector("textarea").value',
        ),
    );
    assert.equal(typed, "Relay native test");
    const recording = await page.evaluate(() => window.relay.stopRecording());
    assert.equal(recording.actions.length, 3);
  }
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
          "real welcome execution",
          "12-child fixed batch",
          "theme switching",
          ...(process.env.RELAY_SMOKE_NATIVE === "1"
            ? [
                "X11 capture",
                "OpenCV detection",
                "detector-result click",
                "guided native click",
                "native typing",
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
