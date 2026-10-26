import { createServer } from "node:http";
import assert from "node:assert/strict";
const waitFor = async (predicate) => {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Probe fixture timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};
// Real preload/main/utility/storage and production Ollama adapter, local HTTP only.
export async function runConnectionProbeSmoke(page) {
  let holdNext = false,
    release,
    calls = 0;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const data = JSON.parse(body);
    calls++;
    const send = () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
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
    await page.evaluate(() => window.relay.deleteConnection("probe-smoke"));
    console.log(
      "PASS: real AI probe IPC, per-operation persistence, owned revisions, synthetic image request, stale evidence and late-response discard; local HTTP only.",
    );
  } finally {
    release?.();
    await new Promise((resolve) => server.close(resolve));
  }
}
