import { describe, expect, it } from "vitest";
import { Storage } from "../src/main/storage";
import { validateFlow } from "../src/engine/validation";
import {
  applyRecording,
  recordingInsertionPoints,
  recordingPointKey,
} from "../src/shared/recording";
import { recordingInsertSchema } from "../src/shared/validation";
import type {
  FlowDefinition,
  RecordingInsertionAnchor,
  RecordingState,
} from "../src/shared/types";

const flow = (): FlowDefinition => ({
  id: "flow",
  schemaVersion: 2,
  revision: 7,
  name: "Branches",
  description: "Keep my graph",
  folder: "Tests",
  createdAt: "2026-10-25T00:00:00.000Z",
  updatedAt: "2026-10-25T00:00:00.000Z",
  inputs: { flag: true },
  outputs: { result: "${inputs.flag}" },
  nodes: [
    {
      id: "start",
      kind: "start",
      label: "Start",
      config: {},
      position: { x: 0, y: 0 },
    },
    {
      id: "choice",
      kind: "condition",
      label: "Choose",
      config: { left: "${inputs.flag}", operator: "truthy" },
      position: { x: 310, y: 0 },
    },
    {
      id: "yes",
      kind: "end",
      label: "Yes",
      config: {},
      position: { x: 620, y: 0 },
    },
    {
      id: "no",
      kind: "end",
      label: "No",
      config: {},
      position: { x: 620, y: 220 },
    },
  ],
  edges: [
    { id: "enter", source: "start", target: "choice" },
    { id: "on-true", source: "choice", port: "true", target: "yes" },
    { id: "on-false", source: "choice", port: "false", target: "no" },
  ],
});
const anchor: RecordingInsertionAnchor = {
  sourceNodeId: "choice",
  port: "true",
  edgeId: "on-true",
  successorNodeId: "yes",
};
const recording = (source = flow()): RecordingState => ({
  phase: "review",
  active: false,
  sessionId: "session",
  revision: 3,
  mode: "guided",
  targetId: "app",
  destination: {
    flowId: source.id,
    flowRevision: source.revision,
    flowName: source.name,
  },
  actions: [1, 2].map((n) => ({
    id: `step-${n}`,
    kind: "wait",
    label: `Recorded ${n}`,
    config: { durationMs: n, extra: { flag: false, zero: 0, nil: null } },
    at: n,
  })),
});
const ids = () => {
  let n = 0;
  return () => `new-${++n}`;
};

describe("predictable recording insertion", () => {
  it("splices the chosen occupied branch, preserves its successor and all other graph data", () => {
    const before = flow(),
      state = recording(before),
      snapshot = structuredClone(before);
    const result = applyRecording(before, state, ids(), anchor);
    const added = result.nodes.filter(
      (node) => !before.nodes.some((prior) => prior.id === node.id),
    );
    expect(added.map((node) => node.label)).toEqual([
      "Recorded 1",
      "Recorded 2",
    ]);
    expect(result.edges.find((edge) => edge.id === "on-true")).toEqual({
      id: "on-true",
      source: "choice",
      port: "true",
      target: added[0].id,
    });
    expect(
      result.edges.find((edge) => edge.source === added[0].id)?.target,
    ).toBe(added[1].id);
    expect(
      result.edges.find((edge) => edge.source === added[1].id)?.target,
    ).toBe("yes");
    expect(result.edges.find((edge) => edge.id === "on-false")).toEqual(
      before.edges[2],
    );
    expect(result.edges.find((edge) => edge.id === "enter")).toEqual(
      before.edges[0],
    );
    expect(result.nodes.slice(0, before.nodes.length)).toEqual(before.nodes);
    expect(result.inputs).toEqual(before.inputs);
    expect(result.outputs).toEqual(before.outputs);
    expect(added.map((node) => node.config)).toEqual(
      state.actions.map((action) => action.config),
    );
    expect(
      added.every((node) =>
        before.nodes.every(
          (prior) =>
            Math.abs(prior.position.x - node.position.x) >= 280 ||
            Math.abs(prior.position.y - node.position.y) >= 190,
        ),
      ),
    ).toBe(true);
    expect(
      validateFlow(result).filter((issue) => issue.severity === "error"),
    ).toEqual([]);
    expect(before).toEqual(snapshot);
  });
  it("accepts an ordinary next edge without an explicit stored port and a chosen empty branch", () => {
    const before = flow();
    const result = applyRecording(before, recording(before), ids(), {
      sourceNodeId: "start",
      port: "next",
      edgeId: "enter",
      successorNodeId: "choice",
    });
    expect(result.edges.find((edge) => edge.id === "enter")?.target).not.toBe(
      "choice",
    );
    expect(
      result.edges.some(
        (edge) => edge.source.startsWith("new-") && edge.target === "choice",
      ),
    ).toBe(true);
    const empty = applyRecording(before, recording(before), ids(), {
      sourceNodeId: "choice",
      port: "error",
    });
    expect(empty.nodes.filter((node) => node.kind === "end")).toHaveLength(3);
    expect(
      empty.edges.filter(
        (edge) => edge.source === "choice" && edge.port === "true",
      ),
    ).toEqual([before.edges[1]]);
    expect(
      empty.edges.some(
        (edge) => edge.source === "choice" && edge.port === "error",
      ),
    ).toBe(true);
  });
  it("requires an explicit branch and refuses Finish, orphan sources, ambiguous outputs and invalid ports", () => {
    const before = flow(),
      state = recording(before);
    expect(() => applyRecording(before, state, ids())).toThrow(
      /Select an insertion point/,
    );
    for (const invalid of [
      { sourceNodeId: "choice", port: "next" },
      { sourceNodeId: "yes", port: "next" },
      { sourceNodeId: "missing", port: "next" },
    ])
      expect(() => applyRecording(before, state, ids(), invalid)).toThrow(
        /insertion point changed/,
      );
    const orphan = {
      ...before,
      nodes: [...before.nodes, { ...before.nodes[1], id: "orphan" }],
    };
    expect(
      recordingInsertionPoints(orphan).some(
        (point) => point.anchor.sourceNodeId === "orphan",
      ),
    ).toBe(false);
    const ambiguous = {
      ...before,
      edges: [
        ...before.edges,
        { id: "duplicate", source: "choice", port: "true", target: "no" },
      ],
    };
    expect(() =>
      applyRecording(ambiguous, recording(ambiguous), ids(), anchor),
    ).toThrow(/at most one successor/);
    expect(
      recordingInsertionPoints(before)
        .filter((point) => point.anchor.sourceNodeId === "choice")
        .map((point) => point.anchor.port),
    ).toEqual(["true", "false", "error"]);
  });
  it("rechecks exact edge, successor, source, port and flow revision at apply", () => {
    const before = flow(),
      state = recording(before);
    const changed = [
      { ...before, revision: 8 },
      {
        ...before,
        edges: before.edges.filter((edge) => edge.id !== "on-true"),
      },
      {
        ...before,
        edges: before.edges.map((edge) =>
          edge.id === "on-true" ? { ...edge, target: "no" } : edge,
        ),
      },
      {
        ...before,
        edges: before.edges.map((edge) =>
          edge.id === "on-true" ? { ...edge, port: "error" } : edge,
        ),
      },
      {
        ...before,
        nodes: before.nodes.map((node) =>
          node.id === "choice" ? { ...node, kind: "end" as const } : node,
        ),
      },
    ];
    for (const next of changed)
      expect(() => applyRecording(next, state, ids(), anchor)).toThrow(
        /changed|unavailable/,
      );
    expect(() =>
      applyRecording(before, state, ids(), {
        sourceNodeId: "choice",
        port: "true",
      }),
    ).toThrow(/changed/);
    expect(
      recordingInsertSchema.safeParse({
        destination: "bound",
        anchor: { sourceNodeId: "choice", port: "true", edgeId: "on-true" },
      }).success,
    ).toBe(false);
    expect(
      recordingInsertionPoints(before).find(
        (point) => point.key === recordingPointKey(anchor),
      )?.anchor,
    ).toEqual(anchor);
  });
  it("keeps detector branches independent and supports the explicit default fallback", () => {
    const before = flow();
    before.nodes[1] = {
      ...before.nodes[1],
      kind: "detect",
      config: { detector: "color", color: "#ffffff", targetId: "app" },
    };
    before.edges[1].port = "match";
    before.edges[2].port = "no-match";
    const result = applyRecording(before, recording(before), ids(), {
      ...anchor,
      port: "match",
    });
    expect(result.edges.find((edge) => edge.id === "on-false")).toEqual(
      before.edges[2],
    );
    expect(
      recordingInsertionPoints(before)
        .filter((point) => point.anchor.sourceNodeId === "choice")
        .map((point) => point.anchor.port),
    ).toEqual(["match", "no-match", "uncertain", "next", "error"]);
  });
});

describe("transactional insertion and graph undo", () => {
  it("returns the exact pre-insertion graph but never overwrites later edits on an insertion retry", () => {
    const store = new Storage(":memory:"),
      before = flow(),
      state = recording(before);
    store.put("flows", before);
    store.saveRecording(state);
    const inserted = store.insertRecording(state, {
      destination: "bound",
      anchor,
    });
    expect(inserted.previousFlow).toEqual(before);
    expect(inserted.flow.revision).toBe(8);
    const undone = store.saveFlow(inserted.previousFlow!, {
      expectedRevision: inserted.flow.revision,
    });
    expect(undone.status).toBe("saved");
    if (undone.status !== "saved") throw new Error("Undo failed");
    expect(undone.flow.nodes).toEqual(before.nodes);
    expect(undone.flow.edges).toEqual(before.edges);
    const retry = store.insertRecording(state, {
      destination: "bound",
      anchor,
    });
    expect(retry.flow).toEqual(undone.flow);
    expect(retry.previousFlow).toBeUndefined();
    expect(retry.warning).toContain("since changed");
    const redone = store.saveFlow(inserted.flow, {
      expectedRevision: undone.flow.revision,
    });
    expect(redone.status).toBe("saved");
    if (redone.status === "saved") {
      expect(redone.flow.nodes).toEqual(inserted.flow.nodes);
      expect(redone.flow.edges).toEqual(inserted.flow.edges);
    }
    expect(store.recording().phase).toBe("idle");
    store.close();
  });
  it("provides one empty graph for Undo of new-flow insertion without deleting the workflow", () => {
    const store = new Storage(":memory:"),
      before = flow(),
      state = recording(before);
    store.put("flows", before);
    store.saveRecording(state);
    const result = store.insertRecording(state, {
      destination: "new",
      name: "New recording",
    });
    expect(result.previousFlow?.id).toBe(result.flow.id);
    expect(result.previousFlow?.nodes.map((node) => node.kind)).toEqual([
      "start",
      "end",
    ]);
    expect(
      validateFlow(result.previousFlow!).filter(
        (issue) => issue.severity === "error",
      ),
    ).toEqual([]);
    const undone = store.saveFlow(result.previousFlow!, {
      expectedRevision: 1,
    });
    expect(undone.status).toBe("saved");
    expect(store.get("flows", before.id)).toEqual(before);
    store.close();
  });
  it("preserves the draft and original graph on a stale anchor or flow write conflict", () => {
    const store = new Storage(":memory:"),
      before = flow(),
      state = recording(before);
    store.put("flows", before);
    store.saveRecording(state);
    expect(() =>
      store.insertRecording(state, {
        destination: "bound",
        anchor: { ...anchor, successorNodeId: "no" },
      }),
    ).toThrow(/changed/);
    expect(store.get("flows", before.id)).toEqual(before);
    expect(store.recording()).toEqual(state);
    store.put("flows", { ...before, revision: 8 });
    expect(() =>
      store.insertRecording(state, { destination: "bound", anchor }),
    ).toThrow(/workflow changed/);
    expect(store.recording()).toEqual(state);
    expect(store.meta("recordingInsertion")).toBeUndefined();
    store.close();
  });
});
