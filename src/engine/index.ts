import { randomUUID } from "node:crypto";
import {
  nodeDefinitions,
  type ValidationContext,
} from "../shared/node-definitions";
import type {
  FlowDefinition,
  FlowNode,
  Json,
  RunRecord,
  RunEvent,
  TargetDescriptor,
} from "../shared/types";
import {
  CancelledError,
  ResourceLeases,
  sleep,
  throwIfAborted,
} from "./leases";
import {
  redact,
  resolve,
  safeVariable,
  secretValues,
  type ReferenceScope,
} from "./references";
import { childSpecs, freezeFlowTree, type ChildSpec } from "./validation";
export { validateFlow, freezeFlowTree } from "./validation";
export { nextRunAt, collectDueSchedules } from "./scheduler";
export type { DueScheduleResult } from "./scheduler";

export interface NodeExecutionContext {
  runId: string;
  rootId: string;
  inputs: Record<string, Json>;
  variables: Record<string, Json>;
  outputs: Record<string, Json>;
  config: Record<string, Json>;
  signal: AbortSignal;
  target?: TargetDescriptor;
}
export interface NodeExecutionResult {
  value?: Json;
  port?: string;
  variables?: Record<string, Json>;
}
export interface EngineOptions {
  getFlows(): FlowDefinition[];
  getTargets(): TargetDescriptor[];
  validationContext?(): ValidationContext;
  /** Adapters must check signal before every side effect, and stop/release held input on abort. */
  executeNode(
    node: FlowNode,
    context: NodeExecutionContext,
  ): Promise<NodeExecutionResult | Json | void>;
  onRun?(run: RunRecord): void;
  /** Release this invocation's browser keys, and physical keys only when physicalInput is true. */
  releaseInputs?(runId: string, physicalInput: boolean): Promise<void>;
  /** Durable history belongs to the caller. Evict completed root trees together. */
  completedRunLimit?: number;
}
interface RunState {
  record: RunRecord;
  flow: FlowDefinition;
  tree: ReadonlyMap<string, FlowDefinition>;
  targets: TargetDescriptor[];
  scope: ReferenceScope;
  output: Record<string, Json>;
  controller: AbortController;
  parent?: RunState;
  paused: boolean;
  steps: number;
  skipBreakpoint?: string;
  secrets: string[];
  done: Promise<RunRecord>;
  complete: (run: RunRecord) => void;
  wake: Set<() => void>;
  pendingChildren: Set<RunState>;
}
const terminal = new Set(["succeeded", "failed", "cancelled", "interrupted"]);
const builtins = new Set([
  "start",
  "end",
  "set",
  "condition",
  "wait",
  "loop",
  "call",
  "group",
]);

export class WorkflowEngine {
  private runs = new Map<string, RunState>();
  private active = new Map<string, RunState>();
  private rootMembers = new Map<string, Set<string>>();
  private completedRoots: string[] = [];
  private completedCount = 0;
  private leases = new ResourceLeases();
  constructor(private options: EngineOptions) {
    const limit = options.completedRunLimit ?? 500;
    if (!Number.isInteger(limit) || limit < 0)
      throw new Error("Completed run retention must be a nonnegative integer");
  }

  submit(
    flowId: string,
    inputs: Record<string, Json> = {},
    trigger: RunRecord["trigger"] = "manual",
  ): RunRecord {
    const tree = freezeFlowTree(
      flowId,
      this.options.getFlows(),
      this.options.validationContext?.(),
    );
    const state = this.create(
      tree.get(flowId)!,
      tree,
      structuredClone(this.options.getTargets()),
      inputs,
      trigger,
    );
    queueMicrotask(() => void this.execute(state));
    return structuredClone(state.record);
  }
  get(id: string): RunRecord | undefined {
    const run = this.runs.get(id);
    return run ? structuredClone(run.record) : undefined;
  }
  list(): RunRecord[] {
    return [...this.runs.values()].map((state) =>
      structuredClone(state.record),
    );
  }
  /** Active includes runs performing cancellation/input cleanup, even if their final status is set. */
  isActive(id?: string): boolean {
    return id === undefined ? this.active.size > 0 : this.active.has(id);
  }
  activeFlowIds(): Set<string> {
    return new Set(
      [...this.active.values()].map((state) => state.record.flowId),
    );
  }
  activeRuns(): RunRecord[] {
    return [...this.active.values()].map((state) =>
      structuredClone(state.record),
    );
  }
  wait(id: string): Promise<RunRecord> {
    const state = this.runs.get(id);
    if (!state) return Promise.reject(new Error("Run not found"));
    return state.done.then((run) => structuredClone(run));
  }
  control(id: string, action: "pause" | "resume" | "step" | "stop"): void {
    const state = this.runs.get(id);
    if (!state || terminal.has(state.record.status)) return;
    if (action === "stop") {
      this.cancel(state);
      return;
    }
    if (action === "pause") {
      state.paused = true;
      state.steps = 0;
      state.record.status = "paused";
      this.event(state, {
        type: "run",
        status: "paused",
        message:
          "Pause requested; the current action will finish before the next node",
      });
    }
    if (action === "step") {
      state.paused = true;
      state.steps = 1;
      state.skipBreakpoint = state.record.currentNodeId;
    }
    if (action === "resume") {
      const resume = (current: RunState) => {
        current.paused = false;
        current.steps = 0;
        current.skipBreakpoint = current.record.currentNodeId;
        if (current.record.status === "paused") {
          current.record.status = current.record.startedAt
            ? "running"
            : "queued";
          this.publish(current);
        }
        this.wake(current);
        for (const child of current.pendingChildren) resume(child);
      };
      resume(state);
    }
    this.wake(state);
  }

  private create(
    flow: FlowDefinition,
    tree: ReadonlyMap<string, FlowDefinition>,
    targets: TargetDescriptor[],
    inputs: Record<string, Json>,
    trigger: RunRecord["trigger"],
    parent?: RunState,
  ): RunState {
    const id = randomUUID();
    const actualInputs = {
      ...structuredClone(flow.inputs),
      ...structuredClone(inputs),
    };
    const secrets = [...(parent?.secrets ?? []), ...secretValues(actualInputs)];
    const record: RunRecord = {
      id,
      flowId: flow.id,
      flowName: flow.name,
      revision: flow.revision,
      rootId: parent?.record.rootId ?? id,
      ...(parent ? { parentId: parent.record.id } : {}),
      status: "queued",
      trigger,
      inputs: redact(actualInputs, secrets),
      outputs: {},
      createdAt: new Date().toISOString(),
      events: [],
      childIds: [],
    };
    let complete!: (run: RunRecord) => void;
    const done = new Promise<RunRecord>((resolve) => {
      complete = resolve;
    });
    const state: RunState = {
      record,
      flow,
      tree,
      targets,
      scope: { inputs: actualInputs, vars: {}, nodes: {} },
      output: {},
      controller: new AbortController(),
      parent,
      paused: false,
      steps: 0,
      secrets,
      done,
      complete,
      wake: new Set(),
      pendingChildren: new Set(),
    };
    this.runs.set(id, state);
    this.active.set(id, state);
    if (!this.rootMembers.has(record.rootId))
      this.rootMembers.set(record.rootId, new Set());
    this.rootMembers.get(record.rootId)!.add(id);
    if (parent) {
      parent.record.childIds.push(id);
      parent.pendingChildren.add(state);
      this.publish(parent);
    }
    this.event(state, {
      type: "run",
      status: "queued",
      message: "Workflow queued",
    });
    return state;
  }

  private ancestors(state: RunState): RunState[] {
    const result: RunState[] = [];
    let current = state.parent;
    while (current) {
      result.push(current);
      current = current.parent;
    }
    return result;
  }
  private cancel(state: RunState): void {
    if (terminal.has(state.record.status)) return;
    state.controller.abort(new CancelledError());
    this.wake(state);
    for (const child of state.pendingChildren) this.cancel(child);
  }
  private wake(state: RunState): void {
    for (const wake of [...state.wake]) wake();
    for (const child of state.pendingChildren) this.wake(child);
  }
  private publish(state: RunState): void {
    try {
      this.options.onRun?.(structuredClone(state.record));
    } catch {
      /* Persistence callbacks must not destabilize execution cleanup. */
    }
  }
  private retainCompletedTree(state: RunState): void {
    if (state.parent) return;
    this.completedRoots.push(state.record.id);
    this.completedCount += this.rootMembers.get(state.record.id)?.size ?? 0;
    while (
      this.completedCount > (this.options.completedRunLimit ?? 500) &&
      this.completedRoots.length
    ) {
      const root = this.completedRoots.shift()!;
      const members = this.rootMembers.get(root);
      if (!members) continue;
      for (const id of members) this.runs.delete(id);
      this.completedCount -= members.size;
      this.rootMembers.delete(root);
    }
  }
  private rememberSecrets(state: RunState, value: Json): void {
    const discovered = secretValues(value);
    for (const current of [state, ...this.ancestors(state)])
      current.secrets = [...new Set([...current.secrets, ...discovered])];
  }
  private event(
    state: RunState,
    event: Omit<RunEvent, "id" | "runId" | "at">,
  ): void {
    state.record.events.push(
      redact(
        {
          id: randomUUID(),
          runId: state.record.id,
          at: new Date().toISOString(),
          ...event,
        },
        state.secrets,
      ),
    );
    // Keep the active record bounded; persistence receives every event as it arrives.
    if (state.record.events.length > 5000)
      state.record.events.splice(0, state.record.events.length - 5000);
    this.publish(state);
  }

  private resources(
    flow: FlowDefinition,
    state: RunState,
    recursive: boolean,
  ): string[] {
    const resources = new Set<string>();
    for (const node of flow.nodes) {
      const visualWait =
        node.kind === "wait" && node.config.detector !== undefined;
      if (
        (!builtins.has(node.kind) || visualWait) &&
        (node.kind !== "ai" || node.config.targetId !== undefined)
      ) {
        const targetId = node.config.targetId;
        const targets =
          typeof targetId === "string" && !targetId.includes("${")
            ? state.targets.filter((target) => target.id === targetId)
            : state.targets;
        for (const target of targets) {
          if (target.kind === "desktop") {
            resources.add("desktop:input");
            resources.add(`target:${target.id}`);
          } else
            resources.add(
              target.browserMode === "extension"
                ? "browser:extension:shared"
                : `browser:managed:${target.profile || target.id}`,
            );
        }
        if (!targets.length) resources.add("desktop:input");
      }
      if (recursive)
        for (const child of childSpecs(node))
          for (const key of this.resources(
            state.tree.get(child.flowId)!,
            state,
            true,
          ))
            resources.add(key);
    }
    return [...resources];
  }

  private async execute(state: RunState): Promise<void> {
    let release: (() => void) | undefined;
    let physicalInput = false;
    try {
      // Pure orchestration reserves nothing. A direct actor reserves its complete subtree atomically,
      // preventing lock upgrades from deadlocking nested calls. Descendants inherit these leases.
      const direct = this.resources(state.flow, state, false);
      if (direct.length) {
        const resources = this.resources(state.flow, state, true);
        physicalInput = resources.includes("desktop:input");
        release = await this.leases.acquire(
          state.record.id,
          resources,
          new Set(this.ancestors(state).map((run) => run.record.id)),
          state.controller.signal,
        );
      }
      throwIfAborted(state.controller.signal);
      state.record.status = "running";
      state.record.startedAt = new Date().toISOString();
      this.event(state, {
        type: "run",
        status: "running",
        message: "Workflow started",
      });
      let node = state.flow.nodes.find((node) => node.kind === "start");
      while (node) {
        state.record.currentNodeId = node.id;
        await this.checkpoint(state, node);
        this.event(state, {
          type: "node",
          nodeId: node.id,
          status: "running",
          message: node.label,
        });
        let result: NodeExecutionResult;
        try {
          result = await this.executeTimedNode(state, node);
          throwIfAborted(state.controller.signal);
          if (result.value !== undefined)
            this.rememberSecrets(state, result.value);
          if (result.variables) this.rememberSecrets(state, result.variables);
          state.scope.nodes[node.id] = result.value ?? null;
          if (result.variables)
            for (const [key, value] of Object.entries(result.variables))
              state.scope.vars[safeVariable(key)] = value;
          this.event(state, {
            type: "node",
            nodeId: node.id,
            status: "succeeded",
            message: `${node.label} completed`,
            data: result.value,
          });
        } catch (cause) {
          throwIfAborted(state.controller.signal);
          const error = cause instanceof Error ? cause.message : String(cause);
          this.event(state, {
            type: "error",
            nodeId: node.id,
            status: "failed",
            message: error,
          });
          if (
            !state.flow.edges.some(
              (edge) => edge.source === node!.id && edge.port === "error",
            )
          )
            throw cause;
          state.scope.nodes[node.id] = { error };
          result = { port: "error" };
        }
        if (node.kind === "end") break;
        const outgoing = state.flow.edges.filter(
          (edge) => edge.source === node!.id,
        );
        const edge =
          outgoing.find(
            (edge) => (edge.port || "next") === (result.port || "next"),
          ) ??
          (result.port !== "error"
            ? outgoing.find((edge) => !edge.port || edge.port === "next")
            : undefined);
        if (!edge)
          throw new Error(
            `No connection for output ${result.port ?? "next"} on ${node.label}`,
          );
        node = state.flow.nodes.find((node) => node.id === edge.target);
      }
      throwIfAborted(state.controller.signal);
      state.output = {
        ...state.output,
        ...resolve(state.flow.outputs, state.scope),
      };
      state.record.outputs = redact(state.output, state.secrets);
      state.record.status = "succeeded";
    } catch (cause) {
      const cancelled =
        state.controller.signal.aborted || cause instanceof CancelledError;
      state.record.status = cancelled ? "cancelled" : "failed";
      state.record.error = redact(
        cause instanceof Error ? cause.message : String(cause),
        state.secrets,
      );
      for (const child of state.pendingChildren) this.cancel(child);
    } finally {
      await Promise.all([...state.pendingChildren].map((child) => child.done));
      // Never release physical ownership until the adapter has released held keys/buttons.
      if (release) {
        try {
          await this.options.releaseInputs?.(state.record.id, physicalInput);
        } catch (cause) {
          if (state.record.status === "succeeded") {
            state.record.status = "failed";
            state.record.error = "Could not release held input";
          }
          this.event(state, {
            type: "error",
            message: `Input cleanup failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          });
        }
        release();
      }
      state.record.finishedAt = new Date().toISOString();
      this.event(state, {
        type: "run",
        status: state.record.status,
        message: state.record.error ?? `Workflow ${state.record.status}`,
      });
      state.parent?.pendingChildren.delete(state);
      this.active.delete(state.record.id);
      state.complete(structuredClone(state.record));
      this.retainCompletedTree(state);
    }
  }

  private async checkpoint(state: RunState, node: FlowNode): Promise<void> {
    if (node.breakpoint && state.skipBreakpoint !== node.id) {
      state.paused = true;
      state.steps = 0;
    }
    state.skipBreakpoint = undefined;
    while (true) {
      throwIfAborted(state.controller.signal);
      const blockers = [state, ...this.ancestors(state)].filter(
        (run) => run.paused,
      );
      if (blockers.every((run) => run.steps > 0)) {
        for (const blocker of blockers) blocker.steps--;
        if (state.record.status === "paused") {
          state.record.status = "running";
          this.publish(state);
        }
        return;
      }
      if (state.record.status !== "paused") {
        state.record.status = "paused";
        this.event(state, {
          type: "run",
          status: "paused",
          message: `Paused before ${node.label}`,
        });
      }
      await new Promise<void>((resolve) => {
        const wake = () => {
          state.wake.delete(wake);
          state.controller.signal.removeEventListener("abort", wake);
          resolve();
        };
        state.wake.add(wake);
        state.controller.signal.addEventListener("abort", wake, { once: true });
        if (state.controller.signal.aborted) wake();
      });
    }
  }

  private async executeTimedNode(
    state: RunState,
    node: FlowNode,
  ): Promise<NodeExecutionResult> {
    const controller = new AbortController();
    const abort = () => controller.abort(state.controller.signal.reason);
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Loop input templates may reference the item/index introduced by each iteration.
    const { inputs: loopInputs, ...rest } = node.config;
    const config =
      node.kind === "loop"
        ? { ...resolve(rest, state.scope), inputs: loopInputs ?? {} }
        : resolve(node.config, state.scope);
    this.rememberSecrets(state, config);
    const validationContext = this.options.validationContext?.();
    const configIssues = nodeDefinitions[node.kind]
      .validateConfig(
        config,
        validationContext
          ? { ...validationContext, targets: state.targets }
          : undefined,
        { resolved: true },
      )
      .filter((issue) => issue.severity === "error");
    if (configIssues.length) {
      throw new Error(
        `${node.label}: ${configIssues.map((issue) => issue.message).join("; ")}`,
      );
    }
    state.controller.signal.addEventListener("abort", abort, { once: true });
    if (state.controller.signal.aborted) abort();
    const timeout = Number(
      config.timeoutMs ?? (node.kind === "wait" && config.detector ? 30000 : 0),
    );
    if (timeout > 0)
      timer = setTimeout(
        () => controller.abort(new Error(`Node timed out after ${timeout} ms`)),
        timeout,
      );
    try {
      const aborted = new Promise<never>((_, reject) => {
        if (controller.signal.aborted) reject(controller.signal.reason);
        else
          controller.signal.addEventListener(
            "abort",
            () => reject(controller.signal.reason),
            { once: true },
          );
      });
      const task = this.executeNode(
        state,
        { ...node, config },
        controller.signal,
      );
      try {
        const result = await Promise.race([task, aborted]);
        throwIfAborted(controller.signal);
        return result;
      } catch (cause) {
        // A timed-out child tree must finish input cleanup before an explicit error branch
        // can start another action using its inherited physical resources.
        if (
          controller.signal.aborted &&
          ["call", "loop", "group"].includes(node.kind)
        )
          await task.catch(() => undefined);
        throw cause;
      }
    } finally {
      clearTimeout(timer);
      state.controller.signal.removeEventListener("abort", abort);
    }
  }

  private async executeNode(
    state: RunState,
    node: FlowNode,
    signal: AbortSignal,
  ): Promise<NodeExecutionResult> {
    throwIfAborted(signal);
    const config = node.config;
    switch (node.kind) {
      case "start":
        return {};
      case "end": {
        if (
          config.outputs &&
          typeof config.outputs === "object" &&
          !Array.isArray(config.outputs)
        )
          state.output = config.outputs;
        return {};
      }
      case "set": {
        const name = safeVariable(config.variable ?? config.name);
        return {
          value: config.value ?? null,
          variables: { [name]: config.value ?? null },
        };
      }
      case "condition":
        return {
          value: compare(
            config.left,
            String(config.operator ?? "truthy"),
            config.right,
          ),
          port: compare(
            config.left,
            String(config.operator ?? "truthy"),
            config.right,
          )
            ? "true"
            : "false",
        };
      case "wait": {
        if (config.detector) {
          while (true) {
            throwIfAborted(signal);
            const detection = await this.external(
              state,
              { ...node, kind: "detect" },
              signal,
            );
            const value = detection.value;
            if (
              detection.port === "match" ||
              (value &&
                typeof value === "object" &&
                !Array.isArray(value) &&
                value.outcome === "match")
            )
              return { value };
            await sleep(
              Math.max(
                50,
                Number(config.pollIntervalMs ?? config.pollMs ?? 500),
              ),
              signal,
            );
          }
        }
        const duration = Number(config.durationMs ?? config.ms ?? 1000);
        if (!Number.isFinite(duration) || duration < 0 || duration > 86400000)
          throw new Error("Wait duration must be between 0 and 86400000 ms");
        await sleep(duration, signal);
        return {};
      }
      case "call":
        return { value: await this.child(state, childSpecs(node)[0], signal) };
      case "loop": {
        const limit = Number(config.maxIterations ?? 1000);
        const items = config.items;
        if (items !== undefined && !Array.isArray(items))
          throw new Error("For each items must resolve to an array");
        const count = items === undefined ? Number(config.count) : items.length;
        if (!Number.isInteger(count) || count < 0 || count > limit)
          throw new Error(`Loop exceeds its ${limit} iteration bound`);
        const results: Json[] = [];
        const raw = state.flow.nodes.find(
          (original) => original.id === node.id,
        )!;
        for (let index = 0; index < count; index++) {
          throwIfAborted(signal);
          const item = items === undefined ? index : items[index];
          const childInputs = resolve(
            (raw.config.inputs ?? {}) as Record<string, Json>,
            { ...state.scope, item, index },
          );
          if (
            !childInputs ||
            typeof childInputs !== "object" ||
            Array.isArray(childInputs)
          )
            throw new Error("Loop child inputs must resolve to an object");
          results.push(
            await this.child(
              state,
              {
                flowId: String(config.flowId),
                inputs: { ...childInputs, item, index },
              },
              signal,
            ),
          );
        }
        return { value: results };
      }
      case "group":
        return { value: await this.group(state, node, signal) };
      default:
        return this.external(state, node, signal);
    }
  }

  private async external(
    state: RunState,
    node: FlowNode,
    signal: AbortSignal,
  ): Promise<NodeExecutionResult> {
    const target = state.targets.find(
      (target) => target.id === node.config.targetId,
    );
    const context: NodeExecutionContext = {
      runId: state.record.id,
      rootId: state.record.rootId,
      inputs: structuredClone(state.scope.inputs),
      variables: structuredClone(state.scope.vars),
      outputs: structuredClone(state.scope.nodes),
      config: node.config,
      signal,
      target: target ? structuredClone(target) : undefined,
    };
    const result = await this.options.executeNode(node, context);
    throwIfAborted(signal);
    if (result === undefined) return {};
    if (
      result &&
      typeof result === "object" &&
      !Array.isArray(result) &&
      ("port" in result ||
        "variables" in result ||
        ("value" in result && !("outcome" in result)))
    ) {
      const envelope = result as NodeExecutionResult;
      const value = envelope.value;
      if (
        node.kind === "detect" &&
        !envelope.port &&
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        typeof value.outcome === "string"
      )
        return { ...envelope, port: value.outcome };
      return envelope;
    }
    const port =
      result &&
      typeof result === "object" &&
      !Array.isArray(result) &&
      "outcome" in result &&
      typeof result.outcome === "string" &&
      node.kind === "detect"
        ? result.outcome
        : undefined;
    return { value: result as Json, port };
  }

  private async child(
    parent: RunState,
    spec: ChildSpec,
    signal: AbortSignal,
  ): Promise<Json> {
    throwIfAborted(signal);
    const flow = parent.tree.get(spec.flowId);
    if (!flow)
      throw new Error(`Child workflow not in snapshot: ${spec.flowId}`);
    const child = this.create(
      flow,
      parent.tree,
      parent.targets,
      spec.inputs,
      "child",
      parent,
    );
    const abort = () => this.cancel(child);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    try {
      void this.execute(child);
      await child.done;
      throwIfAborted(signal);
      if (child.record.status !== "succeeded")
        throw new Error(
          `Child ${flow.name}: ${child.record.error ?? child.record.status}`,
        );
      return child.output;
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  private async group(
    state: RunState,
    node: FlowNode,
    signal: AbortSignal,
  ): Promise<Json[]> {
    const specs = childSpecs(node);
    const mode = String(node.config.mode ?? "sequence");
    const concurrency =
      mode === "sequence" ? 1 : Number(node.config.concurrency ?? 3);
    const results: Json[] = new Array(specs.length);
    const groupController = new AbortController();
    const abort = () => groupController.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    let failure: unknown;
    const run = async (index: number) => {
      try {
        results[index] = await this.child(
          state,
          specs[index],
          groupController.signal,
        );
      } catch (cause) {
        if (signal.aborted) throw cause;
        if (node.config.continueOnError === true)
          results[index] = {
            error: cause instanceof Error ? cause.message : String(cause),
            status: "failed",
          };
        else {
          failure ??= cause;
          groupController.abort(cause);
        }
      }
    };
    try {
      if (mode === "batches") {
        for (
          let offset = 0;
          offset < specs.length && !failure;
          offset += concurrency
        )
          await Promise.all(
            specs
              .slice(offset, offset + concurrency)
              .map((_, index) => run(offset + index)),
          );
      } else {
        let next = 0;
        await Promise.all(
          Array.from(
            { length: Math.min(concurrency, specs.length) },
            async () => {
              while (next < specs.length && !failure) await run(next++);
            },
          ),
        );
      }
      throwIfAborted(signal);
      if (failure) throw failure;
      return results;
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
}

function compare(
  left: Json | undefined,
  operator: string,
  right: Json | undefined,
): boolean {
  switch (operator) {
    case "eq":
      return JSON.stringify(left) === JSON.stringify(right);
    case "neq":
      return JSON.stringify(left) !== JSON.stringify(right);
    case "truthy":
      return Boolean(left);
    case "contains":
      return typeof left === "string"
        ? left.includes(String(right))
        : Array.isArray(left) &&
            left.some((item) => JSON.stringify(item) === JSON.stringify(right));
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      if (typeof left !== "number" || typeof right !== "number")
        throw new Error("Numeric comparison requires numbers");
      return operator === "gt"
        ? left > right
        : operator === "gte"
          ? left >= right
          : operator === "lt"
            ? left < right
            : left <= right;
    }
    default:
      throw new Error(`Unsupported condition operator: ${operator}`);
  }
}
