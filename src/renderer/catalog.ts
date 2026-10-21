import type { LucideIcon } from "lucide-react";
import {
  Play,
  Flag,
  AppWindow,
  MousePointer2,
  Keyboard,
  Mouse,
  Move,
  Scan,
  Clock3,
  GitBranch,
  Braces,
  Repeat2,
  Sparkles,
  Workflow,
  Layers3,
  Globe,
  Focus,
  X,
  Link,
  ArrowDownToLine,
  ListFilter,
  PanelTop,
  Camera,
  Hand,
  TextCursorInput,
} from "lucide-react";
import type { FlowDefinition, Json, NodeKind } from "../shared/types";
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
    | "boolean"
    | "image";
  placeholder?: string;
  options?: string[];
  help?: string;
}
export interface NodeSpec {
  label: string;
  description: string;
  group: string;
  icon: LucideIcon;
  color: string;
  defaults: Record<string, Json>;
  fields: FieldSpec[];
  ports?: string[];
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
  placeholder: "${nodes.detectId}",
  help: "Reference a detector result to use the center of its matched box. Use the same target.",
};
export const catalog: Record<NodeKind, NodeSpec> = {
  start: {
    label: "Start",
    description: "The beginning of your workflow.",
    group: "Flow",
    icon: Play,
    color: "green",
    defaults: {},
    fields: [],
  },
  end: {
    label: "Finish",
    description: "Complete this path and return its results.",
    group: "Flow",
    icon: Flag,
    color: "green",
    defaults: { outputs: {} },
    fields: [{ key: "outputs", label: "Return values", type: "json" }],
  },
  launch: {
    label: "Launch application",
    description: "Open a desktop application or managed browser.",
    group: "Applications",
    icon: AppWindow,
    color: "blue",
    defaults: { targetId: "" },
    fields: [target],
  },
  attach: {
    label: "Attach to application",
    description: "Connect to an existing application window.",
    group: "Applications",
    icon: Link,
    color: "blue",
    defaults: { targetId: "" },
    fields: [target],
  },
  focus: {
    label: "Focus window",
    description: "Bring a target window to the foreground.",
    group: "Applications",
    icon: Focus,
    color: "blue",
    defaults: { targetId: "" },
    fields: [target],
  },
  close: {
    label: "Close application",
    description: "Close the configured application window.",
    group: "Applications",
    icon: X,
    color: "blue",
    defaults: { targetId: "" },
    fields: [target],
  },
  click: {
    label: "Click",
    description: "Click a position or browser element.",
    group: "Input",
    icon: MousePointer2,
    color: "blue",
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
    ],
  },
  move: {
    label: "Move pointer",
    description: "Move the pointer within a target.",
    group: "Input",
    icon: Move,
    color: "blue",
    defaults: { targetId: "", x: 0, y: 0 },
    fields: [...xy, detection],
  },
  drag: {
    label: "Drag",
    description: "Drag between two positions.",
    group: "Input",
    icon: Hand,
    color: "blue",
    defaults: { targetId: "", x: 0, y: 0, toX: 100, toY: 100, durationMs: 500 },
    fields: [
      ...xy,
      { key: "toX", label: "End X", type: "number" },
      { key: "toY", label: "End Y", type: "number" },
      { key: "durationMs", label: "Duration (ms)", type: "number" },
    ],
  },
  scroll: {
    label: "Scroll",
    description: "Scroll a window or browser page.",
    group: "Input",
    icon: Mouse,
    color: "blue",
    defaults: { targetId: "", deltaY: 300, deltaX: 0 },
    fields: [
      target,
      { key: "deltaY", label: "Vertical distance", type: "number" },
      { key: "deltaX", label: "Horizontal distance", type: "number" },
    ],
  },
  type: {
    label: "Type text",
    description: "Enter text into the current field.",
    group: "Input",
    icon: TextCursorInput,
    color: "blue",
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
    icon: Keyboard,
    color: "blue",
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
    icon: Globe,
    color: "cyan",
    defaults: { targetId: "", url: "https://example.com" },
    fields: [target, { key: "url", label: "URL" }],
  },
  read: {
    label: "Read element",
    description: "Read text from a browser element.",
    group: "Browser",
    icon: ArrowDownToLine,
    color: "cyan",
    defaults: { targetId: "", selector: "body" },
    fields: [target, { key: "selector", label: "Element selector" }],
  },
  select: {
    label: "Select option",
    description: "Choose a value in a browser select field.",
    group: "Browser",
    icon: ListFilter,
    color: "cyan",
    defaults: { targetId: "", selector: "", value: "" },
    fields: [
      target,
      { key: "selector", label: "Element selector" },
      { key: "value", label: "Value" },
    ],
  },
  tab: {
    label: "Switch tab",
    description: "Select a tab in the connected browser.",
    group: "Browser",
    icon: PanelTop,
    color: "cyan",
    defaults: { targetId: "", url: "" },
    fields: [target, { key: "url", label: "Tab URL or pattern" }],
  },
  screenshot: {
    label: "Take screenshot",
    description: "Capture the target as evidence or AI input.",
    group: "Observe",
    icon: Camera,
    color: "amber",
    defaults: { targetId: "" },
    fields: [target],
  },
  detect: {
    label: "Detect on screen",
    description: "Find an image, text, or visual condition.",
    group: "Observe",
    icon: Scan,
    color: "amber",
    defaults: { targetId: "", detector: "image", threshold: 0.85 },
    fields: [
      target,
      {
        key: "detector",
        label: "Detector",
        type: "select",
        options: ["image", "text", "color", "change", "element", "ai"],
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
    icon: Clock3,
    color: "amber",
    defaults: { durationMs: 1000 },
    fields: [{ key: "durationMs", label: "Duration (ms)", type: "number" }],
  },
  condition: {
    label: "Condition",
    description: "Choose a path based on a value.",
    group: "Logic",
    icon: GitBranch,
    color: "violet",
    defaults: { left: "", operator: "eq", right: "" },
    fields: [
      { key: "left", label: "Value", placeholder: "${nodes.detect.outcome}" },
      {
        key: "operator",
        label: "Operator",
        type: "select",
        options: ["eq", "neq", "gt", "gte", "lt", "lte", "contains", "truthy"],
      },
      { key: "right", label: "Compare with" },
    ],
    ports: ["true", "false"],
  },
  set: {
    label: "Set variable",
    description: "Store a value for later steps.",
    group: "Logic",
    icon: Braces,
    color: "violet",
    defaults: { variable: "value", value: "" },
    fields: [
      { key: "variable", label: "Variable name" },
      { key: "value", label: "Value", type: "textarea" },
    ],
  },
  loop: {
    label: "Loop",
    description: "Repeat a bounded section of the flow.",
    group: "Logic",
    icon: Repeat2,
    color: "violet",
    defaults: { flowId: "", count: 3, maxIterations: 100 },
    fields: [
      { key: "flowId", label: "Child flow", type: "flow" },
      { key: "count", label: "Iterations", type: "number" },
      { key: "maxIterations", label: "Safety limit", type: "number" },
    ],
  },
  ai: {
    label: "Ask AI",
    description: "Use your model to understand text or an image.",
    group: "AI",
    icon: Sparkles,
    color: "violet",
    defaults: { connectionId: "", prompt: "", mode: "text" },
    fields: [
      {
        key: "mode",
        label: "Mode",
        type: "select",
        options: ["text", "structured", "vision"],
      },
      { key: "connectionId", label: "AI connection", type: "connection" },
      {
        key: "prompt",
        label: "Prompt",
        type: "textarea",
        placeholder: "Describe what you see…",
      },
      { key: "targetId", label: "Optional image source", type: "target" },
      { key: "schema", label: "Output schema (optional)", type: "json" },
    ],
  },
  call: {
    label: "Run child flow",
    description: "Run a reusable flow and collect its result.",
    group: "Orchestration",
    icon: Workflow,
    color: "pink",
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
    icon: Layers3,
    color: "pink",
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
      },
      {
        key: "mode",
        label: "Execution mode",
        type: "select",
        options: ["sequence", "pool", "batches"],
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
      },
    ],
  },
};
export const accents = [
  ["Iris", "#9292ff"],
  ["Violet", "#b294ff"],
  ["Orchid", "#d39af2"],
  ["Pink", "#f391c2"],
  ["Rose", "#f59aaf"],
  ["Coral", "#ff9a87"],
  ["Orange", "#ffaf73"],
  ["Amber", "#efc46a"],
  ["Lemon", "#dfd475"],
  ["Lime", "#bcd67b"],
  ["Green", "#7fd5a1"],
  ["Mint", "#75d7b7"],
  ["Teal", "#6dd4cf"],
  ["Cyan", "#75cbe8"],
  ["Sky", "#8dbfff"],
  ["Slate", "#b3bfdb"],
] as const;
export const uid = () => crypto.randomUUID();
export function blankFlow(name = "Untitled flow"): FlowDefinition {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    id: uid(),
    name,
    description: "",
    folder: "My flows",
    revision: 1,
    nodes: [
      {
        id: uid(),
        kind: "start",
        label: "Start",
        position: { x: 80, y: 180 },
        config: {},
      },
    ],
    edges: [],
    inputs: {},
    outputs: {},
    createdAt: now,
    updatedAt: now,
  };
}
