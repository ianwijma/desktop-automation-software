import type {
  AIConnection,
  AppSettings,
  Json,
  NodeKind,
  TargetDescriptor,
  ValidationIssue,
} from "./types";
import { nativeLocatorSchema } from "./native-locators";
import { browserLocatorSchema } from "./browser-locators";

/** Shared by the editor, import/preflight validation and runtime; no renderer dependencies. */
export const nodeKinds = [
  "start",
  "end",
  "launch",
  "attach",
  "focus",
  "close",
  "click",
  "move",
  "drag",
  "scroll",
  "type",
  "key",
  "navigate",
  "read",
  "select",
  "tab",
  "screenshot",
  "detect",
  "wait",
  "condition",
  "set",
  "loop",
  "ai",
  "call",
  "group",
] as const satisfies readonly NodeKind[];
export interface FieldSpec {
  key: string;
  label: string;
  type?:
    | "text"
    | "number"
    | "textarea"
    | "target"
    | "connection"
    | "flow"
    | "select"
    | "json"
    | "value"
    | "boolean"
    | "image";
  placeholder?: string;
  options?: string[];
  help?: string;
  /** False for structural fields that must remain literal in the authoring UI. */
  reference?: boolean;
}
export interface ValidationContext {
  targets?: TargetDescriptor[];
  connections?: AIConnection[];
  settings?: Pick<
    AppSettings,
    "defaultTextConnection" | "defaultVisionConnection"
  >;
}
export interface OutputSpec {
  /** Empty path describes the complete node result; dotted paths describe its members. */
  path: string;
  type: "json" | "string" | "number" | "boolean" | "object" | "array" | "null";
  description: string;
  optional?: boolean;
}
export type CapabilityRequirement =
  | "accessibility"
  | "input"
  | "capture"
  | "browser"
  | "ai.text"
  | "ai.vision"
  | "ai.structured";
export interface NodeRequirements {
  target?: { kinds: TargetDescriptor["kind"][]; required: boolean };
  capabilities: CapabilityRequirement[];
}
interface DefinitionMetadata {
  label: string;
  description: string;
  group: string;
  defaults: Record<string, Json>;
  fields: FieldSpec[];
  /** Visible branch handles. Standard next/error handles are supplied by the editor. */
  ports?: string[];
}
export interface NodeValidationOptions {
  /** Set after resolving node configuration, so reference-looking input strings cannot bypass type checks. */
  resolved?: boolean;
}
export interface NodeDefinition extends DefinitionMetadata {
  outputs: OutputSpec[];
  target?: NodeRequirements["target"];
  capabilities: CapabilityRequirement[];
  requirements(config: Record<string, Json>): NodeRequirements;
  validateConfig(
    config: Record<string, Json>,
    context?: ValidationContext,
    options?: NodeValidationOptions,
  ): ValidationIssue[];
}

const target: FieldSpec = {
  key: "targetId",
  label: "Application or browser",
  type: "target",
};
const xy: FieldSpec[] = [
  target,
  { key: "x", label: "X position", type: "number" },
  { key: "y", label: "Y position", type: "number" },
];
const detection: FieldSpec = {
  key: "detection",
  label: "Detected result (optional)",
  type: "value",
  placeholder: "${nodes.detectId}",
  help: "Reference a detector result to use the center of its matched box. Use the same target.",
};
const definitions: Record<NodeKind, DefinitionMetadata> = {
  start: {
    label: "Start",
    description: "The beginning of your workflow.",
    group: "Flow",
    defaults: {},
    fields: [],
  },
  end: {
    label: "Finish",
    description: "Complete this path and return its results.",
    group: "Flow",
    defaults: { outputs: {} },
    fields: [{ key: "outputs", label: "Return values", type: "json" }],
  },
  launch: {
    label: "Launch application",
    description: "Open a desktop application or managed browser.",
    group: "Applications",
    defaults: { targetId: "" },
    fields: [target],
  },
  attach: {
    label: "Attach to application",
    description: "Connect to an existing application window.",
    group: "Applications",
    defaults: { targetId: "" },
    fields: [target],
  },
  focus: {
    label: "Focus window",
    description: "Bring a target window to the foreground.",
    group: "Applications",
    defaults: { targetId: "" },
    fields: [target],
  },
  close: {
    label: "Close application",
    description: "Close the configured application window.",
    group: "Applications",
    defaults: { targetId: "" },
    fields: [target],
  },
  click: {
    label: "Click",
    description: "Click a position or browser element.",
    group: "Input",
    defaults: { targetId: "", x: 0, y: 0, button: "left" },
    fields: [
      ...xy,
      detection,
      {
        key: "selector",
        label: "Browser selector",
        placeholder: 'button[aria-label="Continue"]',
      },
      {
        key: "button",
        label: "Button",
        type: "select",
        options: ["left", "right", "middle"],
      },
      { key: "clickCount", label: "Click count (optional)", type: "number" },
      {
        key: "checked",
        label: "Browser checked state (optional)",
        type: "boolean",
      },
      { key: "modifiers", label: "Browser modifiers (optional)", type: "json" },
    ],
  },
  move: {
    label: "Move pointer",
    description: "Move the pointer within a target.",
    group: "Input",
    defaults: { targetId: "", x: 0, y: 0 },
    fields: [...xy, detection],
  },
  drag: {
    label: "Drag",
    description: "Drag between two positions.",
    group: "Input",
    defaults: { targetId: "", x: 0, y: 0, toX: 100, toY: 100, durationMs: 500 },
    fields: [
      ...xy,
      { key: "toX", label: "End X", type: "number" },
      { key: "toY", label: "End Y", type: "number" },
      {
        key: "toLocator",
        label: "Browser destination locator (optional)",
        type: "json",
      },
      { key: "durationMs", label: "Duration (ms)", type: "number" },
    ],
  },
  scroll: {
    label: "Scroll",
    description: "Scroll a window or browser page.",
    group: "Input",
    defaults: { targetId: "", deltaY: 300, deltaX: 0 },
    fields: [
      target,
      { key: "deltaY", label: "Vertical distance", type: "number" },
      { key: "deltaX", label: "Horizontal distance", type: "number" },
      {
        key: "scrollTop",
        label: "Browser vertical position (optional)",
        type: "number",
      },
      {
        key: "scrollLeft",
        label: "Browser horizontal position (optional)",
        type: "number",
      },
    ],
  },
  type: {
    label: "Type text",
    description: "Enter text into the current field.",
    group: "Input",
    defaults: { targetId: "", text: "" },
    fields: [
      target,
      {
        key: "text",
        label: "Text",
        type: "textarea",
        placeholder: "Hello ${inputs.name}",
      },
      { key: "selector", label: "Browser selector (optional)" },
    ],
  },
  key: {
    label: "Press keys",
    description: "Press a key or keyboard shortcut.",
    group: "Input",
    defaults: { targetId: "", key: "Enter" },
    fields: [
      target,
      { key: "key", label: "Key or shortcut", placeholder: "Control+Shift+S" },
      {
        key: "action",
        label: "Action",
        type: "select",
        options: ["press", "down", "up"],
      },
      { key: "durationMs", label: "Hold duration (ms)", type: "number" },
    ],
  },
  navigate: {
    label: "Navigate",
    description: "Open a URL in a connected browser.",
    group: "Browser",
    defaults: { targetId: "", url: "https://example.com" },
    fields: [target, { key: "url", label: "URL" }],
  },
  read: {
    label: "Read element",
    description: "Read text from a browser element.",
    group: "Browser",
    defaults: { targetId: "", selector: "body" },
    fields: [target, { key: "selector", label: "Element selector" }],
  },
  select: {
    label: "Select option",
    description: "Choose a browser option or a native selection item.",
    group: "Browser",
    defaults: { targetId: "", selector: "", value: "" },
    fields: [
      target,
      { key: "selector", label: "Element selector" },
      { key: "value", label: "Value", type: "value" },
    ],
  },
  tab: {
    label: "Switch tab",
    description: "Select a tab in the connected browser.",
    group: "Browser",
    defaults: { targetId: "", url: "" },
    fields: [target, { key: "url", label: "Tab URL or pattern" }],
  },
  screenshot: {
    label: "Take screenshot",
    description: "Capture the target as evidence or AI input.",
    group: "Observe",
    defaults: { targetId: "" },
    fields: [target],
  },
  detect: {
    label: "Detect on screen",
    description: "Find an image, text, or visual condition.",
    group: "Observe",
    defaults: { targetId: "", detector: "image", threshold: 0.85 },
    fields: [
      target,
      {
        key: "detector",
        label: "Detector",
        type: "select",
        options: ["image", "text", "color", "change", "element", "ai"],
        reference: false,
      },
      { key: "prompt", label: "Text or question", type: "textarea" },
      { key: "template", label: "Template image", type: "image" },
      { key: "color", label: "Color to match", placeholder: "#RRGGBB" },
      {
        key: "region",
        label: "Search region (optional)",
        type: "json",
        help: "Image pixels: {x, y, width, height}.",
      },
      { key: "selector", label: "Browser selector" },
      { key: "threshold", label: "Confidence threshold", type: "number" },
      {
        key: "locationThreshold",
        label: "Jev location confidence",
        type: "number",
        help: "Independent Box confidence threshold (default 0.85). Both presence and location must pass before coordinates are available.",
      },
      { key: "connectionId", label: "Vision connection", type: "connection" },
      {
        key: "locate",
        label: "Return a location",
        type: "boolean",
        help: "Ask vision AI for a matched box to use in a Click or Move pointer node.",
      },
    ],
    ports: ["match", "no-match", "uncertain"],
  },
  wait: {
    label: "Wait",
    description: "Pause briefly before continuing.",
    group: "Logic",
    defaults: { durationMs: 1000 },
    fields: [{ key: "durationMs", label: "Duration (ms)", type: "number" }],
  },
  condition: {
    label: "Condition",
    description: "Choose a path based on a value.",
    group: "Logic",
    defaults: { left: "", operator: "eq", right: "" },
    fields: [
      {
        key: "left",
        label: "Value",
        type: "value",
        placeholder: "${nodes.detect.outcome}",
      },
      {
        key: "operator",
        label: "Operator",
        type: "select",
        options: ["eq", "neq", "gt", "gte", "lt", "lte", "contains", "truthy"],
        reference: false,
      },
      { key: "right", label: "Compare with", type: "value" },
    ],
    ports: ["true", "false"],
  },
  set: {
    label: "Set variable",
    description: "Store a value for later steps.",
    group: "Logic",
    defaults: { variable: "value", value: "" },
    fields: [
      { key: "variable", label: "Variable name", reference: false },
      { key: "value", label: "Value", type: "value" },
    ],
  },
  loop: {
    label: "Loop",
    description: "Repeat a bounded section of the flow.",
    group: "Logic",
    defaults: { flowId: "", count: 3, maxIterations: 100 },
    fields: [
      { key: "flowId", label: "Child flow", type: "flow" },
      { key: "count", label: "Iterations", type: "number" },
      {
        key: "items",
        label: "Items (optional)",
        type: "value",
        help: "Use an array to iterate its items instead of a count.",
      },
      {
        key: "inputs",
        label: "Child inputs",
        type: "json",
        help: "Map values to the child flow. Item and index are available for each iteration.",
      },
      { key: "maxIterations", label: "Safety limit", type: "number" },
    ],
  },
  ai: {
    label: "Ask AI",
    description: "Use your model to understand text or an image.",
    group: "AI",
    defaults: { connectionId: "", prompt: "", mode: "text" },
    fields: [
      {
        key: "mode",
        label: "Mode",
        type: "select",
        options: ["text", "structured", "vision"],
        reference: false,
      },
      { key: "connectionId", label: "AI connection", type: "connection" },
      {
        key: "prompt",
        label: "Prompt",
        type: "textarea",
        placeholder: "Describe what you see…",
      },
      { key: "targetId", label: "Optional image source", type: "target" },
      {
        key: "schema",
        label: "Output schema (optional)",
        type: "json",
        reference: false,
      },
    ],
  },
  call: {
    label: "Run child flow",
    description: "Run a reusable flow and collect its result.",
    group: "Orchestration",
    defaults: { flowId: "", inputs: {} },
    fields: [
      { key: "flowId", label: "Child flow", type: "flow" },
      { key: "inputs", label: "Inputs", type: "json" },
    ],
  },
  group: {
    label: "Run flow group",
    description: "Run children sequentially, in a pool, or in batches.",
    group: "Orchestration",
    defaults: {
      flowIds: [],
      mode: "pool",
      concurrency: 3,
      continueOnError: false,
    },
    fields: [
      {
        key: "flowIds",
        label: "Child flow IDs",
        type: "json",
        help: "Each flow is invoked once. Repeat an ID to run it again.",
        reference: false,
      },
      {
        key: "mode",
        label: "Execution mode",
        type: "select",
        options: ["sequence", "pool", "batches"],
        reference: false,
      },
      { key: "concurrency", label: "Pool or batch size", type: "number" },
      {
        key: "continueOnError",
        label: "Continue after a child fails",
        type: "boolean",
      },
      {
        key: "children",
        label: "Children with inputs (optional)",
        type: "json",
        help: "An array of {flowId, inputs} objects; use instead of flow IDs.",
        reference: false,
      },
    ],
  },
};

/** References are checked structurally by validateFlow and again after resolution at execution. */
export function hasReference(value: unknown): boolean {
  return typeof value === "string" && /\$\{[^{}]+\}/.test(value);
}
const object = (value: unknown): value is Record<string, Json> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const present = (value: unknown) =>
  value !== undefined && value !== null && value !== "";
const browserKinds = new Set<NodeKind>(["navigate", "read", "select", "tab"]);
const inputKinds = new Set<NodeKind>([
  "click",
  "move",
  "drag",
  "scroll",
  "type",
  "key",
]);
const noTargetKinds = new Set<NodeKind>([
  "start",
  "end",
  "set",
  "condition",
  "loop",
  "call",
  "group",
]);

export function nodeRequirements(
  kind: NodeKind,
  config: Record<string, Json>,
  options?: NodeValidationOptions,
): NodeRequirements {
  if (noTargetKinds.has(kind) || (kind === "wait" && !config.detector))
    return { capabilities: [] };
  if (kind === "ai") {
    const vision = config.mode === "vision";
    return {
      target: { kinds: ["desktop", "browser"], required: vision },
      capabilities: [
        ...(vision
          ? (["capture", "ai.vision"] as const)
          : (["ai.text"] as const)),
        ...(config.mode === "structured" || present(config.schema)
          ? (["ai.structured"] as const)
          : []),
      ],
    };
  }
  if (config.nativeLocator !== undefined)
    return {
      target: { kinds: ["desktop"], required: true },
      capabilities: ["accessibility"],
    };
  const detector = kind === "detect" || kind === "wait";
  const browser =
    browserKinds.has(kind) ||
    (detector && config.detector === "element") ||
    (!detector &&
      Boolean(
        config.selector ||
        config.locator ||
        config.toLocator ||
        config.checked !== undefined ||
        config.scrollTop !== undefined ||
        config.scrollLeft !== undefined ||
        config.modifiers !== undefined,
      ) &&
      (options?.resolved || !hasReference(config.selector ?? config.locator)));
  return {
    target: {
      kinds: browser ? ["browser"] : ["desktop", "browser"],
      required: true,
    },
    capabilities: [
      ...(browser ? (["browser"] as const) : []),
      ...(inputKinds.has(kind) ? (["input"] as const) : []),
      ...(kind === "screenshot" || (detector && config.detector !== "element")
        ? (["capture"] as const)
        : []),
      ...(detector && config.detector === "ai" ? (["ai.vision"] as const) : []),
    ],
  };
}

/** Validate known fields without dropping advanced adapter options or replacing user values with defaults. */
export function validateNodeConfig(
  kind: NodeKind,
  config: Record<string, Json>,
  context?: ValidationContext,
  options?: NodeValidationOptions,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const reference = (value: unknown) =>
    !options?.resolved && hasReference(value);
  const error = (message: string) =>
    issues.push({ severity: "error", message });
  const numeric = (
    key: string,
    min: number,
    max = Infinity,
    integer = false,
    coerce = false,
  ) => {
    const raw = config[key];
    if (raw === undefined || reference(raw)) return;
    const value =
      coerce && typeof raw === "string" && raw.trim() ? Number(raw) : raw;
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < min ||
      value > max ||
      (integer && !Number.isInteger(value))
    )
      error(
        `${key} must be ${integer ? "an integer" : "a number"} between ${min} and ${max === Infinity ? "a finite maximum" : max}`,
      );
  };
  const choice = (key: string, choices: readonly string[]) => {
    const value = config[key];
    if (
      value !== undefined &&
      !reference(value) &&
      !choices.includes(String(value))
    )
      error(`${key} must be one of: ${choices.join(", ")}`);
  };
  const required = (key: string, message = `${key} is required`) => {
    if (
      !present(config[key]) ||
      (typeof config[key] === "string" && !String(config[key]).trim())
    )
      error(message);
  };
  const record = (key: string) => {
    const value = config[key];
    if (value !== undefined && !reference(value) && !object(value))
      error(`${key} must be an object`);
  };
  if (present(config.nativeLocator)) {
    if (
      !(
        typeof config.nativeLocator === "string" &&
        reference(config.nativeLocator)
      ) &&
      !nativeLocatorSchema.safeParse(config.nativeLocator).success
    )
      error(
        "Native locator is invalid; use semantic properties, not object pointers",
      );
    if (
      !["click", "type", "read", "select", "detect", "wait"].includes(kind) ||
      (["detect", "wait"].includes(kind) && config.detector !== "element")
    )
      error("This node has no supported native semantic action");
    if (
      config.locator ||
      config.selector ||
      config.detection ||
      config.checked !== undefined ||
      config.modifiers
    )
      error(
        "Choose one native locator, browser locator or coordinate detection source",
      );
    if (
      kind === "click" &&
      ((config.button && config.button !== "left") ||
        Number(config.clickCount ?? 1) !== 1)
    )
      error(
        "Native Invoke does not support pointer buttons or repeated clicks",
      );
    if (kind === "select" && config.value !== undefined && config.value !== "")
      error(
        "Native Select selects the matched item; remove the browser option value",
      );
  }
  numeric("timeoutMs", Number.MIN_VALUE);
  if (config.requiresConfiguration === true)
    error(
      typeof config.recordingWarning === "string"
        ? config.recordingWarning
        : "This recorded interaction requires manual configuration before running",
    );
  for (const key of ["locator", "toLocator"])
    if (
      present(config[key]) &&
      !reference(config[key]) &&
      !browserLocatorSchema.safeParse(config[key]).success
    )
      error(`${key} is invalid; complete its strategy and scope fields`);
  for (const key of ["fromOffset", "toOffset"])
    if (present(config[key]) && !reference(config[key])) {
      const offset = config[key];
      if (
        !object(offset) ||
        typeof offset.x !== "number" ||
        typeof offset.y !== "number" ||
        !Number.isFinite(offset.x) ||
        !Number.isFinite(offset.y) ||
        offset.x < 0 ||
        offset.x > 1 ||
        offset.y < 0 ||
        offset.y > 1
      )
        error(`${key} must contain x/y fractions between 0 and 1`);
    }
  if (
    config.checked !== undefined &&
    !reference(config.checked) &&
    typeof config.checked !== "boolean"
  )
    error("checked must be a boolean");
  if (
    config.modifiers !== undefined &&
    !reference(config.modifiers) &&
    (!Array.isArray(config.modifiers) ||
      config.modifiers.some(
        (key) => !["Control", "Alt", "Shift", "Meta"].includes(String(key)),
      ))
  )
    error("modifiers must be an array of modifier keys");
  if (
    (config.checked !== undefined ||
      config.scrollTop !== undefined ||
      config.scrollLeft !== undefined) &&
    !present(config.locator) &&
    !present(config.selector)
  )
    error("Browser state replay requires a locator or selector");
  if (kind === "scroll") {
    numeric("scrollTop", 0);
    numeric("scrollLeft", 0);
  }
  if (
    kind === "select" &&
    config.value !== undefined &&
    !reference(config.value) &&
    typeof config.value !== "string" &&
    (!Array.isArray(config.value) ||
      config.value.some((value) => typeof value !== "string"))
  )
    error("Select value must be a string or an array of strings");
  if (present(config.locator)) {
    if (
      !reference(config.locator) &&
      !browserLocatorSchema.safeParse(config.locator).success
    )
      error(
        "Browser locator is invalid; complete its strategy and scope fields",
      );
    if (present(config.selector))
      error("Choose one browser locator or legacy selector");
  }
  for (const key of ["targetId", "connectionId", "selector", "frameId"])
    if (config[key] !== undefined && typeof config[key] !== "string")
      error(`${key} must be a string`);
  if (inputKinds.has(kind)) {
    for (const key of ["x", "y", "toX", "toY"]) numeric(key, 0);
    numeric("durationMs", 0, 86400000);
    numeric("expectedWidth", 1);
    numeric("expectedHeight", 1);
    if (
      (config.expectedWidth === undefined) !==
      (config.expectedHeight === undefined)
    )
      error("Capture geometry requires both expectedWidth and expectedHeight");
    if (kind === "click" || kind === "drag")
      choice("button", ["left", "right", "middle"]);
    if (kind === "click") numeric("clickCount", 1, Infinity, true);
    if ((kind === "click" || kind === "move") && present(config.detection)) {
      if (config.selector || config.locator)
        error(
          "Choose one location source: a detected result or a browser selector",
        );
      if (!reference(config.detection) && !object(config.detection))
        error("detection must be a detector result or reference");
    }
    if (kind === "drag" && context && !present(config.toLocator)) {
      required("toX");
      required("toY");
    }
    if (kind === "scroll") {
      numeric("deltaX", -Infinity);
      numeric("deltaY", -Infinity);
    }
    if (kind === "key") {
      choice("action", ["press", "down", "up"]);
      if (context) required("key", "Choose a key or shortcut");
    }
  }
  if (kind === "launch") {
    if (
      config.command !== undefined &&
      (typeof config.command !== "string" || !config.command.trim())
    )
      error("Launch command must be a non-empty executable path or name");
    if (
      config.args !== undefined &&
      !reference(config.args) &&
      (!Array.isArray(config.args) ||
        config.args.some((arg) => typeof arg !== "string"))
    )
      error("Launch args must be an array of strings");
  }
  if (
    kind === "select" &&
    context &&
    !present(config.locator) &&
    !present(config.nativeLocator)
  )
    required("selector", "Choose a browser element selector");
  if (kind === "tab") {
    choice("action", ["new", "close", "switch"]);
    numeric("index", 0, Infinity, true);
  }
  if (kind === "end") record("outputs");
  if (kind === "set") {
    const name = config.variable ?? config.name;
    if (
      !reference(name) &&
      (typeof name !== "string" ||
        !/^[a-zA-Z_][\w-]*$/.test(name) ||
        ["__proto__", "prototype", "constructor"].includes(name))
    )
      error("Variable must have a safe, non-empty identifier");
  }
  if (kind === "condition") {
    choice("operator", [
      "eq",
      "neq",
      "gt",
      "gte",
      "lt",
      "lte",
      "contains",
      "truthy",
    ]);
    if (["gt", "gte", "lt", "lte"].includes(String(config.operator)))
      for (const key of ["left", "right"])
        if (!reference(config[key]) && typeof config[key] !== "number")
          error("Numeric comparison requires numbers");
  }
  if (kind === "call" || (kind === "loop" && !hasReference(config.inputs)))
    record("inputs");
  if (kind === "group") {
    choice("mode", ["sequence", "pool", "batches"]);
    numeric("concurrency", 1, 64, true);
    if (
      config.continueOnError !== undefined &&
      !reference(config.continueOnError) &&
      typeof config.continueOnError !== "boolean"
    )
      error("continueOnError must be a boolean");
    if (config.children !== undefined && !Array.isArray(config.children))
      error("children must be an array with fixed child flow IDs");
    if (Array.isArray(config.children))
      for (const child of config.children) {
        if (
          !object(child) ||
          typeof child.flowId !== "string" ||
          !child.flowId.trim()
        )
          error("Each child needs a flowId");
        else if (
          child.inputs !== undefined &&
          !reference(child.inputs) &&
          !object(child.inputs)
        )
          error("Child inputs must be an object");
      }
    if (config.flowIds !== undefined && !Array.isArray(config.flowIds))
      error("flowIds must be an array of fixed child flow IDs");
  }
  if (kind === "loop") {
    numeric("maxIterations", 1, 10000, true);
    const bound =
      typeof config.maxIterations === "number"
        ? config.maxIterations
        : reference(config.maxIterations)
          ? 10000
          : 1000;
    if (config.items === undefined) {
      if (config.count === undefined) error("Loop requires count or items");
      numeric("count", 0, bound, true, true);
    } else if (!reference(config.items)) {
      if (!Array.isArray(config.items))
        error("For each items must resolve to an array");
      else if (config.items.length > bound)
        error("Loop items exceed its iteration bound");
    }
  }
  if (kind === "wait") {
    if (!config.detector) {
      numeric("durationMs", 0, 86400000, false, true);
      if (config.durationMs === undefined)
        numeric("ms", 0, 86400000, false, true);
    }
    numeric("pollIntervalMs", Number.MIN_VALUE);
    if (config.pollIntervalMs === undefined)
      numeric("pollMs", Number.MIN_VALUE);
  }
  const detector =
    kind === "detect" || (kind === "wait" && Boolean(config.detector));
  if (detector) {
    choice("detector", ["image", "text", "color", "change", "element", "ai"]);
    numeric("threshold", 0, 1);
    numeric("locationThreshold", 0, 1);
    if (config.locationThreshold === 0)
      error("Location confidence threshold must be greater than 0");
    const type = config.detector ?? "text";
    if (context && type === "image")
      required("template", "Choose a template image");
    if (
      type === "image" &&
      present(config.template) &&
      !reference(config.template) &&
      (typeof config.template !== "string" ||
        !/^data:image\/(png|jpeg);base64,/.test(config.template))
    )
      error("Template must be a PNG or JPEG data URL");
    if (
      context &&
      type === "element" &&
      !present(config.locator) &&
      !present(config.nativeLocator)
    )
      required("selector", "Element detection requires a browser selector");
    if (context && type === "text" && !present(config.text ?? config.prompt))
      error("Enter the text to detect");
    if (
      config.color !== undefined &&
      !reference(config.color) &&
      !/^#[0-9a-f]{6}$/i.test(String(config.color))
    )
      error("Color must use #RRGGBB format");
    if (
      config.language !== undefined &&
      !reference(config.language) &&
      !/^[a-zA-Z0-9_+]+$/.test(String(config.language))
    )
      error("Invalid OCR language");
    if (
      config.locate !== undefined &&
      !reference(config.locate) &&
      typeof config.locate !== "boolean"
    )
      error("locate must be a boolean");
    if (config.region != null && !reference(config.region)) {
      if (!object(config.region)) error("Region needs x, y, width and height");
      else
        for (const key of ["x", "y", "width", "height"]) {
          const value = config.region[key];
          if (
            !reference(value) &&
            (typeof value !== "number" ||
              !Number.isFinite(value) ||
              value < (key === "x" || key === "y" ? 0 : 1))
          )
            error(`Region ${key} must be a valid pixel dimension`);
        }
    }
  }
  const usesAI = kind === "ai" || (detector && config.detector === "ai");
  if (kind === "ai") {
    choice("mode", ["text", "structured", "vision"]);
    if (config.mode === "structured" || present(config.schema)) {
      let schema = config.schema;
      if (!reference(schema)) {
        if (typeof schema === "string") {
          try {
            schema = JSON.parse(schema) as Json;
          } catch {
            /* Report the common error below. */
          }
        }
        if (!object(schema))
          error("Provide a JSON schema object for structured AI output");
      }
    }
  }
  if (usesAI && context) required("prompt", "An AI prompt is required");
  const requirements = nodeRequirements(kind, config, options);
  if (context?.targets && requirements.target) {
    const id = config.targetId;
    if (!present(id)) {
      if (requirements.target.required)
        error("Choose an application or browser target");
    } else if (!reference(id)) {
      const target = context.targets.find((candidate) => candidate.id === id);
      if (!target) error(`Target not found: ${String(id)}`);
      else {
        if (!requirements.target.kinds.includes(target.kind))
          error(
            `${definitions[kind].label} requires a ${config.nativeLocator ? "desktop" : "browser"} target for this configuration`,
          );
        if (target.kind === "desktop" && target.browserMode !== undefined)
          error("A desktop target cannot use a browser connection mode");
        if (
          target.kind === "browser" &&
          kind === "launch" &&
          (config.command !== undefined || config.args !== undefined)
        )
          error("A browser launch cannot use a desktop executable command");
      }
    }
  }
  if (usesAI && context?.connections) {
    const vision =
      kind === "detect" || kind === "wait" || config.mode === "vision";
    const dynamicMode = kind === "ai" && reference(config.mode);
    const id =
      config.connectionId ||
      (vision
        ? context.settings?.defaultVisionConnection
        : context.settings?.defaultTextConnection);
    if (dynamicMode && !config.connectionId) return issues;
    if (!present(id))
      error(
        `Choose a ${vision ? "vision" : "text"} AI connection or set its default`,
      );
    else if (!reference(id)) {
      const connection = context.connections.find(
        (candidate) => candidate.id === id,
      );
      if (!connection) error(`AI connection not found: ${String(id)}`);
      else {
        if (dynamicMode) return issues;
        if (vision && !connection.capabilities.vision)
          error(`${connection.name} is not configured for vision`);
        if (!vision && !connection.capabilities.text)
          error(`${connection.name} is not configured for text`);
        const structured =
          config.mode === "structured" ||
          present(config.schema) ||
          (detector && connection.provider !== "jev");
        if (structured && !connection.capabilities.structured)
          error(`${connection.name} does not support structured output`);
        if (
          vision &&
          connection.provider === "jev" &&
          !connection.experimentalVision
        )
          error("Enable experimental Jev vision for this connection");
      }
    }
  }
  return issues;
}

const result = (
  type: OutputSpec["type"],
  description: string,
): OutputSpec[] => [{ path: "", type, description }];
const detectorOutputs: OutputSpec[] = [
  ...result("object", "Detection result"),
  {
    path: "outcome",
    type: "string",
    description: "match, no-match or uncertain",
  },
  {
    path: "confidence",
    type: "number",
    description: "Confidence between 0 and 1",
    optional: true,
  },
  ...["presenceConfidence", "locationConfidence"].map((path) => ({
    path,
    type: "number" as const,
    description:
      path === "presenceConfidence"
        ? "Jev presence probability"
        : "Jev Box confidence, independent of presence",
    optional: true,
  })),
  {
    path: "value",
    type: "json",
    description: "Recognized text or detector value",
    optional: true,
  },
  {
    path: "box",
    type: "object",
    description: "Matched rectangle in capture pixels",
    optional: true,
  },
  ...["x", "y", "width", "height"].map((dimension) => ({
    path: `box.${dimension}`,
    type: "number" as const,
    description: `Matched rectangle ${dimension} in capture pixels`,
    optional: true,
  })),
  {
    path: "frameId",
    type: "string",
    description: "Source capture for guarded input",
    optional: true,
  },
  {
    path: "evidence",
    type: "string",
    description: "Detector explanation",
    optional: true,
  },
];
function nodeOutputs(kind: NodeKind): OutputSpec[] {
  if (kind === "start" || kind === "end") return [];
  if (kind === "detect")
    return detectorOutputs.map((output) => ({ ...output }));
  if (kind === "wait")
    return [
      {
        path: "",
        type: "object",
        description: "Detection result when waiting for a detector",
        optional: true,
      },
    ];
  if (kind === "condition")
    return result("boolean", "Whether the condition passed");
  if (kind === "read") return result("string", "Element text");
  if (kind === "call") return result("object", "Child flow outputs");
  if (kind === "group" || kind === "loop")
    return result("array", "Child outputs in input order");
  if (kind === "screenshot")
    return [
      ...result("object", "Capture metadata"),
      ...["frameId", "targetId"].map((path) => ({
        path,
        type: "string" as const,
        description: path,
      })),
      ...["width", "height", "capturedAt"].map((path) => ({
        path,
        type: "number" as const,
        description: path,
      })),
    ];
  if (kind === "set") return result("json", "The assigned variable value");
  if (kind === "ai")
    return result(
      "json",
      "Text, schema-validated JSON or provider vision output",
    );
  return result("json", "Target adapter result");
}

export const nodeDefinitions = Object.fromEntries(
  nodeKinds.map((kind) => [
    kind,
    {
      ...definitions[kind],
      ...nodeRequirements(kind, definitions[kind].defaults),
      outputs: nodeOutputs(kind),
      requirements: (config: Record<string, Json>) =>
        nodeRequirements(kind, config),
      validateConfig: (
        config: Record<string, Json>,
        context?: ValidationContext,
        options?: NodeValidationOptions,
      ) => validateNodeConfig(kind, config, context, options),
    },
  ]),
) as Record<NodeKind, NodeDefinition>;

/** All accepted ports, including runtime error recovery and detector default branches. */
export function nodeOutputPorts(kind: NodeKind): string[] {
  if (kind === "end") return [];
  return kind === "condition"
    ? ["true", "false", "error"]
    : [...(nodeDefinitions[kind].ports ?? []), "next", "error"];
}
