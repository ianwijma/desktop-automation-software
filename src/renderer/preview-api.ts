import type {
  RelayAPI,
  WorkspaceState,
  AppEvent,
  FlowDefinition,
  ValidationIssue,
  Json,
} from "../shared/types";
import { flowSchema, targetSchema } from "../shared/validation";
import {
  createSeedFlows,
  defaultSettings,
  defaultTargets,
  defaultCapabilities,
} from "../shared/seed";
const KEY = "relay.preview.v1";
const listeners = new Set<(event: AppEvent) => void>();
const unavailable = (feature: string): never => {
  throw new Error(
    `${feature} requires the Relay desktop application. This browser preview supports designing and saving flows only.`,
  );
};
function load(): WorkspaceState {
  const state: WorkspaceState = {
    flows: createSeedFlows(),
    targets: structuredClone(defaultTargets),
    connections: [],
    schedules: [],
    runs: [],
    settings: { ...defaultSettings },
    capabilities: {
      ...defaultCapabilities,
      platform: "browser",
      session: "Web preview",
      capture: false,
      input: false,
      directRecording: false,
      globalShortcuts: false,
      windows: [],
      reasons: [
        "Native execution, recording, AI requests, and schedules are available in the desktop application.",
      ],
    },
    recording: { active: false, mode: "guided", actions: [] },
    desktop: false,
  };
  try {
    const saved = localStorage.getItem(KEY);
    if (saved) {
      const parsed = JSON.parse(saved) as Partial<WorkspaceState>;
      if (Array.isArray(parsed.flows)) state.flows = parsed.flows;
      if (Array.isArray(parsed.targets)) state.targets = parsed.targets;
      if (Array.isArray(parsed.connections))
        state.connections = parsed.connections.map((c) => ({
          ...c,
          hasKey: false,
        }));
      if (Array.isArray(parsed.schedules)) state.schedules = parsed.schedules;
      if (parsed.settings)
        state.settings = { ...state.settings, ...parsed.settings };
    }
  } catch {
    /* A corrupt preview cache must not prevent the workspace opening. */
  }
  return state;
}
let state = load();
const copy = <T>(value: T): T => structuredClone(value);
function persist() {
  localStorage.setItem(KEY, JSON.stringify({ ...state, runs: [] }));
  listeners.forEach((fn) => fn({ type: "workspace" }));
}
function upsert<T extends { id: string }>(list: T[], item: T) {
  const index = list.findIndex((x) => x.id === item.id);
  if (index < 0) list.push(copy(item));
  else list[index] = copy(item);
}
function validate(flow: FlowDefinition): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!flow.name.trim())
    issues.push({ severity: "error", message: "Give this flow a name." });
  if (flow.nodes.filter((n) => n.kind === "start").length !== 1)
    issues.push({
      severity: "error",
      message: "A flow needs exactly one Start node.",
    });
  const ids = new Set(flow.nodes.map((n) => n.id));
  for (const edge of flow.edges)
    if (!ids.has(edge.source) || !ids.has(edge.target))
      issues.push({
        severity: "error",
        message: "A connection refers to a missing node.",
      });
  for (const node of flow.nodes) {
    if (node.kind !== "start" && !flow.edges.some((e) => e.target === node.id))
      issues.push({
        nodeId: node.id,
        severity: "warning",
        message: `${node.label} is not connected to a previous step.`,
      });
    if (node.kind === "ai" && !node.config.connectionId)
      issues.push({
        nodeId: node.id,
        severity: "error",
        message: `Choose an AI connection for ${node.label}.`,
      });
    if (
      ["launch", "attach", "click", "navigate", "detect"].includes(node.kind) &&
      !node.config.targetId
    )
      issues.push({
        nodeId: node.id,
        severity: "error",
        message: `Choose a target for ${node.label}.`,
      });
  }
  return issues;
}
export const previewAPI: RelayAPI = {
  async bootstrap() {
    return copy(state);
  },
  async saveFlow(flow) {
    const next = {
      ...copy(flow),
      revision: flow.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    upsert(state.flows, next);
    persist();
    return copy(next);
  },
  async deleteFlow(id) {
    if (
      state.flows.some(
        (f) =>
          f.id !== id &&
          f.nodes.some((n) =>
            JSON.stringify(n.config).includes(JSON.stringify(id)),
          ),
      )
    )
      throw new Error(
        "Another flow calls this flow. Remove that reference first.",
      );
    state.flows = state.flows.filter((f) => f.id !== id);
    state.schedules = state.schedules.filter((item) => item.flowId !== id);
    persist();
  },
  async validateFlow(flow) {
    return validate(flow);
  },
  async runFlow() {
    return unavailable("Running flows");
  },
  async controlRun() {
    unavailable("Run control");
  },
  async saveSettings(settings) {
    state.settings = copy(settings);
    persist();
    return copy(settings);
  },
  async saveConnection(connection, apiKey) {
    if (apiKey)
      throw new Error(
        "API keys cannot be saved in the web preview. Add your key in the desktop application.",
      );
    const next = { ...connection, hasKey: false };
    upsert(state.connections, next);
    persist();
    return copy(next);
  },
  async deleteConnection(id) {
    state.connections = state.connections.filter((x) => x.id !== id);
    persist();
  },
  async testConnection() {
    return unavailable("Testing AI connections");
  },
  async saveTarget(target) {
    upsert(state.targets, target);
    persist();
    return copy(target);
  },
  async deleteTarget(id) {
    state.targets = state.targets.filter((x) => x.id !== id);
    persist();
  },
  async saveSchedule(schedule) {
    upsert(state.schedules, schedule);
    persist();
    return copy(schedule);
  },
  async deleteSchedule(id) {
    state.schedules = state.schedules.filter((x) => x.id !== id);
    persist();
  },
  async getCapabilities() {
    return copy(state.capabilities);
  },
  async capture() {
    return unavailable("Window capture");
  },
  async testDetector() {
    return unavailable("Testing detectors");
  },
  async startRecording() {
    return unavailable("Recording");
  },
  async recordAction() {
    return unavailable("Recording");
  },
  async stopRecording() {
    return copy(state.recording);
  },
  async importFlow() {
    return new Promise((resolve, reject) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".relay,.json,application/json";
      input.addEventListener("cancel", () => resolve(null), { once: true });
      input.onchange = () => {
        const file = input.files?.[0];
        if (!file) {
          resolve(null);
          return;
        }
        if (file.size > 12000000) {
          reject(new Error("Workflow bundles must be smaller than 12 MB."));
          return;
        }
        void file
          .text()
          .then((text) => {
            const data = JSON.parse(text) as {
              flows?: unknown[];
              targets?: unknown[];
              rootId?: string;
            };
            const flows = (data.flows ?? [data]).map((item) =>
              flowSchema.parse(item),
            );
            if (!flows.length || flows.length > 200)
              throw new Error("A bundle must contain between 1 and 200 flows.");
            const targets = (data.targets ?? []).map((item) =>
              targetSchema.parse(item),
            );
            const flowIds = new Map(
              flows.map((flow) => [flow.id, crypto.randomUUID()]),
            );
            const targetIds = new Map(
              targets.map((target) => [target.id, crypto.randomUUID()]),
            );
            function remap(value: Json, key?: string): Json {
              if (typeof value === "string")
                return key === "flowId"
                  ? (flowIds.get(value) ?? value)
                  : key === "targetId"
                    ? (targetIds.get(value) ?? value)
                    : value;
              if (Array.isArray(value))
                return value.map((item) =>
                  remap(item, key === "flowIds" ? "flowId" : undefined),
                );
              if (value && typeof value === "object")
                return Object.fromEntries(
                  Object.entries(value).map(([k, v]) => [k, remap(v, k)]),
                );
              return value;
            }
            const imported = flows.map((flow) => ({
              ...flow,
              id: flowIds.get(flow.id)!,
              nodes: flow.nodes.map((node) => ({
                ...node,
                config: remap(node.config) as Record<string, Json>,
              })),
              revision: 1,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            }));
            targets.forEach((target) =>
              upsert(state.targets, {
                ...target,
                id: targetIds.get(target.id)!,
              }),
            );
            imported.forEach((flow) => upsert(state.flows, flow));
            persist();
            resolve(
              copy(
                imported.find(
                  (flow) => flow.id === flowIds.get(data.rootId ?? flows[0].id),
                ) ?? imported[0],
              ),
            );
          })
          .catch(reject);
      };
      input.click();
    });
  },
  async exportFlow(id) {
    const flows: FlowDefinition[] = [];
    const visited = new Set<string>();
    function visit(flowId: string) {
      if (visited.has(flowId)) return;
      visited.add(flowId);
      const flow = state.flows.find((item) => item.id === flowId);
      if (!flow) throw new Error("A referenced child flow is missing.");
      flows.push(flow);
      for (const node of flow.nodes) {
        if (typeof node.config.flowId === "string" && node.config.flowId)
          visit(node.config.flowId);
        if (Array.isArray(node.config.flowIds))
          node.config.flowIds.forEach((value) => visit(String(value)));
        if (Array.isArray(node.config.children))
          for (const child of node.config.children)
            if (
              child &&
              typeof child === "object" &&
              !Array.isArray(child) &&
              typeof child.flowId === "string"
            )
              visit(child.flowId);
      }
    }
    visit(id);
    const targetIds = new Set(
      flows.flatMap((flow) => flow.nodes.map((node) => node.config.targetId)),
    );
    const bundle = {
      format: "relay",
      version: 1,
      rootId: id,
      flows,
      targets: state.targets.filter((target) => targetIds.has(target.id)),
    };
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `${flows[0].name.replace(/[^a-z0-9_-]/gi, "-")}.relay`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  },
  async browserBridge() {
    return unavailable("Browser extension pairing");
  },
  async openExternal(url) {
    if (!/^https?:\/\//.test(url))
      throw new Error("Only web links are supported.");
    window.open(url, "_blank", "noopener,noreferrer");
  },
  onEvent(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
