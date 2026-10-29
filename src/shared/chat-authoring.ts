import { z } from "zod";
import { flowSchema } from "./validation";
import { nodeKinds } from "./node-definitions";
import type { AIProbeDiagnostics } from "./ai-diagnostics";
import type { FlowDefinition, ValidationIssue } from "./types";
export const authoringLimits = Object.freeze({
  nodes: 200,
  edges: 400,
  contextBytes: 256 * 1024,
  candidateBytes: 512 * 1024,
  providerBytes: 2 * 1024 * 1024,
  maxOutputTokens: 16384,
  timeoutMs: 90000,
  images: 4,
  imageBytes: 2 * 1024 * 1024,
});
const id = z.string().min(1).max(200);
const ids = z
  .array(id)
  .max(30)
  .refine((v) => new Set(v).size === v.length, "Selection IDs must be unique.");
export const authoringGraphSchema = flowSchema
  .pick({
    name: true,
    description: true,
    nodes: true,
    edges: true,
    inputs: true,
    outputs: true,
  })
  .extend({
    nodes: flowSchema.shape.nodes.max(200),
    edges: flowSchema.shape.edges.max(400),
  })
  .strict();
export const flowProposalRequestSchema = z
  .object({
    requestId: z.string().uuid(),
    sessionId: z.string().uuid(),
    connectionId: id,
    prompt: z.string().max(8000),
    attachmentIds: z
      .array(z.string().uuid())
      .max(4)
      .refine(
        (ids) => new Set(ids).size === ids.length,
        "Image IDs must be unique.",
      )
      .optional(),
    targetIds: ids,
    connectionIds: ids,
    childFlowIds: ids,
    source: z
      .object({
        flowId: id,
        expectedRevision: z.number().int().positive(),
        draft: authoringGraphSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type FlowProposalRequest = z.infer<typeof flowProposalRequestSchema>;
// Provider-portable schema: configurations/interfaces are bounded JSON strings,
// parsed and validated by application code. No app-owned flow metadata is accepted.
const graphId = id.refine(
  (value) => !["__proto__", "prototype", "constructor"].includes(value),
  "Unsafe graph identifier",
);
const modelGraphSchema = z
  .object({
    name: z.string().min(1).max(160),
    description: z.string().max(4000),
    nodes: z
      .array(
        z
          .object({
            id: graphId,
            kind: z.enum(nodeKinds),
            label: z.string().max(200),
            x: z.number().min(-1e6).max(1e6),
            y: z.number().min(-1e6).max(1e6),
            configJson: z.string().max(32768),
          })
          .strict(),
      )
      .min(2)
      .max(200),
    edges: z
      .array(
        z
          .object({
            id: graphId,
            source: graphId,
            target: graphId,
            port: z.string().max(80),
          })
          .strict(),
      )
      .max(400),
    inputsJson: z.string().max(32768),
    outputsJson: z.string().max(32768),
    bindings: z
      .array(
        z
          .object({
            nodeId: graphId,
            field: z.enum(["targetId", "connectionId"]),
            hint: z.string().min(1).max(200),
          })
          .strict(),
      )
      .max(200),
    removedNodeIds: z.array(graphId).max(200),
    removedEdgeIds: z.array(graphId).max(400),
  })
  .strict();
export const modelProposalSchema = z
  .object({
    kind: z.enum(["clarification", "proposal"]),
    explanation: z.string().min(1).max(4000),
    questions: z.array(z.string().min(1).max(1000)).max(5),
    graph: modelGraphSchema.nullable(),
  })
  .strict();
export type ModelProposal = z.infer<typeof modelProposalSchema>;
export type ProposalProgress = {
  requestId: string;
  sessionId: string;
  phase:
    | "preparing"
    | "generating"
    | "validating"
    | "completed"
    | "cancelled"
    | "rejected";
};
export type ProposalErrorCode =
  | "attachment"
  | "configuration"
  | "context-limit"
  | "invalid-output"
  | "invalid-graph"
  | "stale-context"
  | "provider"
  | "timeout"
  | "busy"
  | "duplicate-request"
  | "request-limit";
export interface AuthoringBinding {
  id: string;
  nodeId: string;
  field: "targetId" | "connectionId";
  hint: string;
}
export interface ProposalReceipt {
  requestId: string;
  sessionId: string;
  contextSha256?: string;
  /** App-owned references to the exact images explicitly selected for this turn. */
  attachmentIds?: string[];
  diagnostics?: AIProbeDiagnostics;
}
export type FlowProposalResult = ProposalReceipt &
  (
    | {
        status: "proposal";
        proposal: {
          id: string;
          createdAt: string;
          flow: FlowDefinition;
          explanation: string;
          issues: ValidationIssue[];
          requiresReview: true;
          bindings: AuthoringBinding[];
          source?: {
            flowId: string;
            baseRevision: number;
            graphSha256: string;
          };
        };
      }
    | { status: "clarification"; explanation: string; questions: string[] }
    | { status: "cancelled"; message: string }
    | {
        status: "rejected";
        code: ProposalErrorCode;
        message: string;
        issues?: ValidationIssue[];
      }
  );
/** Trusted normalized image content supplied by the attachment service, not runtime frame identities. */
export interface PreparedAuthoringImage {
  dataUrl: string;
  width: number;
  height: number;
}
export const proposalMessages: Record<ProposalErrorCode, string> = {
  attachment:
    "An attached image is unavailable or changed. Add it again or explicitly reuse it before Send.",
  configuration:
    "Select a text and structured-output connection, configure its key/model, and select existing resources. Images additionally require vision.",
  "context-limit":
    "The selected context or images exceed authoring limits. Reduce the graph, resource selection or message before sending again.",
  "invalid-output":
    "The model returned an invalid or truncated proposal. No workflow changed. Review the request and send again explicitly.",
  "invalid-graph":
    "The proposed graph did not pass workflow validation. No workflow changed. Review the reported issues before sending again.",
  "stale-context":
    "The selected connection, source workflow or dependency changed during generation. No workflow changed. Refresh the context before sending again.",
  provider:
    "The selected provider could not produce a proposal. Check its connection and model support; no fallback or automatic retry was made.",
  timeout:
    "Proposal generation timed out. No workflow changed. Check the model or reduce the context before sending again.",
  busy: "Four authoring requests are still active. Cancel or wait for them to settle before sending again.",
  "duplicate-request":
    "This Send request was already handled. It will not be sent to the provider again.",
  "request-limit":
    "The authoring request history limit was reached for this application session.",
};
