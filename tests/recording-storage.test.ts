import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Storage } from "../src/main/storage";
import { emptyRecording, recordingAnchor } from "../src/shared/recording";
import { validateFlow } from "../src/engine/validation";
import {
  recordedActionsSchema,
  recordingStateSchema,
} from "../src/shared/validation";
import type { FlowDefinition, RecordingState } from "../src/shared/types";

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of directories.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function path() {
  const dir = mkdtempSync(join(tmpdir(), "relay-recording-"));
  directories.push(dir);
  return join(dir, "relay.sqlite");
}
function source(store: Storage): FlowDefinition {
  const flow: FlowDefinition = {
    ...store.list("flows")[0],
    id: "source",
    name: "Source",
    nodes: [
      {
        id: "start",
        kind: "start",
        label: "Start",
        position: { x: 0, y: 0 },
        config: {},
      },
    ],
    edges: [],
    revision: 1,
    inputs: {},
    outputs: {},
  };
  store.put("flows", flow);
  return flow;
}
function draft(
  flow: FlowDefinition,
  phase: RecordingState["phase"] = "review",
): RecordingState {
  return {
    phase,
    active: phase === "capturing",
    sessionId: "session-one",
    revision: 1,
    mode: "guided",
    targetId: "target-one",
    destination: {
      flowId: flow.id,
      flowRevision: flow.revision,
      flowName: flow.name,
      anchorNodeId: "start",
    },
    actions: [
      {
        id: "a",
        at: 1,
        kind: "type",
        label: "Type a value",
        config: {
          targetId: "target-one",
          text: "Hello",
          custom: { flag: false, count: 0, empty: null },
        },
      },
      {
        id: "b",
        at: 2,
        kind: "wait",
        label: "Wait for ready",
        config: {
          targetId: "target-two",
          detector: "text",
          prompt: "Ready",
          timeoutMs: 30000,
        },
      },
    ],
  };
}

describe("durable recording drafts and recovery", () => {
  it.each(["capturing", "paused", "review"] as const)(
    "recovers %s into review with a fixed destination and no resumed capture",
    (phase) => {
      const file = path();
      const first = new Storage(file),
        flow = source(first),
        state = draft(flow, phase);
      first.saveRecording(state);
      first.close();
      const second = new Storage(file);
      const recovered = second.recording();
      expect(recovered).toMatchObject({
        phase: "review",
        active: false,
        recovered: true,
        revision: 2,
        sessionId: state.sessionId,
      });
      expect(recovered.destination).toEqual(state.destination);
      expect(recovered.actions).toEqual(state.actions);
      expect(second.get("flows", flow.id)).toEqual(flow);
      second.close();
    },
  );
  it("accepts lost-ack retries, rejects stale edits or replaced destinations, and keeps only one draft", () => {
    const store = new Storage(":memory:"),
      state = draft(source(store));
    store.saveRecording(state);
    expect(store.saveRecording(structuredClone(state))).toEqual(state);
    expect(() => store.saveRecording({ ...state, sessionId: "other" })).toThrow(
      /existing recording/,
    );
    expect(() =>
      store.saveRecording({
        ...state,
        revision: 2,
        destination: { ...state.destination!, flowId: "other" },
      }),
    ).toThrow(/destination/);
    const edited = { ...state, revision: 2, actions: state.actions.slice(1) };
    store.saveRecording(edited);
    expect(() => store.saveRecording(state)).toThrow(/changed/);
    expect(() => store.saveRecording({ ...edited, actions: [] })).toThrow(
      /changed/,
    );
    expect(store.recording()).toEqual(edited);
    store.close();
  });
  it("discard clears only the draft and stays discarded after restart", () => {
    const file = path(),
      first = new Storage(file),
      flow = source(first);
    first.saveRecording(draft(flow));
    first.saveRecording(emptyRecording());
    first.close();
    const next = new Storage(file);
    expect(next.recording()).toEqual(emptyRecording());
    expect(next.get("flows", flow.id)).toEqual(flow);
    next.close();
  });
  it("rejects an unsupported future draft envelope without rewriting its database", () => {
    const file = path(),
      first = new Storage(file);
    const future = { version: 99, state: draft(source(first), "capturing") };
    first.setMeta("recordingDraft", future);
    first.close();
    expect(() => new Storage(file)).toThrow();
    const db = new DatabaseSync(file, { readOnly: true });
    expect(
      JSON.parse(
        (
          db
            .prepare("SELECT value FROM metadata WHERE key='recordingDraft'")
            .get() as { value: string }
        ).value,
      ),
    ).toEqual(future);
    db.close();
  });
});

describe("explicit recording insertion", () => {
  it("atomically creates a connected flow, consumes the draft, and applies once across retries and restart", () => {
    const file = path(),
      first = new Storage(file),
      origin = source(first),
      state = draft(origin);
    first.saveRecording(state);
    const result = first.insertRecording(state, {
      destination: "new",
      name: "Reviewed steps",
    });
    expect(result.recording).toEqual(emptyRecording());
    expect(result.flow.name).toBe("Reviewed steps");
    expect(result.flow.nodes.map((node) => node.kind)).toEqual([
      "start",
      "type",
      "wait",
      "end",
    ]);
    expect(result.flow.nodes.slice(1, -1).map((node) => node.config)).toEqual(
      state.actions.map((action) => action.config),
    );
    expect(
      validateFlow(result.flow).filter((issue) => issue.severity === "error"),
    ).toEqual([]);
    expect(first.get("flows", origin.id)).toEqual(origin);
    expect(first.insertRecording(state, { destination: "new" }).flow.id).toBe(
      result.flow.id,
    );
    expect(() => first.saveRecording(state)).toThrow(/already been inserted/);
    first.close();
    const second = new Storage(file);
    expect(second.recording()).toEqual(emptyRecording());
    expect(second.insertRecording(state, { destination: "new" }).flow.id).toBe(
      result.flow.id,
    );
    expect(
      second.list("flows").filter((flow) => flow.name === "Reviewed steps"),
    ).toHaveLength(1);
    second.close();
  });
  it("inserts only into the bound revision and explicitly selected free ordinary tail", () => {
    const store = new Storage(":memory:"),
      flow = source(store),
      state = draft(flow);
    store.saveRecording(state);
    const result = store.insertRecording(state, { destination: "bound" });
    expect(result.flow.id).toBe(flow.id);
    expect(result.flow.revision).toBe(2);
    expect(result.flow.edges[0].source).toBe("start");
    expect(
      validateFlow(result.flow).filter((issue) => issue.severity === "error"),
    ).toEqual([]);
    store.close();
  });
  it("preserves review on stale/deleted destinations, occupied ports, invalid sessions, and unsaved edits", () => {
    const store = new Storage(":memory:"),
      flow = source(store),
      state = draft(flow);
    store.saveRecording(state);
    expect(() =>
      store.insertRecording({ ...state, revision: 2 }, { destination: "new" }),
    ).toThrow(/changed/);
    expect(() =>
      store.insertRecording({ ...state, actions: [] }, { destination: "new" }),
    ).toThrow(/changed/);
    store.put("flows", { ...flow, revision: 2 });
    expect(() =>
      store.insertRecording(state, { destination: "bound" }),
    ).toThrow(/workflow changed/);
    store.put("flows", {
      ...flow,
      edges: [{ id: "occupied", source: "start", target: "start" }],
    });
    expect(() =>
      store.insertRecording(state, { destination: "bound" }),
    ).toThrow(/free next port/);
    store.delete("flows", flow.id);
    expect(() =>
      store.insertRecording(state, { destination: "bound" }),
    ).toThrow(/deleted/);
    expect(store.recording()).toEqual(state);
    expect(
      store.insertRecording(state, { destination: "new" }).flow.id,
    ).not.toBe(flow.id);
    store.close();
  });
  it("rolls back both graph and draft consumption when saving fails", () => {
    const store = new Storage(":memory:"),
      state = draft(source(store));
    store.saveRecording(state);
    const before = store.list("flows");
    vi.spyOn(store, "put").mockImplementation(() => {
      throw new Error("Disk full");
    });
    expect(() => store.insertRecording(state, { destination: "new" })).toThrow(
      "Disk full",
    );
    expect(store.recording()).toEqual(state);
    expect(store.list("flows")).toEqual(before);
    expect(store.meta("recordingInsertion")).toBeUndefined();
    store.close();
  });
  it("rejects active/empty drafts and never chooses an anchor implicitly or after a decision/Finish", () => {
    const store = new Storage(":memory:"),
      flow = source(store),
      state = draft(flow, "capturing");
    store.saveRecording(state);
    expect(() => store.insertRecording(state, { destination: "new" })).toThrow(
      /Review/,
    );
    const empty = {
      ...state,
      phase: "review" as const,
      active: false,
      actions: [],
      revision: 2,
    };
    store.saveRecording(empty);
    expect(() => store.insertRecording(empty, { destination: "new" })).toThrow(
      /at least one/,
    );
    expect(recordingAnchor(flow)).toBeUndefined();
    for (const kind of ["end", "condition", "detect"] as const)
      expect(
        recordingAnchor(
          { ...flow, nodes: [{ ...flow.nodes[0], kind }] },
          "start",
        ),
      ).toBeUndefined();
    store.close();
  });
});

describe("recording IPC shapes", () => {
  it("rejects duplicate IDs, non-recordable control nodes, and contradictory phases", () => {
    const store = new Storage(":memory:"),
      state = draft(source(store));
    expect(
      recordedActionsSchema.safeParse([state.actions[0], state.actions[0]])
        .success,
    ).toBe(false);
    expect(
      recordedActionsSchema.safeParse([{ ...state.actions[0], kind: "start" }])
        .success,
    ).toBe(false);
    expect(
      recordingStateSchema.safeParse({ ...state, active: true }).success,
    ).toBe(false);
    expect(
      recordingStateSchema.safeParse({ ...state, destination: undefined })
        .success,
    ).toBe(false);
    store.close();
  });
});
