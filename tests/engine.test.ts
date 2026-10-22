import { describe, expect, it, vi } from "vitest";
import {
  WorkflowEngine,
  validateFlow,
  type EngineOptions,
} from "../src/engine";
import { resolve } from "../src/engine/references";
import { sleep } from "../src/engine/leases";
import type {
  FlowDefinition,
  FlowNode,
  Json,
  TargetDescriptor,
} from "../src/shared/types";

const node = (
  id: string,
  kind: FlowNode["kind"],
  config: Record<string, Json> = {},
): FlowNode => ({ id, kind, label: id, config, position: { x: 0, y: 0 } });
function flow(
  id: string,
  actions: FlowNode[] = [],
  outputs: Record<string, Json> = {},
): FlowDefinition {
  const nodes = [node("start", "start"), ...actions, node("end", "end")];
  return {
    id,
    schemaVersion: 1,
    name: id,
    description: "",
    folder: "",
    revision: 1,
    nodes,
    edges: nodes.slice(0, -1).map((item, index) => ({
      id: `e${index}`,
      source: item.id,
      target: nodes[index + 1].id,
    })),
    inputs: {},
    outputs,
    createdAt: "",
    updatedAt: "",
  };
}
function engine(flows: FlowDefinition[], options: Partial<EngineOptions> = {}) {
  return new WorkflowEngine({
    getFlows: () => flows,
    getTargets: () => [],
    executeNode: async () => undefined,
    ...options,
  });
}
async function eventually(test: () => boolean) {
  for (let i = 0; i < 100 && !test(); i++)
    await new Promise((resolve) => setTimeout(resolve, 2));
  expect(test()).toBe(true);
}

describe("workflow graph and immutable execution", () => {
  it("rejects cycles, duplicate output ports, unreachable nodes and recursive calls", () => {
    const cyclic = flow("cyclic", [
      node("action", "set", { variable: "v", value: 1 }),
    ]);
    cyclic.edges.push({ id: "cycle", source: "action", target: "action" });
    cyclic.nodes.push(node("orphan", "end"));
    const messages = validateFlow(cyclic)
      .map((issue) => issue.message)
      .join(" ");
    expect(messages).toContain("cycles");
    expect(messages).toContain("one connection");
    expect(messages).toContain("unreachable");
    const a = flow("a", [node("call", "call", { flowId: "b" })]);
    const b = flow("b", [node("call", "call", { flowId: "a" })]);
    expect(
      validateFlow(a, [a, b]).some((issue) =>
        issue.message.includes("Recursive"),
      ),
    ).toBe(true);
    expect(() => engine([a, b]).submit("a")).toThrow("Recursive");
  });

  it("resolves typed references, interpolation and conditions without eval", async () => {
    const f = flow(
      "refs",
      [node("set", "set", { variable: "answer", value: "${inputs.value}" })],
      { answer: "${vars.answer}", text: "answer=${vars.answer}" },
    );
    const e = engine([f]);
    const run = await e.wait(e.submit("refs", { value: { number: 42 } }).id);
    expect(run.status).toBe("succeeded");
    expect(run.outputs).toEqual({
      answer: { number: 42 },
      text: 'answer={"number":42}',
    });
    expect(() =>
      resolve("${inputs.__proto__}", { inputs: {}, vars: {}, nodes: {} }),
    ).toThrow("unsafe");
    expect(() =>
      resolve("${process.exit()}", { inputs: {}, vars: {}, nodes: {} }),
    ).toThrow("unsafe");
  });

  it("freezes the full referenced tree and targets before queued work starts", async () => {
    const child = flow(
      "child",
      [node("set", "set", { variable: "value", value: "before" })],
      { value: "${vars.value}" },
    );
    const parent = flow("parent", [node("call", "call", { flowId: "child" })], {
      child: "${nodes.call}",
    });
    const e = engine([parent, child]);
    const queued = e.submit("parent");
    child.nodes[1].config.value = "after";
    child.revision = 2;
    const result = await e.wait(queued.id);
    expect(result.outputs).toEqual({ child: { value: "before" } });
    expect(e.get(result.childIds[0])?.revision).toBe(1);
    result.outputs.child = null;
    expect(e.get(queued.id)?.outputs.child).toEqual({ value: "before" });
  });

  it("runs bounded foreach children with iteration-local references and ordered results", async () => {
    const child = flow("child", [], {
      value: "${inputs.value}",
      index: "${inputs.index}",
    });
    const parent = flow(
      "parent",
      [
        node("loop", "loop", {
          flowId: "child",
          items: "${inputs.items}",
          inputs: { value: "${item.name}" },
          maxIterations: 3,
        }),
      ],
      { items: "${nodes.loop}" },
    );
    const e = engine([parent, child]);
    const result = await e.wait(
      e.submit("parent", { items: [{ name: "a" }, { name: "b" }] }).id,
    );
    expect(result.status).toBe("succeeded");
    expect(result.outputs.items).toEqual([
      { value: "a", index: 0 },
      { value: "b", index: 1 },
    ]);
    expect(
      (await e.wait(e.submit("parent", { items: [1, 2, 3, 4] }).id)).error,
    ).toContain("iteration bound");
  });

  it("supports end-node outputs and condition branches", async () => {
    const f = flow("branch", [
      node("condition", "condition", {
        left: "${inputs.a}",
        operator: "gt",
        right: 2,
      }),
    ]);
    f.nodes.find((item) => item.id === "end")!.config.outputs = {
      answer: "yes",
    };
    f.nodes.push(node("no", "end", { outputs: { answer: "no" } }));
    f.edges[1].port = "true";
    f.edges.push({
      id: "false",
      source: "condition",
      target: "no",
      port: "false",
    });
    const e = engine([f]);
    expect((await e.wait(e.submit("branch", { a: 3 }).id)).outputs.answer).toBe(
      "yes",
    );
    expect((await e.wait(e.submit("branch", { a: 1 }).id)).outputs.answer).toBe(
      "no",
    );
  });

  it("isolates child variables and protects captured scopes and targets from adapter mutation", async () => {
    const child = flow(
      "child",
      [
        node("set", "set", { variable: "value", value: "${inputs.value}" }),
        node("mutate", "ai", { targetId: "browser" }),
        node("inspect", "ai", { targetId: "browser" }),
      ],
      {
        value: "${vars.value}",
        input: "${inputs.value}",
        stored: "${nodes.set}",
      },
    );
    const parent = flow(
      "parent",
      [
        node("group", "group", {
          mode: "pool",
          concurrency: 2,
          children: [
            { flowId: "child", inputs: { value: 1 } },
            { flowId: "child", inputs: { value: 2 } },
          ],
        }),
      ],
      { results: "${nodes.group}" },
    );
    const e = engine([parent, child], {
      getTargets: () => [{ id: "browser", name: "Original", kind: "browser" }],
      executeNode: async (node, context) => {
        if (node.id === "mutate") {
          context.inputs.value = 99;
          context.variables.value = 99;
          context.outputs.set = 99;
          context.target!.name = "Changed";
        } else expect(context.target?.name).toBe("Original");
      },
    });
    const result = await e.wait(e.submit("parent").id);
    expect(result.status).toBe("succeeded");
    expect(result.outputs.results).toEqual([
      { value: 1, input: 1, stored: 1 },
      { value: 2, input: 2, stored: 2 },
    ]);
  });
});

describe("child concurrency", () => {
  for (const mode of ["sequence", "pool", "batches"])
    it(`dispatches twelve children in ${mode} mode, preserves input order`, async () => {
      const child = flow("child", [node("work", "ai")], {
        index: "${inputs.index}",
      });
      const parent = flow(
        "parent",
        [
          node("group", "group", {
            mode,
            concurrency: 3,
            children: Array.from({ length: 12 }, (_, index) => ({
              flowId: "child",
              inputs: { index },
            })),
          }),
        ],
        { children: "${nodes.group}" },
      );
      let running = 0,
        maximum = 0;
      const events: string[] = [];
      const e = engine([parent, child], {
        executeNode: async (_, context) => {
          running++;
          maximum = Math.max(maximum, running);
          events.push(`start:${context.inputs.index}`);
          await sleep(context.inputs.index === 0 ? 30 : 4, context.signal);
          events.push(`end:${context.inputs.index}`);
          running--;
        },
      });
      const result = await e.wait(e.submit("parent").id);
      expect(result.status).toBe("succeeded");
      expect(result.childIds).toHaveLength(12);
      expect(result.outputs.children).toEqual(
        Array.from({ length: 12 }, (_, index) => ({ index })),
      );
      expect(maximum).toBe(mode === "sequence" ? 1 : 3);
      if (mode === "pool")
        expect(events.indexOf("start:3")).toBeLessThan(events.indexOf("end:0"));
      if (mode === "batches")
        expect(events.indexOf("start:3")).toBeGreaterThan(
          events.indexOf("end:0"),
        );
    });

  it("serializes all desktop invocations, including waits, but permits independent browser profiles", async () => {
    const targets: TargetDescriptor[] = [
      { id: "desktop1", name: "a", kind: "desktop" },
      { id: "desktop2", name: "b", kind: "desktop" },
      { id: "browser1", name: "c", kind: "browser", profile: "one" },
      { id: "browser2", name: "d", kind: "browser", profile: "two" },
    ];
    const children = targets.map((target) =>
      flow(target.id, [
        node("work", "click", { targetId: target.id }),
        node("wait", "wait", { durationMs: 10 }),
        node("after", "click", { targetId: target.id }),
      ]),
    );
    const parent = flow("parent", [
      node("group", "group", {
        mode: "pool",
        concurrency: 4,
        flowIds: targets.map((target) => target.id),
      }),
    ]);
    let desktop = 0,
      all = 0,
      maxDesktop = 0,
      maxAll = 0;
    const release = vi.fn(
      async (_runId: string, _physicalInput: boolean) => undefined,
    );
    const e = engine([parent, ...children], {
      getTargets: () => targets,
      releaseInputs: release,
      executeNode: async (node, context) => {
        if (node.id === "work") {
          all++;
          if (context.target?.kind === "desktop") desktop++;
          maxAll = Math.max(maxAll, all);
          maxDesktop = Math.max(maxDesktop, desktop);
        } else {
          all--;
          if (context.target?.kind === "desktop") desktop--;
        }
      },
    });
    expect((await e.wait(e.submit("parent").id)).status).toBe("succeeded");
    expect(maxDesktop).toBe(1);
    expect(maxAll).toBe(3);
    expect(release).toHaveBeenCalledTimes(4);
    expect(release.mock.calls.filter(([, physical]) => physical)).toHaveLength(
      2,
    );
  });

  it("inherits native reservations into nested children without deadlocks or sibling overlap", async () => {
    const target: TargetDescriptor = {
      id: "app",
      name: "App",
      kind: "desktop",
    };
    const leaf = flow("leaf", [
      node("click", "click", { targetId: "app" }),
      node("wait", "wait", { durationMs: 2 }),
    ]);
    const middle = flow("middle", [
      node("group", "group", {
        mode: "pool",
        concurrency: 3,
        flowIds: ["leaf", "leaf", "leaf"],
      }),
    ]);
    const parent = flow("parent", [
      node("click", "click", { targetId: "app" }),
      node("call", "call", { flowId: "middle" }),
    ]);
    let active = 0,
      max = 0;
    const e = engine([parent, middle, leaf], {
      getTargets: () => [target],
      executeNode: async (_, context) => {
        active++;
        max = Math.max(max, active);
        await sleep(2, context.signal);
        active--;
      },
    });
    const first = e.submit("parent");
    const second = e.submit("parent");
    expect(
      (await Promise.all([e.wait(first.id), e.wait(second.id)])).every(
        (run) => run.status === "succeeded",
      ),
    ).toBe(true);
    expect(max).toBe(1);
  });

  it("serializes extension targets sharing a connected browser even with different profile labels", async () => {
    const targets: TargetDescriptor[] = ["one", "two"].map((id) => ({
      id,
      name: id,
      kind: "browser",
      browserMode: "extension",
      profile: id,
    }));
    const children = targets.map((target) =>
      flow(target.id, [node("action", "click", { targetId: target.id })]),
    );
    const parent = flow("parent", [
      node("group", "group", {
        mode: "pool",
        concurrency: 2,
        flowIds: ["one", "two"],
      }),
    ]);
    let active = 0,
      maximum = 0;
    const e = engine([parent, ...children], {
      getTargets: () => targets,
      executeNode: async (_, context) => {
        active++;
        maximum = Math.max(maximum, active);
        await sleep(3, context.signal);
        active--;
      },
    });
    expect((await e.wait(e.submit("parent").id)).status).toBe("succeeded");
    expect(maximum).toBe(1);
  });

  it("releases browser keys using each child owner without clearing a concurrent profile", async () => {
    const targets: TargetDescriptor[] = ["one", "two"].map((id) => ({
      id,
      name: id,
      kind: "browser",
      profile: id,
    }));
    const children = targets.map((target) =>
      flow(target.id, [node("hold", "key", { targetId: target.id })]),
    );
    const parent = flow("parent", [
      node("group", "group", {
        mode: "pool",
        concurrency: 2,
        flowIds: ["one", "two"],
      }),
    ]);
    const held = new Map<string, string>();
    const releases: { id: string; physical: boolean }[] = [];
    let secondPreserved = false;
    const e = engine([parent, ...children], {
      getTargets: () => targets,
      executeNode: async (_, context) => {
        held.set(context.runId, context.target!.id);
        await sleep(context.target!.id === "one" ? 2 : 30, context.signal);
      },
      releaseInputs: async (id, physical) => {
        const target = held.get(id);
        held.delete(id);
        releases.push({ id, physical });
        if (target === "one")
          secondPreserved = [...held.values()].includes("two");
      },
    });
    const result = await e.wait(e.submit("parent").id);
    expect(result.status).toBe("succeeded");
    expect(secondPreserved).toBe(true);
    expect(held.size).toBe(0);
    expect(releases.map((release) => release.id).sort()).toEqual(
      [...result.childIds].sort(),
    );
    expect(releases.every((release) => !release.physical)).toBe(true);
    expect(releases.some((release) => release.id === result.id)).toBe(false);
  });

  it("stops siblings on failure or collects failures when explicitly selected", async () => {
    const child = flow("child", [node("work", "ai")], {
      index: "${inputs.index}",
    });
    const parent = flow(
      "parent",
      [
        node("group", "group", {
          mode: "pool",
          concurrency: 3,
          children: Array.from({ length: 12 }, (_, index) => ({
            flowId: "child",
            inputs: { index },
          })),
        }),
      ],
      { result: "${nodes.group}" },
    );
    const e = engine([parent, child], {
      executeNode: async (_, context) => {
        if (context.inputs.index === 0) throw new Error("Broken");
        await sleep(10, context.signal);
      },
    });
    const failed = await e.wait(e.submit("parent").id);
    expect(failed.status).toBe("failed");
    expect(failed.childIds.length).toBeLessThan(12);
    expect(failed.childIds.map((id) => e.get(id)?.status)).toContain(
      "cancelled",
    );
    parent.nodes[1].config.continueOnError = true;
    const collected = await e.wait(e.submit("parent").id);
    expect(collected.status).toBe("succeeded");
    expect(collected.childIds).toHaveLength(12);
    expect((collected.outputs.result as Json[])[0]).toMatchObject({
      status: "failed",
    });
  });
});

describe("debugging, cancellation and data protection", () => {
  it("bounds completed history by whole root trees while preserving active trees and child state", async () => {
    const child = flow("child");
    const parent = flow("parent", [
      node("group", "group", {
        mode: "pool",
        concurrency: 2,
        flowIds: ["child", "child"],
      }),
    ]);
    const e = engine([parent, child], { completedRunLimit: 4 });
    const first = await e.wait(e.submit("parent").id);
    expect(e.list()).toHaveLength(3);
    const second = await e.wait(e.submit("parent").id);
    expect(e.list()).toHaveLength(3);
    expect(e.get(first.id)).toBeUndefined();
    for (const id of first.childIds) expect(e.get(id)).toBeUndefined();
    expect(e.get(second.id)).toBeDefined();
    expect(e.activeRuns()).toEqual([]);
    expect(e.isActive()).toBe(false);
    parent.nodes.find((item) => item.kind === "end")!.breakpoint = true;
    const active = e.submit("parent");
    await eventually(() => e.get(active.id)?.status === "paused");
    expect(e.isActive(active.id)).toBe(true);
    expect(e.activeFlowIds()).toEqual(new Set(["parent"]));
    expect(
      e
        .get(active.id)
        ?.childIds.every((id) => e.get(id)?.status === "succeeded"),
    ).toBe(true);
    await e.wait(e.submit("child").id);
    await e.wait(e.submit("child").id);
    expect(
      e
        .get(active.id)
        ?.childIds.every((id) => e.get(id)?.status === "succeeded"),
    ).toBe(true);
    e.control(active.id, "resume");
    await e.wait(active.id);
    expect(e.list().length).toBeLessThanOrEqual(4);
  });

  it("evicts an oversized completed tree together but keeps it active through input cleanup", async () => {
    const child = flow("child", [node("action", "click", { targetId: "app" })]);
    const parent = flow("parent", [
      node("group", "group", { flowIds: ["child", "child"] }),
    ]);
    let release!: () => void;
    let cleaning = false;
    const e = engine([parent, child], {
      completedRunLimit: 1,
      getTargets: () => [{ id: "app", name: "App", kind: "desktop" }],
      releaseInputs: async () => {
        if (!cleaning) {
          cleaning = true;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
      },
    });
    const run = e.submit("parent");
    const done = e.wait(run.id);
    await eventually(() => cleaning);
    const activeChild = e.get(run.id)!.childIds[0];
    expect(e.isActive(activeChild)).toBe(true);
    expect(e.activeFlowIds()).toEqual(new Set(["parent", "child"]));
    release();
    const result = await done;
    expect(result.status).toBe("succeeded");
    expect(e.list()).toEqual([]);
    expect(e.isActive()).toBe(false);
  });

  it("pauses before breakpoints, steps exactly one node and resumes", async () => {
    const action = node("first", "ai");
    action.breakpoint = true;
    const f = flow("debug", [action, node("second", "ai")]);
    let calls = 0;
    const e = engine([f], {
      executeNode: async () => {
        calls++;
      },
    });
    const run = e.submit("debug");
    await eventually(() => e.get(run.id)?.status === "paused");
    expect(calls).toBe(0);
    e.control(run.id, "step");
    await eventually(() => calls === 1 && e.get(run.id)?.status === "paused");
    expect(e.get(run.id)?.currentNodeId).toBe("second");
    e.control(run.id, "resume");
    expect((await e.wait(run.id)).status).toBe("succeeded");
    expect(calls).toBe(2);
  });

  it("cancels an active tree, releases resources, and discards stale adapter completion", async () => {
    const child = flow("child", [node("work", "click", { targetId: "app" })], {
      result: "${nodes.work}",
    });
    const parent = flow("parent", [
      node("group", "group", {
        mode: "pool",
        concurrency: 3,
        flowIds: ["child", "child", "child"],
      }),
    ]);
    const release = vi.fn(async () => undefined);
    let finish!: (value: Json) => void;
    let started = false;
    const e = engine([parent, child], {
      getTargets: () => [{ id: "app", name: "app", kind: "desktop" }],
      releaseInputs: release,
      executeNode: async () => {
        started = true;
        return new Promise<Json>((resolve) => {
          finish = resolve;
        });
      },
    });
    const run = e.submit("parent");
    await eventually(() => started);
    e.control(run.id, "stop");
    const cancelled = await e.wait(run.id);
    expect(cancelled.status).toBe("cancelled");
    expect(
      cancelled.childIds.every((id) => e.get(id)?.status === "cancelled"),
    ).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
    finish("late result");
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(
      e
        .list()
        .some((run) =>
          run.events.some(
            (event) => event.nodeId === "work" && event.status === "succeeded",
          ),
        ),
    ).toBe(false);
  });

  it("times out nodes, handles error edges, and keeps detector no-match distinct", async () => {
    const f = flow("timeout", [node("work", "ai", { timeoutMs: 5 })]);
    const e = engine([f], {
      executeNode: async (_, context) => {
        await sleep(1000, context.signal);
      },
    });
    const failed = await e.wait(e.submit("timeout").id);
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("timed out");
    const detector = flow("detector", [node("detect", "detect")], {
      result: "${nodes.detect}",
    });
    const d = engine([detector], {
      executeNode: async () => ({
        outcome: "no-match",
        evidence: "not present",
      }),
    });
    expect(
      (await d.wait(d.submit("detector").id)).outputs.result,
    ).toMatchObject({ outcome: "no-match" });
  });

  it("routes adapter detection envelopes through their outcome ports and polls visual waits", async () => {
    const f = flow("detect", [node("detect", "detect")]);
    f.edges[1].port = "no-match";
    f.edges.push(
      { id: "match", source: "detect", target: "end", port: "match" },
      { id: "uncertain", source: "detect", target: "end", port: "uncertain" },
    );
    const e = engine([f], {
      executeNode: async () => ({ value: { outcome: "no-match" } }),
    });
    expect((await e.wait(e.submit("detect").id)).status).toBe("succeeded");
    const w = flow("wait", [
      node("wait", "wait", {
        detector: "image",
        pollIntervalMs: 1,
        timeoutMs: 300,
      }),
    ]);
    let calls = 0;
    const waiting = engine([w], {
      executeNode: async () => ({
        value: { outcome: ++calls > 1 ? "match" : "no-match" },
      }),
    });
    expect((await waiting.wait(waiting.submit("wait").id)).status).toBe(
      "succeeded",
    );
    expect(calls).toBe(2);
  });

  it("finishes timed-out child input cleanup before entering a parent error recovery branch", async () => {
    const child = flow("child", [node("hold", "key", { targetId: "app" })]);
    const parent = flow("parent", [
      node("call", "call", { flowId: "child", timeoutMs: 5 }),
      node("recover", "click", { targetId: "app" }),
    ]);
    parent.edges.push({
      id: "error",
      source: "call",
      target: "recover",
      port: "error",
    });
    const order: string[] = [];
    const e = engine([parent, child], {
      getTargets: () => [{ id: "app", name: "App", kind: "desktop" }],
      executeNode: async (node, context) => {
        if (node.id === "hold") await sleep(1000, context.signal);
        else order.push("recovery");
      },
      releaseInputs: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        order.push("released");
      },
    });
    expect((await e.wait(e.submit("parent").id)).status).toBe("succeeded");
    expect(order).toEqual(["released", "recovery", "released"]);
  });

  it("redacts secret inputs and their values from events, errors and outputs", async () => {
    const f = flow("secret", [node("work", "ai")], {
      copied: "${inputs.apiKey}",
    });
    const published: unknown[] = [];
    const e = engine([f], {
      onRun: (run) => published.push(run),
      executeNode: async (_, context) => ({
        value: { text: `Echo ${context.inputs.apiKey}` },
      }),
    });
    const result = await e.wait(
      e.submit("secret", { apiKey: "sensitive-123" }).id,
    );
    expect(result.outputs.copied).toBe("[redacted]");
    expect(JSON.stringify(published)).not.toContain("sensitive-123");
  });
});
