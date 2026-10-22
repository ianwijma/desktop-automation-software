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
import type { FlowDefinition, NodeKind } from "../shared/types";
import {
  nodeDefinitions,
  nodeKinds,
  type NodeDefinition,
} from "../shared/node-definitions";
export type { FieldSpec } from "../shared/node-definitions";
export type NodeSpec = NodeDefinition & { icon: LucideIcon; color: string };
const presentation: Record<NodeKind, { icon: LucideIcon; color: string }> = {
  start: { icon: Play, color: "green" },
  end: { icon: Flag, color: "green" },
  launch: { icon: AppWindow, color: "blue" },
  attach: { icon: Link, color: "blue" },
  focus: { icon: Focus, color: "blue" },
  close: { icon: X, color: "blue" },
  click: { icon: MousePointer2, color: "blue" },
  move: { icon: Move, color: "blue" },
  drag: { icon: Hand, color: "blue" },
  scroll: { icon: Mouse, color: "blue" },
  type: { icon: TextCursorInput, color: "blue" },
  key: { icon: Keyboard, color: "blue" },
  navigate: { icon: Globe, color: "cyan" },
  read: { icon: ArrowDownToLine, color: "cyan" },
  select: { icon: ListFilter, color: "cyan" },
  tab: { icon: PanelTop, color: "cyan" },
  screenshot: { icon: Camera, color: "amber" },
  detect: { icon: Scan, color: "amber" },
  wait: { icon: Clock3, color: "amber" },
  condition: { icon: GitBranch, color: "violet" },
  set: { icon: Braces, color: "violet" },
  loop: { icon: Repeat2, color: "violet" },
  ai: { icon: Sparkles, color: "violet" },
  call: { icon: Workflow, color: "pink" },
  group: { icon: Layers3, color: "pink" },
};
export const catalog = Object.fromEntries(
  nodeKinds.map((kind) => [
    kind,
    { ...nodeDefinitions[kind], ...presentation[kind] },
  ]),
) as Record<NodeKind, NodeSpec>;
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
    schemaVersion: 2,
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
