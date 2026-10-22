import { z } from "zod";
import type { FlowDefinition, FlowSaveResult, TargetDescriptor } from "./types";
import { boundedJson, flowSchema, targetSchema } from "./validation";

export interface FlowBundle {
  flows: FlowDefinition[];
  targets: TargetDescriptor[];
  rootId: string;
}

/** Parse completely before the caller imports any member of a bundle. */
export function parseFlowBundle(value: unknown): FlowBundle {
  boundedJson(value);
  if (
    value &&
    typeof value === "object" &&
    ("flows" in value || "format" in value || "version" in value)
  ) {
    const bundle = z
      .object({
        format: z.literal("relay"),
        version: z.union([z.literal(1), z.literal(2)]),
        flows: z.array(z.unknown()).min(1).max(200),
        targets: z.array(z.unknown()).max(200).default([]),
        rootId: z.string().min(1).max(200).optional(),
      })
      .parse(value);
    const flows = bundle.flows.map(migrateFlow);
    const targets = bundle.targets.map((target) => targetSchema.parse(target));
    if (new Set(flows.map((flow) => flow.id)).size !== flows.length)
      throw new Error("Workflow IDs in a bundle must be unique.");
    if (new Set(targets.map((target) => target.id)).size !== targets.length)
      throw new Error("Target IDs in a bundle must be unique.");
    const rootId = bundle.rootId ?? flows[0].id;
    if (!flows.some((flow) => flow.id === rootId))
      throw new Error("The bundle root workflow does not exist.");
    return { flows, targets, rootId };
  }
  const flow = migrateFlow(value);
  return { flows: [flow], targets: [], rootId: flow.id };
}

/** Upgrade the envelope without changing node configuration or references. */
export function migrateFlow(value: unknown): FlowDefinition {
  if (
    value &&
    typeof value === "object" &&
    "schemaVersion" in value &&
    value.schemaVersion !== 1 &&
    value.schemaVersion !== 2
  )
    throw new Error(
      `Unsupported workflow schema version: ${String(value.schemaVersion)}`,
    );
  const flow = flowSchema.parse(value);
  return { ...flow, schemaVersion: 2 };
}

/** Pure compare-and-swap preparation; callers provide timestamps and commit. */
export function prepareFlowSave(
  flow: FlowDefinition,
  current: FlowDefinition | undefined,
  expectedRevision: number | null,
): FlowSaveResult {
  if (
    expectedRevision !== null &&
    (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
  )
    throw new Error("Expected revision must be a positive integer or null.");
  const proposed = migrateFlow(flow);
  const existing = current === undefined ? undefined : migrateFlow(current);
  if (existing && existing.id !== proposed.id)
    throw new Error(
      "The current workflow ID does not match the proposed workflow.",
    );
  if (expectedRevision === null) {
    if (existing)
      return {
        status: "conflict",
        current: existing,
        reason:
          "A workflow with this ID already exists. Reload it or save a copy.",
      };
    return { status: "saved", flow: { ...proposed, revision: 1 } };
  }
  if (!existing)
    return {
      status: "conflict",
      reason:
        "This workflow was deleted or is no longer available. Save a copy to keep your changes.",
    };
  if (existing.revision !== expectedRevision)
    return {
      status: "conflict",
      current: existing,
      reason:
        "This workflow changed after it was opened. Reload it or save a copy.",
    };
  if (!Number.isSafeInteger(existing.revision + 1))
    throw new Error("The workflow revision cannot be incremented safely.");
  return {
    status: "saved",
    flow: {
      ...proposed,
      revision: existing.revision + 1,
      createdAt: existing.createdAt,
    },
  };
}
