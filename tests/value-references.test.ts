import { describe, expect, it } from "vitest";
import {
  createReferenceInspector,
  describeReference,
  nodeReference,
  referenceOptions,
} from "../src/shared/value-references";
import { validateFlow } from "../src/engine/validation";
import type {
  FlowDefinition,
  FlowEdge,
  FlowNode,
  Json,
} from "../src/shared/types";

const node = (
  id: string,
  kind: FlowNode["kind"],
  config: Record<string, Json> = {},
  label = id,
): FlowNode => ({ id, kind, config, label, position: { x: 0, y: 0 } });
const edge = (source: string, target: string, port = "next"): FlowEdge => ({
  id: `${source}-${port}-${target}`,
  source,
  target,
  port,
});
function graph(actions: FlowNode[], edges?: FlowEdge[]): FlowDefinition {
  const nodes = [node("start", "start"), ...actions, node("end", "end")];
  return {
    schemaVersion: 2,
    id: "references",
    name: "References",
    description: "",
    folder: "",
    revision: 1,
    nodes,
    edges:
      edges ?? nodes.slice(1).map((target, i) => edge(nodes[i].id, target.id)),
    inputs: {},
    outputs: {},
    createdAt: "2026-10-22",
    updatedAt: "2026-10-22",
  };
}
const find = (flow: FlowDefinition, reference: string, consumer = "consume") =>
  referenceOptions(flow, consumer).find(
    (option) => option.reference === reference,
  );
function branches(
  right: FlowNode = node("right", "set", {
    variable: "choice",
    value: "right",
  }),
) {
  return graph(
    [
      node("condition", "condition", { left: true }),
      node("left", "set", { variable: "choice", value: "left" }, "Left choice"),
      right,
      node("consume", "type", { text: "${vars.choice}" }),
    ],
    [
      edge("start", "condition"),
      edge("condition", "left", "true"),
      edge("condition", "right", "false"),
      edge("left", "consume"),
      edge("right", "consume"),
      edge("consume", "end"),
    ],
  );
}

describe("reference discovery", () => {
  it("offers completion-scope output references without a consuming node", () => {
    const flow = branches();
    const inspector = createReferenceInspector(flow);
    expect(inspector.referenceOptions()).toBe(
      inspector.referenceOptions(undefined),
    );
    expect(
      referenceOptions(flow).find(
        (option) => option.reference === "${vars.choice}",
      ),
    ).toMatchObject({ type: "string", warning: undefined });
    expect(
      referenceOptions(flow).find(
        (option) => option.reference === "${nodes.left}",
      )?.warning,
    ).toContain("flow finishes");
    expect(describeReference("${nodes.left}", flow)?.warning).toContain(
      "flow finishes",
    );
  });

  it("infers structured AI schema properties and propagates optional-parent warnings", () => {
    const schema = {
      type: "object",
      description: "Invoice",
      properties: {
        total: { type: "number", description: "Invoice total" },
        details: {
          type: "object",
          properties: { code: { type: "string" } },
          required: ["code"],
        },
        count: { type: "integer" },
        enabled: { type: "boolean" },
        rows: {
          type: "array",
          items: { type: "object", properties: { name: { type: "string" } } },
        },
        absent: { type: "null" },
      },
      required: ["total", "count", "enabled", "rows", "absent"],
    };
    const flow = graph([
      node("ai", "ai", { mode: "structured", schema }),
      node("consume", "type"),
    ]);
    expect(find(flow, "${nodes.ai}")).toMatchObject({
      type: "object",
      description: "Invoice",
      warning: undefined,
    });
    expect(find(flow, "${nodes.ai.total}")).toMatchObject({
      type: "number",
      description: "Invoice total",
      warning: undefined,
    });
    expect(find(flow, "${nodes.ai.count}")?.type).toBe("number");
    expect(find(flow, "${nodes.ai.enabled}")?.type).toBe("boolean");
    expect(find(flow, "${nodes.ai.absent}")?.type).toBe("null");
    expect(find(flow, "${nodes.ai.details.code}")).toMatchObject({
      type: "string",
      warning: expect.stringContaining("optional"),
    });
    expect(find(flow, "${nodes.ai.rows}")?.type).toBe("array");
    expect(find(flow, "${nodes.ai.rows.0.name}")).toBeUndefined();
    flow.nodes.find((item) => item.id === "ai")!.config.schema =
      JSON.stringify(schema);
    expect(find(flow, "${nodes.ai.total}")?.type).toBe("number");
  });

  it("preserves advanced schemas and declines to invent union or reference output shapes", () => {
    const schema = {
      type: "object",
      properties: {
        dynamic: {
          $ref: "#/$defs/custom",
          properties: { invented: { type: "string" } },
        },
        maybe: {
          type: ["object", "null"],
          properties: { name: { type: "string" } },
        },
        choice: { anyOf: [{ type: "number" }, { type: "string" }] },
        "bad.path": { type: "number" },
        constructor: { type: "number" },
      },
      $defs: { custom: { type: "object" } },
    };
    const flow = graph([
      node("ai", "ai", { mode: "vision", schema }),
      node("consume", "type"),
    ]);
    const before = JSON.stringify(flow);
    const options = referenceOptions(flow, "consume");
    expect(
      options
        .filter((option) => option.nodeId === "ai")
        .map(({ reference, type }) => [reference, type]),
    ).toEqual([
      ["${nodes.ai}", "object"],
      ["${nodes.ai.dynamic}", "json"],
      ["${nodes.ai.maybe}", "json"],
      ["${nodes.ai.choice}", "json"],
    ]);
    expect(JSON.stringify(flow)).toBe(before);
    flow.nodes.find((item) => item.id === "ai")!.config.schema =
      "${inputs.schema}";
    expect(
      referenceOptions(flow, "consume").filter(
        (option) => option.nodeId === "ai",
      ),
    ).toHaveLength(1);
    expect(find(flow, "${nodes.ai}")?.type).toBe("json");
    for (const keyword of ["not", "$recursiveRef"]) {
      flow.nodes.find((item) => item.id === "ai")!.config.schema = {
        type: "object",
        properties: { hidden: { type: "string" } },
        [keyword]: keyword === "not" ? { required: ["hidden"] } : "#",
      };
      const inferred = referenceOptions(flow, "consume").filter(
        (option) => option.nodeId === "ai",
      );
      expect(inferred).toHaveLength(1);
      expect(inferred[0].type).toBe("json");
    }
  });

  it("uses graph order and stable IDs while displaying current node labels", () => {
    const flow = graph([
      node("read-uuid", "read", {}, "Read invoice"),
      node("consume", "type"),
      node("later", "read"),
    ]);
    flow.nodes.reverse();
    expect(find(flow, "${nodes.read-uuid}")).toMatchObject({
      label: "Read invoice → Result",
      type: "string",
      nodeId: "read-uuid",
      group: "Node outputs",
      warning: undefined,
    });
    expect(find(flow, "${nodes.consume}")).toBeUndefined();
    expect(find(flow, "${nodes.later}")).toBeUndefined();
    flow.nodes.find((item) => item.id === "read-uuid")!.label =
      "Read customer invoice";
    expect(find(flow, "${nodes.read-uuid}")?.label).toBe(
      "Read customer invoice → Result",
    );
    expect(nodeReference("read-uuid")).toBe("${nodes.read-uuid}");
    expect(
      describeReference("${nodes.later}", flow, "consume")?.warning,
    ).toContain("does not run before");
  });

  it("discovers literal input defaults and nested JSON paths with their types", () => {
    const flow = graph([node("consume", "type")]);
    flow.inputs = {
      count: 3,
      active: true,
      absent: null,
      profile: { name: "Ada" },
      rows: [{ amount: 4.5 }],
      literal: "${not.a.reference}",
    };
    const options = referenceOptions(flow, "consume");
    expect(
      options
        .filter((option) => option.group === "Flow inputs")
        .map(({ reference, type }) => [reference, type]),
    ).toEqual([
      ["${inputs.count}", "number"],
      ["${inputs.active}", "boolean"],
      ["${inputs.absent}", "null"],
      ["${inputs.profile}", "object"],
      ["${inputs.profile.name}", "string"],
      ["${inputs.rows}", "array"],
      ["${inputs.rows.0}", "object"],
      ["${inputs.rows.0.amount}", "number"],
      ["${inputs.literal}", "string"],
    ]);
    expect(
      describeReference("${inputs.suppliedAtRuntime}", flow, "consume")?.type,
    ).toBe("json");
    expect(
      describeReference("${inputs.suppliedAtRuntime}", flow, "consume")
        ?.warning,
    ).toBeUndefined();
  });

  it("skips property segments and node IDs that the resolver cannot represent", () => {
    const flow = graph([node("bad.node", "read"), node("consume", "type")]);
    flow.inputs = JSON.parse(
      '{"safe":{"child":true},"bad.dot":1,"{bad}":2,"constructor":3,"__proto__":4,"trailing ":5}',
    ) as Record<string, Json>;
    expect(
      referenceOptions(flow, "consume").map((option) => option.reference),
    ).toEqual(["${inputs.safe}", "${inputs.safe.child}"]);
    for (const id of [
      "bad.node",
      "{bad}",
      "constructor",
      "__proto__",
      "",
      " trailing",
    ])
      expect(nodeReference(id)).toBeNull();
    expect(
      describeReference("${inputs.constructor}", flow, "consume"),
    ).toBeNull();
  });

  it("infers set values, their nested outputs, variable aliases and exact-reference types", () => {
    const flow = graph([
      node(
        "set-profile",
        "set",
        { name: "profile", value: { name: "Ada", score: "${inputs.score}" } },
        "Remember profile",
      ),
      node("set-copy", "set", { variable: "score", value: "${inputs.score}" }),
      node("consume", "type"),
    ]);
    flow.inputs.score = 7;
    expect(find(flow, "${nodes.set-profile}")?.type).toBe("object");
    expect(find(flow, "${nodes.set-profile.score}")?.type).toBe("number");
    expect(find(flow, "${vars.profile.name}")).toMatchObject({
      type: "string",
      nodeId: "set-profile",
      warning: undefined,
    });
    expect(find(flow, "${vars.score}")).toMatchObject({
      type: "number",
      description: expect.stringContaining("set-copy"),
    });
  });

  it("warns about conditional node outputs without treating them as graph errors", () => {
    const flow = branches();
    flow.nodes.find((item) => item.id === "consume")!.config.text =
      "Choice: ${nodes.left}";
    expect(find(flow, "${nodes.left}")?.warning).toContain(
      "may not run on every path",
    );
    expect(
      describeReference("${nodes.left}", flow, "consume")?.warning,
    ).toContain("may not run on every path");
    const issues = validateFlow(flow);
    expect(issues.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(issues).toContainEqual(
      expect.objectContaining({
        severity: "warning",
        nodeId: "consume",
        message: expect.stringContaining("may not run on every path"),
      }),
    );
  });

  it("recognizes variables assigned on every branch and the most recent successful assignment", () => {
    const flow = branches();
    expect(find(flow, "${vars.choice}")).toMatchObject({
      type: "string",
      warning: undefined,
    });
    const sequential = graph([
      node("old", "set", { variable: "v", value: 10 }),
      node("new", "set", { variable: "v", value: false }),
      node("consume", "type"),
    ]);
    expect(find(sequential, "${vars.v}")).toMatchObject({
      type: "boolean",
      nodeId: "new",
      warning: undefined,
    });
    const conditional = branches(node("right", "wait", { ms: 1 }));
    expect(find(conditional, "${vars.choice}")?.warning).toContain(
      "may be unset",
    );
    expect(validateFlow(conditional)).toContainEqual(
      expect.objectContaining({
        severity: "warning",
        nodeId: "consume",
        message: expect.stringContaining("may be unset"),
      }),
    );
  });

  it("warns on error recovery even when the producer dominates the consumer", () => {
    const flow = graph(
      [
        node("read", "read", {}, "Read file"),
        node("recover", "wait", { ms: 1 }),
        node("consume", "type", { text: "${nodes.read}" }),
      ],
      [
        edge("start", "read"),
        edge("read", "consume"),
        edge("read", "recover", "error"),
        edge("recover", "consume"),
        edge("consume", "end"),
      ],
    );
    const warning = find(flow, "${nodes.read}")?.warning;
    expect(warning).toContain("error path");
    expect(warning).toContain("contains an error instead");
    expect(warning).not.toContain("may not run");
    expect(validateFlow(flow)).toContainEqual(
      expect.objectContaining({
        severity: "warning",
        nodeId: "consume",
        message: expect.stringContaining("error path"),
      }),
    );
  });

  it("does not treat a failed setter as an assignment, but preserves a prior assignment", () => {
    const make = (initialize: boolean) =>
      graph(
        [
          ...(initialize
            ? [node("initial", "set", { variable: "v", value: 1 })]
            : []),
          node("set", "set", { variable: "v", value: "new" }),
          node("recover", "wait", { ms: 1 }),
          node("consume", "type"),
        ],
        [
          ...(initialize
            ? [edge("start", "initial"), edge("initial", "set")]
            : [edge("start", "set")]),
          edge("set", "consume"),
          edge("set", "recover", "error"),
          edge("recover", "consume"),
          edge("consume", "end"),
        ],
      );
    expect(find(make(false), "${vars.v}")?.warning).toContain("error path");
    expect(find(make(true), "${vars.v}")).toMatchObject({
      type: "json",
      warning: undefined,
    });
  });

  it("describes deleted and future sources, but does not offer them in the picker", () => {
    const flow = graph([
      node("consume", "type"),
      node("future", "set", { variable: "later", value: true }),
    ]);
    expect(
      describeReference("${nodes.deleted}", flow, "consume"),
    ).toMatchObject({
      label: "Missing node: deleted",
      warning: expect.stringContaining("no longer exists"),
    });
    expect(
      describeReference("${vars.later}", flow, "consume")?.warning,
    ).toContain("runs before");
    expect(
      describeReference("${vars.missing}", flow, "consume")?.warning,
    ).toContain("No Set variable");
    expect(
      describeReference("${unknown.value}", flow, "consume")?.warning,
    ).toContain("Unknown reference root");
    expect(
      describeReference("Hello ${nodes.future}", flow, "consume"),
    ).toBeNull();
    flow.nodes.find((item) => item.id === "consume")!.config.text =
      "${nodes.deleted}";
    const issues = validateFlow(flow);
    expect(issues).toContainEqual(
      expect.objectContaining({
        severity: "error",
        message: expect.stringContaining("missing node: deleted"),
      }),
    );
    expect(issues.filter((issue) => issue.severity === "warning")).toEqual([]);
  });

  it("discovers detector fields and treats duration and detector waits differently", () => {
    const flow = graph([
      node("time", "wait", { ms: 1 }),
      node("visual", "wait", { detector: "image" }),
      node("detect", "detect"),
      node("shot", "screenshot"),
      node("consume", "type"),
    ]);
    expect(find(flow, "${nodes.time}")).toMatchObject({
      type: "null",
      warning: undefined,
    });
    expect(find(flow, "${nodes.time.box}")).toBeUndefined();
    expect(find(flow, "${nodes.visual.outcome}")?.type).toBe("string");
    expect(find(flow, "${nodes.detect.box.x}")).toMatchObject({
      type: "number",
      warning: expect.stringContaining("optional"),
    });
    expect(find(flow, "${nodes.shot.width}")?.type).toBe("number");
  });

  it("offers item and index only in Loop child inputs and infers literal item shapes", () => {
    const flow = graph([
      node("loop", "loop", {
        flowId: "child",
        items: [{ name: "Ada", amount: 1 }, { name: "Lin" }],
      }),
      node("consume", "type"),
    ]);
    expect(
      referenceOptions(flow, "loop").some(
        (option) => option.group === "Loop values",
      ),
    ).toBe(false);
    expect(
      referenceOptions(flow, "consume", { loopInputs: true }).some(
        (option) => option.group === "Loop values",
      ),
    ).toBe(false);
    const values = referenceOptions(flow, "loop", { loopInputs: true });
    expect(
      values.find((option) => option.reference === "${item.name}"),
    ).toMatchObject({ type: "string", warning: undefined });
    expect(
      values.find((option) => option.reference === "${item.amount}")?.warning,
    ).toContain("absent");
    expect(values.find((option) => option.reference === "${index}")?.type).toBe(
      "number",
    );
    expect(describeReference("${item}", flow, "consume")?.warning).toContain(
      "only available",
    );
  });

  it("checks flow outputs at completion across all Finish paths", () => {
    const flow = branches();
    flow.outputs = { selected: "${nodes.left}" };
    const issues = validateFlow(flow);
    expect(issues).toContainEqual(
      expect.objectContaining({
        severity: "warning",
        message: expect.stringContaining("flow finishes"),
      }),
    );
    flow.outputs = { end: "${nodes.end}" };
    expect(
      validateFlow(flow).filter((issue) => issue.severity === "warning"),
    ).toEqual([]);
  });

  it("reuses analysis and option lists only within one inspector", () => {
    const flow = graph([
      node("read", "read", {}, "Original"),
      node("consume", "type"),
    ]);
    const inspector = createReferenceInspector(flow);
    const options = inspector.referenceOptions("consume");
    expect(inspector.referenceOptions("consume")).toBe(options);
    expect(inspector.referenceOptions("consume", { loopInputs: false })).toBe(
      options,
    );
    flow.nodes.find((item) => item.id === "read")!.label = "Renamed";
    expect(
      referenceOptions(flow, "consume").find(
        (option) => option.nodeId === "read",
      )?.label,
    ).toContain("Renamed");
    expect(inspector.describeReference("${nodes.read}", "consume")?.type).toBe(
      "string",
    );
  });

  it.each([null, [], "invalid"])(
    "tolerates malformed draft configuration %j during validation",
    (config) => {
      const flow = graph([
        node("broken", "set"),
        node("consume", "type", { text: "${nodes.broken} ${vars.value}" }),
      ]);
      flow.nodes.find((item) => item.id === "broken")!.config =
        config as unknown as FlowNode["config"];
      expect(find(flow, "${nodes.broken}")?.type).toBe("json");
      expect(
        describeReference("${vars.value}", flow, "consume")?.warning,
      ).toContain("No Set variable");
      expect(validateFlow(flow)).toContainEqual(
        expect.objectContaining({
          severity: "error",
          nodeId: "broken",
          message: "Node configuration must be an object",
        }),
      );
    },
  );

  it("keeps diagnostics usable for unknown node kinds and cyclic drafts", () => {
    const unknown = graph([
      node("unknown", "future-kind" as FlowNode["kind"]),
      node("consume", "type", { text: "${nodes.unknown}" }),
    ]);
    expect(
      describeReference("${nodes.unknown}", unknown, "consume")?.type,
    ).toBe("json");
    expect(validateFlow(unknown)).toContainEqual(
      expect.objectContaining({
        severity: "error",
        nodeId: "unknown",
        message: "Unknown node kind: future-kind",
      }),
    );
    const cyclic = graph(
      [
        node("read", "read"),
        node("consume", "type", { text: "${nodes.read}" }),
      ],
      [
        edge("start", "read"),
        edge("read", "consume"),
        edge("consume", "read"),
        edge("consume", "end", "error"),
      ],
    );
    expect(referenceOptions(cyclic, "consume")).toEqual([]);
    expect(
      describeReference("${nodes.read}", cyclic, "consume")?.warning,
    ).toContain("cycle");
    expect(validateFlow(cyclic)).toContainEqual(
      expect.objectContaining({
        severity: "error",
        message: expect.stringMatching(/cycle/i),
      }),
    );
  });
});
