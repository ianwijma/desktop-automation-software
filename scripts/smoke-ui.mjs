/**
 * Relay renderer regression smoke test. Run from the repository root:
 *   node scripts/smoke-ui.mjs
 * Requires the Playwright Chromium browser (`npx playwright install chromium`).
 * Starts a private Vite server on an ephemeral port. Set RELAY_WEB_URL to use
 * an existing preview server instead. All interactions use
 * an isolated browser context; no desktop input or user credentials are used.
 */
import { mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";
import { runReferencePickerSmoke } from "./reference-picker-smoke.mjs";
import { runStructuredInspectorSmoke } from "./structured-inspector-smoke.mjs";
import { runRecordingReviewSmoke } from "./recording-review-smoke.mjs";

let url = process.env.RELAY_WEB_URL;
let server;
let browser;
try {
  if (!url) {
    server = await createServer({
      logLevel: "error",
      server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false },
    });
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === "string")
      throw new Error("Preview server did not bind to a TCP port.");
    url = `http://127.0.0.1:${address.port}`;
  }
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url);
  await page.locator(".react-flow__minimap-node").first().waitFor();
  assert.equal(
    await page.locator(".react-flow__minimap-node").count(),
    6,
    "Measured graph nodes must appear in the minimap",
  );
  assert(
    (await page.locator(".flow-card").first().boundingBox()).width >= 170,
    "Initial graph zoom must keep node labels readable",
  );

  await page.getByRole("button", { name: /New workflow/ }).click();
  await page.waitForFunction(() =>
    Array.from(document.querySelectorAll("input")).some(
      (input) => input.value === "Untitled flow",
    ),
  );
  await page
    .getByLabel("Flow name", { exact: true })
    .fill("Renderer QA workflow");
  await page.getByRole("button", { name: /Add node/ }).click();
  await page.getByPlaceholder("Search actions, detectors, logic…").fill("wait");
  await page.locator(".palette-item").filter({ hasText: "Wait" }).click();
  await page.getByLabel("Duration (ms)", { exact: true }).fill("250");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByText("All changes saved", { exact: true }).waitFor();
  let saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("relay.preview.v1")),
  );
  assert.equal(
    saved.flows
      .find((flow) => flow.name === "Renderer QA workflow")
      .nodes.find((node) => node.kind === "wait").config.durationMs,
    250,
  );

  await page.getByLabel("Duration (ms)", { exact: true }).fill("500");
  await page.getByText("Node properties", { exact: true }).click();
  await page.keyboard.press("Control+z");
  assert.equal(
    await page.getByLabel("Duration (ms)", { exact: true }).inputValue(),
    "250",
  );
  await page.keyboard.press("Control+Shift+z");
  assert.equal(
    await page.getByLabel("Duration (ms)", { exact: true }).inputValue(),
    "500",
  );
  await page.keyboard.press("Control+c");
  await page.keyboard.press("Control+v");
  assert.equal(await page.locator(".flow-card").count(), 3);
  await page.getByRole("button", { name: "Save", exact: true }).click();

  await page.getByText("All changes saved", { exact: true }).waitFor();
  await page.getByRole("button", { name: /Add node/ }).click();
  await page
    .getByPlaceholder("Search actions, detectors, logic…")
    .fill("click");
  await page.locator(".palette-item").filter({ hasText: "Click" }).click();
  await page.getByRole("button", { name: "Advanced configuration" }).click();
  const referencedClick = {
    targetId: "",
    button: "left",
    detection: "${nodes.detectorId}",
    x: "${nodes.detectorId.box.x}",
    y: "${nodes.detectorId.box.y}",
    frameId: "${nodes.detectorId.frameId}",
  };
  await page
    .getByLabel("Node configuration", { exact: true })
    .fill(JSON.stringify(referencedClick));
  await page.getByText("Node properties", { exact: true }).click();
  assert.equal(
    await page.getByLabel("X position", { exact: true }).inputValue(),
    referencedClick.x,
  );
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByText("All changes saved", { exact: true }).waitFor();
  saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("relay.preview.v1")),
  );
  assert.deepEqual(
    saved.flows
      .find((flow) => flow.name === "Renderer QA workflow")
      .nodes.find((node) => node.kind === "click").config,
    referencedClick,
  );
  await page
    .getByRole("button", { name: "Orchestrate a batch", exact: true })
    .click();
  await page
    .locator(".node-name")
    .filter({ hasText: "Four batches of three" })
    .click();
  assert.equal(await page.locator(".child-entry").count(), 12);
  await page
    .getByRole("button", { name: "Remove child 1", exact: true })
    .click();
  assert.equal(await page.locator(".child-entry").count(), 11);
  await page.getByLabel(/^Child flows/).selectOption("welcome");
  assert.equal(await page.locator(".child-entry").count(), 12);
  await page.locator(".child-inputs summary").first().click();
  await page
    .getByRole("button", {
      name: "Edit Inputs for child 1 as JSON",
      exact: true,
    })
    .click();
  await page
    .getByLabel("JSON for Inputs for child 1", { exact: true })
    .fill('{"item":42}');
  await page.getByText("Node properties", { exact: true }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByText("All changes saved", { exact: true }).waitFor();
  saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("relay.preview.v1")),
  );
  const batchConfig = saved.flows
    .find((flow) => flow.id === "batch-starter")
    .nodes.find((node) => node.kind === "group").config;
  assert.equal(batchConfig.children.length, 12);
  assert.equal(batchConfig.children[0].inputs.item, 42);
  assert.equal(batchConfig.flowIds, undefined);

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Teal accent", exact: true }).click();
  await page.getByRole("button", { name: "Light", exact: true }).click();
  await page.waitForFunction(
    () => document.documentElement.dataset.theme === "light",
  );
  saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("relay.preview.v1")),
  );
  assert.equal(saved.settings.accent, "#6dd4cf");
  assert.equal(saved.settings.theme, "light");

  await page
    .getByRole("button", { name: "AI connections", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Add connection", exact: true })
    .click();
  await page
    .getByLabel("Connection name", { exact: true })
    .fill("OpenRouter QA");
  await page.getByLabel("Provider", { exact: true }).selectOption("openrouter");
  assert.equal(
    await page.getByLabel("Endpoint", { exact: true }).inputValue(),
    "https://openrouter.ai/api/v1",
  );
  assert.equal(
    await page.getByLabel("Model ID", { exact: true }).inputValue(),
    "",
  );
  assert.equal(
    await page.getByLabel("Vision", { exact: true }).isChecked(),
    false,
  );
  assert.equal(
    await page.getByLabel("Structured output", { exact: true }).isChecked(),
    false,
  );
  assert.equal(
    await page.getByLabel("API key", { exact: true }).isDisabled(),
    true,
  );
  await page
    .getByLabel("Model ID", { exact: true })
    .fill("test-provider/test-model");
  await page.getByLabel("Vision", { exact: true }).check();
  await page.getByLabel("Structured output", { exact: true }).check();
  await page
    .getByRole("button", { name: "Save connection", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Edit OpenRouter QA", exact: true })
    .waitFor();

  await page.getByRole("button", { name: "Schedules", exact: true }).click();
  await page.getByRole("button", { name: "New schedule", exact: true }).click();
  await page
    .getByLabel("Schedule name", { exact: true })
    .fill("Renderer daily check");
  await page
    .getByRole("button", { name: "Save schedule", exact: true })
    .click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page
    .getByRole("heading", { name: "Renderer daily check", exact: true })
    .waitFor();
  await page.reload();
  await page.getByRole("button", { name: "Run flow", exact: true }).waitFor();
  assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
  saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("relay.preview.v1")),
  );
  assert(
    saved.schedules.some(
      (schedule) => schedule.name === "Renderer daily check",
    ),
  );
  const openRouter = saved.connections.find(
    (connection) => connection.name === "OpenRouter QA",
  );
  assert.equal(openRouter.provider, "openrouter");
  assert.equal(openRouter.baseUrl, "https://openrouter.ai/api/v1");
  assert.equal(openRouter.model, "test-provider/test-model");
  assert.deepEqual(openRouter.capabilities, {
    text: true,
    vision: true,
    structured: true,
  });
  assert.equal(openRouter.hasKey, false);
  await page.getByRole("button", { name: "Run flow", exact: true }).click();
  await page
    .getByText(/Running flows requires the Relay desktop application/)
    .waitFor();
  await page.getByRole("button", { name: "Run flow", exact: true }).isEnabled();
  assert.equal(errors.length, 0, errors.join("\n"));
  const beforeSave = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("relay.preview.v1")).flows.find(
      (flow) => flow.id === "welcome",
    ),
  );
  await page.getByLabel("Flow name", { exact: true }).fill("Saved then undone");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByText("All changes saved", { exact: true }).waitFor();
  await page.getByText("Flow overview", { exact: true }).click();
  await page.keyboard.press("Control+z");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByText("All changes saved", { exact: true }).waitFor();
  const afterUndo = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("relay.preview.v1")).flows.find(
      (flow) => flow.id === "welcome",
    ),
  );
  assert.equal(afterUndo.name, beforeSave.name);
  assert.equal(afterUndo.revision, beforeSave.revision + 2);
  assert.equal(afterUndo.schemaVersion, 2);

  const peer = await page.context().newPage();
  await peer.goto(url);
  await peer.getByLabel("Flow name", { exact: true }).waitFor();
  await page
    .getByLabel("Flow name", { exact: true })
    .fill("Local unsaved draft");
  await peer.getByLabel("Flow name", { exact: true }).fill("Other tab winner");
  await peer.getByRole("button", { name: "Save", exact: true }).click();
  await peer.getByText("All changes saved", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page
    .getByRole("heading", { name: "This flow changed elsewhere" })
    .waitFor();
  assert.equal(
    await page.getByLabel("Flow name", { exact: true }).inputValue(),
    "Local unsaved draft",
  );
  const winner = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("relay.preview.v1")).flows.find(
      (flow) => flow.id === "welcome",
    ),
  );
  assert.equal(winner.name, "Other tab winner");
  await page.getByRole("button", { name: "Keep editing", exact: true }).click();
  assert.equal(
    await page.getByLabel("Flow name", { exact: true }).inputValue(),
    "Local unsaved draft",
  );
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page
    .getByRole("button", {
      name: "Reload latest and discard edits",
      exact: true,
    })
    .click();
  await page.getByText("All changes saved", { exact: true }).waitFor();
  assert.equal(
    await page.getByLabel("Flow name", { exact: true }).inputValue(),
    "Other tab winner",
  );
  await peer.close();

  const futurePage = await browser.newPage();
  const futureState = JSON.stringify({
    ...saved,
    flows: [{ ...saved.flows[0], schemaVersion: 99 }],
  });
  await futurePage.addInitScript(
    (raw) => localStorage.setItem("relay.preview.v1", raw),
    futureState,
  );
  await futurePage.goto(url);
  await futurePage
    .getByRole("heading", { name: "Relay couldn’t open your workspace" })
    .waitFor();
  await futurePage.getByText(/Unsupported workflow schema version/).waitFor();
  assert.equal(
    await futurePage.evaluate(() => localStorage.getItem("relay.preview.v1")),
    futureState,
  );
  await futurePage.close();

  const warningPage = await browser.newPage();
  await warningPage.addInitScript((fixture) => {
    const state = structuredClone(fixture);
    let failRefresh = false;
    let warnOnce = true;
    window.__saveTest = { runs: 0, expectedRevisions: [] };
    window.relay = {
      bootstrap: async () => {
        if (failRefresh) {
          failRefresh = false;
          throw new Error("The runner is unavailable.");
        }
        return structuredClone(state);
      },
      onEvent: () => () => {},
      validateFlow: async () => [],
      saveFlow: async (flow, { expectedRevision }) => {
        const current = state.flows.find((item) => item.id === flow.id);
        window.__saveTest.expectedRevisions.push(expectedRevision);
        if (current.revision !== expectedRevision)
          return {
            status: "conflict",
            current,
            reason: "Stale fixture revision",
          };
        const next = { ...flow, revision: current.revision + 1 };
        state.flows = state.flows.map((item) =>
          item.id === next.id ? next : item,
        );
        if (warnOnce) {
          warnOnce = false;
          failRefresh = true;
          return {
            status: "saved",
            flow: next,
            warning: "The runner could not synchronize.",
          };
        }
        return { status: "saved", flow: next };
      },
      runFlow: async () => {
        window.__saveTest.runs++;
        throw new Error("Unexpected run after save warning");
      },
    };
  }, saved);
  await warningPage.goto(url);
  await warningPage
    .getByLabel("Flow name", { exact: true })
    .fill("Committed with warning");
  await warningPage
    .getByRole("button", { name: "Run flow", exact: true })
    .click();
  await warningPage
    .getByText(/Flow saved\. The runner could not synchronize/)
    .waitFor();
  await warningPage.getByText("All changes saved", { exact: true }).waitFor();
  assert.equal(await warningPage.evaluate(() => window.__saveTest.runs), 0);
  await warningPage
    .getByLabel("Flow name", { exact: true })
    .fill("Edited after warning");
  await warningPage.getByRole("button", { name: "Save", exact: true }).click();
  await warningPage.getByText("All changes saved", { exact: true }).waitFor();
  const expectations = await warningPage.evaluate(
    () => window.__saveTest.expectedRevisions,
  );
  assert.equal(expectations.length, 2);
  assert.equal(expectations[1], expectations[0] + 1);
  await warningPage.close();
  await mkdir("test-results", { recursive: true });
  await page
    .getByRole("button", { name: "Dismiss notification" })
    .last()
    .click();
  await page.screenshot({ path: "test-results/relay-ui-light.png" });
  await page
    .getByRole("button", { name: "Toggle light and dark theme" })
    .click();
  await page.waitForFunction(
    () => document.documentElement.dataset.theme === "dark",
  );
  await page.screenshot({ path: "test-results/relay-ui-dark.png" });
  await runReferencePickerSmoke({ browser, url });
  await runStructuredInspectorSmoke({ browser, url });
  await runRecordingReviewSmoke({ browser, url });
  console.log(
    "PASS: editor and references; undo/redo across revisions; child groups; theme/OpenRouter persistence; schedules; preview rejection; cross-tab conflicts; future-schema preservation; committed-save warning recovery with no automatic run; no page errors.",
  );
} finally {
  await browser?.close();
  await server?.close();
}
