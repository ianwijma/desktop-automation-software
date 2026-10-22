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

let url = process.env.RELAY_WEB_URL;
let server;
let browser;
try {
  if (!url) {
    server = await createServer({
      logLevel: "error",
      server: { host: "127.0.0.1", port: 0, strictPort: false },
    });
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === "string")
      throw new Error("Preview server did not bind to a TCP port.");
    url = `http://127.0.0.1:${address.port}`;
  }
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 960 },
  });
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
  await page
    .getByLabel("Detected result (optional)")
    .fill("${nodes.detectorId}");
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
    .locator(".child-entry")
    .first()
    .locator("textarea")
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
  console.log(
    "PASS: readable graph and minimap; palette search; add/edit/save; undo/redo; copy/paste; detected-click reference authoring; canonical child group editing; theme/accent persistence; OpenRouter configuration persistence; schedule create/reload; honest preview execution rejection; no page errors.",
  );
} finally {
  await browser?.close();
  await server?.close();
}
