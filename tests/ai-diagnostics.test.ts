import { sdkResponseObservation } from "../src/integrations/ai-diagnostics";
import { connectionDiagnosticExport } from "../src/shared/ai-diagnostic-export";
import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { AIService, safeAIError } from "../src/integrations/ai";
import { DiagnosticRequests } from "../src/main/ai-diagnostic-requests";
import { openRouterCatalogSchema } from "../src/shared/ai-diagnostics";
import {
  OpenRouterDiscovery,
  normalizeOpenRouterModels,
} from "../src/integrations/openrouter-catalog";
import type { AIConnection } from "../src/shared/types";
const local: AIConnection = {
  id: "local",
  provider: "ollama",
  name: "Private name",
  baseUrl: "http://user:password@localhost:11434/?api_key=secret",
  model: "local:8b",
  capabilities: { text: true, vision: true, structured: true },
  hasKey: false,
  revision: 2,
  credentialRevision: 3,
};
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
const row = (id = "fixture/vision") => ({
  id,
  name: "Fixture model",
  architecture: {
    input_modalities: ["text", "image"],
    output_modalities: ["text"],
  },
  supported_parameters: ["structured_outputs"],
  context_length: 32000,
  description: "Never retain this prompt-like description",
  pricing: { prompt: "1" },
});
describe("AI diagnostics and cancellation", () => {
  it("does not echo malformed local-provider response content into workflow errors", async () => {
    const service = new AIService(
      () => undefined,
      vi.fn<typeof fetch>(
        async () => new Response("private-plain-key hidden prompt"),
      ),
    );
    let caught: unknown;
    try {
      await service.generate(local, { prompt: "fixture", mode: "text" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    expect(safeAIError(caught)).not.toContain("private-plain-key");
    expect(safeAIError(caught)).not.toContain("hidden prompt");
  });
  it("does not expose provider response bodies through workflow error formatting", async () => {
    const cloud = {
      ...local,
      provider: "openrouter" as const,
      baseUrl: "https://openrouter.ai/api/v1",
    };
    const service = new AIService(
      () => "private-custom-key",
      vi.fn<typeof fetch>(async () =>
        json(
          {
            error: {
              message: "Rejected private-custom-key hidden-private-prompt",
              code: 401,
            },
          },
          401,
        ),
      ),
    );
    let caught: unknown;
    try {
      await service.generate(cloud, { prompt: "fixture", mode: "text" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    expect(safeAIError(caught)).toContain("Authentication failed");
    expect(safeAIError(caught)).not.toContain("private-custom-key");
    expect(safeAIError(caught)).not.toContain("hidden-private-prompt");
  });
  it("does not invent missing model/usage fields from SDK defaults", async () => {
    const cloud = {
      ...local,
      provider: "openrouter" as const,
      baseUrl: "https://openrouter.ai/api/v1",
      model: "fixture/requested",
    };
    const fetcher = vi.fn<typeof fetch>(async () =>
      json({
        id: "fixture",
        object: "chat.completion",
        created: 1,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Relay connected" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 3 },
      }),
    );
    const result = await new AIService(() => "fixture-key", fetcher).test(
      cloud,
      "text",
    );
    expect(result.status).toBe("passed");
    expect(result.diagnostics?.requestedModel).toBe("fixture/requested");
    expect(result.diagnostics?.returnedModel).toBeUndefined();
    expect(result.diagnostics?.usage).toEqual({
      inputTokens: 3,
      outputTokens: undefined,
      totalTokens: undefined,
    });
    expect(
      sdkResponseObservation("gemini", {
        modelVersion: "gemini/fixture",
        usageMetadata: { promptTokenCount: 3 },
      }),
    ).toMatchObject({
      returnedModel: "gemini/fixture",
      usage: { inputTokens: 3 },
    });
    expect(
      sdkResponseObservation("anthropic", {
        model: "claude/fixture",
        usage: { input_tokens: 2, output_tokens: 4 },
      }),
    ).toMatchObject({
      returnedModel: "claude/fixture",
      usage: { inputTokens: 2, outputTokens: 4 },
    });
  });
  it("records Jev decision identity and usage without generic schema support", async () => {
    const jev = {
      ...local,
      provider: "jev" as const,
      model: "jev/pinned",
      baseUrl: "https://fixture.invalid",
      capabilities: { text: false, vision: false, structured: false },
    };
    const result = await new AIService(
      () => "fixture-key",
      vi.fn<typeof fetch>(async () =>
        json({
          model: "jev/actual",
          usage: { input_tokens: 5, output_tokens: 1 },
          answers: { present: { noul: 0.99 } },
        }),
      ),
    ).test(jev, "decision");
    expect(result).toMatchObject({
      status: "passed",
      diagnostics: {
        requestedModel: "jev/pinned",
        returnedModel: "jev/actual",
        usage: { inputTokens: 5, outputTokens: 1 },
      },
    });
  });
  it("records returned model, bounded usage and duration through the actual Ollama adapter", async () => {
    const service = new AIService(
      () => undefined,
      vi.fn<typeof fetch>(async () =>
        json({
          model: "actual:8b",
          message: { content: "Relay connected" },
          prompt_eval_count: 3,
          eval_count: 2,
          raw: "secret",
        }),
      ),
    );
    const result = await service.test(local, "text");
    expect(result.status).toBe("passed");
    expect(result.diagnostics).toMatchObject({
      provider: "ollama",
      requestedModel: "local:8b",
      returnedModel: "actual:8b",
      usage: { inputTokens: 3, outputTokens: 2 },
    });
    expect(result.diagnostics?.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(result)).not.toContain('"raw"');
  });
  it("cancels the provider request and never accepts a late successful response after cancellation", async () => {
    let release!: () => void;
    const fetcher = vi.fn<typeof fetch>(async () => {
      await new Promise<void>((r) => {
        release = r;
      });
      return json({ message: { content: "Relay connected" } });
    });
    const controller = new AbortController(),
      pending = new AIService(() => undefined, fetcher).test(
        local,
        "text",
        controller.signal,
      );
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    controller.abort();
    release();
    expect(await pending).toMatchObject({
      ok: false,
      status: "cancelled",
      diagnostics: { errorCode: "cancelled" },
    });
  });
  it("uses actionable allowlisted failures without echoing arbitrary provider errors", async () => {
    for (const [status, code] of [
      [401, "authentication"],
      [429, "rate-limit"],
      [503, "provider"],
    ] as const) {
      const result = await new AIService(
        () => "secret-value",
        vi.fn<typeof fetch>(async () =>
          json({ error: { message: "secret-value hidden prompt" } }, status),
        ),
      ).test(local, "text");
      expect(result.diagnostics).toMatchObject({
        errorCode: code,
        httpStatus: status,
      });
      expect(result.message).not.toContain("secret-value");
      expect(result.message).not.toContain("hidden prompt");
    }
  });
  it("keeps cancellation scoped to active IDs and enforces a concurrency bound", () => {
    const requests = new DiagnosticRequests(),
      id = randomUUID(),
      first = requests.start(id, "a"),
      second = requests.start(randomUUID(), "b");
    expect(requests.cancel(id)).toBe(true);
    expect(first.controller.signal.aborted).toBe(true);
    expect(second.controller.signal.aborted).toBe(false);
    requests.finish(id, first);
    expect(requests.cancel(id)).toBe(false);
    expect(requests.cancelConnection("b")).toHaveLength(1);
    expect(second.controller.signal.aborted).toBe(true);
    requests.start(randomUUID());
    requests.start(randomUUID());
    requests.start(randomUUID());
    expect(() => requests.start(randomUUID())).toThrow("Four diagnostics");
  });
  it("exports fixed metadata, excluding endpoints, names, messages, prompts, images, raw values and known secrets", () => {
    const connection = {
      ...local,
      checks: {
        text: {
          operation: "text" as const,
          status: "passed" as const,
          at: new Date().toISOString(),
          message: "secret-message prompt data:image/png;base64,xxx",
          connectionRevision: 2,
          credentialRevision: 3,
          diagnostics: {
            provider: "ollama" as const,
            requestedModel: "local:8b",
            returnedModel: "secret-model",
            elapsedMs: 5,
            usage: { inputTokens: 3, outputTokens: 2 },
          },
        },
      },
    };
    const report = connectionDiagnosticExport(connection, ["secret-model"]),
      text = JSON.stringify(report);
    expect(report.operations[0]).toMatchObject({
      operation: "text",
      state: "passed",
      elapsedMs: 5,
      usage: { inputTokens: 3, outputTokens: 2 },
    });
    for (const secret of [
      "password",
      "secret-message",
      "secret-model",
      "data:image",
      "Private name",
      "baseUrl",
      "localhost",
      "message",
      "requestedModel",
    ])
      expect(text).not.toContain(secret);
    expect(
      connectionDiagnosticExport(
        { ...connection, model: "https://user:password@localhost" },
        [],
      ),
    ).not.toHaveProperty("configuredModel");
  });
});
describe("bounded OpenRouter discovery", () => {
  it("maps advertised capabilities without retaining descriptions or turning JSON mode into strict schema support", () => {
    const models = normalizeOpenRouterModels({
      data: [
        row(),
        { ...row("fixture/json"), supported_parameters: ["response_format"] },
        { id: "fixture/unknown" },
      ],
    });
    expect(models.find((m) => m.id === "fixture/vision")?.advertised).toEqual({
      text: true,
      vision: true,
      structured: true,
    });
    expect(
      models.find((m) => m.id === "fixture/json")?.advertised.structured,
    ).toBe(false);
    expect(models.find((m) => m.id === "fixture/unknown")?.advertised).toEqual({
      text: null,
      vision: null,
      structured: null,
    });
    expect(JSON.stringify(models)).not.toContain("description");
    expect(JSON.stringify(models)).not.toContain("pricing");
  });
  it("makes no request for cached/manual search, fetches the fixed public endpoint without credentials, and labels stale cache", async () => {
    let cache: unknown;
    let now = Date.parse("2026-10-27T00:00:00Z");
    const fetcher = vi.fn<typeof fetch>(async () => json({ data: [row()] }));
    const discovery = new OpenRouterDiscovery(
      () => cache,
      (c) => {
        cache = c;
      },
      fetcher,
      () => now,
    );
    expect((await discovery.search("manual")).models).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
    const fresh = await discovery.search("vision", true);
    expect(fresh.models).toHaveLength(1);
    expect(fresh.stale).toBe(false);
    expect(fetcher.mock.calls[0][0]).toBe(
      "https://openrouter.ai/api/v1/models",
    );
    expect(
      new Headers(fetcher.mock.calls[0][1]?.headers).has("authorization"),
    ).toBe(false);
    expect(fetcher.mock.calls[0][1]?.credentials).toBe("omit");
    expect(openRouterCatalogSchema.safeParse(cache).success).toBe(true);
    now += 86400001;
    expect((await discovery.search("vision")).stale).toBe(true);
    fetcher.mockImplementationOnce(async () => {
      throw new TypeError("secret-failure");
    });
    const offline = await discovery.search("vision", true);
    expect(offline.models).toHaveLength(1);
    expect(offline.stale).toBe(true);
    expect(offline.error?.message).not.toContain("secret-failure");
  });
  it("reads the selected model metadata independently of the search filter", async () => {
    let cache: unknown;
    const discovery = new OpenRouterDiscovery(
      () => cache,
      (c) => {
        cache = c;
      },
      vi.fn<typeof fetch>(async () =>
        json({ data: [row("fixture/text"), row("fixture/vision")] }),
      ),
    );
    const result = await discovery.search(
      "text",
      true,
      undefined,
      "fixture/vision",
    );
    expect(result.models.map((m) => m.id)).toEqual(["fixture/text"]);
    expect(result.selected?.id).toBe("fixture/vision");
  });
  it("rejects overlarge/malformed responses and ignores cancelled/superseded refresh results", async () => {
    let cache: unknown;
    let release!: (r: Response) => void;
    const slow = vi.fn<typeof fetch>(
      async () =>
        new Promise<Response>((r) => {
          release = r;
        }),
    );
    const discovery = new OpenRouterDiscovery(
        () => cache,
        (c) => {
          cache = c;
        },
        slow,
      ),
      controller = new AbortController();
    const pending = discovery.search("", true, controller.signal);
    await vi.waitFor(() => expect(slow).toHaveBeenCalledTimes(1));
    controller.abort();
    release(json({ data: [row()] }));
    expect((await pending).error?.code).toBe("cancelled");
    expect(cache).toBeUndefined();
    slow.mockImplementationOnce(
      async () =>
        new Response("{}", {
          headers: { "content-length": String(9 * 1024 * 1024) },
        }),
    );
    expect((await discovery.search("", true)).error?.code).toBe(
      "invalid-response",
    );
    expect(cache).toBeUndefined();
    slow.mockImplementationOnce(
      async () => new Response(new Uint8Array(8 * 1024 * 1024 + 1)),
    );
    expect((await discovery.search("", true)).error?.code).toBe(
      "invalid-response",
    );
    expect(cache).toBeUndefined();
    slow.mockImplementationOnce(async () => json({ data: "invalid" }));
    expect((await discovery.search("", true)).error?.code).toBe(
      "invalid-response",
    );
    let releaseOld!: (r: Response) => void;
    slow.mockImplementationOnce(
      async () =>
        new Promise<Response>((r) => {
          releaseOld = r;
        }),
    );
    const old = discovery.search("", true);
    await vi.waitFor(() => expect(releaseOld).toBeDefined());
    slow.mockImplementationOnce(async () => json({ data: [row("new/model")] }));
    await discovery.search("", true);
    releaseOld(json({ data: [row("old/model")] }));
    await old;
    expect((await discovery.search("")).models.map((m) => m.id)).toEqual([
      "new/model",
    ]);
  });
});
