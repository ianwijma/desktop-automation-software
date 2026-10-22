import type {
  FlowDefinition,
  FlowNode,
  Json,
  ValidationIssue,
} from "../shared/types";

export interface ChildSpec {
  flowId: string;
  inputs: Record<string, Json>;
}
export function childSpecs(node: FlowNode): ChildSpec[] {
  if (node.kind === "call" || node.kind === "loop")
    return typeof node.config.flowId === "string"
      ? [
          {
            flowId: node.config.flowId,
            inputs: (node.config.inputs ?? {}) as Record<string, Json>,
          },
        ]
      : [];
  if (node.kind !== "group") return [];
  if (Array.isArray(node.config.children))
    return node.config.children.map((child) => {
      if (
        !child ||
        typeof child !== "object" ||
        Array.isArray(child) ||
        typeof child.flowId !== "string"
      )
        throw new Error("Each child needs a flowId");
      return {
        flowId: child.flowId,
        inputs: (child.inputs ?? {}) as Record<string, Json>,
      };
    });
  if (Array.isArray(node.config.flowIds))
    return node.config.flowIds.map((flowId) => {
      if (typeof flowId !== "string")
        throw new Error("Each child flowId must be a string");
      return { flowId, inputs: {} };
    });
  return [];
}

export function validateFlow(
  flow: FlowDefinition,
  flows: FlowDefinition[] = [flow],
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const error = (message: string, nodeId?: string) =>
    issues.push({ severity: "error", message, ...(nodeId ? { nodeId } : {}) });
  if (flow.schemaVersion !== 1) error("Unsupported workflow schema version");
  if (flow.nodes.length > 10000)
    error("A workflow cannot contain more than 10000 nodes");
  const nodes = new Map(flow.nodes.map((node) => [node.id, node]));
  if (nodes.size !== flow.nodes.length) error("Node IDs must be unique");
  if (new Set(flow.edges.map((edge) => edge.id)).size !== flow.edges.length)
    error("Edge IDs must be unique");
  const starts = flow.nodes.filter((node) => node.kind === "start");
  if (starts.length !== 1) error("A workflow needs exactly one Start node");
  if (!flow.nodes.some((node) => node.kind === "end"))
    error("A workflow needs an End node");
  const outgoing = new Map<string, Map<string, string>>();
  for (const edge of flow.edges) {
    if (!nodes.has(edge.source) || !nodes.has(edge.target)) {
      error("An edge references a missing node");
      continue;
    }
    const from = nodes.get(edge.source)!;
    const port = edge.port || "next";
    const allowed =
      from.kind === "condition"
        ? ["true", "false", "error"]
        : from.kind === "detect"
          ? ["match", "no-match", "uncertain", "next", "error"]
          : ["next", "error"];
    if (!allowed.includes(port))
      error(`Unsupported ${from.kind} output port: ${port}`, from.id);
    if (from.kind === "end")
      error("End nodes cannot have outgoing connections", from.id);
    if (nodes.get(edge.target)?.kind === "start")
      error("Start nodes cannot have incoming connections", edge.target);
    if (!outgoing.has(edge.source)) outgoing.set(edge.source, new Map());
    if (outgoing.get(edge.source)!.has(port))
      error(
        `Only one connection is allowed per output port (${port})`,
        edge.source,
      );
    outgoing.get(edge.source)!.set(port, edge.target);
  }
  for (const node of flow.nodes) {
    const ports = outgoing.get(node.id);
    if (node.kind !== "end" && !ports?.size)
      error("Node needs an outgoing connection", node.id);
    if (
      node.kind === "condition" &&
      (!ports?.has("true") || !ports.has("false"))
    )
      error("Condition needs true and false connections", node.id);
    if (
      node.kind !== "condition" &&
      node.kind !== "detect" &&
      node.kind !== "end" &&
      !ports?.has("next")
    )
      error("Node needs a next connection", node.id);
    if (
      node.kind === "detect" &&
      !ports?.has("next") &&
      (!ports?.has("match") ||
        !ports.has("no-match") ||
        !ports.has("uncertain"))
    )
      error(
        "Detector needs a default connection or match, no-match and uncertain connections",
        node.id,
      );
    if (["call", "group", "loop"].includes(node.kind)) {
      try {
        const specs = childSpecs(node);
        if (!specs.length) error("Choose at least one child workflow", node.id);
        for (const spec of specs) {
          if (spec.flowId.includes("${"))
            error(
              "Child workflow IDs must be fixed for reproducible execution",
              node.id,
            );
          if (!flows.some((candidate) => candidate.id === spec.flowId))
            error(`Child workflow not found: ${spec.flowId}`, node.id);
          if (
            !spec.inputs ||
            Array.isArray(spec.inputs) ||
            typeof spec.inputs !== "object"
          )
            error("Child inputs must be an object", node.id);
        }
      } catch (cause) {
        error((cause as Error).message, node.id);
      }
    }
    if (node.kind === "group") {
      if (
        node.config.mode !== undefined &&
        !["sequence", "pool", "batches"].includes(String(node.config.mode))
      )
        error("Unknown group execution mode", node.id);
      const count = node.config.concurrency ?? 3;
      if (
        typeof count !== "number" ||
        !Number.isInteger(count) ||
        count < 1 ||
        count > 64
      )
        error("Concurrency must be between 1 and 64", node.id);
    }
    if (node.kind === "loop") {
      const limit = node.config.maxIterations ?? 1000;
      if (
        typeof limit !== "number" ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 10000
      )
        error("Loop maxIterations must be between 1 and 10000", node.id);
      if (node.config.items === undefined && node.config.count === undefined)
        error("Loop requires count or items", node.id);
      const count = node.config.count;
      if (
        count !== undefined &&
        typeof count !== "string" &&
        (typeof count !== "number" ||
          !Number.isInteger(count) ||
          count < 0 ||
          count > Number(limit))
      )
        error("Loop count exceeds its bound", node.id);
    }
    if (
      node.config.timeoutMs !== undefined &&
      (typeof node.config.timeoutMs !== "number" ||
        node.config.timeoutMs <= 0 ||
        !Number.isFinite(node.config.timeoutMs))
    )
      error("Timeout must be positive milliseconds", node.id);
  }
  const reached = new Set<string>();
  const stack = new Set<string>();
  const walk = (id: string) => {
    if (stack.has(id)) {
      error("Graph cycles are unsupported; use a bounded Loop node", id);
      return;
    }
    if (reached.has(id)) return;
    reached.add(id);
    stack.add(id);
    for (const target of outgoing.get(id)?.values() ?? []) walk(target);
    stack.delete(id);
  };
  if (starts[0]) walk(starts[0].id);
  for (const node of flow.nodes)
    if (!reached.has(node.id)) error("Node is unreachable from Start", node.id);
  const flowMap = new Map(flows.map((item) => [item.id, item]));
  flowMap.set(flow.id, flow);
  const traversed = new Set<string>();
  const ancestry = new Set<string>();
  const childWalk = (id: string) => {
    if (ancestry.has(id)) {
      error("Recursive child workflow calls are unsupported");
      return;
    }
    if (traversed.has(id)) return;
    traversed.add(id);
    ancestry.add(id);
    for (const node of flowMap.get(id)?.nodes ?? []) {
      try {
        for (const spec of childSpecs(node)) childWalk(spec.flowId);
      } catch {
        /* Reported above. */
      }
    }
    ancestry.delete(id);
  };
  childWalk(flow.id);
  return issues;
}

export function freezeFlowTree(
  flowId: string,
  available: FlowDefinition[],
): ReadonlyMap<string, FlowDefinition> {
  const all = new Map(available.map((flow) => [flow.id, flow]));
  const selected = new Map<string, FlowDefinition>();
  const visit = (id: string) => {
    if (selected.has(id)) return;
    const flow = all.get(id);
    if (!flow) throw new Error(`Workflow not found: ${id}`);
    const errors = validateFlow(flow, available).filter(
      (issue) => issue.severity === "error",
    );
    if (errors.length)
      throw new Error(
        `${flow.name}: ${errors.map((issue) => issue.message).join("; ")}`,
      );
    selected.set(id, deepFreeze(structuredClone(flow)));
    for (const node of flow.nodes)
      for (const child of childSpecs(node)) visit(child.flowId);
  };
  visit(flowId);
  return selected;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
