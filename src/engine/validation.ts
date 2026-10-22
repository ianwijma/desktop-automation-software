import type {
  FlowDefinition,
  FlowNode,
  Json,
  ValidationIssue,
} from "../shared/types";
import {
  hasReference,
  nodeDefinitions,
  nodeOutputPorts,
  type ValidationContext,
} from "../shared/node-definitions";
import { createReferenceInspector } from "../shared/value-references";
export type { ValidationContext } from "../shared/node-definitions";

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
  context?: ValidationContext,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const error = (message: string, nodeId?: string) =>
    issues.push({ severity: "error", message, ...(nodeId ? { nodeId } : {}) });
  if (![1, 2].includes(flow.schemaVersion))
    error("Unsupported workflow schema version");
  if (flow.nodes.length > 2000)
    error("A workflow cannot contain more than 2000 nodes");
  if (flow.edges.length > 4000)
    error("A workflow cannot contain more than 4000 edges");
  const nodes = new Map(flow.nodes.map((node) => [node.id, node]));
  // Reuse graph analysis for every reference in this validation pass.
  const references = createReferenceInspector(flow);
  const warnings = new Set<string>();
  const referenceWarning = (
    value: string,
    nodeId?: string,
    loopInputs = false,
  ) => {
    const option = references.describeReference(value, nodeId, { loopInputs });
    if (!option?.warning) return;
    const message = `${option.label}: ${option.warning}`;
    const key = `${nodeId ?? ""}:${message}`;
    if (!warnings.has(key)) {
      warnings.add(key);
      issues.push({
        severity: "warning",
        message,
        ...(nodeId ? { nodeId } : {}),
      });
    }
  };
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
    const allowed = Object.hasOwn(nodeDefinitions, from.kind)
      ? nodeOutputPorts(from.kind)
      : [];
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
    if (!Object.hasOwn(nodeDefinitions, node.kind)) {
      error(`Unknown node kind: ${node.kind}`, node.id);
      continue;
    }
    if (
      !node.config ||
      typeof node.config !== "object" ||
      Array.isArray(node.config)
    ) {
      error("Node configuration must be an object", node.id);
      continue;
    }
    for (const issue of nodeDefinitions[node.kind].validateConfig(
      node.config,
      context,
    ))
      issues.push({ ...issue, nodeId: node.id });
    validateReferences(
      node.config,
      nodes,
      (message) => error(message, node.id),
      node.kind === "loop",
      [],
      (reference, loopInputs) =>
        referenceWarning(reference, node.id, loopInputs),
    );
    const detection =
      typeof node.config.detection === "string"
        ? /^\$\{nodes\.([^.{}]+)\}$/.exec(node.config.detection)
        : null;
    if (detection && ["click", "move"].includes(node.kind)) {
      const source = nodes.get(detection[1]);
      const sourceTarget = source?.config?.targetId;
      const target = node.config.targetId;
      if (
        sourceTarget &&
        target &&
        !hasReference(sourceTarget) &&
        !hasReference(target) &&
        sourceTarget !== target
      )
        error("Detected location and action must use the same target", node.id);
    }
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
            !hasReference(spec.inputs) &&
            (!spec.inputs ||
              Array.isArray(spec.inputs) ||
              typeof spec.inputs !== "object")
          )
            error("Child inputs must be an object", node.id);
        }
      } catch (cause) {
        error((cause as Error).message, node.id);
      }
    }
  }
  validateReferences(flow.outputs, nodes, error, false, [], (reference) =>
    referenceWarning(reference),
  );
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
  context?: ValidationContext,
): ReadonlyMap<string, FlowDefinition> {
  const all = new Map(available.map((flow) => [flow.id, flow]));
  const selected = new Map<string, FlowDefinition>();
  const visit = (id: string) => {
    if (selected.has(id)) return;
    const flow = all.get(id);
    if (!flow) throw new Error(`Workflow not found: ${id}`);
    const errors = validateFlow(flow, available, context).filter(
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

function validateReferences(
  value: Json,
  nodes: ReadonlyMap<string, FlowNode>,
  error: (message: string) => void,
  loop = false,
  path: string[] = [],
  warn?: (reference: string, loopInputs: boolean) => void,
): void {
  if (typeof value === "string") {
    const pattern = /\$\{([^{}]+)\}/g;
    for (const match of value.matchAll(pattern)) {
      const parts = match[1].trim().split(".");
      if (
        parts.some(
          (part) =>
            !part || ["__proto__", "prototype", "constructor"].includes(part),
        )
      ) {
        error(`Unsafe or invalid reference: ${match[1]}`);
        continue;
      }
      const root = parts[0];
      if (!["inputs", "vars", "nodes", "item", "index"].includes(root))
        error(`Unknown reference root: ${root}`);
      else if (root === "nodes" && parts[1] && !nodes.has(parts[1]))
        error(`Reference points to a missing node: ${parts[1]}`);
      else if (
        (root === "item" || root === "index") &&
        !(loop && path[0] === "inputs")
      )
        error(
          `${root} references are only available in Loop inputs; use inputs.${root} inside the child flow`,
        );
      else if (root === "index" && parts.length !== 1)
        error("Loop index is a number and cannot have a property path");
      if (
        (root === "nodes" && parts[1] && nodes.has(parts[1])) ||
        root === "vars"
      )
        warn?.(match[0], loop && path[0] === "inputs");
    }
    if (value.replace(pattern, "").includes("${"))
      error(
        "Malformed reference; use ${inputs.name}, ${vars.name} or ${nodes.nodeId}",
      );
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (["__proto__", "prototype", "constructor"].includes(key))
        error(`Unsafe property: ${key}`);
      validateReferences(child, nodes, error, loop, [...path, key], warn);
    }
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
