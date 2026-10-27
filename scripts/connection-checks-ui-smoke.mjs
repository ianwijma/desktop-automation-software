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
      id: "openrouter-probes",
      name: "OpenRouter probes",
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "manual/unlisted",
      capabilities: { text: true, vision: false, structured: false },
    },
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
    window.__diagnosticCancels = [];
    window.__diagnosticExports = [];
    window.__catalogCalls = [];
    const catalog = [
      {
        id: "fixture/vision",
        name: "Vision fixture",
        advertised: { text: true, vision: true, structured: true },
        contextLength: 32000,
      },
      {
        id: "fixture/text",
        name: "Text fixture",
        advertised: { text: true, vision: false, structured: false },
      },
    ];
    let fresh = false;
    const catalogResult = (query) => ({
      models: catalog.filter((m) =>
        `${m.id} ${m.name}`.toLowerCase().includes(query.toLowerCase()),
      ),
      total: 2,
      matched: 2,
      fetchedAt: fresh ? new Date().toISOString() : "2000-01-01T00:00:00.000Z",
      stale: !fresh,
    });
    window.relay = {
      bootstrap: async () => structuredClone(state),
      onEvent: () => () => {},
      testConnection: async (id, operation, requestId) => {
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
        result.diagnostics = {
          provider: c.provider,
          requestedModel: c.model,
          returnedModel: "fixture-returned",
          elapsedMs: 10,
          usage: { inputTokens: 3, outputTokens: 2 },
        };
        if (window.__holdProbe) {
          window.__holdProbe = false;
          await new Promise((resolve) => {
            window.__pendingProbe = {
              requestId,
              resolve: () => {
                result.status = "cancelled";
                result.ok = false;
                result.message = "AI check cancelled.";
                result.diagnostics.errorCode = "cancelled";
                resolve();
              },
            };
          });
        }
        c.checks = { ...c.checks, [operation]: { ...result } };
        return result;
      },
      cancelAIDiagnostic: async (requestId) => {
        window.__diagnosticCancels.push(requestId);
        if (window.__pendingProbe?.requestId === requestId) {
          window.__pendingProbe.resolve();
          delete window.__pendingProbe;
          return true;
        }
        if (window.__pendingCatalog?.requestId === requestId) {
          window.__pendingCatalog.resolve();
          delete window.__pendingCatalog;
          return true;
        }
        return false;
      },
      exportConnectionDiagnostics: async (id) => {
        window.__diagnosticExports.push(id);
        return { saved: true };
      },
      searchOpenRouterModels: async (query, options = {}) => {
        window.__catalogCalls.push({ query, ...options });
        if (window.__catalogOffline) throw new Error("offline");
        if (query === "Slow") {
          await new Promise((resolve) => {
            window.__releaseSlowCatalog = resolve;
          });
          return {
            models: [
              {
                id: "stale/model",
                name: "Late model",
                advertised: { text: true, vision: true, structured: true },
              },
            ],
            total: 1,
            matched: 1,
            stale: true,
          };
        }
        if (options.refresh && window.__holdCatalog) {
          window.__holdCatalog = false;
          await new Promise((resolve) => {
            window.__pendingCatalog = { requestId: options.requestId, resolve };
          });
          return {
            ...catalogResult(query),
            error: { code: "cancelled", message: "Model refresh cancelled." },
          };
        }
        if (options.refresh) fresh = true;
        return catalogResult(query);
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
    await page.evaluate(() => {
      window.__holdProbe = true;
    });
    await page
      .getByRole("button", { name: "Test Text for Local probes", exact: true })
      .click();
    await page
      .getByRole("button", {
        name: "Cancel Text for Local probes",
        exact: true,
      })
      .click();
    await local.getByText("cancelled", { exact: true }).waitFor();
    await page
      .getByRole("button", {
        name: "Export diagnostics for Local probes",
        exact: true,
      })
      .click();
    assert.deepEqual(await page.evaluate(() => window.__diagnosticExports), [
      "local-probes",
    ]);
    await page
      .getByRole("button", { name: "Edit OpenRouter probes", exact: true })
      .click();
    await page.getByText(/Stale cached metadata/).waitFor();
    const search = page.getByLabel("Search OpenRouter models", { exact: true });
    await search.fill("Slow");
    await page.waitForFunction(() => Boolean(window.__releaseSlowCatalog));
    await search.fill("vision");
    await page
      .getByRole("button", { name: "Use model fixture/vision", exact: true })
      .waitFor();
    await page.evaluate(() => window.__releaseSlowCatalog());
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    assert.equal(
      await page
        .getByRole("button", { name: "Use model stale/model", exact: true })
        .count(),
      0,
    );
    await page
      .getByRole("button", { name: "Use model fixture/vision", exact: true })
      .click();
    assert.equal(
      await page.getByLabel("Model ID", { exact: true }).inputValue(),
      "fixture/vision",
    );
    assert.equal(
      await page
        .getByRole("dialog")
        .getByLabel("Vision", { exact: true })
        .isChecked(),
      false,
    );
    assert.equal(
      await page
        .getByRole("dialog")
        .getByLabel("Structured output", { exact: true })
        .isChecked(),
      false,
    );
    await page
      .getByRole("button", { name: "Refresh model catalog", exact: true })
      .click();
    await page.getByText(/^Cached metadata/).waitFor();
    await page.evaluate(() => {
      window.__holdCatalog = true;
    });
    await page
      .getByRole("button", { name: "Refresh model catalog", exact: true })
      .click();
    await page.waitForFunction(() => Boolean(window.__pendingCatalog));
    await page
      .getByRole("button", { name: "Cancel model refresh", exact: true })
      .click();
    await page.getByText("Model refresh cancelled.", { exact: true }).waitFor();
    await page.evaluate(() => {
      window.__catalogOffline = true;
    });
    await search.fill("offline");
    await page
      .getByText(
        "Model search is unavailable. Manual model IDs remain available.",
        { exact: true },
      )
      .waitFor();
    await page.getByLabel("Model ID", { exact: true }).fill("manual/offline");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Save connection", exact: true })
      .click();
    await page.getByText("manual/offline", { exact: false }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.__probeChecks), [
      { id: "local-probes", operation: "text" },
      { id: "jev-probes", operation: "decision" },
      { id: "local-probes", operation: "text" },
    ]);
    assert.equal(
      await page.evaluate(() => window.__diagnosticCancels.length),
      2,
    );
    await page.evaluate(() => {
      window.__holdProbe = true;
    });
    await page
      .getByRole("button", { name: "Test Text for Local probes", exact: true })
      .click();
    await page.waitForFunction(() => Boolean(window.__pendingProbe));
    await page.getByRole("button", { name: "Appearance", exact: true }).click();
    await page.waitForFunction(() => window.__diagnosticCancels.length === 3);
    await page
      .getByRole("button", { name: "AI connections", exact: true })
      .click();

    await page.screenshot({
      path: join(outputDir, "relay-ai-operation-checks.png"),
      fullPage: true,
    });
    assert.deepEqual(errors, []);
    console.log(
      "PASS: individual AI probe states, no vision promotion from text, Jev decision independent of generic schemas, model-change stale state, request-scoped cancellation/export, cached OpenRouter search, stale/late metadata, capability-preserving selection and offline manual IDs (controlled API).",
    );
  } finally {
    await context.close();
  }
}
