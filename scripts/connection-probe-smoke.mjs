import { createServer } from "node:http";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
const waitFor = async (predicate) => {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Probe fixture timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};
// Real preload/main/utility/storage and production Ollama adapter, local HTTP only.
export async function runConnectionProbeSmoke(page, app, dataDir) {
  let holdNext = false,
    release,
    calls = 0;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const data = JSON.parse(body);
    calls++;
    const send = () => {
      if (res.destroyed) return;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          model: "fixture-returned",
          prompt_eval_count: 3,
          eval_count: 2,
          private_metadata: "do-not-export-response",
          message: {
            content: data.messages[0].images ? "red" : "Relay connected",
          },
        }),
      );
    };
    if (holdNext) {
      holdNext = false;
      release = send;
    } else send();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const connection = {
    id: "probe-smoke",
    name: "Local probe fixture",
    provider: "ollama",
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    model: "fixture",
    capabilities: { text: true, vision: true, structured: true },
    hasKey: false,
  };
  const read = () =>
    page.evaluate(async () =>
      (await window.relay.bootstrap()).connections.find(
        (c) => c.id === "probe-smoke",
      ),
    );
  try {
    const saved = await page.evaluate(
      (c) =>
        window.relay.saveConnection({
          ...c,
          revision: 900,
          credentialRevision: 900,
          checks: {},
        }),
      connection,
    );
    assert.equal(saved.revision, 1);
    assert.equal(saved.credentialRevision, 0);
    assert.equal(saved.checks, undefined);
    const passed = await page.evaluate(() =>
      window.relay.testConnection("probe-smoke", "text"),
    );
    assert.equal(passed.status, "passed");
    assert.equal(passed.connectionRevision, 1);
    assert.equal(passed.diagnostics.requestedModel, "fixture");
    assert.equal(passed.diagnostics.returnedModel, "fixture-returned");
    assert.equal(passed.diagnostics.usage.inputTokens, 3);
    const cached = await page.evaluate(() =>
      window.relay.searchOpenRouterModels("manual-only"),
    );
    assert.equal(cached.total, 0);
    await assert.rejects(
      page.evaluate(() =>
        window.relay.searchOpenRouterModels("", {
          refresh: true,
          requestId: "invalid",
        }),
      ),
      /Invalid/,
    );
    const path = join(dataDir, "ai-diagnostics.json");
    await app.evaluate(({ dialog }, path) => {
      global.__aiOriginalSaveDialog = dialog.showSaveDialog;
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
    }, path);
    try {
      assert.equal(
        (
          await page.evaluate(() =>
            window.relay.exportConnectionDiagnostics("probe-smoke"),
          )
        ).saved,
        true,
      );
    } finally {
      await app.evaluate(({ dialog }) => {
        dialog.showSaveDialog = global.__aiOriginalSaveDialog;
        delete global.__aiOriginalSaveDialog;
      });
    }
    const report = JSON.parse(await readFile(path, "utf8")),
      exported = JSON.stringify(report);
    assert.equal(report.format, "relay-ai-diagnostics");
    assert.equal(report.operations[0].returnedModel, "fixture-returned");
    for (const forbidden of [
      "127.0.0.1",
      "baseUrl",
      "Local probe fixture",
      "do-not-export-response",
      "Relay connected",
      "data:image",
      '"message"',
    ])
      assert.ok(!exported.includes(forbidden));
    assert.equal((await read()).checks.text.status, "passed");
    assert.equal((await read()).checks.image, undefined);
    assert.equal(
      (
        await page.evaluate(() =>
          window.relay.testConnection("probe-smoke", "image"),
        )
      ).status,
      "passed",
    );
    assert.equal((await read()).checks.image.status, "passed");
    await page.evaluate(
      (c) => window.relay.saveConnection({ ...c, model: "changed-model" }),
      await read(),
    );
    let current = await read();
    assert.equal(current.revision, 2);
    assert.equal(current.checks.text.connectionRevision, 1);
    holdNext = true;
    const before = calls;
    const pending = page.evaluate(() =>
      window.relay.testConnection("probe-smoke", "text"),
    );
    await waitFor(() => calls > before && Boolean(release));
    await page.evaluate(
      (c) => window.relay.saveConnection({ ...c, model: "changed-again" }),
      current,
    );
    release();
    release = undefined;
    const discarded = await pending;
    assert.equal(discarded.discarded, true);
    assert.equal(discarded.ok, false);
    current = await read();
    assert.equal(current.revision, 3);
    assert.equal(current.checks.text.connectionRevision, 1);
    const count = calls;
    await assert.rejects(
      page.evaluate(() =>
        window.relay.testConnection("probe-smoke", "invalid-operation"),
      ),
      /Invalid/,
    );
    assert.equal(calls, count);
    holdNext = true;
    const cancelledBefore = calls,
      requestId = randomUUID();
    const cancelPending = page.evaluate(
      (requestId) =>
        window.relay.testConnection("probe-smoke", "text", requestId),
      requestId,
    );
    await waitFor(() => calls > cancelledBefore && Boolean(release));
    assert.equal(
      await page.evaluate(
        (requestId) => window.relay.cancelAIDiagnostic(requestId),
        requestId,
      ),
      true,
    );
    const cancelled = await cancelPending;
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.diagnostics.errorCode, "cancelled");
    release?.();
    release = undefined;
    assert.equal(
      await page.evaluate(
        (requestId) => window.relay.cancelAIDiagnostic(requestId),
        requestId,
      ),
      false,
    );
    await page.evaluate(() => window.relay.deleteConnection("probe-smoke"));
    console.log(
      "PASS: real AI probe IPC, per-operation persistence, owned revisions, synthetic image request, stale evidence and late-response discard, real provider cancellation, allowlisted diagnostic file export and cached/manual catalog IPC; local HTTP only.",
    );
  } finally {
    release?.();
    await new Promise((resolve) => server.close(resolve));
  }
}
