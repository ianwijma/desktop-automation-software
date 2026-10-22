import { describe, expect, it } from "vitest";
import {
  nodeDefinitions,
  nodeKinds,
  nodeOutputPorts,
  type ValidationContext,
} from "../src/shared/node-definitions";
import type { AIConnection, Json, NodeKind } from "../src/shared/types";

const connection: AIConnection = {
  id: "model",
  name: "Local model",
  provider: "ollama",
  model: "local",
  baseUrl: "http://localhost:11434",
  hasKey: false,
  capabilities: { text: true, vision: true, structured: true },
};
const context: ValidationContext = {
  targets: [
    { id: "desktop", name: "Editor", kind: "desktop" },
    { id: "browser", name: "Web", kind: "browser", browserMode: "managed" },
  ],
  connections: [connection],
  settings: {
    defaultTextConnection: "model",
    defaultVisionConnection: "model",
  },
};
const messages = (
  kind: NodeKind,
  config: Record<string, Json>,
  ctx?: ValidationContext,
) =>
  nodeDefinitions[kind]
    .validateConfig(config, ctx)
    .map((issue) => issue.message)
    .join("; ");

describe("shared node definitions", () => {
  it("supplies complete metadata and the runtime branch vocabulary", () => {
    expect(new Set(nodeKinds).size).toBe(nodeKinds.length);
    expect(Object.keys(nodeDefinitions).sort()).toEqual([...nodeKinds].sort());
    for (const kind of nodeKinds) {
      const definition = nodeDefinitions[kind];
      expect(definition.label).toBeTruthy();
      expect(definition.fields).toBeInstanceOf(Array);
      expect(definition.outputs).toBeInstanceOf(Array);
      expect(definition).not.toHaveProperty("icon");
    }
    expect(nodeOutputPorts("detect")).toEqual([
      "match",
      "no-match",
      "uncertain",
      "next",
      "error",
    ]);
    expect(nodeOutputPorts("condition")).toEqual(["true", "false", "error"]);
    expect(nodeOutputPorts("end")).toEqual([]);
    expect(
      nodeDefinitions.detect.outputs.find((output) => output.path === "box"),
    ).toMatchObject({ type: "object", optional: true });
  });

  it.each([
    ["wait", { ms: "125", adapterExtension: true }],
    ["set", { name: "answer", value: { nested: [1, true] } }],
    ["click", { targetId: "browser", selector: "button", x: 0, y: 0 }],
    ["loop", { flowId: "child", count: "3", maxIterations: 5, inputs: {} }],
    ["loop", { flowId: "child", items: [1, 2], count: -1, maxIterations: 5 }],
    [
      "ai",
      { prompt: "Summarize", mode: "structured", schema: '{"type":"object"}' },
    ],
  ] satisfies [NodeKind, Record<string, Json>][])(
    "preserves compatible %s configurations and advanced fields",
    (kind, config) => {
      expect(messages(kind, config, context)).toBe("");
    },
  );

  it.each([
    ["wait", { ms: -1 }, "ms"],
    ["set", { variable: "constructor" }, "safe"],
    ["condition", { operator: "gt", left: "12", right: 2 }, "numbers"],
    ["loop", { count: 4, maxIterations: 3 }, "count"],
    ["loop", { items: [1, 2], maxIterations: 1 }, "bound"],
    ["group", { concurrency: 0 }, "concurrency"],
    ["detect", { detector: "color", color: "red" }, "#RRGGBB"],
    ["detect", { detector: "change", threshold: 2 }, "threshold"],
    ["detect", { detector: "image", template: "not-an-image" }, "PNG"],
    ["detect", { region: { x: 0, y: 0, width: 0, height: 20 } }, "width"],
    ["ai", { mode: "structured", schema: "[]" }, "schema"],
    ["key", { action: "toggle" }, "action"],
  ] satisfies [NodeKind, Record<string, Json>, string][])(
    "rejects invalid literal %s configuration",
    (kind, config, fragment) => {
      expect(messages(kind, config)).toContain(fragment);
    },
  );

  it("defers references until resolution without allowing the resolved value to bypass validation", () => {
    expect(
      messages("wait", {
        durationMs: "1${inputs.delay}",
        timeoutMs: "${vars.timeout}",
      }),
    ).toBe("");
    expect(
      messages("group", {
        mode: "${inputs.mode}",
        concurrency: "${inputs.size}",
      }),
    ).toBe("");
    expect(messages("group", { mode: "pool", concurrency: 500 })).toContain(
      "concurrency",
    );
    expect(
      messages("loop", { count: 2000, maxIterations: "${inputs.limit}" }),
    ).toBe("");
    expect(messages("loop", { count: 2000, maxIterations: 20000 })).toContain(
      "maxIterations",
    );
  });

  it("keeps injectable adapters possible while checking application requirements with context", () => {
    expect(messages("ai", {})).toBe("");
    expect(messages("key", {})).toBe("");
    expect(messages("ai", {}, context)).toContain("prompt");
    expect(messages("key", {}, context)).toContain("key");
    expect(messages("click", {}, context)).toContain("target");
    expect(messages("click", { targetId: "missing" }, context)).toContain(
      "Target not found",
    );
    expect(messages("click", { targetId: "${inputs.target}" }, context)).toBe(
      "",
    );
  });

  it("rejects incompatible target and location modes, retaining coordinates beneath selectors", () => {
    expect(messages("read", { targetId: "desktop" }, context)).toContain(
      "browser target",
    );
    expect(
      messages(
        "detect",
        { detector: "element", selector: "button", targetId: "desktop" },
        context,
      ),
    ).toContain("browser target");
    expect(
      messages("click", { targetId: "desktop", selector: "button" }, context),
    ).toContain("browser target");
    expect(
      messages(
        "click",
        {
          targetId: "browser",
          selector: "button",
          detection: "${nodes.detect}",
        },
        context,
      ),
    ).toContain("one location source");
    expect(
      messages(
        "click",
        { targetId: "browser", selector: "button", x: 5, y: 5 },
        context,
      ),
    ).toBe("");
    expect(
      messages(
        "launch",
        { targetId: "browser", command: "/bin/editor" },
        context,
      ),
    ).toContain("desktop executable");
  });

  it("resolves configured defaults and verifies AI connection capabilities", () => {
    expect(messages("ai", { prompt: "Summarize" }, context)).toBe("");
    expect(
      messages("ai", { prompt: "Summarize", connectionId: "deleted" }, context),
    ).toContain("not found");
    expect(
      messages("ai", { prompt: "Summarize" }, { connections: [connection] }),
    ).toContain("set its default");
    const textOnly = {
      ...context,
      connections: [
        {
          ...connection,
          capabilities: { text: true, vision: false, structured: false },
        },
      ],
    };
    expect(
      messages(
        "ai",
        { prompt: "Describe", mode: "vision", targetId: "desktop" },
        textOnly,
      ),
    ).toContain("vision");
    expect(
      messages(
        "detect",
        { prompt: "Is it ready?", detector: "ai", targetId: "desktop" },
        textOnly,
      ),
    ).toContain("structured output");
    expect(
      messages(
        "ai",
        { prompt: "Describe", mode: "${inputs.mode}" },
        { ...context, settings: { defaultVisionConnection: "model" } },
      ),
    ).toBe("");
  });

  it("models detector waits and Jev's dedicated vision capability", () => {
    expect(nodeDefinitions.wait.requirements({ durationMs: 5 })).toEqual({
      capabilities: [],
    });
    expect(
      nodeDefinitions.wait.requirements({ detector: "element" }),
    ).toMatchObject({ target: { kinds: ["browser"], required: true } });
    const jev = {
      ...context,
      connections: [
        {
          ...connection,
          provider: "jev" as const,
          experimentalVision: true,
          capabilities: { text: false, vision: true, structured: false },
        },
      ],
    };
    expect(
      messages(
        "wait",
        { detector: "ai", prompt: "Ready?", targetId: "desktop", pollMs: 50 },
        jev,
      ),
    ).toBe("");
    expect(
      messages(
        "wait",
        {
          detector: "element",
          selector: "#ready",
          targetId: "browser",
          pollIntervalMs: -1,
        },
        context,
      ),
    ).toContain("pollIntervalMs");
  });
});
