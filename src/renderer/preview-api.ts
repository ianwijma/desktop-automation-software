import type {
  RelayAPI,
  WorkspaceState,
  AppEvent,
  FlowDefinition,
  Json,
} from "../shared/types";
import {
  migrateFlow,
  parseFlowBundle,
  prepareFlowSave,
} from "../shared/flow-persistence";
import { validateFlow } from "../engine/validation";
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
  const saved = localStorage.getItem(KEY);
  if (saved) {
    let parsed: Partial<WorkspaceState>;
    try {
      parsed = JSON.parse(saved) as Partial<WorkspaceState>;
    } catch {
      throw new Error(
        "The saved browser workspace is not valid JSON. Its original data has been preserved.",
      );
    }
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.flows))
      throw new Error(
        "The saved browser workspace has an invalid format. Its original data has been preserved.",
      );
    state.flows = parsed.flows.map(migrateFlow);
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
  return state;
}
const copy = <T>(value: T): T => structuredClone(value);
function notify() {
  listeners.forEach((fn) => fn({ type: "workspace" }));
}
async function locked<T>(operation: () => T): Promise<T> {
  if (!globalThis.navigator?.locks)
    throw new Error(
      "Saving the preview requires a browser with Web Locks support. Use a current browser on localhost or HTTPS.",
    );
  return navigator.locks.request(KEY, operation);
}
async function mutate<T>(
  operation: (state: WorkspaceState) => T,
  shouldSave: (result: T) => boolean = () => true,
): Promise<T> {
  return locked(() => {
    const latest = load();
    const result = operation(latest);
    if (shouldSave(result)) {
      localStorage.setItem(KEY, JSON.stringify({ ...latest, runs: [] }));
      notify();
    }
    return copy(result);
  });
}
function upsert<T extends { id: string }>(list: T[], item: T) {
  const index = list.findIndex((x) => x.id === item.id);
  if (index < 0) list.push(copy(item));
  else list[index] = copy(item);
}
export const previewAPI: RelayAPI = {
  async bootstrap() {
    const state = load();
    const saved = localStorage.getItem(KEY);
    if (
      saved &&
      (JSON.parse(saved) as { flows: { schemaVersion: number }[] }).flows.some(
        (flow) => flow.schemaVersion === 1,
      )
    )
      return locked(() => {
        const latest = load();
        localStorage.setItem(KEY, JSON.stringify({ ...latest, runs: [] }));
        return copy(latest);
      });
    return copy(state);
  },
  async saveFlow(flow, { expectedRevision }) {
    return mutate(
      (state) => {
        const result = prepareFlowSave(
          { ...flow, updatedAt: new Date().toISOString() },
          state.flows.find((item) => item.id === flow.id),
          expectedRevision,
        );
        if (result.status === "saved") upsert(state.flows, result.flow);
        return result;
      },
      (result) => result.status === "saved",
    );
  },
  async deleteFlow(id) {
    return mutate((state) => {
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
    });
  },
  async validateFlow(flow) {
    const state = load();
    return validateFlow(
      flow,
      state.flows
        .map((item) => (item.id === flow.id ? flow : item))
        .concat(state.flows.some((item) => item.id === flow.id) ? [] : [flow]),
      {
        targets: state.targets,
        connections: state.connections,
        settings: state.settings,
      },
    );
  },
  async runFlow() {
    return unavailable("Running flows");
  },
  async controlRun() {
    unavailable("Run control");
  },
  async saveSettings(settings) {
    return mutate((state) => {
      state.settings = copy(settings);
      return settings;
    });
  },
  async saveConnection(connection, apiKey) {
    if (apiKey)
      throw new Error(
        "API keys cannot be saved in the web preview. Add your key in the desktop application.",
      );
    const next = { ...connection, hasKey: false };
    return mutate((state) => {
      upsert(state.connections, next);
      return next;
    });
  },
  async deleteConnection(id) {
    return mutate((state) => {
      state.connections = state.connections.filter((x) => x.id !== id);
    });
  },
  async testConnection() {
    return unavailable("Testing AI connections");
  },
  async saveTarget(target) {
    return mutate((state) => {
      upsert(state.targets, target);
      return target;
    });
  },
  async deleteTarget(id) {
    return mutate((state) => {
      state.targets = state.targets.filter((x) => x.id !== id);
    });
  },
  async saveSchedule(schedule) {
    return mutate((state) => {
      upsert(state.schedules, schedule);
      return schedule;
    });
  },
  async deleteSchedule(id) {
    return mutate((state) => {
      state.schedules = state.schedules.filter((x) => x.id !== id);
    });
  },
  async getCapabilities() {
    return copy(load().capabilities);
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
    return copy(load().recording);
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
          .then(async (text) => {
            const { flows, targets, rootId } = parseFlowBundle(
              JSON.parse(text),
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
            await mutate((state) => {
              targets.forEach((target) =>
                upsert(state.targets, {
                  ...target,
                  id: targetIds.get(target.id)!,
                }),
              );
              imported.forEach((flow) => upsert(state.flows, flow));
            });
            resolve(
              copy(
                imported.find((flow) => flow.id === flowIds.get(rootId)) ??
                  imported[0],
              ),
            );
          })
          .catch(reject);
      };
      input.click();
    });
  },
  async exportFlow(id) {
    const state = load();
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
      version: 2,
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
    const onStorage = (event: StorageEvent) => {
      if (event.key === KEY || event.key === null)
        listener({ type: "workspace" });
    };
    window.addEventListener("storage", onStorage);
    return () => {
      listeners.delete(listener);
      window.removeEventListener("storage", onStorage);
    };
  },
};
