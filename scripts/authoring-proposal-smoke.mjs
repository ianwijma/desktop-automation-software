import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
const graph = () => ({
  name: "Proposed only",
  description: "Unsaved candidate",
  nodes: [
    { id: "s", kind: "start", label: "Start", x: 0, y: 0, configJson: "{}" },
    {
      id: "w",
      kind: "wait",
      label: "Wait",
      x: 200,
      y: 0,
      configJson: '{"durationMs":5}',
    },
    {
      id: "e",
      kind: "end",
      label: "End",
      x: 400,
      y: 0,
      configJson: '{"outputs":{}}',
    },
  ],
  edges: [
    { id: "sw", source: "s", target: "w", port: "next" },
    { id: "we", source: "w", target: "e", port: "next" },
  ],
  inputsJson: "{}",
  outputsJson: "{}",
  bindings: [],
  removedNodeIds: [],
  removedEdgeIds: [],
});
const envelope = () => ({
  kind: "proposal",
  explanation: "A waiting flow to review.",
  questions: [],
  graph: graph(),
});
const waitFor = async (predicate) => {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Authoring fixture timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};
export async function runAuthoringProposalSmoke(page) {
  let calls = 0,
    hold = false,
    held = false,
    release,
    mode = "proposal",
    closed = 0;
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    calls++;
    assert.equal(req.url, "/api/chat");
    assert.equal(body.model, "authoring-fixture");
    assert.equal(body.options.num_predict, 16384);
    assert.equal(body.tools, undefined);
    assert(body.format.properties.graph);
    const send = () => {
      if (res.destroyed) return;
      res.writeHead(200, { "content-type": "application/json" });
      const response =
        mode === "clarification"
          ? {
              kind: "clarification",
              explanation: "Choose a target.",
              questions: ["Which application?"],
              graph: null,
            }
          : mode === "invalid"
            ? { ...envelope(), graph: { ...graph(), hotkey: "Control+R" } }
            : envelope();
      res.end(
        JSON.stringify({
          model: "actual-authoring-fixture",
          prompt_eval_count: 7,
          eval_count: 9,
          message: { content: JSON.stringify(response) },
        }),
      );
    };
    if (hold) {
      hold = false;
      held = true;
      release = send;
      res.on("close", () => {
        closed++;
      });
    } else send();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const connection = {
    id: "authoring-smoke",
    name: "Authoring fixture",
    provider: "ollama",
    model: "authoring-fixture",
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    capabilities: { text: true, structured: true, vision: true },
    hasKey: false,
  };
  const req = (extra = {}) => ({
    requestId: randomUUID(),
    sessionId: randomUUID(),
    connectionId: connection.id,
    prompt: "private-authoring-goal",
    targetIds: [],
    connectionIds: [],
    childFlowIds: [],
    ...extra,
  });
  let sourceId;
  const state = () =>
    page.evaluate(async () => {
      const w = await window.relay.bootstrap();
      return {
        flows: w.flows,
        schedules: w.schedules,
        targets: w.targets,
        runs: w.runs,
      };
    });
  try {
    await page.evaluate((c) => window.relay.saveConnection(c), connection);
    await page.evaluate(() => {
      window.__authoringProgress = [];
      window.__authoringUnsubscribe = window.relay.onEvent((event) => {
        if (event.type === "authoring-progress")
          window.__authoringProgress.push(event.progress);
      });
    });
    const before = await state(),
      request = req();
    const result = await page.evaluate(
      (r) => window.relay.requestFlowProposal(r),
      request,
    );
    assert.equal(result.status, "proposal");
    assert.equal(result.proposal.requiresReview, true);
    assert.equal(result.proposal.flow.hotkey, undefined);
    assert.equal(result.diagnostics.returnedModel, "actual-authoring-fixture");
    assert.equal(result.diagnostics.usage.inputTokens, 7);
    assert.equal(calls, 1);
    assert.deepEqual(
      await state(),
      before,
      "Generating a proposal must not save any graph, trigger, target or run",
    );
    assert.equal(
      (await page.evaluate((r) => window.relay.requestFlowProposal(r), request))
        .code,
      "duplicate-request",
    );
    assert.equal(calls, 1);
    assert.deepEqual(
      await page.evaluate(
        (id) =>
          window.__authoringProgress
            .filter((p) => p.requestId === id)
            .map((p) => p.phase),
        request.requestId,
      ),
      ["preparing", "generating", "validating", "completed"],
    );
    mode = "clarification";
    assert.equal(
      (await page.evaluate((r) => window.relay.requestFlowProposal(r), req()))
        .status,
      "clarification",
    );
    mode = "invalid";
    assert.equal(
      (await page.evaluate((r) => window.relay.requestFlowProposal(r), req()))
        .status,
      "rejected",
    );
    mode = "proposal";
    assert.deepEqual(await state(), before);
    hold = true;
    held = false;
    const cancel = req();
    await page.evaluate((r) => {
      window.__authoringPending = window.relay.requestFlowProposal(r);
    }, cancel);
    await waitFor(() => held);
    assert.equal(
      await page.evaluate(
        (r) =>
          window.relay.cancelFlowProposal(crypto.randomUUID(), r.requestId),
        cancel,
      ),
      false,
    );
    assert.equal(
      await page.evaluate(
        (r) => window.relay.cancelFlowProposal(r.sessionId, r.requestId),
        cancel,
      ),
      true,
    );
    assert.equal(
      (await page.evaluate(() => window.__authoringPending)).status,
      "cancelled",
    );
    await waitFor(() => closed >= 1);
    release();
    assert.deepEqual(await state(), before);
    const now = new Date().toISOString(),
      g = graph();
    sourceId = randomUUID();
    const source = {
      schemaVersion: 2,
      id: sourceId,
      name: "Manual authoring source",
      description: "Stay saved",
      folder: "Fixtures",
      revision: 1,
      nodes: g.nodes.map((n) => ({
        id: n.id,
        kind: n.kind,
        label: n.label,
        position: { x: n.x + 30, y: 60 },
        config: JSON.parse(n.configJson),
      })),
      edges: g.edges,
      inputs: {},
      outputs: {},
      createdAt: now,
      updatedAt: now,
    };
    const saved = await page.evaluate(
      (flow) => window.relay.saveFlow(flow, { expectedRevision: null }),
      source,
    );
    assert.equal(saved.status, "saved");
    const baseline = await state(),
      edit = req({
        source: { flowId: sourceId, expectedRevision: saved.flow.revision },
      });
    const edited = await page.evaluate(
      (r) => window.relay.requestFlowProposal(r),
      edit,
    );
    assert.equal(edited.status, "proposal");
    assert.equal(edited.proposal.flow.id, sourceId);
    assert.deepEqual(edited.proposal.flow.nodes[1].position, { x: 230, y: 60 });
    assert.deepEqual(await state(), baseline);
    hold = true;
    held = false;
    const stale = req({
      source: { flowId: sourceId, expectedRevision: saved.flow.revision },
    });
    await page.evaluate((r) => {
      window.__authoringPending = window.relay.requestFlowProposal(r);
    }, stale);
    await waitFor(() => held);
    const newer = structuredClone(saved.flow);
    newer.nodes[1].config.durationMs = 99;
    const savedNewer = await page.evaluate(
      (flow) =>
        window.relay.saveFlow(flow, { expectedRevision: flow.revision }),
      newer,
    );
    assert.equal(savedNewer.status, "saved");
    const discarded = await page.evaluate(() => window.__authoringPending);
    assert.equal(discarded.status, "rejected");
    assert.equal(discarded.code, "stale-context");
    await waitFor(() => closed >= 2);
    release();
    const after = await state();
    assert.equal(
      after.flows.find((f) => f.id === sourceId).nodes[1].config.durationMs,
      99,
    );
    assert.deepEqual(after.schedules, baseline.schedules);
    assert.deepEqual(after.runs, baseline.runs);
    assert.equal(after.flows.length, baseline.flows.length);
    assert.equal(
      await page.evaluate(
        (id) =>
          window.__authoringProgress.some(
            (p) => p.requestId === id && p.phase === "completed",
          ),
        stale.requestId,
      ),
      false,
    );
    console.log(
      "PASS: production authoring preload/main/provider IPC, one call per Send, unsaved app-owned graph/clarification, validation rejection, scoped HTTP cancellation, stale saved revision discard and progress events; saved flows/triggers/targets/runs unchanged by generation; loopback only.",
    );
  } finally {
    await page.evaluate(() => {
      window.__authoringUnsubscribe?.();
      delete window.__authoringPending;
    });
    if (sourceId)
      await page.evaluate((id) => window.relay.deleteFlow(id), sourceId);
    await page.evaluate(
      (id) => window.relay.deleteConnection(id),
      connection.id,
    );
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
