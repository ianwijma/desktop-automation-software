import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { previewAPI } from "./preview-api";
import { validateFlow } from "../engine/validation";
import type { FlowDefinition, WorkspaceState } from "../shared/types";

const key = "relay.preview.v1";
let values: Map<string, string>;
beforeEach(() => {
  values = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (name: string) => values.get(name) ?? null,
    setItem: (name: string, value: string) => values.set(name, value),
  });
  let pending = Promise.resolve<unknown>(undefined);
  vi.stubGlobal("navigator", {
    locks: {
      request: (_name: string, operation: () => unknown) => {
        const next = pending.then(operation);
        pending = next.catch(() => undefined);
        return next;
      },
    },
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function seed() {
  const state = await previewAPI.bootstrap();
  values.set(key, JSON.stringify(state));
  return state;
}

async function imported(data: unknown) {
  const input: {
    type?: string;
    accept?: string;
    files: { size: number; text: () => Promise<string> }[];
    onchange?: () => void;
    addEventListener: () => void;
    click: () => void;
  } = {
    files: [{ size: 100, text: async () => JSON.stringify(data) }],
    addEventListener() {},
    click() {
      this.onchange?.();
    },
  };
  vi.stubGlobal("document", { createElement: () => input });
  return previewAPI.importFlow();
}

describe("browser preview persistence", () => {
  it("migrates v1 storage without changing revisions or node configuration", async () => {
    const state = await seed();
    const legacy = {
      ...state,
      flows: state.flows.map((flow) => ({ ...flow, schemaVersion: 1 })),
    };
    values.set(key, JSON.stringify(legacy));
    const migrated = await previewAPI.bootstrap();
    expect(migrated.flows.every((flow) => flow.schemaVersion === 2)).toBe(true);
    expect(migrated.flows[0].revision).toBe(legacy.flows[0].revision);
    expect(migrated.flows[0].nodes).toEqual(legacy.flows[0].nodes);
    expect(JSON.parse(values.get(key)!).flows[0].schemaVersion).toBe(2);
  });

  it("rejects future schemas and preserves their complete original storage", async () => {
    const state = await seed();
    const future = JSON.stringify({
      ...state,
      flows: [{ ...state.flows[0], schemaVersion: 99 }],
    });
    values.set(key, future);
    await expect(previewAPI.bootstrap()).rejects.toThrow(
      "Unsupported workflow schema version",
    );
    await expect(
      previewAPI.saveSettings({ ...state.settings, accent: "#123456" }),
    ).rejects.toThrow("Unsupported workflow schema version");
    expect(values.get(key)).toBe(future);
  });

  it("serializes simultaneous saves so a stale tab cannot overwrite the winner", async () => {
    const state = await seed();
    const flow = state.flows[0];
    const results = await Promise.all([
      previewAPI.saveFlow(
        { ...flow, name: "First tab" },
        { expectedRevision: flow.revision },
      ),
      previewAPI.saveFlow(
        { ...flow, name: "Second tab" },
        { expectedRevision: flow.revision },
      ),
    ]);
    expect(results[0].status).toBe("saved");
    expect(results[1].status).toBe("conflict");
    const saved = (await previewAPI.bootstrap()).flows.find(
      (item) => item.id === flow.id,
    )!;
    expect(saved.name).toBe("First tab");
    expect(saved.revision).toBe(flow.revision + 1);
    await previewAPI.saveSettings({ ...state.settings, accent: "#123456" });
    expect(
      (await previewAPI.bootstrap()).flows.find((item) => item.id === flow.id),
    ).toEqual(saved);
  });

  it("requires create-only writes for new IDs and never resurrects deleted flows", async () => {
    const state = await seed();
    const fresh = { ...state.flows[0], id: "preview-new", revision: 41 };
    expect(
      await previewAPI.saveFlow(fresh, { expectedRevision: 41 }),
    ).toMatchObject({ status: "conflict" });
    expect(
      await previewAPI.saveFlow(fresh, { expectedRevision: null }),
    ).toMatchObject({
      status: "saved",
      flow: { revision: 1, schemaVersion: 2 },
    });
    expect(
      await previewAPI.saveFlow(fresh, { expectedRevision: null }),
    ).toMatchObject({ status: "conflict" });
    await previewAPI.deleteFlow(fresh.id);
    expect(
      await previewAPI.saveFlow(fresh, { expectedRevision: 1 }),
    ).toMatchObject({ status: "conflict" });
    expect(
      (await previewAPI.bootstrap()).flows.some((flow) => flow.id === fresh.id),
    ).toBe(false);
  });

  it("uses the same graph and configuration validator as execution", async () => {
    const state = await seed();
    const invalid: FlowDefinition = {
      ...state.flows[0],
      nodes: [
        {
          id: "start",
          kind: "start",
          label: "Start",
          position: { x: 0, y: 0 },
          config: {},
        },
      ],
      edges: [
        {
          id: "broken",
          source: "start",
          target: "missing",
          port: "not-a-port",
        },
      ],
    };
    const flows = state.flows.map((flow) =>
      flow.id === invalid.id ? invalid : flow,
    );
    const issues = await previewAPI.validateFlow(invalid);
    expect(issues).toEqual(
      validateFlow(invalid, flows, {
        targets: state.targets,
        connections: state.connections,
        settings: state.settings,
      }),
    );
    expect(issues.some((issue) => issue.severity === "error")).toBe(true);
  });

  it("migrates imported v1 flows and rejects future imports without a partial write", async () => {
    const state = await seed();
    const legacy = { ...state.flows[0], schemaVersion: 1 };
    const flow = await imported(legacy);
    expect(flow).toMatchObject({ schemaVersion: 2, revision: 1 });
    expect(flow?.id).not.toBe(legacy.id);
    const original = values.get(key);
    await expect(imported({ ...legacy, schemaVersion: 99 })).rejects.toThrow(
      "Unsupported workflow schema version",
    );
    expect(values.get(key)).toBe(original);
    expect((JSON.parse(original!) as WorkspaceState).flows).toHaveLength(
      state.flows.length + 1,
    );
  });

  it("rejects unsupported or ambiguous bundles without importing any member", async () => {
    const state = await seed();
    const bundle = {
      format: "relay",
      version: 2,
      rootId: state.flows[0].id,
      flows: [state.flows[0]],
      targets: [state.targets[0]],
    };
    const original = values.get(key);
    const invalid = [
      { ...bundle, version: 99 },
      { ...bundle, format: "other" },
      { ...bundle, flows: [state.flows[0], state.flows[0]] },
      { ...bundle, targets: [state.targets[0], state.targets[0]] },
      { ...bundle, rootId: "missing-root" },
    ];
    for (const value of invalid) {
      await expect(imported(value)).rejects.toThrow();
      expect(values.get(key)).toBe(original);
    }
    const flow = await imported(bundle);
    expect(flow?.id).not.toBe(bundle.rootId);
    expect(flow).toMatchObject({ schemaVersion: 2, revision: 1 });
    const persisted = JSON.parse(values.get(key)!) as WorkspaceState;
    expect(persisted.flows).toHaveLength(state.flows.length + 1);
    expect(persisted.targets).toHaveLength(state.targets.length + 1);
  });

  it("exports a version 2 bundle that can be imported again", async () => {
    vi.useFakeTimers();
    const state = await seed();
    let blob: Blob | undefined;
    vi.spyOn(URL, "createObjectURL").mockImplementation((value) => {
      blob = value as Blob;
      return "blob:relay-export";
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    vi.stubGlobal("document", { createElement: () => ({ click() {} }) });
    await expect(previewAPI.exportFlow(state.flows[0].id)).resolves.toBe(true);
    const bundle = JSON.parse(await blob!.text());
    expect(bundle).toMatchObject({
      format: "relay",
      version: 2,
      rootId: state.flows[0].id,
    });
    expect(
      bundle.flows.every((flow: FlowDefinition) => flow.schemaVersion === 2),
    ).toBe(true);
    expect(await imported(bundle)).toMatchObject({
      schemaVersion: 2,
      revision: 1,
    });
    vi.runAllTimers();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:relay-export");
  });
});
