import type {
  AppSettings,
  FlowDefinition,
  FlowNode,
  PlatformCapabilities,
  TargetDescriptor,
} from "./types";

export const defaultSettings: AppSettings = {
  theme: "dark",
  accent: "#9292ff",
  launchAtLogin: false,
  minimizeToTray: true,
  stopHotkey: "F8",
  pauseHotkey: "F7",
  historyRetentionDays: 30,
};
export const defaultCapabilities: PlatformCapabilities = {
  platform: "unknown",
  session: "unknown",
  capture: false,
  input: false,
  accessibility: false,
  directRecording: false,
  globalShortcuts: false,
  reasons: ["Desktop capabilities have not been checked."],
  windows: [],
};
export const defaultTargets: TargetDescriptor[] = [
  {
    id: "browser-research",
    name: "Research browser",
    kind: "browser",
    browserMode: "managed",
    profile: "research",
    url: "https://example.com",
  },
];

function makeFlow(
  id: string,
  name: string,
  description: string,
  folder: string,
  nodes: FlowNode[],
  edges?: FlowDefinition["edges"],
): FlowDefinition {
  const now = new Date().toISOString();
  return {
    schemaVersion: 2,
    id,
    name,
    description,
    folder,
    revision: 1,
    nodes,
    edges:
      edges ??
      nodes.slice(1).map((n, i) => ({
        id: `${id}-e${i}`,
        source: nodes[i].id,
        target: n.id,
      })),
    inputs: {},
    outputs: {},
    createdAt: now,
    updatedAt: now,
  };
}
const n = (
  id: string,
  kind: FlowNode["kind"],
  label: string,
  x: number,
  y: number,
  config: FlowNode["config"] = {},
): FlowNode => ({ id, kind, label, position: { x, y }, config });

export function createSeedFlows(): FlowDefinition[] {
  return [
    makeFlow(
      "welcome",
      "Your first workflow",
      "A safe, runnable introduction to variables, decisions, and execution history. No application access required.",
      "Getting started",
      [
        n("start", "start", "Start here", 60, 160),
        n("greeting", "set", "Set a greeting", 350, 160, {
          variable: "message",
          value: "Hello from Relay",
        }),
        n("pause", "wait", "Wait a moment", 640, 160, { durationMs: 750 }),
        n("check", "condition", "Check the message", 930, 160, {
          left: "${vars.message}",
          operator: "contains",
          right: "Relay",
        }),
        n("done", "end", "Ready to automate", 1220, 80, {
          outputs: { message: "${vars.message}" },
        }),
        n("other", "end", "Try another message", 1220, 280),
      ],
      [
        { id: "w1", source: "start", target: "greeting" },
        { id: "w2", source: "greeting", target: "pause" },
        { id: "w3", source: "pause", target: "check" },
        { id: "w4", source: "check", target: "done", port: "true" },
        { id: "w5", source: "check", target: "other", port: "false" },
      ],
    ),
    makeFlow(
      "browser-starter",
      "Explore a website",
      "Open an isolated browser, navigate, and read a page. Install the Chromium browser when prompted.",
      "Templates",
      [
        n("start", "start", "Start", 60, 160),
        n("open", "navigate", "Open example.com", 350, 160, {
          targetId: "browser-research",
          url: "https://example.com",
        }),
        n("read", "read", "Read the heading", 640, 160, {
          targetId: "browser-research",
          selector: "h1",
        }),
        n("done", "end", "Finish", 930, 160, {
          outputs: { heading: "${nodes.read}" },
        }),
      ],
    ),
    makeFlow(
      "batch-starter",
      "Orchestrate a batch",
      "Run twelve safe child workflows in four batches of three. Switch to a rolling pool or sequence in the inspector.",
      "Templates",
      [
        n("start", "start", "Start", 60, 160),
        n("batch", "group", "Four batches of three", 350, 160, {
          mode: "batches",
          concurrency: 3,
          children: Array.from({ length: 12 }, (_, i) => ({
            flowId: "welcome",
            inputs: { item: i + 1 },
          })),
          continueOnError: false,
        }),
        n("done", "end", "All workflows complete", 680, 160),
      ],
    ),
  ];
}
