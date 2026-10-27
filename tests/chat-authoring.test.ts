import { validateFlow } from "../src/engine/validation";
import { privateAuthoringValue } from "../src/main/authoring-private-values";
import { randomUUID } from "node:crypto";
import { describe, it, expect, vi } from "vitest";
import sharp from "sharp";
import { FlowAuthoringService } from "../src/main/authoring-service";
import {
  prepareAuthoringContext,
  type AuthoringWorkspace,
} from "../src/main/authoring-context";
import {
  authoringLimits,
  type FlowProposalRequest,
  type ModelProposal,
  type ProposalProgress,
} from "../src/shared/chat-authoring";
import type { FlowDefinition } from "../src/shared/types";
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
const graph = (): NonNullable<ModelProposal["graph"]> => ({
  name: "Proposed flow",
  description: "Wait and finish",
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
const proposal = (g = graph()): ModelProposal => ({
  kind: "proposal",
  explanation: "Added the requested wait.",
  questions: [],
  graph: g,
});
const request = (
  patch: Partial<FlowProposalRequest> = {},
): FlowProposalRequest => ({
  requestId: randomUUID(),
  sessionId: randomUUID(),
  connectionId: "local",
  prompt: "Create a short waiting flow",
  targetIds: [],
  connectionIds: [],
  childFlowIds: [],
  ...patch,
});
const workspace = (): AuthoringWorkspace => ({
  flows: [],
  targets: [
    {
      id: "app",
      name: "Selected application",
      kind: "desktop",
      launch: {
        linux: {
          command: "private-launch-command",
          args: ["private-launch-args"],
        },
      },
    },
    { id: "hidden-app", name: "never-share-hidden-app", kind: "desktop" },
  ],
  connections: [
    {
      id: "local",
      name: "Local model",
      provider: "ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "pinned-author",
      hasKey: false,
      capabilities: { text: true, structured: true, vision: true },
      revision: 1,
      credentialRevision: 0,
    },
    {
      id: "hidden-model",
      name: "never-share-hidden-model",
      provider: "openrouter",
      baseUrl: "https://private-inference.invalid/v1",
      model: "private-model",
      hasKey: true,
      capabilities: { text: true, structured: true, vision: true },
    },
  ],
});
const source = (): FlowDefinition => ({
  schemaVersion: 2,
  id: "source",
  name: "Manual source",
  description: "Preserve its identity",
  folder: "Personal",
  revision: 4,
  nodes: graph().nodes.map((n) => ({
    id: n.id,
    kind: n.kind,
    label: n.label,
    position: { x: n.x + 25, y: 75 },
    config: JSON.parse(n.configJson),
    breakpoint: n.id === "w",
  })),
  edges: graph().edges,
  inputs: { name: "input" },
  outputs: {},
  createdAt: "2020-01-01T00:00:00.000Z",
  updatedAt: "2020-01-01T00:00:00.000Z",
  hotkey: "Control+Alt+W",
});
const mock = (result: unknown = proposal()) =>
  vi.fn<typeof fetch>(async () =>
    json({
      model: "actual-author",
      prompt_eval_count: 11,
      eval_count: 13,
      message: { content: JSON.stringify(result) },
    }),
  );
function setup(fetcher = mock(), state = workspace(), key?: string) {
  const events: ProposalProgress[] = [];
  const service = new FlowAuthoringService({
    workspace: () => state,
    getKey: () => key,
    fetcher,
    progress: (e) => events.push(e),
  });
  return { service, events, state, fetcher };
}
describe("bounded chat authoring proposals", () => {
  it("uses the same structured proposal contract through every supported SDK authoring adapter", async () => {
    for (const provider of [
      "openrouter",
      "openai",
      "anthropic",
      "gemini",
      "lmstudio",
    ] as const) {
      const state = workspace();
      state.connections[0].provider = provider;
      const content = JSON.stringify(proposal());
      const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
        const body = JSON.parse(String(init?.body));
        if (provider === "anthropic") {
          expect(body.tools.map((tool: { name: string }) => tool.name)).toEqual(
            ["json"],
          );
          expect(body.tool_choice).toMatchObject({
            type: "any",
            disable_parallel_tool_use: true,
          });
        } else expect(body.tools).toBeUndefined();
        if (provider === "openrouter")
          expect(body.provider).toMatchObject({
            allow_fallbacks: false,
            require_parameters: true,
          });
        if (provider === "anthropic")
          return json({
            id: "fixture",
            type: "message",
            role: "assistant",
            model: "actual-author",
            content: [
              {
                type: "tool_use",
                id: "json-response",
                name: "json",
                input: proposal(),
              },
            ],
            stop_reason: "tool_use",
            stop_sequence: null,
            usage: { input_tokens: 11, output_tokens: 13 },
          });
        if (provider === "gemini")
          return json({
            candidates: [
              {
                content: { role: "model", parts: [{ text: content }] },
                finishReason: "STOP",
                index: 0,
              },
            ],
            modelVersion: "actual-author",
            usageMetadata: {
              promptTokenCount: 11,
              candidatesTokenCount: 13,
              totalTokenCount: 24,
            },
          });
        return json({
          id: "fixture",
          object: "chat.completion",
          created: 1,
          model: "actual-author",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 11, completion_tokens: 13, total_tokens: 24 },
        });
      });
      const { service } = setup(fetcher, state, "private-authoring-key");
      const result = await service.send(request());
      expect(result.status, JSON.stringify(result)).toBe("proposal");
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(result.diagnostics).toMatchObject({
        returnedModel: "actual-author",
        usage: { inputTokens: 11, outputTokens: 13 },
      });
    }
  });
  it("enforces the host deadline and reports timeout without retrying a held provider request", async () => {
    const state = workspace(),
      events: ProposalProgress[] = [];
    const fetcher = vi.fn<typeof fetch>(
      async (_input, init) =>
        new Promise((_resolve, reject) =>
          init!.signal!.addEventListener(
            "abort",
            () => reject(init!.signal!.reason),
            { once: true },
          ),
        ),
    );
    const service = new FlowAuthoringService({
      workspace: () => state,
      getKey: () => undefined,
      fetcher,
      timeoutMs: 100,
      progress: (e) => events.push(e),
    });
    expect(await service.send(request())).toMatchObject({
      status: "rejected",
      code: "timeout",
      diagnostics: { errorCode: "timeout" },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(events.at(-1)?.phase).toBe("rejected");
    expect(
      () =>
        new FlowAuthoringService({
          workspace: () => state,
          getKey: () => undefined,
          timeoutMs: 90001,
        }),
    ).toThrow();
  });
  it("uses exactly one selected production model, validates a full graph and assigns app-owned unscheduled metadata", async () => {
    const { service, events, fetcher, state } = setup(),
      before = structuredClone(state),
      r = request();
    const result = await service.send(r);
    expect(result.status, JSON.stringify(result)).toBe("proposal");
    if (result.status !== "proposal") return;
    expect(result.proposal.flow.nodes).toHaveLength(3);
    expect(result.proposal.flow.hotkey).toBeUndefined();
    expect(result.proposal.flow.revision).toBe(1);
    expect(result.proposal.flow.id).not.toBe("source");
    expect(result.proposal.requiresReview).toBe(true);
    expect(result.diagnostics).toMatchObject({
      requestedModel: "pinned-author",
      returnedModel: "actual-author",
      usage: { inputTokens: 11, outputTokens: 13 },
    });
    expect(state).toEqual(before);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(events.map((e) => e.phase)).toEqual([
      "preparing",
      "generating",
      "validating",
      "completed",
    ]);
    const body = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
    expect(body.model).toBe("pinned-author");
    expect(body.options.num_predict).toBe(authoringLimits.maxOutputTokens);
    expect(body.tools).toBeUndefined();
    expect(fetcher.mock.calls[0][1]?.redirect).toBe("error");
    expect(await service.send(r)).toMatchObject({
      status: "rejected",
      code: "duplicate-request",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("sends only selected resource descriptors and graph schema, never launch commands, endpoints, keys or hidden workspace resources", async () => {
    const state = workspace(),
      f = source();
    f.nodes[1] = {
      ...f.nodes[1],
      kind: "launch",
      config: {
        targetId: "app",
        command: "private-node-command",
        args: ["private-node-args"],
      },
    };
    state.flows = [f];
    const g = graph();
    g.nodes[1].kind = "launch";
    g.nodes[1].configJson = '{"targetId":"app"}';
    g.nodes[1].x = 999;
    g.nodes[1].y = 999;
    const { service, fetcher } = setup(
      mock(proposal(g)),
      state,
      "private-api-key",
    );
    const result = await service.send(
      request({
        targetIds: ["app"],
        source: { flowId: f.id, expectedRevision: 4 },
        prompt: "Retain this application launch private-api-key",
      }),
    );
    expect(result.status, JSON.stringify(result)).toBe("proposal");
    const body = String(fetcher.mock.calls[0][1]?.body);
    for (const hidden of [
      "private-api-key",
      "private-launch-command",
      "private-launch-args",
      "private-node-command",
      "private-node-args",
      "private-inference.invalid",
      "never-share-hidden-app",
      "never-share-hidden-model",
    ])
      expect(body).not.toContain(hidden);
    if (result.status !== "proposal") return;
    expect(result.proposal.flow.nodes[1]).toMatchObject({
      id: "w",
      position: { x: 225, y: 75 },
      breakpoint: true,
      config: { command: "private-node-command", args: ["private-node-args"] },
    });
    expect(result.proposal.flow.id).toBe(f.id);
    expect(result.proposal.flow.createdAt).toBe(f.createdAt);
    expect(result.proposal.flow.folder).toBe("Personal");
    expect(result.proposal.flow.hotkey).toBeUndefined();
    expect(result.proposal.source).toMatchObject({
      flowId: "source",
      baseRevision: 4,
    });
  });
  it("projects credential-named literal fields and restores owned secrets without rebinding private arrays", async () => {
    const state = workspace(),
      original = source();
    original.nodes[1].config = {
      durationMs: 5,
      apiKey: "flow-private-api-token",
      headers: [
        { Authorization: "flow-private-header" },
        { X_PUBLIC: "public" },
      ],
    };
    original.inputs = {
      password: "flow-private-password",
      publicName: "readable",
    };
    state.flows = [original];
    const g = graph();
    g.nodes[1].configJson = JSON.stringify({
      durationMs: 10,
      apiKey: privateAuthoringValue,
      headers: [{ X_PUBLIC: "model-reordered" }],
    });
    const { service, fetcher } = setup(
      mock(proposal(g)),
      state,
      "transport-private-key",
    );
    const result = await service.send(
      request({ source: { flowId: "source", expectedRevision: 4 } }),
    );
    expect(result.status, JSON.stringify(result)).toBe("proposal");
    const body = String(fetcher.mock.calls[0][1]?.body);
    for (const value of [
      "flow-private-api-token",
      "flow-private-header",
      "flow-private-password",
      "transport-private-key",
    ])
      expect(body).not.toContain(value);
    expect(body).toContain(privateAuthoringValue);
    expect(body).toContain("readable");
    if (result.status !== "proposal") return;
    expect(result.proposal.flow.nodes[1].config).toMatchObject({
      durationMs: 10,
      apiKey: "flow-private-api-token",
      headers: original.nodes[1].config.headers,
    });
    expect(result.proposal.flow.inputs.password).toBe("flow-private-password");
    expect(state.flows[0]).toEqual(original);
  });
  it("rejects protected markers and unsafe graph identifiers introduced into new workflow values", async () => {
    const g = graph();
    g.nodes[1].configJson = JSON.stringify({
      durationMs: 5,
      value: privateAuthoringValue,
    });
    expect(
      await setup(mock(proposal(g))).service.send(request()),
    ).toMatchObject({ status: "rejected", code: "invalid-graph" });
    const unsafe = graph();
    unsafe.nodes[0].id = "__proto__";
    unsafe.edges[0].source = "__proto__";
    expect(
      await setup(mock(proposal(unsafe))).service.send(request()),
    ).toMatchObject({ status: "rejected", code: "invalid-output" });
  });
  it("keeps explicit unsaved graph context with a distinct snapshot stamp while preserving source IDs/positions", async () => {
    const state = workspace();
    state.flows = [source()];
    const draft = {
      name: "Unsaved name",
      description: "draft",
      nodes: source().nodes,
      edges: source().edges,
      inputs: {},
      outputs: {},
    };
    draft.nodes[1].position = { x: 700, y: 500 };
    const { service } = setup(mock(), state);
    const result = await service.send(
      request({ source: { flowId: "source", expectedRevision: 4, draft } }),
    );
    expect(result.status).toBe("proposal");
    if (result.status !== "proposal") return;
    expect(result.proposal.flow.nodes[1].position).toEqual({ x: 700, y: 500 });
    const a = prepareAuthoringContext(
        request({ source: { flowId: "source", expectedRevision: 4, draft } }),
        state,
      ),
      b = prepareAuthoringContext(
        request({ source: { flowId: "source", expectedRevision: 4 } }),
        state,
      );
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });
  it("returns clarification without creating a workflow and rejects inconsistent envelopes or app metadata", async () => {
    const { service, state } = setup(
      mock({
        kind: "clarification",
        explanation: "Choose the target.",
        questions: ["Which application should this use?"],
        graph: null,
      }),
    );
    expect(await service.send(request())).toMatchObject({
      status: "clarification",
      questions: ["Which application should this use?"],
    });
    expect(state.flows).toEqual([]);
    for (const invalid of [
      { ...proposal(), kind: "clarification", questions: ["Question?"] },
      { ...proposal(), graph: { ...graph(), hotkey: "Control+R" } },
      { ...proposal(), graph: { ...graph(), id: "model-owned-id" } },
      { ...proposal(), schedules: [{ enabled: true }] },
    ]) {
      const { service } = setup(mock(invalid));
      expect(await service.send(request())).toMatchObject({
        status: "rejected",
        code: "invalid-output",
      });
    }
  });
  it("rejects unknown nodes, bad config, missing references, cycles, invalid branches and unknown child workflows", async () => {
    const invalids: Array<NonNullable<ModelProposal["graph"]>> = [];
    let g = graph();
    g.nodes[1].kind = "shell" as never;
    invalids.push(g);
    g = graph();
    g.nodes[1].configJson = '{"durationMs":-1}';
    invalids.push(g);
    g = graph();
    g.nodes[1].kind = "type";
    g.nodes[1].configJson =
      '{"targetId":"app","text":"${nodes.missing.value}"}';
    invalids.push(g);
    g = graph();
    g.edges.push({ id: "cycle", source: "w", target: "w", port: "error" });
    invalids.push(g);
    g = graph();
    g.nodes[1].kind = "condition";
    g.nodes[1].configJson = '{"left":1,"right":1,"operator":"eq"}';
    invalids.push(g);
    g = graph();
    g.nodes[1].kind = "call";
    g.nodes[1].configJson = '{"flowId":"missing-child","inputs":{}}';
    invalids.push(g);
    for (const bad of invalids) {
      const { service, state } = setup(mock(proposal(bad)));
      const before = structuredClone(state);
      const result = await service.send(request({ targetIds: ["app"] }));
      expect(result.status, JSON.stringify(result)).toBe("rejected");
      expect(state).toEqual(before);
    }
  });
  it("returns explicit resource binding receipts without inventing or persisting actual resources", async () => {
    for (const field of ["targetId", "connectionId"] as const) {
      const g = graph();
      g.nodes[1].kind = field === "targetId" ? "click" : "ai";
      g.nodes[1].configJson = JSON.stringify(
        field === "targetId"
          ? { targetId: "", x: 10, y: 20 }
          : { connectionId: "", mode: "text", prompt: "Summarize the input" },
      );
      g.bindings = [
        {
          nodeId: "w",
          field,
          hint:
            field === "targetId"
              ? "Choose the application"
              : "Choose the model",
        },
      ];
      const { service, state } = setup(mock(proposal(g))),
        before = structuredClone(state);
      const result = await service.send(request());
      expect(result.status, JSON.stringify(result)).toBe("proposal");
      if (result.status !== "proposal") continue;
      expect(result.proposal.bindings).toHaveLength(1);
      expect(result.proposal.bindings[0]).toMatchObject({ nodeId: "w", field });
      expect(result.proposal.bindings[0].id).toMatch(/^[a-f0-9-]{36}$/);
      expect(result.proposal.flow.nodes[1].config[field]).toBe("");
      expect(
        validateFlow(result.proposal.flow, [result.proposal.flow], {
          targets: state.targets,
          connections: state.connections,
          settings: {},
        }).some((i) => i.severity === "error"),
      ).toBe(true);
      expect(state).toEqual(before);
    }
    for (const bindings of [
      [{ nodeId: "missing", field: "targetId" as const, hint: "App" }],
      [{ nodeId: "w", field: "targetId" as const, hint: "App" }],
    ]) {
      const g = graph();
      g.bindings = bindings;
      expect(
        await setup(mock(proposal(g))).service.send(request()),
      ).toMatchObject({ status: "rejected", code: "invalid-graph" });
    }
  });
  it("rejects executable overrides, fabricated captures/detections, unselected resources and recursive children", async () => {
    for (const config of [
      { command: "sh", args: ["-c", "echo bad"] },
      { frameId: "invented" },
      {
        detection: {
          outcome: "match",
          frameId: "invented",
          box: { x: 0, y: 0, width: 10, height: 10 },
        },
      },
      { targetId: "hidden-app" },
    ]) {
      const g = graph();
      g.nodes[1].kind = "click";
      g.nodes[1].configJson = JSON.stringify(config);
      const { service } = setup(mock(proposal(g)));
      expect(await service.send(request({ targetIds: ["app"] }))).toMatchObject(
        { status: "rejected", code: "invalid-graph" },
      );
    }
    const state = workspace();
    state.flows = [source()];
    const g = graph();
    g.nodes[1].kind = "call";
    g.nodes[1].configJson = '{"flowId":"source","inputs":{}}';
    const { service } = setup(mock(proposal(g)), state);
    expect(
      await service.send(
        request({
          source: { flowId: "source", expectedRevision: 4 },
          childFlowIds: ["source"],
        }),
      ),
    ).toMatchObject({ status: "rejected", code: "invalid-graph" });
  });
  it("permits deliberate existing child references without exposing or editing child graphs", async () => {
    const state = workspace();
    const child = source();
    child.id = "child";
    child.nodes[1].config = {
      durationMs: 7,
      privateExtension: "hidden-child-content",
    };
    state.flows = [child];
    const g = graph();
    g.nodes[1].kind = "call";
    g.nodes[1].configJson = '{"flowId":"child","inputs":{"name":"selected"}}';
    const { service, fetcher } = setup(mock(proposal(g)), state),
      before = structuredClone(child);
    const result = await service.send(request({ childFlowIds: ["child"] }));
    expect(result.status, JSON.stringify(result)).toBe("proposal");
    expect(String(fetcher.mock.calls[0][1]?.body)).not.toContain(
      "hidden-child-content",
    );
    expect(state.flows[0]).toEqual(before);
    const invalidState = structuredClone(state);
    invalidState.flows[0].outputs = { broken: "${nodes.missing.value}" };
    const invalid = setup(mock(proposal(g)), invalidState);
    expect(
      await invalid.service.send(request({ childFlowIds: ["child"] })),
    ).toMatchObject({ status: "rejected", code: "configuration" });
    expect(invalid.fetcher).not.toHaveBeenCalled();
  });
  it("fences child target dependencies while allowing unrelated workspace changes", async () => {
    for (const relevant of [false, true]) {
      const state = workspace(),
        child = source();
      child.id = "child";
      child.nodes[1].kind = "launch";
      child.nodes[1].config = { targetId: "app" };
      state.flows = [child];
      const g = graph();
      g.nodes[1].kind = "call";
      g.nodes[1].configJson = '{"flowId":"child","inputs":{}}';
      let release!: () => void, signal!: AbortSignal;
      const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
        signal = init!.signal!;
        await new Promise<void>((r) => {
          release = r;
        });
        return json({ message: { content: JSON.stringify(proposal(g)) } });
      });
      const { service } = setup(fetcher, state),
        pending = service.send(request({ childFlowIds: ["child"] }));
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
      if (relevant) state.targets[0].launch!.linux!.args.push("changed");
      else {
        state.targets[1].name = "unrelated rename";
        state.settings = { defaultTextConnection: "hidden-model" };
      }
      service.invalidate();
      expect(signal.aborted).toBe(relevant);
      release();
      const result = await pending;
      expect(result.status).toBe(relevant ? "rejected" : "proposal");
      if (relevant) expect(result).toMatchObject({ code: "stale-context" });
    }
  });
  it("requires declared deletions so renamed/disappearing source IDs cannot silently replace retained nodes", async () => {
    const state = workspace();
    state.flows = [source()];
    const g = graph();
    g.nodes = g.nodes.filter((n) => n.id !== "w");
    g.edges = [{ id: "se", source: "s", target: "e", port: "next" }];
    let { service } = setup(mock(proposal(g)), state);
    expect(
      await service.send(
        request({ source: { flowId: "source", expectedRevision: 4 } }),
      ),
    ).toMatchObject({ status: "rejected", code: "invalid-output" });
    g.removedNodeIds = ["w"];
    g.removedEdgeIds = ["sw", "we"];
    ({ service } = setup(mock(proposal(g)), state));
    const result = await service.send(
      request({ source: { flowId: "source", expectedRevision: 4 } }),
    );
    expect(result.status, JSON.stringify(result)).toBe("proposal");
  });
  it("rejects context/shape/depth/output bounds before a retry or partial save", async () => {
    const { service, fetcher } = setup();
    await expect(
      service.send(request({ prompt: "x".repeat(8001) })),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    const state = workspace();
    state.flows = [source()];
    state.flows[0].nodes[1].config.largeUserData = "x".repeat(300000);
    const s = setup(mock(), state);
    expect(
      await s.service.send(
        request({ source: { flowId: "source", expectedRevision: 4 } }),
      ),
    ).toMatchObject({ status: "rejected", code: "context-limit" });
    expect(s.fetcher).not.toHaveBeenCalled();
    const big = graph();
    big.nodes = Array.from({ length: 201 }, (_, i) => ({
      ...big.nodes[0],
      id: `n${i}`,
    }));
    const b = setup(mock(proposal(big)));
    expect(await b.service.send(request())).toMatchObject({
      status: "rejected",
      code: "invalid-output",
    });
    expect(b.fetcher).toHaveBeenCalledTimes(1);
    const tooManyEdges = graph();
    tooManyEdges.edges = Array.from({ length: 401 }, (_, i) => ({
      ...tooManyEdges.edges[0],
      id: `edge-${i}`,
    }));
    expect(
      await setup(mock(proposal(tooManyEdges))).service.send(request()),
    ).toMatchObject({ status: "rejected", code: "invalid-output" });
    const deep: any = {};
    let at = deep;
    for (let i = 0; i < 30; i++) {
      at.value = {};
      at = at.value;
    }
    const d = graph();
    d.nodes[1].configJson = JSON.stringify(deep);
    expect(
      (await setup(mock(proposal(d))).service.send(request())).status,
    ).toBe("rejected");
  });
  it("requires selected text+structured models and keys, never uses a default/fallback connection", async () => {
    for (const patch of [
      { capabilities: { text: false, vision: true, structured: true } },
      { capabilities: { text: true, vision: true, structured: false } },
      { provider: "jev" as const },
      { provider: "openrouter" as const },
    ]) {
      const state = workspace();
      Object.assign(state.connections[0], patch);
      const { service, fetcher } = setup(mock(), state);
      expect(await service.send(request())).toMatchObject({
        status: "rejected",
        code: "configuration",
      });
      expect(fetcher).not.toHaveBeenCalled();
    }
    const { service, fetcher } = setup();
    expect(
      await service.send(request({ connectionId: "missing" })),
    ).toMatchObject({ status: "rejected", code: "configuration" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("uses prepared image content separately from runtime captures and requires vision without silent image drops", async () => {
    const buffer = await sharp({
        create: { width: 10, height: 10, channels: 3, background: "red" },
      })
        .png()
        .toBuffer(),
      image = {
        dataUrl: `data:image/png;base64,${buffer.toString("base64")}`,
        width: 10,
        height: 10,
      };
    const { service, fetcher } = setup();
    expect(
      (await service.send(request(), [image, image, image, image])).status,
    ).toBe("proposal");
    const body = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
    expect(body.messages[0].images).toHaveLength(4);
    const state = workspace();
    state.connections[0].capabilities.vision = false;
    const s = setup(mock(), state);
    expect(await s.service.send(request(), [image])).toMatchObject({
      status: "rejected",
      code: "configuration",
    });
    expect(s.fetcher).not.toHaveBeenCalled();
    const b = setup();
    expect(await b.service.send(request(), Array(5).fill(image))).toMatchObject(
      { status: "rejected", code: "context-limit" },
    );
    expect(b.fetcher).not.toHaveBeenCalled();
    const empty = setup();
    expect(
      await empty.service.send(request({ prompt: "" }), [image]),
    ).toMatchObject({ status: "clarification" });
    expect(empty.fetcher).not.toHaveBeenCalled();
  });
  it("discards changed source/selected dependencies and never emits completed for a stale result", async () => {
    for (const mutate of [
      (w: AuthoringWorkspace) => {
        w.connections[0].revision = 2;
      },
      (w: AuthoringWorkspace) => {
        w.targets[0].name = "Changed";
      },
      (w: AuthoringWorkspace) => {
        w.flows[0].revision++;
      },
    ]) {
      const state = workspace();
      state.flows = [source()];
      let release!: () => void;
      const fetcher = vi.fn<typeof fetch>(async () => {
        await new Promise<void>((r) => {
          release = r;
        });
        return json({ message: { content: JSON.stringify(proposal()) } });
      });
      const { service, events } = setup(fetcher, state);
      const pending = service.send(
        request({
          targetIds: ["app"],
          source: { flowId: "source", expectedRevision: 4 },
        }),
      );
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
      mutate(state);
      release();
      expect(await pending).toMatchObject({
        status: "rejected",
        code: "stale-context",
      });
      expect(events.map((e) => e.phase)).not.toContain("completed");
    }
  });
  it("cancels exact session/request IDs, suppresses late successes, rejects duplicate sends and cleans up after disposal", async () => {
    let release!: () => void;
    const fetcher = vi.fn<typeof fetch>(async () => {
      await new Promise<void>((r) => {
        release = r;
      });
      return json({ message: { content: JSON.stringify(proposal()) } });
    });
    const { service, events } = setup(fetcher),
      r = request(),
      pending = service.send(r);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(service.cancel(randomUUID(), r.requestId)).toBe(false);
    expect(service.cancel(r.sessionId, randomUUID())).toBe(false);
    expect(service.cancel(r.sessionId, r.requestId)).toBe(true);
    expect(await service.send(r)).toMatchObject({
      status: "rejected",
      code: "duplicate-request",
    });
    release();
    expect(await pending).toMatchObject({ status: "cancelled" });
    expect(events.map((e) => e.phase)).toEqual([
      "preparing",
      "generating",
      "cancelled",
    ]);
    expect(service.cancel(r.sessionId, r.requestId)).toBe(false);
    service.dispose();
    expect(await service.send(request())).toMatchObject({
      status: "rejected",
      code: "configuration",
    });
  });
  it("a newer send supersedes only its session and active requests remain bounded until provider settlement", async () => {
    const releases: Array<() => void> = [];
    const fetcher = vi.fn<typeof fetch>(async () => {
      await new Promise<void>((r) => releases.push(r));
      return json({ message: { content: JSON.stringify(proposal()) } });
    });
    const { service } = setup(fetcher),
      session = randomUUID();
    const old = service.send(request({ sessionId: session }));
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    const fresh = service.send(request({ sessionId: session }));
    const other = service.send(request());
    const fourth = service.send(request());
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(4));
    expect(await service.send(request())).toMatchObject({
      status: "rejected",
      code: "busy",
    });
    releases.forEach((r) => r());
    expect((await old).status).toBe("cancelled");
    expect((await fresh).status).toBe("proposal");
    expect((await other).status).toBe("proposal");
    expect((await fourth).status).toBe("proposal");
  });
  it("provider failures, malformed/truncated responses and credential echoes never expose raw errors or start retries", async () => {
    for (const response of [
      () => json({ error: "raw-private-body secret-key" }, 401),
      () => new Response("raw-private-body secret-key malformed"),
      () => json({ message: { content: '{"kind":"proposal"' } }),
      () =>
        json({
          message: {
            content: JSON.stringify({
              ...proposal(),
              explanation: "secret-key",
            }),
          },
        }),
      () =>
        new Response("x", {
          headers: {
            "content-length": String(authoringLimits.providerBytes + 1),
          },
        }),
      () => new Response(new Uint8Array(authoringLimits.providerBytes + 1)),
    ]) {
      const fetcher = vi.fn<typeof fetch>(async () => response()),
        { service, state } = setup(fetcher, workspace(), "secret-key"),
        before = structuredClone(state);
      const result = await service.send(request());
      expect(result.status).toBe("rejected");
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(result)).not.toContain("secret-key");
      expect(JSON.stringify(result)).not.toContain("raw-private-body");
      expect(state).toEqual(before);
    }
  });
});
