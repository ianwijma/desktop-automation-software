import { describe, expect, it } from "vitest";
import {
  migrateFlow,
  parseFlowBundle,
  prepareFlowSave,
} from "../src/shared/flow-persistence";
import { WorkflowEngine } from "../src/engine";
import { flowSchema, targetSchema } from "../src/shared/validation";
import type { FlowDefinition, Json } from "../src/shared/types";
import pr1 from "./fixtures/pr1-workflows-v1.json";

const flow = (revision = 4): FlowDefinition => ({
  schemaVersion: 1,
  id: "parent",
  name: "My workflow",
  description: "Preserve my data",
  folder: "Work",
  revision,
  nodes: [
    {
      id: "child-node",
      kind: "call",
      label: "Child",
      position: { x: 42, y: -19 },
      config: {
        flowId: "child-flow",
        targetId: "my-window",
        connectionId: "my-model",
        inputs: { value: "${nodes.previous.result}", items: [1, null, true] },
      },
      breakpoint: true,
    },
  ],
  edges: [
    { id: "edge", source: "child-node", target: "child-node", port: "error" },
  ],
  inputs: { value: "initial" },
  outputs: { value: "${nodes.child-node}" },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-02-01T00:00:00.000Z",
  hotkey: "Control+Alt+W",
});

describe("workflow envelope migration", () => {
  it("preserves execution of the exact PR1 welcome, twelve-child batch, and browser fixtures", async () => {
    const legacy = pr1.flows.map((item) => flowSchema.parse(item));
    const migrated = legacy.map(migrateFlow);
    expect(migrated).toEqual(
      legacy.map((item) => ({ ...item, schemaVersion: 2 })),
    );
    async function execute(flows: FlowDefinition[]) {
      const browserActions: {
        kind: string;
        config: Record<string, Json>;
        targetId?: string;
      }[] = [];
      const engine = new WorkflowEngine({
        getFlows: () => flows,
        getTargets: () =>
          pr1.targets.map((target) => targetSchema.parse(target)),
        executeNode: async (node, context) => {
          browserActions.push({
            kind: node.kind,
            config: context.config,
            targetId: context.target?.id,
          });
          return node.kind === "read" ? { value: "Example Domain" } : undefined;
        },
      });
      const welcome = await engine.wait(engine.submit("welcome").id);
      const batch = await engine.wait(engine.submit("batch-starter").id);
      const browser = await engine.wait(engine.submit("browser-starter").id);
      const children = batch.childIds.map((id) => engine.get(id)!);
      expect(welcome.status).toBe("succeeded");
      expect(welcome.outputs).toEqual({ message: "Hello from Relay" });
      expect(batch.status).toBe("succeeded");
      expect(children).toHaveLength(12);
      expect(children.every((child) => child.status === "succeeded")).toBe(
        true,
      );
      expect(children.map((child) => child.inputs.item)).toEqual(
        Array.from({ length: 12 }, (_, index) => index + 1),
      );
      expect(browser.status).toBe("succeeded");
      expect(browser.outputs).toEqual({ heading: "Example Domain" });
      return {
        welcome: welcome.outputs,
        batch: batch.outputs,
        children: children.map((child) => ({
          flowId: child.flowId,
          revision: child.revision,
          inputs: child.inputs,
          outputs: child.outputs,
        })),
        browser: browser.outputs,
        browserActions,
      };
    }
    const [before, after] = await Promise.all([
      execute(legacy),
      execute(migrated),
    ]);
    expect(after).toEqual(before);
  }, 30_000);

  it("upgrades schema 1 without changing identities, configuration, references, or revision", () => {
    const original = flow();
    const before = structuredClone(original);
    const migrated = migrateFlow(original);
    expect(migrated).toEqual({ ...before, schemaVersion: 2 });
    expect(original).toEqual(before);
    expect(migrateFlow(migrated)).toEqual(migrated);
    migrated.nodes[0].config.flowId = "changed";
    expect(original.nodes[0].config.flowId).toBe("child-flow");
  });

  it("rejects unknown schemas and malformed envelopes without repairing graph contents", () => {
    for (const schemaVersion of [0, 3, 99, "2"])
      expect(() => migrateFlow({ ...flow(), schemaVersion })).toThrow(
        "Unsupported workflow schema version",
      );
    expect(() => migrateFlow({ ...flow(), id: "" })).toThrow();
    expect(() =>
      migrateFlow({ ...flow(), nodes: [{ kind: "unknown" }] }),
    ).toThrow();
    expect(() => migrateFlow(null)).toThrow();
    // Migration is deliberately independent of semantic graph validation.
    expect(migrateFlow(flow()).edges[0].target).toBe("child-node");
  });
});

describe("workflow bundle parsing", () => {
  it("imports PR1 and current bundles through the same migration without mutating inputs", () => {
    for (const version of [1, 2]) {
      const source = structuredClone({ ...pr1, version });
      const before = structuredClone(source);
      expect(parseFlowBundle(source)).toEqual({
        flows: pr1.flows.map((item) => ({ ...item, schemaVersion: 2 })),
        targets: pr1.targets,
        rootId: pr1.rootId,
      });
      expect(source).toEqual(before);
    }
  });

  it("accepts a bare legacy/current flow and defaults an omitted bundle root", () => {
    for (const schemaVersion of [1, 2]) {
      const source = { ...flow(), schemaVersion };
      expect(parseFlowBundle(source)).toEqual({
        flows: [{ ...source, schemaVersion: 2 }],
        targets: [],
        rootId: source.id,
      });
    }
    const { rootId: _root, targets: _targets, ...withoutRoot } = pr1;
    expect(parseFlowBundle(withoutRoot)).toMatchObject({
      rootId: pr1.flows[0].id,
      targets: [],
    });
  });

  it.each([
    ["future bundle", { ...pr1, version: 3 }],
    ["unknown format", { ...pr1, format: "another" }],
    ["unmarked bundle", { flows: pr1.flows }],
    [
      "future workflow",
      { ...pr1, flows: [{ ...pr1.flows[0], schemaVersion: 3 }] },
    ],
    ["duplicate workflows", { ...pr1, flows: [pr1.flows[0], pr1.flows[0]] }],
    [
      "duplicate targets",
      { ...pr1, targets: [pr1.targets[0], pr1.targets[0]] },
    ],
    ["missing root", { ...pr1, rootId: "deleted" }],
    ["malformed target", { ...pr1, targets: [{ id: "broken" }] }],
    ["empty flows", { ...pr1, flows: [] }],
    ["too many workflows", { ...pr1, flows: Array(201).fill(pr1.flows[0]) }],
    ["too many targets", { ...pr1, targets: Array(201).fill(pr1.targets[0]) }],
  ])("rejects %s before returning any importable data", (_name, source) => {
    const before = structuredClone(source);
    expect(() => parseFlowBundle(source)).toThrow();
    expect(source).toEqual(before);
  });
});

describe("pure revision-checked save preparation", () => {
  it("creates only when absent and assigns the first revision", () => {
    const candidate = flow(90);
    expect(prepareFlowSave(candidate, undefined, null)).toEqual({
      status: "saved",
      flow: { ...candidate, schemaVersion: 2, revision: 1 },
    });
    const conflict = prepareFlowSave(candidate, flow(), null);
    expect(conflict.status).toBe("conflict");
    if (conflict.status === "conflict")
      expect(conflict.current?.revision).toBe(4);
  });

  it("updates the expected revision, preserving creation metadata and provided timestamps", () => {
    const current = flow();
    const proposed = {
      ...flow(100),
      name: "Edited",
      createdAt: "do-not-overwrite",
      updatedAt: "2026-03-01T00:00:00.000Z",
    };
    const result = prepareFlowSave(proposed, current, 4);
    expect(result).toEqual({
      status: "saved",
      flow: {
        ...proposed,
        schemaVersion: 2,
        revision: 5,
        createdAt: current.createdAt,
      },
    });
    expect(current.revision).toBe(4);
    expect(proposed.revision).toBe(100);
  });

  it("does not overwrite a newer revision or resurrect a deleted workflow", () => {
    expect(prepareFlowSave(flow(), flow(5), 4)).toMatchObject({
      status: "conflict",
      current: { revision: 5 },
    });
    const deleted = prepareFlowSave(flow(), undefined, 4);
    expect(deleted).toMatchObject({ status: "conflict" });
    expect(deleted).not.toHaveProperty("current");
  });

  it("rejects invalid expectations, mismatched IDs, and revision overflow", () => {
    for (const expected of [
      0,
      -1,
      1.5,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
    ])
      expect(() => prepareFlowSave(flow(), flow(), expected)).toThrow(
        "Expected revision",
      );
    expect(() =>
      prepareFlowSave(flow(), { ...flow(), id: "another" }, 4),
    ).toThrow("ID does not match");
    expect(() =>
      prepareFlowSave(
        flow(),
        flow(Number.MAX_SAFE_INTEGER),
        Number.MAX_SAFE_INTEGER,
      ),
    ).toThrow("incremented safely");
  });
});
