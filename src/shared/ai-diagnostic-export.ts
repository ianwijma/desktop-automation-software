import type { AIConnection } from "./types";
import { aiCheckOperations, connectionCheckState } from "./ai-connections";
import { aiProbeDiagnosticsSchema, safeModelIdentity } from "./ai-diagnostics";
// Export only fixed metadata. Never spread stored checks, endpoints, names or provider payloads.
export function connectionDiagnosticExport(
  connection: AIConnection,
  secrets: readonly string[] = [],
) {
  const model = safeModelIdentity(connection.model, secrets);
  return {
    format: "relay-ai-diagnostics",
    version: 1,
    exportedAt: new Date().toISOString(),
    provider: connection.provider,
    ...(model ? { configuredModel: model } : {}),
    connectionRevision: connection.revision ?? 0,
    credentialRevision: connection.credentialRevision ?? 0,
    enabled: {
      text: connection.capabilities.text,
      vision: connection.capabilities.vision,
      structured: connection.capabilities.structured,
    },
    operations: aiCheckOperations.map((operation) => {
      const state = connectionCheckState(connection, operation),
        record = connection.checks?.[operation],
        parsed = aiProbeDiagnosticsSchema.safeParse(record?.diagnostics),
        d = parsed.success ? parsed.data : undefined;
      return {
        operation,
        state: state.status,
        ...(record &&
        /^\d{4}-\d{2}-\d{2}T/.test(record.at) &&
        Number.isFinite(Date.parse(record.at)) &&
        !secrets.some((secret) => secret && record.at.includes(secret))
          ? { at: record.at }
          : {}),
        ...(d
          ? {
              elapsedMs: d.elapsedMs,
              ...(safeModelIdentity(d.returnedModel, secrets)
                ? { returnedModel: safeModelIdentity(d.returnedModel, secrets) }
                : {}),
              ...(d.usage
                ? {
                    usage: {
                      inputTokens: d.usage.inputTokens,
                      outputTokens: d.usage.outputTokens,
                      totalTokens: d.usage.totalTokens,
                    },
                  }
                : {}),
              ...(d.errorCode ? { errorCode: d.errorCode } : {}),
              ...(d.httpStatus ? { httpStatus: d.httpStatus } : {}),
            }
          : {}),
      };
    }),
  };
}
