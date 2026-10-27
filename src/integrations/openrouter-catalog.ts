import {
  openRouterCatalogSchema,
  openRouterModelSchema,
  type OpenRouterCatalog,
  type OpenRouterModel,
  type OpenRouterSearchResult,
} from "../shared/ai-diagnostics";
import { AIHTTPError, diagnosticFailure } from "./ai-diagnostics";
const source = "https://openrouter.ai/api/v1/models";
const MAX_BYTES = 8 * 1024 * 1024;
export function normalizeOpenRouterModels(value: unknown): OpenRouterModel[] {
  if (
    !value ||
    typeof value !== "object" ||
    !Array.isArray((value as { data?: unknown }).data)
  )
    throw new SyntaxError("Invalid catalog");
  const rows = (value as { data: unknown[] }).data;
  if (rows.length > 20000) throw new SyntaxError("Catalog limit exceeded");
  const models = new Map<string, OpenRouterModel>();
  const strings = (v: unknown) =>
    Array.isArray(v) &&
    v.length <= 200 &&
    v.every((x) => typeof x === "string" && x.length <= 100)
      ? (v as string[])
      : undefined;
  for (const entry of rows) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>,
      architecture =
        row.architecture && typeof row.architecture === "object"
          ? (row.architecture as Record<string, unknown>)
          : {};
    const inputs = strings(architecture.input_modalities),
      outputs = strings(architecture.output_modalities),
      parameters = strings(row.supported_parameters);
    const text =
      inputs && outputs
        ? inputs.includes("text") && outputs.includes("text")
        : null;
    const parsed = openRouterModelSchema.safeParse({
      id: row.id,
      name:
        typeof row.name === "string"
          ? row.name.slice(0, 160)
          : typeof row.id === "string"
            ? row.id
            : "",
      ...(typeof row.context_length === "number" &&
      Number.isSafeInteger(row.context_length) &&
      row.context_length > 0 &&
      row.context_length <= 1e9
        ? { contextLength: row.context_length }
        : {}),
      advertised: {
        text,
        vision:
          inputs && outputs
            ? inputs.includes("image") && outputs.includes("text")
            : null,
        structured: parameters
          ? parameters.includes("structured_outputs")
          : null,
      },
    });
    if (parsed.success) models.set(parsed.data.id, parsed.data);
  }
  if (rows.length && !models.size) throw new SyntaxError("Invalid catalog");
  return [...models.values()].sort((a, b) => a.id.localeCompare(b.id));
}
async function boundedJSON(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  if (!response.ok) throw new AIHTTPError(response.status);
  if (Number(response.headers.get("content-length")) > MAX_BYTES)
    throw new SyntaxError("Catalog too large");
  if (!response.body) throw new SyntaxError("Empty catalog");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BYTES) throw new SyntaxError("Catalog too large");
      chunks.push(value);
    }
    signal.throwIfAborted();
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export class OpenRouterDiscovery {
  private generation = 0;
  private failure?: OpenRouterSearchResult["error"];
  constructor(
    private read: () => unknown,
    private write: (catalog: OpenRouterCatalog) => void,
    private fetcher: typeof fetch = fetch,
    private now: () => number = Date.now,
  ) {}
  async search(
    query: string,
    refresh = false,
    externalSignal?: AbortSignal,
    selectedModel?: string,
  ): Promise<OpenRouterSearchResult> {
    if (refresh) {
      const generation = ++this.generation,
        signal = externalSignal
          ? AbortSignal.any([externalSignal, AbortSignal.timeout(15000)])
          : AbortSignal.timeout(15000);
      try {
        const response = await this.fetcher(source, {
          method: "GET",
          redirect: "error",
          credentials: "omit",
          signal,
          headers: { Accept: "application/json" },
        });
        const models = normalizeOpenRouterModels(
          await boundedJSON(response, signal),
        );
        signal.throwIfAborted();
        if (generation === this.generation) {
          this.write({
            version: 1,
            source,
            fetchedAt: new Date(this.now()).toISOString(),
            models,
          });
          this.failure = undefined;
        }
      } catch (error) {
        if (generation === this.generation) {
          const failure = diagnosticFailure(error, signal);
          this.failure = {
            code: failure.code,
            message:
              failure.code === "cancelled"
                ? "Model refresh cancelled. Cached metadata is unchanged."
                : "Model refresh failed. Check network access or try again later; manual model IDs remain available.",
          };
        }
      }
    }
    const parsed = openRouterCatalogSchema.safeParse(this.read()),
      catalog = parsed.success ? parsed.data : undefined;
    const needle = query.trim().toLowerCase(),
      all = catalog?.models ?? [],
      matches = all.filter((m) =>
        `${m.id} ${m.name}`.toLowerCase().includes(needle),
      );
    const age = catalog ? this.now() - Date.parse(catalog.fetchedAt) : Infinity;
    return {
      models: matches.slice(0, 50),
      ...(all.some((m) => m.id === selectedModel)
        ? { selected: all.find((m) => m.id === selectedModel) }
        : {}),
      total: all.length,
      matched: matches.length,
      ...(catalog ? { fetchedAt: catalog.fetchedAt } : {}),
      stale:
        !catalog ||
        age < 0 ||
        age > 24 * 60 * 60 * 1000 ||
        Boolean(this.failure && this.failure.code !== "cancelled"),
      ...(this.failure ? { error: this.failure } : {}),
    };
  }
}
