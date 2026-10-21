export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };
export type NodeKind =
  | "start"
  | "end"
  | "launch"
  | "attach"
  | "focus"
  | "close"
  | "click"
  | "move"
  | "drag"
  | "scroll"
  | "type"
  | "key"
  | "navigate"
  | "read"
  | "select"
  | "tab"
  | "screenshot"
  | "detect"
  | "wait"
  | "condition"
  | "set"
  | "loop"
  | "ai"
  | "call"
  | "group";
export interface FlowNode {
  id: string;
  kind: NodeKind;
  label: string;
  position: { x: number; y: number };
  config: Record<string, Json>;
  breakpoint?: boolean;
}
export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  port?: string;
}
export interface FlowDefinition {
  schemaVersion: 1;
  id: string;
  name: string;
  description: string;
  folder: string;
  revision: number;
  nodes: FlowNode[];
  edges: FlowEdge[];
  inputs: Record<string, Json>;
  outputs: Record<string, Json>;
  createdAt: string;
  updatedAt: string;
  hotkey?: string;
}
export type ProviderKind =
  "openai" | "anthropic" | "gemini" | "ollama" | "lmstudio" | "jev";
export interface AIConnection {
  id: string;
  name: string;
  provider: ProviderKind;
  baseUrl: string;
  model: string;
  capabilities: { text: boolean; vision: boolean; structured: boolean };
  hasKey: boolean;
  experimentalVision?: boolean;
  lastTest?: { ok: boolean; message: string; at: string };
}
export interface TargetDescriptor {
  id: string;
  name: string;
  kind: "desktop" | "browser";
  browserMode?: "managed" | "extension";
  profile?: string;
  url?: string;
  application?: string;
  windowTitle?: string;
  launch?: Partial<
    Record<"linux" | "win32" | "darwin", { command: string; args: string[] }>
  >;
}
export interface NativeWindow {
  id: string;
  title: string;
  application?: string;
  bounds: { x: number; y: number; width: number; height: number };
}
export interface CaptureFrame {
  id: string;
  targetId: string;
  capturedAt: number;
  width: number;
  height: number;
  dataUrl: string;
  bounds?: { x: number; y: number; width: number; height: number };
  scale?: number;
}
export interface DetectionResult {
  outcome: "match" | "no-match" | "uncertain";
  value?: Json;
  confidence?: number;
  box?: { x: number; y: number; width: number; height: number };
  frameId?: string;
  evidence?: string;
}
export type RunStatus =
  | "queued"
  | "running"
  | "paused"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "skipped";
export interface RunEvent {
  id: string;
  runId: string;
  at: string;
  type: "run" | "node" | "log" | "error";
  nodeId?: string;
  status?: string;
  message: string;
  data?: Json;
}
export interface RunRecord {
  id: string;
  flowId: string;
  flowName: string;
  revision: number;
  parentId?: string;
  rootId: string;
  status: RunStatus;
  trigger: "manual" | "hotkey" | "schedule" | "child";
  inputs: Record<string, Json>;
  outputs: Record<string, Json>;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  currentNodeId?: string;
  error?: string;
  events: RunEvent[];
  childIds: string[];
}
export interface Schedule {
  id: string;
  flowId: string;
  name: string;
  enabled: boolean;
  kind: "once" | "interval" | "daily" | "weekly";
  time: string;
  timezone: string;
  intervalMinutes: number;
  weekdays: number[];
  inputs: Record<string, Json>;
  lastRunAt?: string;
  nextRunAt?: string;
}
export interface AppSettings {
  theme: "dark" | "light" | "system";
  accent: string;
  defaultTextConnection?: string;
  defaultVisionConnection?: string;
  launchAtLogin: boolean;
  minimizeToTray: boolean;
  stopHotkey: string;
  pauseHotkey: string;
  historyRetentionDays: number;
}
export interface PlatformCapabilities {
  platform: string;
  session: string;
  capture: boolean;
  input: boolean;
  accessibility: boolean;
  directRecording: boolean;
  globalShortcuts: boolean;
  reasons: string[];
  windows: NativeWindow[];
}
export interface RecordedAction {
  id: string;
  kind: NodeKind;
  label: string;
  config: Record<string, Json>;
  at: number;
}
export interface RecordingState {
  active: boolean;
  mode: "guided" | "direct";
  targetId?: string;
  actions: RecordedAction[];
}
export interface WorkspaceState {
  flows: FlowDefinition[];
  targets: TargetDescriptor[];
  connections: AIConnection[];
  schedules: Schedule[];
  runs: RunRecord[];
  settings: AppSettings;
  capabilities: PlatformCapabilities;
  recording: RecordingState;
  desktop: boolean;
}
export interface ValidationIssue {
  nodeId?: string;
  message: string;
  severity: "error" | "warning";
}
export type AppEvent =
  | { type: "run"; run: RunRecord }
  | { type: "recording"; recording: RecordingState }
  | { type: "capabilities"; capabilities: PlatformCapabilities }
  | { type: "workspace" };
export interface RelayAPI {
  bootstrap(): Promise<WorkspaceState>;
  saveFlow(flow: FlowDefinition): Promise<FlowDefinition>;
  deleteFlow(id: string): Promise<void>;
  validateFlow(flow: FlowDefinition): Promise<ValidationIssue[]>;
  runFlow(id: string, inputs?: Record<string, Json>): Promise<RunRecord>;
  controlRun(
    id: string,
    action: "pause" | "resume" | "step" | "stop",
  ): Promise<void>;
  saveSettings(settings: AppSettings): Promise<AppSettings>;
  saveConnection(
    connection: AIConnection,
    apiKey?: string,
  ): Promise<AIConnection>;
  deleteConnection(id: string): Promise<void>;
  testConnection(id: string): Promise<{ ok: boolean; message: string }>;
  saveTarget(target: TargetDescriptor): Promise<TargetDescriptor>;
  deleteTarget(id: string): Promise<void>;
  saveSchedule(schedule: Schedule): Promise<Schedule>;
  deleteSchedule(id: string): Promise<void>;
  getCapabilities(): Promise<PlatformCapabilities>;
  browserBridge(): Promise<{ port: number; token: string; connected: boolean }>;
  capture(targetId: string): Promise<CaptureFrame>;
  testDetector(config: Record<string, Json>): Promise<DetectionResult>;
  startRecording(
    targetId: string,
    mode: "guided" | "direct",
  ): Promise<RecordingState>;
  recordAction(
    action: Omit<RecordedAction, "id" | "at">,
    perform: boolean,
  ): Promise<RecordingState>;
  stopRecording(): Promise<RecordingState>;
  importFlow(): Promise<FlowDefinition | null>;
  exportFlow(id: string): Promise<boolean>;
  openExternal(url: string): Promise<void>;
  onEvent(listener: (event: AppEvent) => void): () => void;
}
declare global {
  interface Window {
    relay?: RelayAPI;
  }
}
