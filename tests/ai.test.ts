import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { AIService, safeAIError } from "../src/integrations/ai";
import type { AIConnection, CaptureFrame } from "../src/shared/types";

const connection = (
  provider: AIConnection["provider"],
  overrides: Partial<AIConnection> = {},
): AIConnection => ({
  id: "connection",
  name: "Test model",
  provider,
  baseUrl:
    provider === "jev"
      ? "https://api.example.invalid"
      : "http://127.0.0.1:11434",
  model: "pinned-model",
  capabilities: { text: true, vision: true, structured: true },
  hasKey: provider !== "ollama",
  experimentalVision: true,
  ...overrides,
});
const frame: CaptureFrame = {
  id: "frame",
  targetId: "target",
  capturedAt: 1,
  width: 200,
  height: 100,
  dataUrl: `data:image/png;base64,${(
    await sharp({
      create: { width: 200, height: 100, channels: 3, background: "red" },
    })
      .png()
      .toBuffer()
  ).toString("base64")}`,
};
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
function mockFetch(body: unknown) {
  return vi.fn<typeof fetch>(async () => json(body));
}
function completion(content: string) {
  return {
    id: "completion",
    object: "chat.completion",
    created: 1,
    model: "fixture/vision-model",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
  };
}
const openrouter = () =>
  connection("openrouter", {
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1/",
    model: "fixture/vision-model",
  });

describe("bring-your-own AI adapters", () => {
  it("never uses a returned Jev box when the presence decision says absent or uncertain", async () => {
    for (const [probability, outcome] of [
      [0.01, "no-match"],
      [0.5, "uncertain"],
    ] as const) {
      const fetcher = mockFetch({
        answers: {
          present: { noul: probability },
          location: { box: { left: 0.2, right: 0.4, top: 0.3, bottom: 0.6 } },
        },
      });
      const service = new AIService(() => "test-key", fetcher);
      const result = await service.detect(connection("jev"), {
        prompt: "Find Save",
        frame,
        locate: true,
      });
      expect(result.outcome).toBe(outcome);
      expect(result.box).toBeUndefined();
      expect(result.frameId).toBe("frame");
      const body = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
      expect(body.questions.present.type).toBe("noul");
      expect(body.questions.location.type).toBe("box");
      expect(body.model).toBe("pinned-model");
      expect(
        new Headers(fetcher.mock.calls[0][1]?.headers).get(
          "TypeSafe-Danger-Zone-Images",
        ),
      ).toBe("true");
    }
  });

  it("maps validated Jev coordinates into their source frame and rejects invalid boxes/probabilities", async () => {
    const fetcher = mockFetch({
      answers: {
        present: { noul: 0.98 },
        location: {
          confidence: 0.97,
          box: {
            left: 60 / 280,
            right: 120 / 280,
            top: 110 / 280,
            bottom: 140 / 280,
          },
        },
      },
    });
    const service = new AIService(() => "test-key", fetcher);
    const result = await service.detect(connection("jev"), {
      prompt: "Find Save",
      frame,
      locate: true,
    });
    expect(result.outcome).toBe("match");
    expect(result.box).toMatchObject({ x: 20, y: 20, height: 30 });
    expect(result.box?.width).toBeCloseTo(60);
    fetcher.mockImplementationOnce(async () =>
      json({
        answers: {
          present: { noul: 0.98 },
          location: {
            confidence: 0.97,
            box: { left: 0.9, right: 0.1, top: 0, bottom: 1 },
          },
        },
      }),
    );
    await expect(
      service.detect(connection("jev"), {
        prompt: "Find Save",
        frame,
        locate: true,
      }),
    ).rejects.toThrow("invalid target box");
    fetcher.mockImplementationOnce(async () =>
      json({ answers: { present: { noul: 42 } } }),
    );
    await expect(
      service.detect(connection("jev"), { prompt: "Find Save", frame }),
    ).rejects.toThrow("invalid presence");
  });

  it("requires explicit experimental vision and capabilities before making requests", async () => {
    const fetcher = mockFetch({});
    const service = new AIService(() => "key", fetcher);
    await expect(
      service.detect(connection("jev", { experimentalVision: false }), {
        prompt: "Find Save",
        frame,
      }),
    ).rejects.toThrow("experimental vision");
    await expect(
      service.generate(
        connection("ollama", {
          capabilities: { text: true, vision: false, structured: true },
        }),
        { prompt: "Image", frame },
      ),
    ).rejects.toThrow("not configured for vision");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects zero-area or missing locations for matched visual targets", async () => {
    for (const box of [
      { x: 0.1, y: 0.2, width: 0, height: 0.3 },
      { x: 0.1, y: 0.2, width: 0.3, height: 0 },
      null,
    ]) {
      const fetcher = mockFetch({
        message: {
          content: JSON.stringify({
            outcome: "match",
            evidence: "Button is visible",
            box,
          }),
        },
      });
      const service = new AIService(() => undefined, fetcher);
      await expect(
        service.detect(connection("ollama"), {
          prompt: "Find Save",
          frame,
          locate: true,
        }),
      ).rejects.toThrow();
    }
  });

  it("validates Ollama structured data and uses only the configured local endpoint", async () => {
    const fetcher = mockFetch({ message: { content: '{"count":3}' } });
    const service = new AIService(() => undefined, fetcher);
    const local = connection("ollama", {
      baseUrl: "http://127.0.0.1:11434/v1",
    });
    const schema = {
      type: "object",
      required: ["count"],
      properties: { count: { type: "integer", minimum: 1 } },
      additionalProperties: false,
    };
    expect(
      await service.generate(local, {
        prompt: "Count",
        mode: "structured",
        schema,
      }),
    ).toEqual({ count: 3 });
    expect(fetcher.mock.calls[0][0]).toBe("http://127.0.0.1:11434/api/chat");
    expect(
      new Headers(fetcher.mock.calls[0][1]?.headers).has("Authorization"),
    ).toBe(false);
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body)).format).toEqual(
      schema,
    );
    fetcher.mockImplementationOnce(async () =>
      json({ message: { content: '{"count":"three"}' } }),
    );
    await expect(
      service.generate(local, { prompt: "Count", mode: "structured", schema }),
    ).rejects.toThrow("Invalid structured response");
    fetcher.mockImplementationOnce(async () =>
      json({ message: { content: "not-json" } }),
    );
    await expect(
      service.generate(local, { prompt: "Count", mode: "structured", schema }),
    ).rejects.toThrow();
  });

  it("reports an offline local server without retries or cloud fallback", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => {
      throw new TypeError("fetch failed: ECONNREFUSED");
    });
    const service = new AIService(() => undefined, fetcher);
    const result = await service.test(connection("ollama"));
    expect(result.ok).toBe(false);
    expect(result.message).toContain("ECONNREFUSED");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0][0])).toContain("127.0.0.1");
  });

  it("uses the configured OpenAI-compatible endpoint for LM Studio without requiring a key", async () => {
    const fetcher = mockFetch({
      id: "completion",
      object: "chat.completion",
      created: 1,
      model: "local-model",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Relay connected" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    });
    const service = new AIService(() => undefined, fetcher);
    const result = await service.generate(
      connection("lmstudio", {
        baseUrl: "http://localhost:1234/v1",
        hasKey: false,
      }),
      { prompt: "Hello", mode: "text" },
    );
    expect(result).toBe("Relay connected");
    expect(String(fetcher.mock.calls[0][0])).toBe(
      "http://localhost:1234/v1/chat/completions",
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("tests OpenRouter using the user's key, exact model and direct chat endpoint", async () => {
    const fetcher = mockFetch(completion("Relay connected"));
    const service = new AIService(() => "sk-or-v1-test-key", fetcher);
    expect(await service.test(openrouter())).toMatchObject({ ok: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, options] = fetcher.mock.calls[0];
    expect(String(url)).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(new Headers(options?.headers).get("Authorization")).toBe(
      "Bearer sk-or-v1-test-key",
    );
    const body = JSON.parse(String(options?.body));
    expect(body.model).toBe("fixture/vision-model");
    expect(body.provider).toEqual({ allow_fallbacks: false });
    expect(body.models).toBeUndefined();
    expect(body.messages[0]).toMatchObject({ role: "user" });
    expect(body.response_format).toBeUndefined();
  });

  it("sends OpenRouter screenshot data and strict JSON schema, then validates its response", async () => {
    const fetcher = mockFetch(completion('{"count":3}'));
    const service = new AIService(() => "test-key", fetcher);
    const schema = {
      type: "object",
      properties: { count: { type: "integer", minimum: 1 } },
      required: ["count"],
      additionalProperties: false,
    };
    const request = {
      prompt: "Count the buttons",
      mode: "structured" as const,
      schema,
      frame,
    };
    expect(await service.generate(openrouter(), request)).toEqual({ count: 3 });
    const body = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
    expect(body.messages[0].content).toEqual([
      { type: "text", text: "Count the buttons" },
      { type: "image_url", image_url: { url: frame.dataUrl } },
    ]);
    expect(body.response_format).toMatchObject({
      type: "json_schema",
      json_schema: { schema, strict: true },
    });
    expect(body.provider).toEqual({
      allow_fallbacks: false,
      require_parameters: true,
    });
    fetcher.mockImplementationOnce(async () =>
      json(completion('{"count":"three"}')),
    );
    await expect(service.generate(openrouter(), request)).rejects.toThrow();
  });

  it("rejects missing OpenRouter credentials and unsupported capabilities before sending captures", async () => {
    const fetcher = mockFetch({});
    expect(
      await new AIService(() => undefined, fetcher).test(openrouter()),
    ).toMatchObject({ ok: false, message: "Add an API key for OpenRouter." });
    const service = new AIService(() => "test-key", fetcher);
    await expect(
      service.generate(
        {
          ...openrouter(),
          capabilities: { text: true, vision: false, structured: true },
        },
        { prompt: "Find Save", mode: "vision", frame },
      ),
    ).rejects.toThrow("not configured for vision");
    await expect(
      service.generate(
        {
          ...openrouter(),
          capabilities: { text: true, vision: true, structured: false },
        },
        {
          prompt: "Find Save",
          mode: "vision",
          frame,
          schema: { type: "object" },
        },
      ),
    ).rejects.toThrow("does not support structured output");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reports OpenRouter authentication failures without retries, fallback or exposing the key", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      json(
        {
          error: { message: "Invalid API key sk-or-v1-test-secret", code: 401 },
        },
        401,
      ),
    );
    const service = new AIService(() => "sk-or-v1-test-secret", fetcher);
    const result = await service.test(openrouter());
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Invalid API key");
    expect(result.message).not.toContain("test-secret");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0][0])).toBe(
      "https://openrouter.ai/api/v1/chat/completions",
    );
  });

  it("propagates cancellation and cleans authentication details in errors", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>(
      async (_, options) =>
        new Promise((_, reject) =>
          options?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Cancelled", "AbortError")),
            { once: true },
          ),
        ),
    );
    const service = new AIService(() => undefined, fetcher);
    const pending = service.generate(connection("ollama"), {
      prompt: "Hello",
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toThrow("Cancelled");
    expect(
      safeAIError(
        new Error("Authorization Bearer secret-value; token sk-12345"),
      ),
    ).not.toContain("secret-value");
    expect(safeAIError(new Error("token sk-12345"))).not.toContain("sk-12345");
  });
});

describe("validated connection probes", () => {
  it("redacts long configured secrets before truncating probe errors", () => {
    const secret = "custom-secret-".repeat(100);
    expect(safeAIError(new Error(`Denied ${secret}`), secret)).toBe(
      "Denied [redacted]",
    );
  });
  it("rejects a text response that merely returned HTTP success", async () => {
    const service = new AIService(
      () => undefined,
      mockFetch({ message: { content: "Hello" } }),
    );
    expect(await service.test(connection("ollama"), "text")).toMatchObject({
      ok: false,
      status: "failed",
      operation: "text",
    });
  });
  it("runs a fresh Jev decision without claiming text or arbitrary schema generation", async () => {
    const fetcher = mockFetch({ answers: { present: { noul: 0.99 } } });
    const service = new AIService(() => "test-key", fetcher);
    const jev = connection("jev", {
      capabilities: { text: false, vision: false, structured: false },
    });
    expect(await service.test(jev, "decision")).toMatchObject({
      ok: true,
      status: "passed",
      operation: "decision",
    });
    expect(await service.test(jev, "text")).toMatchObject({
      ok: false,
      status: "unsupported",
    });
    expect(await service.test(jev, "structured")).toMatchObject({
      ok: false,
      status: "unsupported",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(
      service.generate(connection("jev"), {
        prompt: "schema",
        mode: "structured",
        schema: { type: "object" },
      }),
    ).rejects.toThrow("decision model");
  });
  it("validates structured probes and isolates image results", async () => {
    const fetcher = mockFetch({
      message: { content: JSON.stringify({ relay: "connected" }) },
    });
    const service = new AIService(() => undefined, fetcher),
      local = connection("ollama");
    expect(await service.test(local, "structured")).toMatchObject({
      ok: true,
      operation: "structured",
    });
    fetcher.mockImplementationOnce(async () =>
      json({ message: { content: "blue" } }),
    );
    expect(await service.test(local, "image")).toMatchObject({
      ok: false,
      status: "failed",
      operation: "image",
    });
    const body = JSON.parse(String(fetcher.mock.calls[1][1]?.body));
    expect(body.messages[0].images).toHaveLength(1);
    expect(body.options.num_predict).toBe(256);
  });
  it("requires a localization box overlapping the known synthetic target", async () => {
    const fetcher = mockFetch({
      message: {
        content: JSON.stringify({
          outcome: "match",
          evidence: "red",
          box: { x: 24 / 128, y: 40 / 128, width: 48 / 128, height: 32 / 128 },
        }),
      },
    });
    const service = new AIService(() => undefined, fetcher);
    const probe = await service.test(connection("ollama"), "localization");
    expect(probe, probe.message).toMatchObject({
      ok: true,
      operation: "localization",
    });
    fetcher.mockImplementationOnce(async () =>
      json({
        message: {
          content: JSON.stringify({
            outcome: "match",
            evidence: "red",
            box: { x: 0, y: 0, width: 1, height: 1 },
          }),
        },
      }),
    );
    expect(
      await service.test(connection("ollama"), "localization"),
    ).toMatchObject({ ok: false, status: "failed" });
  });
  it("never sends an unsupported operation or leaks a nonstandard API key", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => {
      throw new Error("Rejected secret-custom-credential");
    });
    const service = new AIService(() => "secret-custom-credential", fetcher);
    expect(
      await service.test(
        connection("ollama", {
          capabilities: { text: false, vision: false, structured: false },
        }),
        "image",
      ),
    ).toMatchObject({ status: "unsupported" });
    expect(fetcher).not.toHaveBeenCalled();
    const result = await service.test(openrouter(), "text");
    expect(result.status).toBe("failed");
    expect(result.message).not.toContain("secret-custom-credential");
  });
});
