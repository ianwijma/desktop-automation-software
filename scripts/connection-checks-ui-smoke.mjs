import assert from "node:assert/strict";
import { join } from "node:path";
export async function runConnectionChecksUISmoke({
  browser,
  url,
  outputDir = "test-results",
}) {
  const context = await browser.newContext({
      viewport: { width: 1560, height: 1100 },
    }),
    page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(url);
  const state = await page.evaluate(async () =>
    (await import("/src/renderer/preview-api.ts")).previewAPI.bootstrap(),
  );
  state.desktop = true;
  const common = {
    baseUrl: "http://127.0.0.1:11434",
    model: "fixture",
    hasKey: false,
    revision: 1,
    credentialRevision: 0,
  };
  state.connections = [
    {
      ...common,
      id: "local-probes",
      name: "Local probes",
      provider: "ollama",
      capabilities: { text: true, vision: true, structured: true },
    },
    {
      ...common,
      id: "jev-probes",
      name: "Jev probes",
      provider: "jev",
      capabilities: { text: false, vision: false, structured: false },
    },
  ];
  await page.addInitScript((state) => {
    window.__probeChecks = [];
    window.relay = {
      bootstrap: async () => structuredClone(state),
      onEvent: () => () => {},
      testConnection: async (id, operation) => {
        window.__probeChecks.push({ id, operation });
        const c = state.connections.find((c) => c.id === id);
        const result = {
          operation,
          status: "passed",
          ok: true,
          message: `${operation} fixture passed`,
          at: new Date().toISOString(),
          connectionRevision: c.revision,
          credentialRevision: c.credentialRevision,
        };
        c.checks = { ...c.checks, [operation]: { ...result } };
        return result;
      },
      saveConnection: async (draft) => {
        const { prepareConnectionSave } =
          await import("/src/shared/ai-connections.ts");
        const index = state.connections.findIndex((c) => c.id === draft.id);
        const next = prepareConnectionSave(
          state.connections[index],
          draft,
          false,
        );
        state.connections[index] = next;
        return structuredClone(next);
      },
    };
  }, state);
  try {
    await page.reload();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page
      .getByRole("button", { name: "AI connections", exact: true })
      .click();
    const local = page.getByLabel("Checks for Local probes", { exact: true }),
      jev = page.getByLabel("Checks for Jev probes", { exact: true });
    assert.equal(await local.getByText("untested", { exact: true }).count(), 5);
    await page
      .getByRole("button", { name: "Test Text for Local probes", exact: true })
      .click();
    await local.getByText("passed", { exact: true }).waitFor();
    assert.equal(await local.getByText("untested", { exact: true }).count(), 4);
    assert.equal(
      await page
        .getByRole("button", {
          name: "Test Structured for Jev probes",
          exact: true,
        })
        .isDisabled(),
      true,
    );
    await page
      .getByRole("button", {
        name: "Test Decision for Jev probes",
        exact: true,
      })
      .click();
    await jev.getByText("passed", { exact: true }).waitFor();
    await page
      .getByRole("button", { name: "Edit Local probes", exact: true })
      .click();
    await page.getByLabel("Model ID", { exact: true }).fill("changed-model");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Save connection", exact: true })
      .click();
    await local.getByText("stale", { exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.__probeChecks), [
      { id: "local-probes", operation: "text" },
      { id: "jev-probes", operation: "decision" },
    ]);
    await page.screenshot({
      path: join(outputDir, "relay-ai-operation-checks.png"),
      fullPage: true,
    });
    assert.deepEqual(errors, []);
    console.log(
      "PASS: individual AI probe states, no vision promotion from text, Jev decision independent of generic schemas, model-change stale state (controlled API).",
    );
  } finally {
    await context.close();
  }
}
