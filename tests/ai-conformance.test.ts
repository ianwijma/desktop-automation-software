import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { runAIConformance } from "../src/verification/ai-conformance";
import {
  type ConformanceProfile,
  visualCases,
} from "../src/verification/ai-conformance-config";
import {
  conformanceImage,
  visualOutcomeValid,
} from "../src/verification/ai-conformance-images";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const profile = (
  provider: ConformanceProfile["provider"] = "ollama",
  overrides: Partial<ConformanceProfile> = {},
): ConformanceProfile => ({
  id: provider,
  provider,
  model: "fixture-model-pinned",
  baseUrl: "http://127.0.0.1:11434/v1",
  capabilities: { text: true, vision: true, structured: true },
  operations: ["text"],
  visualCases: [],
  runtime: {
    name: "fixture-runtime",
    version: "1.2.3",
    modelRevision: "sha256:fixture-model-hash",
  },
  experimentalVision: true,
  ...(["ollama", "lmstudio"].includes(provider)
    ? {}
    : { keyEnv: "RELAY_FIXTURE_KEY" }),
  ...overrides,
});
const config = (
  profiles = [profile()],
  overrides: Record<string, unknown> = {},
) => ({
  version: 1,
  maxRequests: 30,
  requestTimeoutMs: 500,
  totalTimeoutMs: 10000,
  profiles,
  ...overrides,
});
const completion = (content: string) => ({
  id: "fixture",
  object: "chat.completion",
  created: 1,
  model: "actual-returned-model",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
});
const env = { RELAY_FIXTURE_KEY: "private-conformance-credential" };
const options = (fetcher: typeof fetch, enabled = true) => ({
  enabled,
  env,
  fetcher,
});
describe("opt-in AI conformance safety and evidence", () => {
  it("makes no requests by default and distinguishes no-run, missing credentials, and missing exact local identity", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const disabled = await runAIConformance(config(), options(fetcher, false));
    expect(disabled).toMatchObject({
      live: false,
      status: "incomplete",
      requests: 0,
    });
    expect(disabled.profiles[0].cases[0]).toMatchObject({
      status: "not-run",
      reason: "explicit-opt-in-required",
    });
    const missing = await runAIConformance(
      config([
        profile("openrouter"),
        profile("ollama", { runtime: undefined }),
      ]),
      { enabled: true, env: {}, fetcher },
    );
    expect(missing.profiles.map((p) => p.cases[0].reason)).toEqual([
      "missing-key",
      "exact-local-runtime-and-model-revision-required",
    ]);
    expect(missing.status).toBe("incomplete");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("rejects unbounded plans, duplicate IDs, implicit models, insecure endpoints and embedded credentials before fetching", async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const invalid of [
      config(undefined, { maxRequests: 101 }),
      config(undefined, { requestTimeoutMs: 20001 }),
      config([profile(), profile()]),
      config([profile("ollama", { model: "YOUR_EXACT_MODEL_ID" })]),
      config([profile("ollama", { baseUrl: "http://remote.invalid/api" })]),
      config([
        profile("ollama", {
          baseUrl: "https://user:private@example.invalid/v1",
        }),
      ]),
      config([
        profile("ollama", {
          baseUrl: "https://example.invalid/v1?api_key=private",
        }),
      ]),
      config([profile("openai", { visualCases: ["absent"] })]),
      config([profile("ollama", { operations: ["text", "text"] })]),
    ]) {
      await expect(
        runAIConformance(invalid, options(fetcher)),
      ).rejects.toThrow();
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("uses all seven production adapters and reports actual identity/usage without raw payloads", async () => {
    const providers = [
      "openai",
      "openrouter",
      "anthropic",
      "gemini",
      "ollama",
      "lmstudio",
      "jev",
    ] as const;
    for (const provider of providers) {
      const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
        expect(init?.redirect).toBe("error");
        const body = JSON.parse(String(init?.body));
        expect(body.model ?? String(_input)).toContain("fixture-model-pinned");
        if (provider === "jev")
          return json({
            model: "actual-returned-model",
            usage: { input_tokens: 3, output_tokens: 2 },
            answers: { present: { noul: 0.99 } },
            private: "hidden-raw-body",
          });
        if (provider === "ollama")
          return json({
            model: "actual-returned-model",
            message: { content: "Relay connected" },
            prompt_eval_count: 3,
            eval_count: 2,
            private: "hidden-raw-body",
          });
        if (provider === "anthropic")
          return json({
            id: "fixture",
            type: "message",
            role: "assistant",
            model: "actual-returned-model",
            content: [{ type: "text", text: "Relay connected" }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 3, output_tokens: 2 },
          });
        if (provider === "gemini")
          return json({
            candidates: [
              {
                content: {
                  role: "model",
                  parts: [{ text: "Relay connected" }],
                },
                finishReason: "STOP",
                index: 0,
              },
            ],
            modelVersion: "actual-returned-model",
            usageMetadata: {
              promptTokenCount: 3,
              candidatesTokenCount: 2,
              totalTokenCount: 5,
            },
          });
        return json(completion("Relay connected"));
      });
      const report = await runAIConformance(
        config([
          profile(provider, {
            operations: [provider === "jev" ? "decision" : "text"],
          }),
        ]),
        options(fetcher),
      );
      expect(report.status, JSON.stringify(report)).toBe("pass-selected");
      expect(report.requests).toBe(1);
      expect(report.profiles[0].cases[0].diagnostics).toMatchObject({
        returnedModel: "actual-returned-model",
        usage: { inputTokens: 3, outputTokens: 2 },
      });
      expect(report.profiles[0].unselectedOperations).toHaveLength(4);
      const serialized = JSON.stringify(report);
      expect(serialized).not.toContain("Relay connected");
      expect(serialized).not.toContain("hidden-raw-body");
      expect(serialized).not.toContain("127.0.0.1");
      expect(serialized).not.toContain(env.RELAY_FIXTURE_KEY);
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
  it("exercises each enabled local operation through the production protocol with a fixed output bound", async () => {
    for (const provider of ["ollama", "lmstudio"] as const) {
      const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
        const body = JSON.parse(String(init?.body));
        expect(
          provider === "ollama" ? body.options.num_predict : body.max_tokens,
        ).toBe(256);
        const prompt =
          typeof body.messages[0].content === "string"
            ? body.messages[0].content
            : body.messages[0].content[0].text;
        const content = prompt.includes("single color")
          ? "red"
          : prompt.startsWith("Return")
            ? '{"relay":"connected"}'
            : prompt.includes("Decide whether")
              ? JSON.stringify({
                  outcome: "match",
                  evidence: "fixture",
                  box: prompt.includes("red rectangle")
                    ? {
                        x: 60 / 320,
                        y: 100 / 320,
                        width: 120 / 320,
                        height: 80 / 320,
                      }
                    : null,
                })
              : "Relay connected";
        return provider === "ollama"
          ? json({ model: "actual-model", message: { content } })
          : json(completion(content));
      });
      const report = await runAIConformance(
        config([
          profile(provider, {
            operations: [
              "text",
              "structured",
              "decision",
              "image",
              "localization",
            ],
          }),
        ]),
        options(fetcher),
      );
      expect(report.status, JSON.stringify(report)).toBe("pass-selected");
      expect(report.requests).toBe(5);
      expect(fetcher).toHaveBeenCalledTimes(5);
    }
  });
  it("never retries failures or spends past the global request budget and leaves untested rows unverified", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      json({ error: "private-conformance-credential hidden response" }, 503),
    );
    const report = await runAIConformance(
      config([profile("ollama", { operations: ["text", "structured"] })], {
        maxRequests: 1,
      }),
      options(fetcher),
    );
    expect(report.status).toBe("fail");
    expect(report.requests).toBe(1);
    expect(report.profiles[0].cases.map((c) => c.status)).toEqual([
      "fail",
      "skip",
    ]);
    expect(report.profiles[0].cases[1].reason).toBe("request-budget-exhausted");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(report)).not.toContain("hidden response");
    const unsupported = await runAIConformance(
      config([profile("jev", { operations: ["text"] })]),
      options(fetcher),
    );
    expect(unsupported.status).toBe("incomplete");
    expect(unsupported.requests).toBe(0);
  });
  it("reports cancellation after dispatch and never promotes a late successful response", async () => {
    let calls = 0;
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      calls++;
      if (calls === 1) return json({ message: { content: "Relay connected" } });
      await new Promise<void>((resolve) =>
        init!.signal!.addEventListener("abort", () => resolve(), {
          once: true,
        }),
      );
      return json({ message: { content: "Relay connected" } });
    });
    const report = await runAIConformance(
      config([
        profile("ollama", { cancellation: { operation: "text", afterMs: 15 } }),
      ]),
      options(fetcher),
    );
    expect(report.status).toBe("pass-selected");
    expect(report.requests).toBe(2);
    expect(report.profiles[0].cases[1]).toMatchObject({
      status: "pass",
      requests: 1,
      diagnostics: { errorCode: "cancelled" },
    });
    const fast = await runAIConformance(
      config([
        profile("ollama", { cancellation: { operation: "text", afterMs: 15 } }),
      ]),
      options(async () => json({ message: { content: "Relay connected" } })),
    );
    expect(fast.status).toBe("incomplete");
    expect(fast.profiles[0].cases[1].reason).toBe(
      "request-completed-before-cancellation",
    );
  });
  it("bounds cold-start and run deadlines without restarting servers or silently skipping their failure", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async (_input, init) =>
        new Promise((_resolve, reject) =>
          init!.signal!.addEventListener(
            "abort",
            () => reject(init!.signal!.reason),
            { once: true },
          ),
        ),
    );
    const report = await runAIConformance(
      config(
        [
          profile("ollama", {
            operations: ["text", "structured"],
            coldStartExpected: true,
          }),
        ],
        { requestTimeoutMs: 100, totalTimeoutMs: 100 },
      ),
      options(fetcher),
    );
    expect(report.status).toBe("fail");
    expect(report.profiles[0].cases[0]).toMatchObject({
      status: "fail",
      firstRequest: "operator-expects-cold-start",
      diagnostics: { errorCode: "timeout" },
    });
    expect(report.profiles[0].cases[1]).toMatchObject({
      status: "skip",
      reason: "run-deadline-or-cancellation",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("records malformed output, unavailable servers and oversized provider bodies safely", async () => {
    for (const fetcher of [
      async () => new Response("private-conformance-credential broken JSON"),
      async () => {
        throw new TypeError("unavailable private-conformance-credential");
      },
      async () =>
        new Response("x", {
          headers: { "content-length": String(9 * 1024 * 1024) },
        }),
      async () => new Response(new Uint8Array(8 * 1024 * 1024 + 1)),
    ]) {
      const report = await runAIConformance(config(), options(fetcher));
      expect(report.status).toBe("fail");
      expect(report.requests).toBe(1);
      expect(JSON.stringify(report)).not.toContain(env.RELAY_FIXTURE_KEY);
      expect(JSON.stringify(report)).not.toContain("broken JSON");
    }
  });
  it("handles whole-run cancellation without starting another case", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn<typeof fetch>();
    const report = await runAIConformance(config(), {
      ...options(fetcher),
      signal: controller.signal,
    });
    expect(report.status).toBe("incomplete");
    expect(report.requests).toBe(0);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("redacts credential-like returned identities and operator labels without exporting keys or raw errors", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      json({
        model: env.RELAY_FIXTURE_KEY,
        message: { content: "Relay connected" },
        prompt_eval_count: 3,
      }),
    );
    const report = await runAIConformance(
      config([
        profile("ollama", {
          keyEnv: "RELAY_FIXTURE_KEY",
          id: env.RELAY_FIXTURE_KEY,
        }),
      ]),
      options(fetcher),
    );
    expect(report.status).toBe("pass-selected");
    expect(JSON.stringify(report)).not.toContain(env.RELAY_FIXTURE_KEY);
    expect(
      report.profiles[0].cases[0].diagnostics?.returnedModel,
    ).toBeUndefined();
  });
});
describe("synthetic Jev visual conformance", () => {
  it("generates deterministic image identities across themes/scales and refuses unsafe or inaccurate localization", async () => {
    const hashes = new Set();
    for (const name of visualCases) {
      const fixture = await conformanceImage(name),
        again = await conformanceImage(name);
      expect(fixture.sha256).toBe(again.sha256);
      hashes.add(fixture.sha256);
      const meta = await sharp(
        Buffer.from(fixture.frame.dataUrl.split(",")[1], "base64"),
      ).metadata();
      expect(meta.width).toBe(fixture.frame.width);
      expect(meta.height).toBe(fixture.frame.height);
      const { data, info } = await sharp(
        Buffer.from(fixture.frame.dataUrl.split(",")[1], "base64"),
      )
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const scale = fixture.frame.width / 480;
      const pixel = (x: number, y: number) => [
        ...data.subarray(
          (y * scale * info.width + x * scale) * info.channels,
          (y * scale * info.width + x * scale) * info.channels + 3,
        ),
      ];
      const background = name.startsWith("dark")
        ? [23, 24, 28]
        : [255, 255, 255];
      expect(pixel(10, 10)).toEqual(background);
      expect(pixel(180, 135)).toEqual(
        ["absent", "obscured"].includes(name) ? background : [34, 211, 238],
      );
      expect(pixel(380, 235)).toEqual(
        name === "duplicate" ? [34, 211, 238] : background,
      );
      const positive = fixture.expected === "unique-target";
      expect(
        visualOutcomeValid(fixture, {
          outcome: "match",
          evidence: "fixture",
          box: fixture.box,
        }),
      ).toBe(positive);
      expect(
        visualOutcomeValid(fixture, {
          outcome: "uncertain",
          evidence: "fixture",
        }),
      ).toBe(!positive);
      expect(
        visualOutcomeValid(fixture, {
          outcome: "match",
          evidence: "fixture",
          box: {
            x: 0,
            y: 0,
            width: fixture.frame.width,
            height: fixture.frame.height,
          },
        }),
      ).toBe(false);
    }
    expect(hashes.size).toBe(7);
  });
  it("evaluates all visual cases through the real Jev image preparation and adapter, without saving images", async () => {
    let index = -1;
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.questions.present.type).toBe("noul");
      if (!body.assets) return json({ answers: { present: { noul: 0.99 } } });
      index++;
      const visual = visualCases[index],
        positive = index < 4;
      const fixture = await conformanceImage(visual);
      const scale = fixture.frame.width / 480;
      // These fixtures are already within Jev's supported dimensions; no
      // resize or padding is required. Coordinates describe the source image.
      const asset = Object.values(body.assets)[0] as { data_base64: string };
      const metadata = await sharp(
        Buffer.from(asset.data_base64, "base64"),
      ).metadata();
      expect(metadata.width).toBe(fixture.frame.width);
      expect(metadata.height).toBe(fixture.frame.height);
      const w = fixture.frame.width,
        h = fixture.frame.height;
      return json({
        model: "returned-jev",
        answers: {
          present: { noul: positive ? 0.99 : 0.01 },
          location: {
            confidence: 0.98,
            box: {
              left: (100 * scale) / w,
              right: (260 * scale) / w,
              top: (90 * scale) / h,
              bottom: (180 * scale) / h,
            },
          },
        },
      });
    });
    const report = await runAIConformance(
      config([
        profile("jev", {
          operations: ["decision"],
          visualCases: [...visualCases],
        }),
      ]),
      options(fetcher),
    );
    expect(report.status, JSON.stringify(report)).toBe("pass-selected");
    expect(report.requests).toBe(8);
    expect(report.profiles[0].cases.filter((c) => c.fixture)).toHaveLength(7);
    expect(JSON.stringify(report)).not.toContain("data:image");
    expect(JSON.stringify(report)).not.toContain("evidence");
  });
});
