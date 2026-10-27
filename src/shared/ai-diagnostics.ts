import { z } from "zod";
export const diagnosticRequestIdSchema = z.string().uuid();
export const diagnosticErrorCodeSchema = z.enum([
  "cancelled",
  "timeout",
  "authentication",
  "rate-limit",
  "network",
  "invalid-response",
  "unsupported",
  "configuration",
  "provider",
]);
export type DiagnosticErrorCode = z.infer<typeof diagnosticErrorCodeSchema>;
export const aiProbeDiagnosticsSchema = z
  .object({
    provider: z.enum([
      "openai",
      "openrouter",
      "anthropic",
      "gemini",
      "ollama",
      "lmstudio",
      "jev",
    ]),
    requestedModel: z.string().max(200),
    returnedModel: z.string().max(200).optional(),
    elapsedMs: z.number().int().min(0).max(86400000),
    usage: z
      .object({
        inputTokens: z.number().int().min(0).max(1e12).optional(),
        outputTokens: z.number().int().min(0).max(1e12).optional(),
        totalTokens: z.number().int().min(0).max(1e12).optional(),
      })
      .strict()
      .optional(),
    errorCode: diagnosticErrorCodeSchema.optional(),
    httpStatus: z.number().int().min(100).max(599).optional(),
  })
  .strict();
export type AIProbeDiagnostics = z.infer<typeof aiProbeDiagnosticsSchema>;
export const advertisedCapabilitiesSchema = z
  .object({
    text: z.boolean().nullable(),
    vision: z.boolean().nullable(),
    structured: z.boolean().nullable(),
  })
  .strict();
export const openRouterModelSchema = z
  .object({
    id: z.string().min(1).max(200),
    name: z.string().max(160),
    contextLength: z.number().int().positive().max(1e9).optional(),
    advertised: advertisedCapabilitiesSchema,
  })
  .strict();
export type OpenRouterModel = z.infer<typeof openRouterModelSchema>;
export const openRouterCatalogSchema = z
  .object({
    version: z.literal(1),
    source: z.literal("https://openrouter.ai/api/v1/models"),
    fetchedAt: z.string().datetime(),
    models: z.array(openRouterModelSchema).max(20000),
  })
  .strict();
export type OpenRouterCatalog = z.infer<typeof openRouterCatalogSchema>;
export interface OpenRouterSearchResult {
  selected?: OpenRouterModel;
  models: OpenRouterModel[];
  total: number;
  matched: number;
  fetchedAt?: string;
  stale: boolean;
  error?: { code: DiagnosticErrorCode; message: string };
}
export const openRouterSearchOptionsSchema = z
  .object({
    refresh: z.boolean().optional(),
    selectedModel: z.string().max(200).optional(),
    requestId: diagnosticRequestIdSchema.optional(),
  })
  .strict();
export type OpenRouterSearchOptions = z.infer<
  typeof openRouterSearchOptionsSchema
>;
export const diagnosticMessages: Record<DiagnosticErrorCode, string> = {
  cancelled:
    "AI check cancelled. An already accepted provider request may still be billed.",
  timeout:
    "AI check timed out. Check the endpoint and model, including local-model startup time, then retry explicitly.",
  authentication:
    "Authentication failed. Replace the API key and check provider access to this model.",
  "rate-limit":
    "The provider rate or credit limit was reached. Check the account quota before retrying.",
  network:
    "The endpoint could not be reached. Check its address, network access, or local model server.",
  "invalid-response":
    "The model returned an invalid or unexpected probe response. Check support for this operation and the exact model ID.",
  unsupported:
    "The provider or model does not support this operation. Check the exact model ID and enabled capabilities, or choose a compatible model.",
  configuration:
    "The connection is incomplete or this operation is disabled. Check the saved endpoint, model, key and capability switches.",
  provider:
    "The provider could not complete this check. Check its service status and model availability; no fallback was attempted.",
};
export function safeModelIdentity(
  value: unknown,
  secrets: readonly string[] = [],
): string | undefined {
  if (
    typeof value !== "string" ||
    value.length > 200 ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_./:+-]*$/.test(value) ||
    value.includes("://") ||
    /(?:^|\/)sk-/.test(value) ||
    secrets.some((k) => k && value.includes(k))
  )
    return undefined;
  return value;
}
