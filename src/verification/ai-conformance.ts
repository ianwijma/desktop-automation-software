import { AIService } from "../integrations/ai";
import {
  diagnosticFailure,
  type ResponseObservation,
} from "../integrations/ai-diagnostics";
import {
  aiProbeDiagnosticsSchema,
  safeModelIdentity,
  type AIProbeDiagnostics,
} from "../shared/ai-diagnostics";
import {
  conformanceConfigSchema,
  casesFor,
  configurationIdentity,
  connectionFor,
  exactLocalRuntime,
  notSelected,
  unsupportedCase,
} from "./ai-conformance-config";
import {
  conformanceImage,
  visualOutcomeValid,
  visualPrompt,
} from "./ai-conformance-images";
export type ConformanceStatus =
  "pass" | "fail" | "skip" | "not-run" | "unsupported";
export interface ConformanceCaseReport {
  id: string;
  kind: string;
  operation: string;
  status: ConformanceStatus;
  reason?: string;
  requests: number;
  firstRequest?: string;
  diagnostics?: AIProbeDiagnostics;
  fixture?: {
    sha256: string;
    width: number;
    height: number;
    expected: string;
    outcome?: string;
  };
}
export interface ConformanceReport {
  schemaVersion: 1;
  live: boolean;
  startedAt: string;
  finishedAt?: string;
  scope: "selected-configurations-and-synthetic-fixtures-only";
  status: "pass-selected" | "incomplete" | "fail";
  limits: {
    maxRequests: number;
    requestTimeoutMs: number;
    totalTimeoutMs: number;
    maxOutputTokens: 256;
    retries: 0;
    maxResponseBytes: number;
  };
  requests: number;
  profiles: Array<{
    id: string;
    provider: string;
    configuredModel: string;
    tokenCapApplied: boolean;
    configurationSha256: string;
    runtime?: {
      name: string;
      version: string;
      modelRevision: string;
      source: "operator-attested";
    };
    cases: ConformanceCaseReport[];
    unselectedOperations: string[];
  }>;
}
const MAX_BYTES = 8 * 1024 * 1024;
class ConformanceBoundaryError extends Error {}
async function boundedResponse(response: Response, signal: AbortSignal) {
  if (Number(response.headers.get("content-length")) > MAX_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new ConformanceBoundaryError("response-size-limit");
  }
  if (!response.body) return response;
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BYTES)
        throw new ConformanceBoundaryError("response-size-limit");
      chunks.push(value);
    }
    signal.throwIfAborted();
    return new Response(Buffer.concat(chunks), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
function scrub<T>(value: T, secrets: string[]): T {
  const clean = (v: unknown): unknown =>
    typeof v === "string"
      ? secrets.reduce((s, key) => s.split(key).join("[redacted]"), v)
      : Array.isArray(v)
        ? v.map(clean)
        : v && typeof v === "object"
          ? Object.fromEntries(
              Object.entries(v).map(([k, item]) => [k, clean(item)]),
            )
          : v;
  return clean(value) as T;
}
export async function runAIConformance(
  input: unknown,
  options: {
    enabled: boolean;
    env?: Record<string, string | undefined>;
    fetcher?: typeof fetch;
    signal?: AbortSignal;
  },
) {
  const config = conformanceConfigSchema.parse(input);
  const env = options.env ?? {},
    secrets = [
      ...new Set(
        config.profiles.flatMap((p) =>
          p.keyEnv && env[p.keyEnv]?.trim() ? [env[p.keyEnv]!.trim()] : [],
        ),
      ),
    ];
  const report: ConformanceReport = {
    schemaVersion: 1,
    live: options.enabled,
    startedAt: new Date().toISOString(),
    scope: "selected-configurations-and-synthetic-fixtures-only",
    status: "incomplete",
    limits: {
      maxRequests: config.maxRequests,
      requestTimeoutMs: config.requestTimeoutMs,
      totalTimeoutMs: config.totalTimeoutMs,
      maxOutputTokens: 256,
      retries: 0,
      maxResponseBytes: MAX_BYTES,
    },
    requests: 0,
    profiles: [],
  };
  const totalSignal = options.signal
    ? AbortSignal.any([
        options.signal,
        AbortSignal.timeout(config.totalTimeoutMs),
      ])
    : AbortSignal.timeout(config.totalTimeoutMs);
  for (const profile of config.profiles) {
    const key = profile.keyEnv ? env[profile.keyEnv]?.trim() : undefined;
    const connection = connectionFor(profile);
    const entry: ConformanceReport["profiles"][number] = {
      id: profile.id,
      provider: profile.provider,
      configuredModel: profile.model,
      tokenCapApplied: profile.provider !== "jev",
      configurationSha256: configurationIdentity(scrub(profile, secrets)),
      ...(profile.runtime
        ? {
            runtime: {
              ...profile.runtime,
              source: "operator-attested" as const,
            },
          }
        : {}),
      cases: [],
      unselectedOperations: notSelected(profile),
    };
    report.profiles.push(entry);
    for (const scenario of casesFor(profile)) {
      const row: ConformanceCaseReport = {
        id: scenario.id,
        kind: scenario.kind,
        operation: scenario.operation,
        status: "not-run",
        requests: 0,
        ...(scenario.firstRequest
          ? { firstRequest: scenario.firstRequest }
          : {}),
      };
      entry.cases.push(row);
      const skip = (reason: string, status: ConformanceStatus = "skip") => {
        row.status = status;
        row.reason = reason;
      };
      if (!options.enabled) {
        skip("explicit-opt-in-required", "not-run");
        continue;
      }
      if (!key && !["ollama", "lmstudio"].includes(profile.provider)) {
        skip("missing-key");
        continue;
      }
      if (profile.keyEnv && !key) {
        skip("missing-key");
        continue;
      }
      if (!exactLocalRuntime(profile)) {
        skip("exact-local-runtime-and-model-revision-required");
        continue;
      }
      if (unsupportedCase(profile, scenario)) {
        skip("operation-not-enabled-or-supported", "unsupported");
        continue;
      }
      if (totalSignal.aborted) {
        skip("run-deadline-or-cancellation");
        continue;
      }
      if (report.requests >= config.maxRequests) {
        skip("request-budget-exhausted");
        continue;
      }
      const cancel = new AbortController(),
        signal = AbortSignal.any([
          cancel.signal,
          totalSignal,
          AbortSignal.timeout(config.requestTimeoutMs),
        ]);
      let boundaryReason: string | undefined;
      // Ollama's production adapter accepts /v1 or /api aliases but calls
      // the native /api/chat endpoint on that same explicitly chosen server.
      const base = new URL(
        profile.provider === "ollama"
          ? profile.baseUrl.replace(/\/(?:v1|api)\/?$/, "").replace(/\/$/, "")
          : profile.baseUrl,
      );
      const boundedFetch: typeof fetch = async (input, init) => {
        signal.throwIfAborted();
        const url = new URL(
          typeof input === "string" || input instanceof URL ? input : input.url,
        );
        const method = (
          init?.method ?? (input instanceof Request ? input.method : "GET")
        ).toUpperCase();
        const prefix = base.pathname.replace(/\/$/, "");
        if (
          url.origin !== base.origin ||
          url.username ||
          url.password ||
          (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) ||
          method !== "POST"
        ) {
          boundaryReason = "request-outside-explicit-endpoint";
          throw new ConformanceBoundaryError(boundaryReason);
        }
        if (row.requests >= 1 || report.requests >= config.maxRequests) {
          boundaryReason = "request-budget-exhausted";
          throw new ConformanceBoundaryError(boundaryReason);
        }
        row.requests++;
        report.requests++;
        try {
          return await boundedResponse(
            await (options.fetcher ?? fetch)(input, {
              ...init,
              redirect: "error",
              signal: init?.signal
                ? AbortSignal.any([signal, init.signal])
                : signal,
            }),
            signal,
          );
        } catch (error) {
          if (error instanceof ConformanceBoundaryError)
            boundaryReason = error.message;
          throw error;
        }
      };
      let observation: ResponseObservation = {},
        timer: ReturnType<typeof setTimeout> | undefined,
        cancellationRequested = false;
      const started = performance.now();
      const service = new AIService(
        () => key,
        boundedFetch,
        (v) => {
          observation = v;
        },
      );
      const diagnostics = (extra: Partial<AIProbeDiagnostics> = {}) =>
        aiProbeDiagnosticsSchema.parse({
          provider: profile.provider,
          requestedModel: profile.model,
          elapsedMs: Math.max(0, Math.round(performance.now() - started)),
          ...observation,
          ...extra,
        });
      try {
        if (scenario.kind === "cancellation")
          timer = setTimeout(() => {
            cancellationRequested = true;
            cancel.abort();
          }, scenario.afterMs);
        if (scenario.kind === "visual") {
          const fixture = await conformanceImage(scenario.visual!);
          row.fixture = {
            sha256: fixture.sha256,
            width: fixture.frame.width,
            height: fixture.frame.height,
            expected: fixture.expected,
          };
          signal.throwIfAborted();
          const result = await service.detect(connection, {
            prompt: visualPrompt,
            mode: "vision",
            frame: fixture.frame,
            locate: true,
            threshold: 0.85,
            locationThreshold: 0.85,
            signal,
            maxOutputTokens: 256,
          });
          signal.throwIfAborted();
          row.fixture.outcome = result.outcome;
          row.status = visualOutcomeValid(fixture, result) ? "pass" : "fail";
          if (row.status === "fail") row.reason = "visual-expectation-not-met";
          row.diagnostics = diagnostics();
        } else {
          const result = await service.test(
            connection,
            scenario.operation,
            signal,
          );
          if (result.diagnostics)
            row.diagnostics = aiProbeDiagnosticsSchema.parse(
              result.diagnostics,
            );
          if (scenario.kind === "cancellation") {
            if (
              result.status === "cancelled" &&
              cancellationRequested &&
              row.requests === 1
            )
              row.status = "pass";
            else if (result.status === "passed")
              skip("request-completed-before-cancellation");
            else if (result.status === "cancelled" && row.requests === 0)
              skip("cancelled-before-provider-dispatch");
            else {
              row.status = "fail";
              row.reason = "requested-cancellation-not-observed";
            }
          } else {
            row.status = result.status === "passed" ? "pass" : "fail";
            if (row.status === "fail")
              row.reason = result.diagnostics?.errorCode ?? "probe-failed";
          }
        }
        if (row.requests === 0 && row.status === "pass") {
          row.status = "fail";
          row.reason = "no-provider-request-observed";
        }
        if (boundaryReason) {
          row.status = "fail";
          row.reason = boundaryReason;
        }
      } catch (error) {
        const failure = diagnosticFailure(error, signal);
        row.status = "fail";
        row.reason = boundaryReason ?? failure.code;
        row.diagnostics = diagnostics({
          errorCode: failure.code,
          ...(failure.httpStatus ? { httpStatus: failure.httpStatus } : {}),
        });
      } finally {
        if (timer) clearTimeout(timer);
      }
      // Unknown/unsafe returned identities never enter reports, even from a provider.
      if (
        row.diagnostics?.returnedModel &&
        !safeModelIdentity(row.diagnostics.returnedModel, secrets)
      )
        delete row.diagnostics.returnedModel;
    }
  }
  const statuses = report.profiles.flatMap((p) => p.cases.map((c) => c.status));
  report.status = statuses.includes("fail")
    ? "fail"
    : statuses.length && statuses.every((s) => s === "pass")
      ? "pass-selected"
      : "incomplete";
  report.finishedAt = new Date().toISOString();
  return scrub(report, secrets);
}
