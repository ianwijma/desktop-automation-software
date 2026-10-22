import { describe, expect, it, vi } from "vitest";
import { WorkflowEngine } from "../src/engine";
import { freezeFlowTree, validateFlow } from "../src/engine/validation";
import { resolve } from "../src/engine/references";
import { flowSchema } from "../src/shared/validation";
import type { FlowDefinition, FlowNode, Json } from "../src/shared/types";

const node = (
  id: string,
  kind: FlowNode["kind"],
  config: Record<string, Json> = {},
): FlowNode => ({ id, kind, config, label: id, position: { x: 0, y: 0 } });
function flow(actions: FlowNode[], id = "flow"): FlowDefinition {
  const nodes = [node("start", "start"), ...actions, node("end", "end")];
  return {
    schemaVersion: 2,
    id,
    name: id,
    description: "",
    folder: "",
    revision: 1,
    nodes,
    edges: nodes.slice(1).map((item, i) => ({
      id: `edge-${i}`,
      source: nodes[i].id,
      target: item.id,
      port: "next",
    })),
    inputs: {},
    outputs: {},
    createdAt: "2026-10-22",
    updatedAt: "2026-10-22",
  };
}
const messages = (definition: FlowDefinition, available?: FlowDefinition[]) =>
  validateFlow(definition, available)
    .map((issue) => issue.message)
    .join("; ");

describe("authoritative workflow validation", () => {
  it("agrees with the persistence envelope at node and edge size boundaries", () => {
    const nodesAtLimit = flow(
      Array.from({ length: 1998 }, (_, i) =>
        node(`wait-${i}`, "wait", { ms: 1 }),
      ),
    );
    const nodesOverLimit = flow(
      Array.from({ length: 1999 }, (_, i) =>
        node(`wait-${i}`, "wait", { ms: 1 }),
      ),
    );
    const withEdges = (count: number) => {
      const definition = flow(
        Array.from({ length: 1998 }, (_, i) => node(`detect-${i}`, "detect")),
      );
      const extra = count - definition.edges.length;
      const ports = ["match", "no-match", "uncertain", "error"];
      for (let i = 0; i < extra; i++)
        definition.edges.push({
          id: `branch-${i}`,
          source: `detect-${Math.floor(i / ports.length)}`,
          target: "end",
          port: ports[i % ports.length],
        });
      return definition;
    };
    for (const definition of [nodesAtLimit, withEdges(4000)]) {
      expect(flowSchema.safeParse(definition).success).toBe(true);
      expect(validateFlow(definition)).toEqual([]);
    }
    for (const [definition, limit] of [
      [nodesOverLimit, "2000 nodes"],
      [withEdges(4001), "4000 edges"],
    ] as const) {
      expect(flowSchema.safeParse(definition).success).toBe(false);
      expect(messages(definition)).toContain(limit);
      expect(() => freezeFlowTree(definition.id, [definition])).toThrow(limit);
    }
  });

  it("accepts both schema versions and preserves advanced configuration in frozen snapshots", () => {
    const current = flow([
      node("value", "set", {
        name: "answer",
        value: 42,
        extensionConfig: { custom: true },
      }),
    ]);
    const legacy = { ...current, schemaVersion: 1 as const };
    expect(validateFlow(current)).toEqual([]);
    expect(validateFlow(legacy)).toEqual([]);
    const saved = freezeFlowTree(current.id, [current]).get(current.id)!;
    current.nodes[1].config.extensionConfig = false;
    expect(saved.nodes[1].config.extensionConfig).toEqual({ custom: true });
    expect(Object.isFrozen(saved.nodes[1].config)).toBe(true);
  });

  it("checks exact and embedded node references, including flow and Finish outputs", () => {
    const definition = flow([
      node("value", "set", { variable: "v", value: "${inputs.payload}" }),
      node("message", "set", {
        variable: "text",
        value: "Result: ${nodes.value}",
      }),
    ]);
    definition.outputs = {
      result: "${nodes.value}",
      supplied: "${inputs.undeclared}",
    };
    definition.nodes.at(-1)!.config.outputs = { value: "${vars.v}" };
    expect(validateFlow(definition)).toEqual([]);
    definition.nodes[2].config.value = "Result: ${nodes.deleted.answer}";
    definition.outputs = { broken: "${unknown.value}" };
    definition.nodes.at(-1)!.config.outputs = { broken: "${nodes.missing}" };
    const issues = validateFlow(definition);
    expect(issues).toContainEqual(
      expect.objectContaining({
        nodeId: "message",
        message: expect.stringContaining("deleted"),
      }),
    );
    expect(issues).toContainEqual(
      expect.objectContaining({
        nodeId: "end",
        message: expect.stringContaining("missing"),
      }),
    );
    expect(
      issues.some((issue) => issue.message.includes("Unknown reference root")),
    ).toBe(true);
  });

  it("rejects unsafe paths and malformed expressions without evaluating them", () => {
    for (const value of [
      "${inputs.constructor}",
      "${vars..name}",
      "${inputs.name",
      "${process.exit()}",
    ]) {
      expect(
        validateFlow(
          flow([node("value", "set", { variable: "v", value })]),
        ).some((issue) => issue.severity === "error"),
      ).toBe(true);
    }
    const value = {
      exact: "${inputs.object}",
      embedded: "Value ${inputs.object}",
      array: "${inputs.list}",
    };
    expect(
      resolve(value, {
        inputs: { object: { valid: true }, list: [1, 2] },
        vars: {},
        nodes: {},
      }),
    ).toEqual({
      exact: { valid: true },
      embedded: 'Value {"valid":true}',
      array: [1, 2],
    });
  });

  it("permits loop iteration references only within the iteration input template", () => {
    const child = flow([], "child");
    const parent = flow([
      node("loop", "loop", {
        flowId: "child",
        items: "${inputs.items}",
        maxIterations: 5,
        inputs: { value: "${item.name}", number: "${index}" },
      }),
    ]);
    expect(validateFlow(parent, [parent, child])).toEqual([]);
    parent.nodes[1].config.count = "${item.count}";
    expect(messages(parent, [parent, child])).toContain(
      "only available in Loop inputs",
    );
  });

  it("retains fixed child identities while allowing child input objects from references", () => {
    const child = flow([], "child");
    const parent = flow([
      node("call", "call", { flowId: "child", inputs: "${inputs.child}" }),
    ]);
    expect(validateFlow(parent, [parent, child])).toEqual([]);
    parent.nodes[1].config.flowId = "${inputs.flow}";
    expect(messages(parent, [parent, child])).toContain("must be fixed");
  });

  it("rejects missing children, recursive flow trees and invalid configuration in descendants", () => {
    const parent = flow([node("call", "call", { flowId: "child" })]);
    const child = flow([node("call", "call", { flowId: "flow" })], "child");
    expect(messages(parent)).toContain("Child workflow not found");
    expect(messages(parent, [parent, child])).toContain("Recursive child");
    const invalidChild = flow([node("wait", "wait", { ms: -5 })], "child");
    expect(() => freezeFlowTree("flow", [parent, invalidChild])).toThrow(
      /child:.*ms/,
    );
  });

  it("checks production target requirements throughout the frozen flow tree", () => {
    const child = flow(
      [node("read", "read", { targetId: "app", selector: "body" })],
      "child",
    );
    const parent = flow([node("call", "call", { flowId: "child" })]);
    expect(validateFlow(child)).toEqual([]);
    expect(() =>
      freezeFlowTree(parent.id, [parent, child], {
        targets: [{ id: "app", name: "Editor", kind: "desktop" }],
      }),
    ).toThrow("browser target");
    expect(() =>
      freezeFlowTree(parent.id, [parent, child], {
        targets: [{ id: "app", name: "Page", kind: "browser" }],
      }),
    ).not.toThrow();
  });

  it("catches a detected location connected to the wrong target before input executes", () => {
    const definition = flow([
      node("found", "detect", { targetId: "one", detector: "image" }),
      node("click", "click", { targetId: "two", detection: "${nodes.found}" }),
    ]);
    expect(messages(definition)).toContain("same target");
  });

  it("uses registry ports and rejects incompatible branch connections", () => {
    const definition = flow([node("wait", "wait", { ms: 1 })]);
    definition.edges[1].port = "match";
    expect(messages(definition)).toContain("Unsupported wait output port");
    definition.nodes[1] = node("wait", "detect", {});
    definition.edges.push({
      id: "default",
      source: "wait",
      target: "end",
      port: "next",
    });
    expect(validateFlow(definition)).toEqual([]);
  });

  it("rejects invalid referenced detector settings before the adapter can perform an action", async () => {
    const definition = flow([
      node("detect", "detect", {
        targetId: "browser",
        detector: "change",
        threshold: "${inputs.threshold}",
      }),
    ]);
    const targets = [{ id: "browser", name: "Page", kind: "browser" as const }];
    const executeNode = vi.fn(async () => ({ outcome: "match" }));
    const engine = new WorkflowEngine({
      getFlows: () => [definition],
      getTargets: () => targets,
      validationContext: () => ({ targets }),
      executeNode,
    });
    const completed = await engine.wait(
      engine.submit(definition.id, { threshold: 2 }).id,
    );
    expect(completed.status).toBe("failed");
    expect(completed.error).toContain("threshold");
    expect(executeNode).not.toHaveBeenCalled();
  });

  it("fails resolved zero concurrency instead of leaving a group without workers", async () => {
    const child = flow([], "child");
    const definition = flow([
      node("group", "group", {
        flowIds: [child.id],
        mode: "pool",
        concurrency: "${inputs.concurrency}",
      }),
    ]);
    const engine = new WorkflowEngine({
      getFlows: () => [definition, child],
      getTargets: () => [],
      executeNode: async () => undefined,
    });
    const completed = await engine.wait(
      engine.submit(definition.id, { concurrency: 0 }).id,
    );
    expect(completed.status).toBe("failed");
    expect(completed.error).toContain("concurrency");
    expect(completed.childIds).toEqual([]);
  });

  it.each([
    ["click", { targetId: "browser", x: "${inputs.value}", y: 10 }, "x"],
    ["wait", { durationMs: "${inputs.value}" }, "durationMs"],
    [
      "group",
      { flowIds: ["child"], concurrency: "${inputs.value}" },
      "concurrency",
    ],
  ] satisfies [FlowNode["kind"], Record<string, Json>, string][])(
    "does not reinterpret reference-looking %s input strings as unresolved configuration",
    async (kind, config, field) => {
      const definition = flow([node("action", kind, config)]);
      const targets = [
        { id: "browser", name: "Page", kind: "browser" as const },
      ];
      const executeNode = vi.fn(async () => true);
      const engine = new WorkflowEngine({
        getFlows: () => [definition, flow([], "child")],
        getTargets: () => targets,
        validationContext: () => ({ targets }),
        executeNode,
      });
      const completed = await engine.wait(
        engine.submit(definition.id, { value: "${vars.unresolved}" }).id,
      );
      expect(completed.status).toBe("failed");
      expect(completed.error).toContain(field);
      expect(executeNode).not.toHaveBeenCalled();
      expect(completed.childIds).toEqual([]);
    },
  );

  it("keeps literal reference-looking text inside resolved text payloads", async () => {
    const definition = flow([
      node("type", "type", { targetId: "browser", text: "${inputs.message}" }),
    ]);
    const targets = [{ id: "browser", name: "Page", kind: "browser" as const }];
    const executeNode = vi.fn(async () => true);
    const engine = new WorkflowEngine({
      getFlows: () => [definition],
      getTargets: () => targets,
      validationContext: () => ({ targets }),
      executeNode,
    });
    const completed = await engine.wait(
      engine.submit(definition.id, { message: "Write ${literal.text} exactly" })
        .id,
    );
    expect(completed.status).toBe("succeeded");
    expect(executeNode.mock.calls[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          config: expect.objectContaining({
            text: "Write ${literal.text} exactly",
          }),
        }),
      ]),
    );
  });

  it.each(["call", "group", "loop"] as const)(
    "rejects %s child inputs that resolve to a scalar before creating a child",
    async (kind) => {
      const childConfig = { flowId: "child", inputs: "${inputs.child}" };
      const config: Record<string, Json> =
        kind === "group"
          ? { children: [childConfig] }
          : kind === "loop"
            ? { ...childConfig, count: 1 }
            : childConfig;
      const definition = flow([node("action", kind, config)]);
      const engine = new WorkflowEngine({
        getFlows: () => [definition, flow([], "child")],
        getTargets: () => [],
        executeNode: async () => undefined,
      });
      const completed = await engine.wait(
        engine.submit(definition.id, { child: "abc" }).id,
      );
      expect(completed.status).toBe("failed");
      expect(completed.error).toMatch(/inputs must .*object/i);
      expect(completed.childIds).toEqual([]);
    },
  );

  it("validates target kinds against the same snapshot used by an active run", async () => {
    const definition = flow([
      node("first", "click", { targetId: "browser" }),
      node("second", "read", { targetId: "browser", selector: "body" }),
    ]);
    const targets = [{ id: "browser", name: "Page", kind: "browser" as const }];
    const executed: string[] = [];
    const engine = new WorkflowEngine({
      getFlows: () => [definition],
      getTargets: () => targets,
      validationContext: () => ({ targets }),
      executeNode: async (action, context) => {
        executed.push(action.id);
        expect(context.target?.kind).toBe("browser");
        targets.splice(0);
        return true;
      },
    });
    const completed = await engine.wait(engine.submit(definition.id).id);
    expect(completed.status).toBe("succeeded");
    expect(executed).toEqual(["first", "second"]);
  });
});
