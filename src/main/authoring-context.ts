import { projectAuthoringValue } from "./authoring-private-values";
import { createHash } from "node:crypto";
import {
  authoringLimits,
  authoringGraphSchema,
  type FlowProposalRequest,
} from "../shared/chat-authoring";
import {
  nodeDefinitions,
  nodeKinds,
  nodeOutputPorts,
} from "../shared/node-definitions";
import { childSpecs, validateFlow } from "../engine/validation";
import type {
  AIConnection,
  AppSettings,
  FlowDefinition,
  Json,
  TargetDescriptor,
} from "../shared/types";
export interface AuthoringWorkspace {
  flows: FlowDefinition[];
  targets: TargetDescriptor[];
  connections: AIConnection[];
  settings?: Pick<
    AppSettings,
    "defaultTextConnection" | "defaultVisionConnection"
  >;
}
export class AuthoringContextError extends Error {
  constructor(
    readonly code: "configuration" | "context-limit" | "stale-context",
  ) {
    super(code);
  }
}
export function boundedAuthoringJSON(value: unknown, maxBytes: number) {
  const pending = [{ value, depth: 0 }];
  let count = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (++count > 100000 || item.depth > 24)
      throw new AuthoringContextError("context-limit");
    if (item.value && typeof item.value === "object") {
      for (const [key, value] of Object.entries(item.value)) {
        if (["__proto__", "prototype", "constructor"].includes(key))
          throw new AuthoringContextError("configuration");
        pending.push({ value, depth: item.depth + 1 });
      }
    }
  }
  const text = JSON.stringify(value);
  if (!text || Buffer.byteLength(text) > maxBytes)
    throw new AuthoringContextError("context-limit");
  return text;
}
export const sha256 = (value: unknown) =>
  createHash("sha256")
    .update(boundedAuthoringJSON(value, 2 * 1024 * 1024))
    .digest("hex");
export function authoringConnectionIdentity(c: AIConnection) {
  return {
    id: c.id,
    name: c.name,
    provider: c.provider,
    baseUrl: c.baseUrl,
    model: c.model,
    capabilities: c.capabilities,
    experimentalVision: c.experimentalVision,
    revision: c.revision ?? 0,
    credentialRevision: c.credentialRevision ?? 0,
  };
}
export function prepareAuthoringContext(
  request: FlowProposalRequest,
  workspace: AuthoringWorkspace,
) {
  const choose = <T extends { id: string }>(ids: string[], available: T[]) =>
    ids.map((id) => {
      const value = available.find((v) => v.id === id);
      if (!value) throw new AuthoringContextError("configuration");
      return structuredClone(value);
    });
  const connection = choose([request.connectionId], workspace.connections)[0];
  if (
    connection.provider === "jev" ||
    !connection.model.trim() ||
    !connection.capabilities.text ||
    !connection.capabilities.structured
  )
    throw new AuthoringContextError("configuration");
  const targets = choose(request.targetIds, workspace.targets),
    connections = choose(request.connectionIds, workspace.connections),
    children = choose(request.childFlowIds, workspace.flows);
  const saved = request.source
    ? choose([request.source.flowId], workspace.flows)[0]
    : undefined;
  if (saved && saved.revision !== request.source!.expectedRevision)
    throw new AuthoringContextError("stale-context");
  const source = saved
    ? { ...saved, ...(request.source?.draft ?? {}) }
    : undefined;
  if (source) boundedAuthoringJSON(source, 2 * 1024 * 1024);
  if (source)
    authoringGraphSchema.parse({
      name: source.name,
      description: source.description,
      nodes: source.nodes,
      edges: source.edges,
      inputs: source.inputs,
      outputs: source.outputs,
    });
  // Include transitive children for local validation/freshness only, never in the model context.
  const closure = new Map<string, FlowDefinition>();
  const visit = (flow: FlowDefinition) => {
    if (closure.has(flow.id)) return;
    closure.set(flow.id, flow);
    for (const node of flow.nodes)
      for (const spec of childSpecs(node)) {
        const child = workspace.flows.find((f) => f.id === spec.flowId);
        if (!child) throw new AuthoringContextError("configuration");
        visit(child);
      }
  };
  children.forEach(visit);
  boundedAuthoringJSON([...closure.values()], 2 * 1024 * 1024);
  const graph = source
    ? {
        name: source.name,
        description: source.description,
        nodes: source.nodes.map((n) => ({
          id: n.id,
          kind: n.kind,
          label: n.label,
          x: n.position.x,
          y: n.position.y,
          config: projectAuthoringValue(
            Object.fromEntries(
              Object.entries(n.config).filter(
                ([key]) => !["command", "args", "frameId"].includes(key),
              ),
            ),
          ),
        })),
        edges: source.edges,
        inputs: projectAuthoringValue(source.inputs),
        outputs: projectAuthoringValue(source.outputs),
      }
    : null;
  const context = {
    selectedGraph: graph,
    targets: targets.map((t) => ({
      id: t.id,
      name: t.name,
      kind: t.kind,
      ...(t.browserMode ? { browserMode: t.browserMode } : {}),
    })),
    connections: connections.map((c) => ({
      id: c.id,
      name: c.name,
      provider: c.provider,
      model: c.model,
      capabilities: c.capabilities,
      experimentalVision: Boolean(c.experimentalVision),
    })),
    children: children.map((f) => ({
      id: f.id,
      name: f.name,
      inputs: projectAuthoringValue(f.inputs),
      outputs: projectAuthoringValue(f.outputs),
    })),
    registry: nodeKinds.map((kind) => ({
      kind,
      label: nodeDefinitions[kind].label,
      description: nodeDefinitions[kind].description,
      defaults: nodeDefinitions[kind].defaults,
      fields: nodeDefinitions[kind].fields,
      ports: nodeOutputPorts(kind),
      outputs: nodeDefinitions[kind].outputs,
    })),
    referenceSyntax: {
      inputs: "${inputs.name}",
      variables: "${vars.name}",
      nodes: "${nodes.nodeId.path}",
      loop: "${item} and ${index} only in loop child inputs",
    },
  };
  const contextJSON = boundedAuthoringJSON(
    context,
    authoringLimits.contextBytes,
  );
  const childTargetIds = new Set<string>(),
    childConnectionIds = new Set<string>();
  let usesChildDefaults = false;
  for (const child of closure.values())
    for (const node of child.nodes) {
      if (
        typeof node.config.targetId === "string" &&
        !node.config.targetId.includes("${")
      )
        childTargetIds.add(node.config.targetId);
      if (
        typeof node.config.connectionId === "string" &&
        node.config.connectionId &&
        !node.config.connectionId.includes("${")
      )
        childConnectionIds.add(node.config.connectionId);
      if (
        (node.kind === "ai" ||
          (["detect", "wait"].includes(node.kind) &&
            node.config.detector === "ai")) &&
        !node.config.connectionId
      ) {
        usesChildDefaults = true;
        for (const id of [
          workspace.settings?.defaultTextConnection,
          workspace.settings?.defaultVisionConnection,
        ])
          if (id) childConnectionIds.add(id);
      }
    }
  const fingerprint = sha256({
    connection: authoringConnectionIdentity(connection),
    targets,
    connections: connections.map(authoringConnectionIdentity),
    children: [...closure.values()],
    childTargets: workspace.targets.filter((t) => childTargetIds.has(t.id)),
    childConnections: workspace.connections
      .filter((c) => childConnectionIds.has(c.id))
      .map(authoringConnectionIdentity),
    childDefaults: usesChildDefaults
      ? {
          defaultTextConnection: workspace.settings?.defaultTextConnection,
          defaultVisionConnection: workspace.settings?.defaultVisionConnection,
        }
      : {},
    saved,
    draft: request.source?.draft ?? null,
  });
  for (const child of closure.values())
    if (
      validateFlow(child, [...closure.values()], {
        targets: workspace.targets,
        connections: workspace.connections,
        settings: workspace.settings ?? {},
      }).some((issue) => issue.severity === "error")
    )
      throw new AuthoringContextError("configuration");
  return {
    connection,
    targets,
    connections,
    children: [...closure.values()],
    source,
    selectedChildIds: [...request.childFlowIds],
    contextJSON,
    fingerprint,
    sourceGraphSha256: source
      ? sha256({
          name: source.name,
          description: source.description,
          nodes: source.nodes,
          edges: source.edges,
          inputs: source.inputs,
          outputs: source.outputs,
        })
      : undefined,
  };
}
export type AuthoringContext = ReturnType<typeof prepareAuthoringContext>;
export function parseAuthoringRecord(value: string): Record<string, Json> {
  if (Buffer.byteLength(value) > 32768)
    throw new AuthoringContextError("context-limit");
  const parsed: unknown = JSON.parse(value);
  boundedAuthoringJSON(parsed, 32768);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new AuthoringContextError("configuration");
  return parsed as Record<string, Json>;
}
