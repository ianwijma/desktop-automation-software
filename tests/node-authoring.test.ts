import { describe, expect, it } from "vitest";
import {
  setLoopMode,
  setWaitMode,
  updateNodeConfig,
} from "../src/shared/node-authoring";
import { prepareFlowSave } from "../src/shared/flow-persistence";
import { referenceOptions } from "../src/shared/value-references";
import { WorkflowEngine } from "../src/engine";
import type { FlowDefinition, FlowNode, Json } from "../src/shared/types";

describe("explicit node authoring", () => {
  it("switches wait modes without hidden polling, target or duration conflicts", () => {
    const original = { ms: "${inputs.delay}", extension: { keep: true } };
    const detection = setWaitMode(original, "detector");
    expect(detection).toEqual({
      detector: "text",
      timeoutMs: 30000,
      pollIntervalMs: 500,
      extension: original.extension,
    });
    expect(original).toEqual({
      ms: "${inputs.delay}",
      extension: { keep: true },
    });
    const duration = setWaitMode(
      {
        ...detection,
        targetId: "app",
        prompt: "Ready",
        region: { x: 0, y: 0, width: 1, height: 1 },
        connectionId: "vision",
        pollMs: 15,
        threshold: 0.9,
        language: "eng",
      },
      "duration",
    );
    expect(duration).toEqual({
      durationMs: 1000,
      extension: original.extension,
    });
    expect(setWaitMode(original, "duration").durationMs).toBe(
      "${inputs.delay}",
    );
    expect(
      setWaitMode(
        { detector: "text", pollMs: "${inputs.rate}", timeoutMs: 9000 },
        "detector",
      ),
    ).toEqual({
      detector: "text",
      pollIntervalMs: "${inputs.rate}",
      timeoutMs: 9000,
    });
  });

  it("removes only known inactive detector fields on an explicit method change", () => {
    const config = {
      detector: "ai",
      targetId: "app",
      prompt: "Ready?",
      connectionId: "model",
      locate: true,
      threshold: 0.9,
      region: { x: 0, y: 0, width: 1, height: 1 },
      custom: { untouched: true },
    };
    expect(updateNodeConfig("detect", config, "detector", "element")).toEqual({
      detector: "element",
      targetId: "app",
      custom: config.custom,
    });
    const image = updateNodeConfig("detect", config, "detector", "image");
    expect(image).toEqual({
      detector: "image",
      targetId: "app",
      threshold: 0.9,
      region: config.region,
      custom: config.custom,
    });
    expect(
      updateNodeConfig("detect", image, "detector", "change").threshold,
    ).toBeUndefined();
    expect(
      updateNodeConfig("detect", config, "detector", "${inputs.method}"),
    ).toEqual({ ...config, detector: "${inputs.method}" });
  });

  it("normalizes aliases only when the corresponding field is edited", () => {
    expect(
      updateNodeConfig(
        "wait",
        { ms: 5, other: true },
        "durationMs",
        "${inputs.delay}",
      ),
    ).toEqual({ durationMs: "${inputs.delay}", other: true });
    expect(
      updateNodeConfig("wait", { pollMs: 5 }, "pollIntervalMs", undefined),
    ).toEqual({});
    expect(
      updateNodeConfig(
        "set",
        { name: "old", value: false },
        "variable",
        "chosen",
      ),
    ).toEqual({ variable: "chosen", value: false });
    expect(
      updateNodeConfig(
        "detect",
        { detector: "text", text: "old" },
        "prompt",
        "${inputs.text}",
      ),
    ).toEqual({ detector: "text", prompt: "${inputs.text}" });
    expect(
      updateNodeConfig(
        "set",
        { name: "legacy", extension: true },
        "value",
        null,
      ),
    ).toEqual({ name: "legacy", extension: true, value: null });
  });

  it("preserves typed loop mappings while switching count and foreach modes", () => {
    const config = {
      flowId: "child",
      count: 3,
      maxIterations: 10,
      inputs: { value: "${item}", index: "${index}" },
      extension: "keep",
    };
    const each = updateNodeConfig(
      "loop",
      setLoopMode(config, "foreach"),
      "items",
      "${inputs.rows}",
    );
    expect(each).toEqual({
      flowId: "child",
      items: "${inputs.rows}",
      maxIterations: 10,
      inputs: config.inputs,
      extension: "keep",
    });
    expect(setLoopMode(each, "count")).toEqual(config);
    expect(setLoopMode(config, "foreach").items).toEqual([]);
    expect(config.count).toBe(3);
  });

  it("removes conflicting operands and child sources while preserving advanced AI schemas", () => {
    expect(
      updateNodeConfig(
        "condition",
        { left: false, operator: "eq", right: true },
        "operator",
        "truthy",
      ),
    ).toEqual({ left: false, operator: "truthy" });
    const children = [{ flowId: "child", inputs: { enabled: true } }];
    expect(
      updateNodeConfig(
        "group",
        { flowIds: ["old"], mode: "pool" },
        "children",
        children,
      ),
    ).toEqual({ children, mode: "pool" });
    expect(
      updateNodeConfig("group", { children }, "flowIds", ["other"]),
    ).toEqual({ flowIds: ["other"] });
    const schema: Json = {
      anyOf: [{ type: "object", additionalProperties: true }, { type: "null" }],
    };
    const structured = updateNodeConfig(
      "ai",
      { mode: "vision", schema, prompt: "Question" },
      "mode",
      "structured",
    );
    expect(structured.schema).toBe(schema);
    expect(updateNodeConfig("ai", structured, "mode", "vision").schema).toBe(
      schema,
    );
    expect(updateNodeConfig("ai", structured, "mode", "text")).toEqual({
      mode: "text",
      prompt: "Question",
    });
    expect(updateNodeConfig("ai", {}, "mode", "structured").schema).toEqual({
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    });
  });

  it("removes an inactive image target when explicitly leaving AI vision mode", () => {
    const imported = {
      mode: "vision",
      targetId: "old-app",
      prompt: "Summarize",
      schema: { type: "object" },
      custom: { keep: true },
    };
    for (const mode of ["text", "structured"])
      expect(updateNodeConfig("ai", imported, "mode", mode)).not.toHaveProperty(
        "targetId",
      );
    expect(
      updateNodeConfig("ai", imported, "prompt", "Edited question").targetId,
    ).toBe("old-app");
    expect(updateNodeConfig("ai", imported, "mode", "vision").targetId).toBe(
      "old-app",
    );
    expect(imported.targetId).toBe("old-app");
  });
});

const node = (
  id: string,
  kind: FlowNode["kind"],
  config: Record<string, Json> = {},
): FlowNode => ({ id, kind, config, label: id, position: { x: 0, y: 0 } });
const flow = (
  id: string,
  actions: FlowNode[],
  outputs: Record<string, Json>,
): FlowDefinition => {
  const nodes = [node("start", "start"), ...actions, node("end", "end")];
  return {
    id,
    name: id,
    schemaVersion: 2,
    revision: 1,
    description: "",
    folder: "",
    nodes,
    edges: nodes.slice(1).map((target, index) => ({
      id: `edge${index}`,
      source: nodes[index].id,
      target: target.id,
    })),
    inputs: {},
    outputs,
    createdAt: "",
    updatedAt: "",
  };
};
const persisted = (flow: FlowDefinition): FlowDefinition => {
  const saved = prepareFlowSave(flow, undefined, null);
  if (saved.status !== "saved") throw new Error("Expected a saved flow");
  return JSON.parse(JSON.stringify(saved.flow)) as FlowDefinition;
};

it("runs an authored detector wait, numeric condition, mocked structured AI and typed foreach after save/reload", async () => {
  let wait = setWaitMode({ ms: 9999 }, "detector");
  wait = updateNodeConfig("wait", wait, "prompt", "Ready");
  wait = updateNodeConfig("wait", wait, "pollIntervalMs", 50);
  wait = updateNodeConfig("wait", wait, "targetId", "app");
  const schema = {
    type: "object",
    properties: {
      rows: {
        type: "array",
        items: {
          type: "object",
          properties: {
            amount: { type: "number" },
            enabled: { type: "boolean" },
            note: { type: "null" },
          },
          required: ["amount", "enabled", "note"],
        },
      },
    },
    required: ["rows"],
  };
  let ai = updateNodeConfig(
    "ai",
    { prompt: "Extract rows" },
    "mode",
    "structured",
  );
  ai = updateNodeConfig("ai", ai, "schema", schema);
  const loop = updateNodeConfig(
    "loop",
    setLoopMode(
      {
        flowId: "child",
        count: 10,
        maxIterations: 5,
        inputs: {
          amount: "${item.amount}",
          enabled: "${item.enabled}",
          note: "${item.note}",
          position: "${index}",
        },
      },
      "foreach",
    ),
    "items",
    "${nodes.ai.rows}",
  );
  const authored = flow(
    "authored",
    [
      node("wait", "wait", wait),
      node(
        "condition",
        "condition",
        updateNodeConfig(
          "condition",
          { left: "${nodes.wait.confidence}", right: 0.9 },
          "operator",
          "gte",
        ),
      ),
      node("ai", "ai", ai),
      node("loop", "loop", loop),
    ],
    { rows: "${nodes.loop}", passed: "${nodes.condition}" },
  );
  authored.edges.find((edge) => edge.source === "condition")!.port = "true";
  authored.edges.push({
    id: "false",
    source: "condition",
    target: "ai",
    port: "false",
  });
  const parent = persisted(authored);
  const child = persisted(
    flow("child", [], {
      amount: "${inputs.amount}",
      enabled: "${inputs.enabled}",
      note: "${inputs.note}",
      position: "${inputs.position}",
    }),
  );
  expect(
    referenceOptions(parent).find(
      (option) => option.reference === "${nodes.ai.rows}",
    )?.type,
  ).toBe("array");
  let polls = 0;
  const rows = [
    { amount: 3.5, enabled: true, note: null },
    { amount: 0, enabled: false, note: null },
  ];
  const engine = new WorkflowEngine({
    getFlows: () => [parent, child],
    getTargets: () => [{ id: "app", name: "Fixture", kind: "desktop" }],
    executeNode: async (node, context): Promise<Json> => {
      if (node.kind === "detect")
        return {
          outcome: ++polls === 1 ? "no-match" : "match",
          confidence: 0.95,
        };
      if (node.kind === "ai") {
        expect(context.config.schema).toEqual(schema);
        return { rows };
      }
      throw new Error(`Unexpected adapter action ${node.kind}`);
    },
  });
  const run = await engine.wait(engine.submit(parent.id).id);
  expect(run.status).toBe("succeeded");
  expect(polls).toBe(2);
  expect(run.outputs).toEqual({
    passed: true,
    rows: rows.map((row, position) => ({ ...row, position })),
  });
  expect(run.childIds).toHaveLength(2);
  expect(
    parent.nodes.find((node) => node.id === "loop")!.config,
  ).not.toHaveProperty("count");
  expect(
    parent.nodes.find((node) => node.id === "wait")!.config,
  ).not.toHaveProperty("ms");
});
