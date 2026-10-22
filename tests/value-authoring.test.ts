import { describe, expect, it } from "vitest";
import { WorkflowEngine } from "../src/engine";
import { detectionCoordinates } from "../src/integrations/locations";
import { prepareFlowSave } from "../src/shared/flow-persistence";
import type { FlowDefinition, FlowNode, Json } from "../src/shared/types";

function node(
  id: string,
  kind: FlowNode["kind"],
  config: Record<string, Json> = {},
): FlowNode {
  return { id, kind, label: id, config, position: { x: 0, y: 0 } };
}
function flow(
  id: string,
  actions: FlowNode[],
  outputs: Record<string, Json> = {},
): FlowDefinition {
  const nodes = [
    node("start", "start"),
    ...actions,
    node("end", "end", { outputs }),
  ];
  return {
    schemaVersion: 2,
    id,
    name: id,
    description: "",
    folder: "",
    revision: 1,
    createdAt: "2026-10-22T00:00:00.000Z",
    updatedAt: "2026-10-22T00:00:00.000Z",
    nodes,
    edges: nodes.slice(1).map((item, index) => ({
      id: `edge-${index}`,
      source: nodes[index].id,
      target: item.id,
    })),
    inputs: {},
    outputs: {},
  };
}
function persisted(candidate: FlowDefinition): FlowDefinition {
  const saved = prepareFlowSave(candidate, undefined, null);
  if (saved.status !== "saved") throw new Error("Expected a new workflow");
  return JSON.parse(JSON.stringify(saved.flow)) as FlowDefinition;
}

describe("authored values through persistence and real engine execution", () => {
  it.each([
    ["text", "Ready to continue"],
    ["number", 42.5],
    ["zero", 0],
    ["object", { label: "Ready", nested: { enabled: true, empty: null } }],
    ["array", [1, "two", false, null, { value: 3 }]],
    ["boolean", true],
    ["false", false],
    ["null", null],
  ] satisfies [string, Json][])(
    "preserves %s literals and exact references without converting them to strings",
    async (_name, value) => {
      const authored = flow(
        "typed",
        [
          node("source", "set", { variable: "original", value }),
          node("copied", "set", { variable: "copy", value: "${nodes.source}" }),
          node("input-copy", "set", {
            variable: "inputCopy",
            value: "${inputs.value}",
          }),
        ],
        {
          literal: "${nodes.source}",
          exact: "${nodes.copied}",
          variable: "${vars.copy}",
          input: "${nodes.input-copy}",
          embedded: "Value: ${nodes.copied}",
        },
      );
      const saved = persisted(authored);
      const engine = new WorkflowEngine({
        getFlows: () => [saved],
        getTargets: () => [],
        executeNode: async () => {
          throw new Error("This workflow needs no external adapters");
        },
      });
      const run = await engine.wait(engine.submit(saved.id, { value }).id);
      expect(run.status).toBe("succeeded");
      expect(run.outputs).toEqual({
        literal: value,
        exact: value,
        variable: value,
        input: value,
        embedded: `Value: ${typeof value === "string" ? value : JSON.stringify(value)}`,
      });
      expect(saved.nodes[1].config.value).toEqual(value);
      expect(saved.nodes[2].config.value).toBe("${nodes.source}");
    },
  );

  it("keeps detector references bound by ID across renaming, saving, and reloading", async () => {
    const authored = flow("visual", [
      node("detector-stable-id", "detect", {
        targetId: "app",
        detector: "color",
        color: "#112233",
      }),
      node("click", "click", {
        targetId: "app",
        detection: "${nodes.detector-stable-id}",
      }),
    ]);
    const saved = persisted(authored);
    const renamed = prepareFlowSave(
      {
        ...saved,
        nodes: saved.nodes.map((item) =>
          item.id === "detector-stable-id"
            ? { ...item, label: "Renamed ready button" }
            : item,
        ),
      },
      saved,
      saved.revision,
    );
    if (renamed.status !== "saved") throw new Error("Rename should save");
    const reloaded: FlowDefinition = JSON.parse(JSON.stringify(renamed.flow));
    const detection = {
      outcome: "match",
      frameId: "synthetic-current-frame",
      box: { x: 20, y: 30, width: 40, height: 10 },
      evidence: "Synthetic result",
    };
    const actions: Record<string, Json>[] = [];
    const engine = new WorkflowEngine({
      getFlows: () => [reloaded],
      getTargets: () => [
        { id: "app", name: "Fixture window", kind: "desktop" },
      ],
      executeNode: async (item, context) => {
        if (item.kind === "detect") return detection;
        if (item.kind === "click")
          actions.push(detectionCoordinates(context.config));
      },
    });
    const run = await engine.wait(engine.submit(reloaded.id).id);
    expect(run.status).toBe("succeeded");
    expect(actions).toEqual([
      {
        targetId: "app",
        detection,
        x: 40,
        y: 35,
        frameId: "synthetic-current-frame",
      },
    ]);
    expect(reloaded.nodes[2].config.detection).toBe(
      "${nodes.detector-stable-id}",
    );
  });

  it("preserves typed loop item/index mappings in child inputs", async () => {
    const child = flow("child", [], {
      item: "${inputs.chosen}",
      index: "${inputs.position}",
    });
    const parent = persisted(
      flow(
        "looping",
        [
          node("loop", "loop", {
            flowId: "child",
            items: "${inputs.items}",
            maxIterations: 5,
            inputs: { chosen: "${item}", position: "${index}" },
          }),
        ],
        { result: "${nodes.loop}" },
      ),
    );
    const engine = new WorkflowEngine({
      getFlows: () => [parent, child],
      getTargets: () => [],
      executeNode: async () => {},
    });
    const run = await engine.wait(
      engine.submit(parent.id, { items: [false, null, { value: [1, 2] }] }).id,
    );
    expect(run.status).toBe("succeeded");
    expect(run.outputs.result).toEqual([
      { item: false, index: 0 },
      { item: null, index: 1 },
      { item: { value: [1, 2] }, index: 2 },
    ]);
  });
});
