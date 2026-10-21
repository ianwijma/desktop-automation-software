import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Storage } from "../src/main/storage";
import { WorkflowEngine } from "../src/engine";
import { connectionSchema } from "../src/shared/validation";
import type { FlowDefinition, RunRecord } from "../src/shared/types";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const database = () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-storage-test-"));
  directories.push(dir);
  return join(dir, "relay.sqlite");
};
function record(id: string, status: RunRecord["status"]): RunRecord {
  return {
    id,
    flowId: "flow",
    flowName: "Flow",
    rootId: id,
    revision: 1,
    status,
    trigger: "manual",
    inputs: {},
    outputs: {},
    createdAt: "2026-01-01T00:00:00Z",
    events: [],
    childIds: [],
  };
}

describe("durable local storage", () => {
  it("persists flows/settings across restart and seeds only once", () => {
    const path = database();
    const first = new Storage(path);
    const seeded = first.list("flows");
    expect(seeded.length).toBeGreaterThan(0);
    first.put("flows", { ...seeded[0], name: "My edited flow", revision: 7 });
    first.setMeta("settings", { ...first.settings(), accent: "#123456" });
    first.close();
    const second = new Storage(path);
    expect(second.list("flows")).toHaveLength(seeded.length);
    expect(second.get("flows", seeded[0].id)?.name).toBe("My edited flow");
    expect(second.settings().accent).toBe("#123456");
    second.close();
  });

  it("marks queued/running/paused runs interrupted after a crash without replaying them", () => {
    const path = database();
    const first = new Storage(path);
    for (const status of [
      "queued",
      "running",
      "paused",
      "succeeded",
      "failed",
      "cancelled",
    ] as const)
      first.put("runs", record(status, status));
    first.close();
    const recovered = new Storage(path);
    for (const status of ["queued", "running", "paused"]) {
      const run = recovered.get("runs", status)!;
      expect(run.status).toBe("interrupted");
      expect(run.error).toContain("Review");
      expect(run.finishedAt).toBeTruthy();
    }
    for (const status of ["succeeded", "failed", "cancelled"])
      expect(recovered.get("runs", status)?.status).toBe(status);
    recovered.close();
  });

  it("rolls back atomic writes and keeps credential ciphertext out of public connection records", () => {
    const store = new Storage(":memory:");
    expect(() =>
      store.transaction(() => {
        store.setMeta("temporary", "value");
        throw new Error("Abort");
      }),
    ).toThrow("Abort");
    expect(store.meta("temporary")).toBeUndefined();
    const connection = connectionSchema.parse({
      id: "ai",
      name: "AI",
      provider: "openai",
      baseUrl: "https://example.invalid/v1",
      model: "model",
      capabilities: { text: true, vision: false, structured: true },
      hasKey: true,
      apiKey: "must-not-persist",
    });
    store.put("connections", connection);
    store.setCredential("ai", "os-encrypted-ciphertext");
    expect(store.credential("ai")).toBe("os-encrypted-ciphertext");
    expect(JSON.stringify(store.list("connections"))).not.toMatch(
      /must-not-persist|ciphertext|apiKey/,
    );
    store.deleteCredential("ai");
    expect(store.credential("ai")).toBeUndefined();
    store.close();
  });

  it("persists engine progress with redacted secrets and immutable revision metadata", async () => {
    const store = new Storage(":memory:");
    const flow: FlowDefinition = {
      id: "secret",
      schemaVersion: 1,
      name: "Secret flow",
      description: "",
      folder: "",
      revision: 9,
      createdAt: "",
      updatedAt: "",
      inputs: {},
      outputs: { echoed: "${inputs.secret}" },
      nodes: [
        {
          id: "start",
          kind: "start",
          label: "Start",
          config: {},
          position: { x: 0, y: 0 },
        },
        {
          id: "end",
          kind: "end",
          label: "End",
          config: {},
          position: { x: 1, y: 0 },
        },
      ],
      edges: [{ id: "edge", source: "start", target: "end" }],
    };
    const engine = new WorkflowEngine({
      getFlows: () => [flow],
      getTargets: () => [],
      executeNode: async () => undefined,
      onRun: (run) => {
        store.put("runs", run);
      },
    });
    const run = engine.submit("secret", { secret: "private-value" });
    await engine.wait(run.id);
    const persisted = store.get("runs", run.id)!;
    expect(persisted.status).toBe("succeeded");
    expect(persisted.revision).toBe(9);
    expect(JSON.stringify(persisted)).not.toContain("private-value");
    expect(persisted.events.length).toBeGreaterThan(2);
    store.close();
  });

  it("prunes old completed history while preserving active runs", () => {
    const store = new Storage(":memory:");
    const old = new Date(Date.now() - 40 * 86400000).toISOString();
    store.put("runs", { ...record("old", "succeeded"), finishedAt: old });
    store.put("runs", record("active", "running"));
    store.put("runs", {
      ...record("recent", "succeeded"),
      finishedAt: new Date().toISOString(),
    });
    store.pruneHistory(30);
    expect(store.list("runs").map((run) => run.id)).toEqual([
      "active",
      "recent",
    ]);
    store.close();
  });

  it("preserves complete run trees until every member has expired", () => {
    const store = new Storage(":memory:");
    const old = new Date(Date.now() - 40 * 86400000).toISOString();
    store.put("runs", record("active-parent", "running"));
    store.put("runs", {
      ...record("old-child", "succeeded"),
      rootId: "active-parent",
      parentId: "active-parent",
      finishedAt: old,
    });
    store.put("runs", {
      ...record("old-parent", "succeeded"),
      finishedAt: old,
    });
    store.put("runs", {
      ...record("recent-child", "succeeded"),
      rootId: "old-parent",
      parentId: "old-parent",
      finishedAt: new Date().toISOString(),
    });
    store.put("runs", {
      ...record("expired-parent", "succeeded"),
      finishedAt: old,
    });
    store.put("runs", {
      ...record("expired-child", "succeeded"),
      rootId: "expired-parent",
      parentId: "expired-parent",
      finishedAt: old,
    });
    store.pruneHistory(30);
    expect(store.list("runs").map((run) => run.id)).toEqual([
      "active-parent",
      "old-child",
      "old-parent",
      "recent-child",
    ]);
    store.close();
  });
});
