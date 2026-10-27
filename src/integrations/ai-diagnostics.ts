import { APICallError } from "ai";
import {
  diagnosticMessages,
  type DiagnosticErrorCode,
  type AIProbeDiagnostics,
  safeModelIdentity,
} from "../shared/ai-diagnostics";
export class ProbeResponseError extends Error {}
export class AIHTTPError extends Error {
  constructor(public readonly statusCode: number) {
    super(`AI provider returned HTTP ${statusCode}.`);
  }
}
export interface ResponseObservation {
  returnedModel?: string;
  usage?: AIProbeDiagnostics["usage"];
}
const count = (value: unknown) =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= 1e12
    ? value
    : undefined;
export function responseObservation(
  model: unknown,
  usage: {
    inputTokens?: unknown;
    outputTokens?: unknown;
    totalTokens?: unknown;
  },
  secret?: string,
): ResponseObservation {
  const values = {
    inputTokens: count(usage.inputTokens),
    outputTokens: count(usage.outputTokens),
    totalTokens: count(usage.totalTokens),
  };
  return {
    ...(safeModelIdentity(model, secret ? [secret] : [])
      ? { returnedModel: safeModelIdentity(model, secret ? [secret] : []) }
      : {}),
    ...(Object.values(values).some((v) => v !== undefined)
      ? { usage: values }
      : {}),
  };
}
export function sdkResponseObservation(
  provider: string,
  body: unknown,
  secret?: string,
): ResponseObservation {
  const value =
    body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const rawUsage = provider === "gemini" ? value.usageMetadata : value.usage;
  const usage =
    rawUsage && typeof rawUsage === "object"
      ? (rawUsage as Record<string, unknown>)
      : {};
  const counts =
    provider === "gemini"
      ? {
          inputTokens: usage.promptTokenCount,
          outputTokens: usage.candidatesTokenCount,
          totalTokens: usage.totalTokenCount,
        }
      : provider === "anthropic"
        ? { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens }
        : {
            inputTokens: usage.prompt_tokens,
            outputTokens: usage.completion_tokens,
            totalTokens: usage.total_tokens,
          };
  return responseObservation(
    provider === "gemini" ? value.modelVersion : value.model,
    counts,
    secret,
  );
}
export function diagnosticFailure(
  error: unknown,
  signal?: AbortSignal,
): { code: DiagnosticErrorCode; message: string; httpStatus?: number } {
  let code: DiagnosticErrorCode = "provider",
    status: number | undefined;
  if (error instanceof AIHTTPError) status = error.statusCode;
  else if (APICallError.isInstance(error)) {
    status = error.statusCode;
    if (status === undefined) code = "network";
  }
  if (signal?.aborted)
    code =
      signal.reason instanceof Error && signal.reason.name === "TimeoutError"
        ? "timeout"
        : "cancelled";
  else if (error instanceof Error && error.name === "TimeoutError")
    code = "timeout";
  else if (error instanceof Error && error.name === "AbortError")
    code = "cancelled";
  else if (status === 401 || status === 403) code = "authentication";
  else if (status === 429 || status === 402) code = "rate-limit";
  else if (status === 400 || status === 404 || status === 422)
    code = "unsupported";
  else if (status !== undefined) code = "provider";
  else if (
    error instanceof ProbeResponseError ||
    error instanceof SyntaxError ||
    (error instanceof Error &&
      [
        "ZodError",
        "AI_NoObjectGeneratedError",
        "AI_NoOutputGeneratedError",
        "AI_TypeValidationError",
        "AI_JSONParseError",
      ].includes(error.name))
  )
    code = "invalid-response";
  else if (error instanceof TypeError) code = "network";
  return {
    code,
    message: diagnosticMessages[code],
    ...(status && Number.isInteger(status) && status >= 100 && status <= 599
      ? { httpStatus: status }
      : {}),
  };
}
