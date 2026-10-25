import { describe, expect, it, vi } from "vitest";
import {
  RecordingController,
  RecordingStorageTimeoutError,
  type RecordingControllerOptions,
} from "../src/main/recording-controller";
import { emptyRecording } from "../src/shared/recording";
import { boundedJson, recordingStateSchema } from "../src/shared/validation";
import type {
  FlowDefinition,
  RecordedAction,
  RecordingState,
  TargetDescriptor,
} from "../src/shared/types";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const action = (text = "hello"): Omit<RecordedAction, "id" | "at"> => ({
  kind: "type",
  label: "Type text",
  config: { text },
});
const flow: FlowDefinition = {
  id: "flow",
  name: "Bound destination",
  revision: 5,
  schemaVersion: 2,
  nodes: [],
  edges: [],
  inputs: {},
  outputs: {},
  description: "",
  folder: "",
  createdAt: "",
  updatedAt: "",
};
const start = {
  flowId: "flow",
  flowRevision: 5,
  targetId: "app",
  mode: "guided" as const,
  anchorNodeId: "tail",
};
function fixture(overrides: Partial<RecordingControllerOptions> = {}) {
  let serial = 0;
  const targets: TargetDescriptor[] = [
    { id: "app", name: "App", kind: "desktop" },
    { id: "browser", name: "Browser", kind: "browser" },
  ];
  const saved: RecordingState[] = [],
    events: RecordingState[] = [];
  const callbacks: ((action: RecordedAction) => void)[] = [];
  const options: RecordingControllerOptions = {
    getTarget: (id) => targets.find((target) => target.id === id),
    getFlow: () => structuredClone(flow),
    canStart: vi.fn(),
    persist: vi.fn(async (state) => {
      saved.push(structuredClone(state));
      return structuredClone(state);
    }),
    insert: vi.fn(async () => ({ flow, recording: emptyRecording() })),
    startDirect: vi.fn(async (_target, callback) => {
      callbacks.push(callback);
    }),
    stopDirect: vi.fn(async () => undefined),
    releaseInputs: vi.fn(async () => undefined),
    execute: vi.fn(async () => undefined),
    onState: vi.fn((state) => events.push(state)),
    newId: () => `id-${++serial}`,
    now: () => 100,
    ...overrides,
  };
  return {
    controller: new RecordingController(options),
    options,
    saved,
    events,
    callbacks,
    targets,
  };
}
const observed = (label: string): RecordedAction => ({
  id: label,
  at: 5,
  kind: "type",
  label,
  config: { text: label },
});

describe("recording lifecycle", () => {
  it("locks immediately but waits for durable acknowledgement before events or direct listeners", async () => {
    const gate = deferred<RecordingState>();
    const f = fixture({ persist: vi.fn(() => gate.promise) });
    const pending = f.controller.start({ ...start, mode: "direct" });
    expect(f.controller.isLocked()).toBe(true);
    await vi.waitFor(() => expect(f.options.persist).toHaveBeenCalledOnce());
    expect(f.controller.getState().phase).toBe("idle");
    expect(f.options.startDirect).not.toHaveBeenCalled();
    expect(f.events).toEqual([]);
    gate.resolve(vi.mocked(f.options.persist).mock.calls[0][0]);
    const state = await pending;
    expect(state.phase).toBe("capturing");
    expect(f.options.startDirect).toHaveBeenCalledOnce();
    expect(f.events).toEqual([state]);
  });

  it("serializes guided actions and freezes submitted values", async () => {
    const gate = deferred();
    const executed: string[] = [];
    const f = fixture({
      execute: vi.fn(async (item) => {
        executed.push(String(item.config.text));
        if (executed.length === 1) await gate.promise;
      }),
    });
    const state = await f.controller.start(start);
    const first = f.controller.record(state.sessionId!, action("one"), true);
    const source = action("two");
    const second = f.controller.record(state.sessionId!, source, true);
    source.config.text = "changed after submit";
    await vi.waitFor(() => expect(executed).toEqual(["one"]));
    gate.resolve();
    await first;
    await second;
    expect(executed).toEqual(["one", "two"]);
    expect(
      f.controller.getState().actions.map((item) => item.config.text),
    ).toEqual(["one", "two"]);
  });

  it("pause aborts pending input, awaits release, and preserves the uncertain step without replay", async () => {
    const release = deferred();
    const f = fixture({
      execute: vi.fn(
        async (_action, _target, signal) =>
          new Promise((_resolve, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            }),
          ),
      ),
      releaseInputs: vi.fn(() => release.promise),
    });
    const state = await f.controller.start(start);
    const pending = f.controller.record(state.sessionId!, action(), true);
    await vi.waitFor(() => expect(f.options.execute).toHaveBeenCalledOnce());
    const pause = f.controller.pause(state.sessionId!);
    await vi.waitFor(() =>
      expect(f.options.releaseInputs).toHaveBeenCalledOnce(),
    );
    expect(f.controller.isLocked()).toBe(true);
    expect(f.controller.getState().phase).toBe("capturing");
    release.resolve();
    await pending;
    const paused = await pause;
    expect(paused.phase).toBe("paused");
    expect(paused.actions[0].config.recordingUncertain).toBe(true);
    expect(paused.error).toContain("may have affected");
    expect(f.controller.isLocked()).toBe(false);
    await expect(
      f.controller.record(state.sessionId!, action("blocked"), true),
    ).rejects.toThrow("paused or stopped");
    const review = await f.controller.stop(state.sessionId!);
    expect(review.phase).toBe("review");
    expect(f.options.execute).toHaveBeenCalledOnce();
    expect(f.options.releaseInputs).toHaveBeenCalledOnce();
  });

  it("drains already observed events but ignores late direct callbacks after pause and restart", async () => {
    const f = fixture();
    const state = await f.controller.start({ ...start, mode: "direct" });
    const old = f.callbacks[0];
    old(observed("before pause"));
    const paused = await f.controller.pause(state.sessionId!);
    expect(paused.actions.map((item) => item.label)).toEqual(["before pause"]);
    old(observed("late"));
    await f.controller.resume(state.sessionId!);
    old(observed("old epoch"));
    f.callbacks[1](observed("resumed"));
    const review = await f.controller.stop(state.sessionId!);
    expect(review.actions.map((item) => item.label)).toEqual([
      "before pause",
      "resumed",
    ]);
    await f.controller.discard(review.sessionId!, review.revision);
    const newer = await f.controller.start({ ...start, mode: "direct" });
    old(observed("previous session"));
    await f.controller.stop(newer.sessionId!);
    expect(f.controller.getState().actions).toEqual([]);
  });

  it("rejects stale session IDs and malformed performed configs before adapter calls", async () => {
    const f = fixture();
    const state = await f.controller.start(start);
    expect(() => f.controller.record("old", action(), true)).toThrow(
      "no longer current",
    );
    expect(() => f.controller.pause("old")).toThrow("no longer current");
    expect(() => f.controller.resume("old")).toThrow("no longer current");
    expect(() => f.controller.stop("old")).toThrow("no longer current");
    await expect(f.controller.setTarget("old", "browser")).rejects.toThrow(
      "no longer current",
    );
    await expect(
      f.controller.record(
        state.sessionId!,
        { kind: "click", label: "Invalid", config: { x: "${inputs.x}", y: 0 } },
        true,
      ),
    ).rejects.toThrow("x must");
    await expect(
      f.controller.record(
        state.sessionId!,
        { kind: "wait", label: "Wait", config: { durationMs: 1 } },
        true,
      ),
    ).rejects.toThrow("cannot be performed");
    expect(f.options.execute).not.toHaveBeenCalled();
    expect(f.options.stopDirect).not.toHaveBeenCalled();
  });

  it("keeps ownership on failed cleanup and retries it before review", async () => {
    let fail = true;
    const f = fixture({
      stopDirect: vi.fn(async () => {
        if (fail) throw new Error("Listener still attached");
      }),
    });
    const state = await f.controller.start(start);
    await expect(f.controller.stop(state.sessionId!)).rejects.toThrow(
      "cleanup failed",
    );
    expect(f.controller.getState().phase).toBe("paused");
    expect(f.controller.isLocked()).toBe(true);
    await expect(f.controller.resume(state.sessionId!)).rejects.toThrow(
      "completed cleanup",
    );
    fail = false;
    const review = await f.controller.stop(state.sessionId!);
    expect(review.phase).toBe("review");
    expect(f.controller.isLocked()).toBe(false);
    expect(f.options.stopDirect).toHaveBeenCalledTimes(2);
  });

  it("fences a pending startup on emergency stop even before the session is acknowledged", async () => {
    const gate = deferred<RecordingState>();
    let initial = true;
    const f = fixture({
      persist: vi.fn(async (state) => {
        if (initial) {
          initial = false;
          return gate.promise;
        }
        return state;
      }),
    });
    const startup = f.controller.start({ ...start, mode: "direct" });
    const rejected = expect(startup).rejects.toThrow("interrupted");
    await vi.waitFor(() => expect(f.options.persist).toHaveBeenCalledOnce());
    const stop = f.controller.stopCurrent();
    gate.resolve(vi.mocked(f.options.persist).mock.calls[0][0]);
    await rejected;
    expect((await stop).phase).toBe("review");
    expect(f.options.startDirect).not.toHaveBeenCalled();
    expect(f.controller.isLocked()).toBe(false);
  });

  it("binds destination and target snapshots, allowing only explicit paused target changes", async () => {
    const f = fixture();
    const state = await f.controller.start(start);
    const destination = state.destination;
    await expect(
      f.controller.setTarget(state.sessionId!, "browser"),
    ).rejects.toThrow("Pause recording");
    await f.controller.pause(state.sessionId!);
    f.targets[0].name = "Different app definition";
    await expect(f.controller.resume(state.sessionId!)).rejects.toThrow(
      "target changed",
    );
    await f.controller.setTarget(state.sessionId!, "browser");
    const resumed = await f.controller.resume(state.sessionId!);
    expect(resumed.destination).toEqual(destination);
    expect(resumed.targetId).toBe("browser");
    expect(destination).toEqual({
      flowId: "flow",
      flowRevision: 5,
      flowName: "Bound destination",
      anchorNodeId: "tail",
    });
  });

  it("rechecks active workflows on resume while keeping paused drafts usable", async () => {
    let running = false;
    const f = fixture({
      canStart: () => {
        if (running) throw new Error("Workflow running");
      },
    });
    const state = await f.controller.start(start);
    await f.controller.pause(state.sessionId!);
    running = true;
    await expect(f.controller.resume(state.sessionId!)).rejects.toThrow(
      "Workflow running",
    );
    expect(f.controller.getState().phase).toBe("paused");
    expect(f.controller.isLocked()).toBe(false);
    await f.controller.stop(state.sessionId!);
    expect(f.options.releaseInputs).toHaveBeenCalledOnce();
  });

  it("recovers only into review and makes edits, undo and discard without input", async () => {
    const original: RecordingState = {
      phase: "capturing",
      active: true,
      sessionId: "recovered",
      revision: 7,
      mode: "direct",
      targetId: "app",
      destination: { flowId: "flow", flowRevision: 5, flowName: "Bound" },
      actions: [observed("one"), observed("two")],
    };
    const f = fixture({ initialState: original });
    const recovered = f.controller.getState();
    expect(recovered).toMatchObject({
      phase: "review",
      active: false,
      recovered: true,
    });
    await expect(f.controller.resume(recovered.sessionId!)).rejects.toThrow(
      "Only a paused",
    );
    const edited = await f.controller.update(
      recovered.sessionId!,
      recovered.revision,
      [recovered.actions[1], { ...recovered.actions[0], id: "copy" }],
    );
    await expect(
      f.controller.update(recovered.sessionId!, recovered.revision, []),
    ).rejects.toThrow("draft changed");
    const undone = await f.controller.update(
      edited.sessionId!,
      edited.revision,
      recovered.actions,
    );
    expect(undone.actions).toEqual(original.actions);
    expect(
      await f.controller.discard(undone.sessionId!, undone.revision),
    ).toEqual(emptyRecording());
    expect(f.options.startDirect).not.toHaveBeenCalled();
    expect(f.options.execute).not.toHaveBeenCalled();
    expect(f.options.insert).not.toHaveBeenCalled();
    expect(f.options.releaseInputs).not.toHaveBeenCalled();
  });

  it("retains performed steps through a storage failure and never retries input", async () => {
    let calls = 0;
    const f = fixture({
      persist: vi.fn(async (state) => {
        if (++calls === 2) throw new Error("Disk busy");
        return state;
      }),
    });
    const state = await f.controller.start(start);
    await expect(
      f.controller.record(state.sessionId!, action(), true),
    ).rejects.toThrow("not acknowledged");
    expect(f.controller.getState()).toMatchObject({
      phase: "paused",
      actions: [{ config: { text: "hello" } }],
    });
    const review = await f.controller.stop(state.sessionId!);
    expect(review.actions).toHaveLength(1);
    expect(f.options.execute).toHaveBeenCalledOnce();
  });

  it("preflights aggregate draft size before guided input and leaves review editable after rejected candidates", async () => {
    const f = fixture();
    const state = await f.controller.start(start);
    const source = {
      ...action(),
      config: { text: "hello", template: "x".repeat(6_100_000) },
    };
    await f.controller.record(state.sessionId!, source, true);
    const saved = f.controller.getState();
    await expect(
      f.controller.record(state.sessionId!, source, true),
    ).rejects.toThrow("12 MB limit");
    expect(f.options.execute).toHaveBeenCalledOnce();
    expect(f.controller.getState()).toEqual(saved);
    const review = await f.controller.stop(state.sessionId!);
    await expect(
      f.controller.update(review.sessionId!, review.revision, [
        ...review.actions,
        { ...review.actions[0], id: "second" },
      ]),
    ).rejects.toThrow("12 MB limit");
    await expect(
      f.controller.update(review.sessionId!, review.revision, [
        { ...review.actions[0], label: "x".repeat(201) },
      ]),
    ).rejects.toThrow();
    expect(f.controller.getState()).toEqual(review);
    expect(f.controller.isLocked()).toBe(false);
    const edited = await f.controller.update(
      review.sessionId!,
      review.revision,
      [],
    );
    expect(edited.actions).toEqual([]);
    expect(f.options.execute).toHaveBeenCalledOnce();
  });

  it("pauses direct capture at the aggregate size limit without retaining an unsaveable pending action", async () => {
    const f = fixture();
    const state = await f.controller.start({ ...start, mode: "direct" });
    const source = {
      ...observed("large image"),
      config: { template: "x".repeat(6_100_000) },
    };
    f.callbacks[0](source);
    await vi.waitFor(() =>
      expect(f.controller.getState().actions).toHaveLength(1),
    );
    f.callbacks[0](source);
    await vi.waitFor(() =>
      expect(f.controller.getState().phase).toBe("paused"),
    );
    expect(f.controller.getState().error).toContain("12 MB limit");
    expect(f.controller.isLocked()).toBe(false);
    expect(f.controller.getState().actions).toHaveLength(1);
    expect(f.options.stopDirect).toHaveBeenCalledOnce();
    const review = await f.controller.stop(state.sessionId!);
    expect(review.actions).toHaveLength(1);
    expect(
      await f.controller.discard(review.sessionId!, review.revision),
    ).toEqual(emptyRecording());
    expect(f.options.execute).not.toHaveBeenCalled();
  });

  it("bounds uncertain-action labels and errors within the durable schema", async () => {
    const f = fixture({
      execute: vi.fn(async () => {
        throw new Error("\0".repeat(5000));
      }),
      persist: vi.fn(async (state) => {
        boundedJson(state);
        return recordingStateSchema.parse(state);
      }),
    });
    const state = await f.controller.start(start);
    await expect(
      f.controller.record(
        state.sessionId!,
        { ...action(), label: "x".repeat(200) },
        true,
      ),
    ).rejects.toThrow();
    const paused = f.controller.getState();
    expect(paused.phase).toBe("paused");
    expect(paused.actions[0].label).toContain("execution uncertain");
    expect(paused.actions[0].label.length).toBeLessThanOrEqual(200);
    expect(paused.error?.length).toBe(4000);
    expect(f.controller.isLocked()).toBe(false);
  });

  it("keeps review on insertion conflict and safely retries an unacknowledged receipt", async () => {
    let attempts = 0;
    const f = fixture({
      insert: vi.fn(async () => {
        attempts++;
        if (attempts === 1) throw new Error("Destination changed");
        if (attempts === 2) throw new RecordingStorageTimeoutError("Ack lost");
        return { flow, recording: emptyRecording() };
      }),
    });
    const state = await f.controller.start(start);
    await f.controller.record(state.sessionId!, action(), false);
    const review = await f.controller.stop(state.sessionId!);
    await expect(
      f.controller.insert(review.sessionId!, review.revision, {
        destination: "bound",
      }),
    ).rejects.toThrow("Destination changed");
    expect(f.controller.getState()).toEqual(review);
    await expect(
      f.controller.insert(review.sessionId!, review.revision, {
        destination: "new",
      }),
    ).rejects.toThrow("Ack lost");
    await expect(
      f.controller.discard(review.sessionId!, review.revision),
    ).rejects.toThrow("Retry Insert");
    const result = await f.controller.insert(
      review.sessionId!,
      review.revision,
      { destination: "new" },
    );
    expect(result.flow).toEqual(flow);
    expect(f.controller.getState()).toEqual(emptyRecording());
    expect(f.options.execute).not.toHaveBeenCalled();
  });

  it("retries exact review/discard candidates after lost acknowledgements without divergent overwrite", async () => {
    let failNext = false;
    let durable = emptyRecording();
    const f = fixture({
      persist: vi.fn(async (state) => {
        if (
          durable.sessionId === state.sessionId &&
          durable.revision === state.revision
        )
          expect(state).toEqual(durable);
        durable = structuredClone(state);
        if (failNext) {
          failNext = false;
          throw new RecordingStorageTimeoutError("Ack lost");
        }
        return state;
      }),
    });
    const started = await f.controller.start(start);
    await f.controller.record(started.sessionId!, action(), false);
    const review = await f.controller.stop(started.sessionId!);
    const actions = [{ ...review.actions[0], label: "Edited" }];
    failNext = true;
    await expect(
      f.controller.update(review.sessionId!, review.revision, actions),
    ).rejects.toThrow("Ack lost");
    expect(f.controller.getState()).toEqual(review);
    const edited = await f.controller.update(
      review.sessionId!,
      review.revision,
      actions,
    );
    expect(edited.actions).toEqual(actions);
    expect(f.controller.isLocked()).toBe(false);
    failNext = true;
    await expect(
      f.controller.update(edited.sessionId!, edited.revision, []),
    ).rejects.toThrow("Ack lost");
    await expect(
      f.controller.update(edited.sessionId!, edited.revision, actions),
    ).rejects.toThrow("draft changed");
    const refreshed = f.controller.getState();
    expect(refreshed.actions).toEqual([]);
    failNext = true;
    await expect(
      f.controller.discard(refreshed.sessionId!, refreshed.revision),
    ).rejects.toThrow("Ack lost");
    expect(
      await f.controller.discard(refreshed.sessionId!, refreshed.revision),
    ).toEqual(emptyRecording());
    expect(f.controller.isLocked()).toBe(false);
    expect(f.options.execute).not.toHaveBeenCalled();
  });

  it("keeps the explicitly selected target snapshot coherent through a failed save", async () => {
    let failNext = false;
    const f = fixture({
      persist: vi.fn(async (state) => {
        if (failNext) {
          failNext = false;
          throw new Error("Disk busy");
        }
        return state;
      }),
    });
    const started = await f.controller.start(start);
    await f.controller.pause(started.sessionId!);
    failNext = true;
    await expect(
      f.controller.setTarget(started.sessionId!, "browser"),
    ).rejects.toThrow("Disk busy");
    expect(f.controller.getState().targetId).toBe("app");
    expect(
      (await f.controller.setTarget(started.sessionId!, "browser")).targetId,
    ).toBe("browser");
    expect((await f.controller.resume(started.sessionId!)).targetId).toBe(
      "browser",
    );
  });
});
