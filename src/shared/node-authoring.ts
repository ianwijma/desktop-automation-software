import type { Json, NodeKind } from "./types";

type Config = Record<string, Json>;
const detectorFields = [
  "detector",
  "targetId",
  "region",
  "threshold",
  "template",
  "text",
  "prompt",
  "color",
  "language",
  "watchId",
  "selector",
  "locator",
  "nativeLocator",
  "connectionId",
  "locate",
];
const detectorOnlyFields: Record<string, readonly string[]> = {
  template: ["image"],
  text: ["text"],
  prompt: ["text", "ai"],
  color: ["color"],
  language: ["text"],
  watchId: ["change"],
  selector: ["element"],
  locator: ["element"],
  nativeLocator: ["element"],
  connectionId: ["ai"],
  locate: ["ai"],
  threshold: ["image", "color", "change", "ai"],
  region: ["image", "text", "color", "change", "ai"],
};
const detectorKinds = ["image", "text", "color", "change", "element", "ai"];

/** Explicit edits normalize only known aliases and conflicting active options. */
export function updateNodeConfig(
  kind: NodeKind,
  config: Config,
  key: string,
  value: Json | undefined,
): Config {
  const next = { ...config, ...(value === undefined ? {} : { [key]: value }) };
  if (value === undefined) delete next[key];
  const aliases =
    kind === "set"
      ? [["variable", "name"]]
      : kind === "wait"
        ? [
            ["durationMs", "ms"],
            ["pollIntervalMs", "pollMs"],
          ]
        : [];
  for (const pair of aliases)
    if (pair.includes(key))
      for (const alias of pair) if (alias !== key) delete next[alias];
  if (kind === "condition" && key === "operator" && value === "truthy")
    delete next.right;
  if (kind === "loop") {
    if (key === "items") delete next.count;
    if (key === "count") delete next.items;
  }
  if (kind === "group") {
    if (key === "children") delete next.flowIds;
    if (key === "flowIds") delete next.children;
  }
  if (kind === "ai" && key === "mode") {
    if (value === "text" || value === "structured") delete next.targetId;
    if (value === "text") delete next.schema;
    if (value === "structured" && next.schema === undefined)
      next.schema = {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      };
  }
  if (kind === "detect" || kind === "wait") {
    if (
      key === "detector" &&
      typeof value === "string" &&
      detectorKinds.includes(value)
    ) {
      for (const [field, methods] of Object.entries(detectorOnlyFields))
        if (!methods.includes(value)) delete next[field];
      // Change detection measures a changed fraction rather than confidence.
      if (
        value !== config.detector &&
        (value === "change" || config.detector === "change")
      )
        delete next.threshold;
      if (kind === "wait") {
        delete next.durationMs;
        delete next.ms;
      }
    }
    if (
      (next.detector ?? (kind === "detect" ? "text" : undefined)) === "text"
    ) {
      if (key === "text") delete next.prompt;
      if (key === "prompt") delete next.text;
    }
  }
  return next;
}

/** Call only when the user explicitly selects the wait mode, never while rendering. */
export function setWaitMode(
  config: Config,
  mode: "duration" | "detector",
): Config {
  if (mode === "duration") {
    const next: Config = {
      ...config,
      durationMs: config.durationMs ?? config.ms ?? 1000,
    };
    for (const field of [
      ...detectorFields,
      "ms",
      "timeoutMs",
      "pollIntervalMs",
      "pollMs",
    ])
      delete next[field];
    return next;
  }
  const next = updateNodeConfig(
    "wait",
    config,
    "detector",
    config.detector || "text",
  );
  delete next.durationMs;
  delete next.ms;
  next.timeoutMs ??= 30000;
  next.pollIntervalMs ??= next.pollMs ?? 500;
  delete next.pollMs;
  return next;
}

/** Switching loop modes preserves child mappings, bounds, and unknown extensions. */
export function setLoopMode(config: Config, mode: "count" | "foreach"): Config {
  return mode === "count"
    ? updateNodeConfig("loop", config, "count", config.count ?? 3)
    : updateNodeConfig("loop", config, "items", config.items ?? []);
}
