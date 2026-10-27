import {
  containsPrivatePlaceholder,
  restoreAuthoringPrivateValues,
} from "./authoring-private-values";
import { randomUUID } from "node:crypto";
import {
  modelProposalSchema,
  type AuthoringBinding,
} from "../shared/chat-authoring";
import { nodeDefinitions } from "../shared/node-definitions";
import { flowSchema } from "../shared/validation";
import { childSpecs, validateFlow } from "../engine/validation";
import type { FlowDefinition, ValidationIssue } from "../shared/types";
import {
  parseAuthoringRecord,
  type AuthoringContext,
} from "./authoring-context";
export class AuthoringProposalError extends Error {}
export function normalizeAuthoringProposal(
  raw: unknown,
  context: AuthoringContext,
) {
  const result = modelProposalSchema.parse(raw);
  if (result.kind === "clarification") {
    if (result.graph !== null || !result.questions.length)
      throw new AuthoringProposalError("invalid-clarification");
    return {
      kind: "clarification" as const,
      explanation: result.explanation,
      questions: result.questions,
    };
  }
  if (!result.graph || result.questions.length)
    throw new AuthoringProposalError("invalid-proposal");
  const graph = result.graph,
    source = context.source;
  const exactRemovals = (
    declared: string[],
    previous: string[],
    retained: string[],
  ) => {
    const expected = previous.filter((id) => !retained.includes(id));
    if (
      new Set(declared).size !== declared.length ||
      expected.length !== declared.length ||
      declared.some((id) => !expected.includes(id))
    )
      throw new AuthoringProposalError("undeclared-removal");
  };
  exactRemovals(
    graph.removedNodeIds,
    source?.nodes.map((n) => n.id) ?? [],
    graph.nodes.map((n) => n.id),
  );
  exactRemovals(
    graph.removedEdgeIds,
    source?.edges.map((e) => e.id) ?? [],
    graph.edges.map((e) => e.id),
  );
  const issues: ValidationIssue[] = [];
  const problem = (message: string, nodeId?: string) =>
    issues.push({ severity: "error", message, ...(nodeId ? { nodeId } : {}) });
  const nodes = graph.nodes.map((node) => {
    let config = parseAuthoringRecord(node.configJson);
    const old = source?.nodes.find((n) => n.id === node.id);
    for (const protectedKey of ["command", "args", "frameId"])
      if (Object.hasOwn(config, protectedKey))
        problem(
          "Executable overrides and runtime frame identities are application-owned.",
          node.id,
        );
    if (config.detection !== undefined && typeof config.detection !== "string")
      problem(
        "Use a detector node reference instead of a fabricated runtime detection.",
        node.id,
      );
    for (const [key, selected] of [
      ["targetId", context.targets],
      ["connectionId", context.connections],
    ] as const) {
      const value = config[key];
      if (
        value !== undefined &&
        value !== "" &&
        (typeof value !== "string" || !selected.some((v) => v.id === value))
      ) {
        if (
          !old ||
          old.config[key] !== value ||
          typeof value !== "string" ||
          !value.includes("${")
        )
          problem(
            "Bind resource IDs to explicitly selected existing resources.",
            node.id,
          );
      }
    }
    // Keep user-authored launch overrides and stale frame fences out of the model
    // contract. Only unchanged retained node kinds may inherit those owned fields.
    if (old?.kind === node.kind)
      for (const key of ["command", "args", "frameId"])
        if (old.config[key] !== undefined)
          config[key] = structuredClone(old.config[key]);
    if (old?.kind === node.kind)
      config = restoreAuthoringPrivateValues(
        config,
        old.config,
      ) as typeof config;
    if (containsPrivatePlaceholder(config))
      problem(
        "Protected secret placeholders cannot become workflow values.",
        node.id,
      );
    return {
      id: node.id,
      kind: node.kind,
      label: node.label,
      position: old ? structuredClone(old.position) : { x: node.x, y: node.y },
      config,
      ...(old?.breakpoint !== undefined ? { breakpoint: old.breakpoint } : {}),
    };
  });
  const now = new Date().toISOString();
  const flow: FlowDefinition = flowSchema.parse({
    schemaVersion: 2,
    id: source?.id ?? randomUUID(),
    name: graph.name,
    description: graph.description,
    folder: source?.folder ?? "AI drafts",
    revision: source?.revision ?? 1,
    nodes,
    edges: graph.edges.map((e) => ({
      ...e,
      ...(!e.port ? { port: "next" } : {}),
    })),
    inputs: source
      ? restoreAuthoringPrivateValues(
          parseAuthoringRecord(graph.inputsJson),
          source.inputs,
        )
      : parseAuthoringRecord(graph.inputsJson),
    outputs: source
      ? restoreAuthoringPrivateValues(
          parseAuthoringRecord(graph.outputsJson),
          source.outputs,
        )
      : parseAuthoringRecord(graph.outputsJson),
    createdAt: source?.createdAt ?? now,
    updatedAt: now,
  });
  if (
    containsPrivatePlaceholder(flow.inputs) ||
    containsPrivatePlaceholder(flow.outputs)
  )
    problem(
      "Protected secret placeholders cannot become workflow interface values.",
    );
  for (const node of flow.nodes) {
    try {
      for (const spec of childSpecs(node))
        if (
          !context.children.some((f) => f.id === spec.flowId) ||
          !contextSelectedChild(context, spec.flowId)
        )
          problem(
            "Choose an explicitly selected existing child workflow.",
            node.id,
          );
    } catch {
      problem("Child workflow configuration is invalid.", node.id);
    }
  }
  const bindings: AuthoringBinding[] = [];
  const validationFlow = structuredClone(flow),
    targets = [...context.targets],
    connections = [...context.connections];
  const boundFields = new Set<string>();
  for (const binding of graph.bindings) {
    const node = validationFlow.nodes.find((n) => n.id === binding.nodeId),
      key = `${binding.nodeId}:${binding.field}`;
    if (
      !node ||
      boundFields.has(key) ||
      (node.config[binding.field] !== undefined &&
        node.config[binding.field] !== "")
    ) {
      problem(
        "Bindings must identify a unique empty resource field on an existing node.",
        binding.nodeId,
      );
      continue;
    }
    const requirements = nodeDefinitions[node.kind].requirements(node.config),
      id = randomUUID();
    if (binding.field === "targetId") {
      if (!requirements.target) {
        problem("This node does not accept an application binding.", node.id);
        continue;
      }
      targets.push({
        id,
        name: "Unbound validation target",
        kind: requirements.target.kinds[0],
      });
    } else {
      if (
        node.kind !== "ai" &&
        !(
          ["detect", "wait"].includes(node.kind) &&
          node.config.detector === "ai"
        )
      ) {
        problem("This node does not accept an AI connection binding.", node.id);
        continue;
      }
      connections.push({
        id,
        name: "Unbound validation connection",
        provider: "ollama",
        model: "unbound",
        baseUrl: "http://127.0.0.1",
        hasKey: false,
        capabilities: { text: true, vision: true, structured: true },
      });
    }
    boundFields.add(key);
    node.config[binding.field] = id;
    bindings.push({
      id: randomUUID(),
      nodeId: binding.nodeId,
      field: binding.field,
      hint: binding.hint,
    });
  }
  issues.push(
    ...validateFlow(validationFlow, [...context.children, validationFlow], {
      targets,
      connections,
      settings: {},
    }),
  );
  // Placeholders exist only in the validator copy. The returned candidate keeps
  // empty resource IDs and explicit app-owned binding receipts for C03 review.
  const bindingIssues = bindings.map((binding) => ({
    severity: "warning" as const,
    nodeId: binding.nodeId,
    message: `Bind an existing ${binding.field === "targetId" ? "application/browser target" : "AI connection"} before Apply.`,
  }));
  return {
    kind: "proposal" as const,
    flow,
    explanation: result.explanation,
    issues: [...issues, ...bindingIssues],
    bindings,
  };
}
function contextSelectedChild(context: AuthoringContext, id: string) {
  return context.selectedChildIds.includes(id);
}
export type NormalizedAuthoringProposal = ReturnType<
  typeof normalizeAuthoringProposal
>;
