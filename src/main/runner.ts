import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  WorkflowEngine,
  collectDueSchedules,
  type NodeExecutionContext,
  type NodeExecutionResult,
} from "../engine";
import { NativeAdapter } from "../integrations/native";
import { BrowserAdapter } from "../integrations/browser";
import { aiCheckOperationSchema } from "../shared/ai-connections";
import { AIService, safeAIError } from "../integrations/ai";
import { NativeServiceError } from "../shared/native-protocol";
import { detectionCoordinates } from "../integrations/locations";
import {
  DetectorService,
  cropFrame,
  restoreDetectionRegion,
} from "../integrations/detectors";
import {
  RecordingController,
  RecordingStorageTimeoutError,
} from "./recording-controller";
import type {
  AIConnection,
  CaptureFrame,
  DetectionResult,
  FlowNode,
  Json,
  RecordedAction,
  RecordingState,
  RecordingStartOptions,
  RecordingInsertOptions,
  RecordingInsertResult,
  RunRecord,
  Schedule,
  TargetDescriptor,
} from "../shared/types";
import type {
  RunnerInit,
  RunnerMessage,
  RunnerResponse,
  RunnerWorkspace,
} from "./protocol";

const port = (
  process as unknown as {
    parentPort: {
      on(
        event: string,
        listener: (event: { data: RunnerMessage }) => void,
      ): void;
      postMessage(message: RunnerResponse): void;
    };
  }
).parentPort;
if (!port)
  throw new Error("Relay runner must start as an Electron utility process.");
let workspace: RunnerWorkspace;
let native: NativeAdapter;
let browser: BrowserAdapter;
let engine: WorkflowEngine;
let initialized = false;
let disposing = false;
let recording: RecordingController;
let stoppingRuns: Promise<void> | undefined;
const recordingLocked = () => Boolean(recording?.isLocked());
const captures = new Map<string, CaptureFrame>();
const detectors = new DetectorService();
const ai = new AIService((id) => workspace?.keys[id]);
const recordingRequests = new Map<
  string,
  {
    resolve(value: unknown): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  }
>();
function recordingStore<T>(
  operation: "save" | "insert",
  state: RecordingState,
  options?: RecordingInsertOptions,
): Promise<T> {
  const id = randomUUID();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      recordingRequests.delete(id);
      reject(
        new RecordingStorageTimeoutError(
          "Recording storage did not acknowledge the draft. Retry Stop or Insert; application actions will not be repeated.",
        ),
      );
    }, 15000);
    recordingRequests.set(id, {
      resolve: (value) => resolve(value as T),
      reject,
      timer,
    });
    port.postMessage({
      recordingRequest: {
        id,
        operation,
        state,
        ...(options ? { options } : {}),
      },
    });
  });
}
function targetFor(id: unknown): TargetDescriptor {
  const target = workspace.targets.find((t) => t.id === id);
  if (!target)
    throw new Error(
      "Choose an application or browser target in the node inspector.",
    );
  return target;
}
function connectionFor(
  config: Record<string, Json>,
  vision: boolean,
): AIConnection {
  const id =
    config.connectionId ||
    (vision
      ? workspace.settings.defaultVisionConnection
      : workspace.settings.defaultTextConnection);
  const connection = workspace.connections.find((c) => c.id === id);
  if (!connection)
    throw new Error(
      `Choose a ${vision ? "vision" : "text"} connection in AI Connections or the node inspector.`,
    );
  return connection;
}
async function capture(
  target: TargetDescriptor,
  signal?: AbortSignal,
): Promise<CaptureFrame> {
  const frame = await (target.kind === "browser" ? browser : native).capture(
    target,
    signal,
  );
  captures.set(frame.id, frame);
  if (captures.size > 30) captures.delete(captures.keys().next().value!);
  return frame;
}
async function detect(
  config: Record<string, Json>,
  signal?: AbortSignal,
  targetOverride?: TargetDescriptor,
): Promise<DetectionResult> {
  const target = targetOverride ?? targetFor(config.targetId);
  if (config.detector === "element") {
    const value = await (target.kind === "browser" ? browser : native).execute(
      "detect",
      config,
      target,
      signal,
    );
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      "outcome" in value
    )
      return value as unknown as DetectionResult;
    return { outcome: value ? "match" : "no-match", value };
  }
  const frame = await capture(target, signal);
  if (config.detector === "ai") {
    const { frame: region, region: offset } = await cropFrame(
      frame,
      config.region,
    );
    const result = await ai.detect(connectionFor(config, true), {
      prompt: String(config.prompt ?? ""),
      frame: region,
      threshold: Number(config.threshold ?? 0.85),
      locationThreshold: Number(config.locationThreshold ?? 0.85),
      locate: Boolean(config.locate),
      signal,
    });
    return restoreDetectionRegion(result, frame, offset);
  }
  return detectors.detect(frame, config, signal);
}
async function execute(
  node: FlowNode,
  context: NodeExecutionContext,
): Promise<NodeExecutionResult> {
  const config = ["click", "move"].includes(node.kind)
    ? detectionCoordinates(context.config)
    : context.config;
  context.signal.throwIfAborted();
  if (node.kind === "detect")
    return {
      value: (await detect(
        { ...config, watchId: `${context.runId}:${node.id}` },
        context.signal,
        context.target,
      )) as unknown as Json,
    };
  if (node.kind === "wait" && config.detector) {
    const deadline = Date.now() + Number(config.timeoutMs ?? 30000);
    while (Date.now() < deadline) {
      context.signal.throwIfAborted();
      const result = await detect(
        { ...config, watchId: `${context.runId}:${node.id}` },
        context.signal,
        context.target,
      );
      if (result.outcome === "match")
        return { value: result as unknown as Json, port: "match" };
      await new Promise<void>((resolve, reject) => {
        const done = () => {
          clearTimeout(timer);
          context.signal.removeEventListener("abort", abort);
        };
        const abort = () => {
          done();
          reject(context.signal.reason);
        };
        const timer = setTimeout(
          () => {
            done();
            resolve();
          },
          Math.max(100, Number(config.pollMs ?? 750)),
        );
        context.signal.addEventListener("abort", abort, { once: true });
      });
    }
    throw new Error("Wait for detector timed out.");
  }
  if (node.kind === "ai") {
    const vision = config.mode === "vision";
    const frame = vision
      ? await capture(
          context.target ?? targetFor(config.targetId),
          context.signal,
        )
      : undefined;
    let schema = config.schema;
    if (typeof schema === "string" && schema.trim())
      schema = JSON.parse(schema) as Json;
    if (
      config.mode === "structured" &&
      (!schema || typeof schema !== "object" || Array.isArray(schema))
    )
      throw new Error("Provide a JSON schema for structured AI output.");
    try {
      return {
        value: await ai.generate(connectionFor(config, vision), {
          prompt: String(config.prompt ?? ""),
          mode: (config.mode as "text" | "structured" | "vision") ?? "text",
          schema:
            schema && typeof schema === "object" && !Array.isArray(schema)
              ? schema
              : undefined,
          frame,
          signal: context.signal,
          state: context.inputs,
        }),
      };
    } catch (error) {
      throw new Error(safeAIError(error));
    }
  }
  const target = context.target ?? targetFor(config.targetId);
  if (node.kind === "screenshot") {
    const frame = await capture(target, context.signal);
    return {
      value: {
        frameId: frame.id,
        targetId: frame.targetId,
        width: frame.width,
        height: frame.height,
        capturedAt: frame.capturedAt,
      },
    };
  }
  if (config.frameId && ["click", "move", "drag"].includes(node.kind)) {
    const frame = captures.get(String(config.frameId));
    if (
      !frame ||
      frame.targetId !== target.id ||
      Date.now() - frame.capturedAt > 5000
    )
      throw new Error(
        "The detected location is stale. Capture and detect the target again.",
      );
    const current = await capture(target, context.signal);
    if (
      frame.width !== current.width ||
      frame.height !== current.height ||
      JSON.stringify(frame.bounds) !== JSON.stringify(current.bounds)
    )
      throw new Error("The target moved or resized. Detect the target again.");
    config.frameId = current.id;
  }
  return {
    value:
      target.kind === "browser"
        ? await browser.execute(
            node.kind,
            config,
            target,
            context.signal,
            context.runId,
          )
        : await native.execute(node.kind, config, target, context.signal),
  };
}

let lastTick = new Date();
function scheduleOutcome(
  schedule: Schedule,
  status: "failed" | "skipped",
  message: string,
) {
  const id = randomUUID(),
    now = new Date().toISOString();
  const flow = workspace.flows.find((f) => f.id === schedule.flowId);
  const run: RunRecord = {
    id,
    rootId: id,
    flowId: schedule.flowId,
    flowName: flow?.name ?? schedule.name,
    revision: flow?.revision ?? 1,
    status,
    trigger: "schedule",
    inputs: {},
    outputs: {},
    createdAt: now,
    finishedAt: now,
    error: message,
    childIds: [],
    events: [
      {
        id: randomUUID(),
        runId: id,
        at: now,
        type: status === "failed" ? "error" : "log",
        status,
        message,
      },
    ],
  };
  port.postMessage({ event: { type: "run", run } });
}
setInterval(() => {
  if (!initialized || disposing) return;
  const now = new Date();
  const active = engine.activeFlowIds();
  const before = new Map(
    workspace.schedules.map((s) => [s.id, JSON.stringify(s)]),
  );
  const result = collectDueSchedules(
    workspace.schedules,
    active,
    now,
    lastTick,
  );
  lastTick = now;
  workspace.schedules = result.schedules;
  for (const schedule of result.due) {
    if (recordingLocked() || stoppingRuns) {
      scheduleOutcome(
        schedule,
        "skipped",
        "Occurrence skipped while recording or input cleanup owns the desktop.",
      );
      continue;
    }
    try {
      engine.submit(schedule.flowId, schedule.inputs, "schedule");
    } catch (error) {
      scheduleOutcome(schedule, "failed", safeAIError(error));
    }
  }
  for (const skipped of result.skipped) {
    const schedule = workspace.schedules.find(
      (s) => s.id === skipped.scheduleId,
    );
    if (schedule) scheduleOutcome(schedule, "skipped", skipped.reason);
  }
  const changes = workspace.schedules
    .filter((s) => before.get(s.id) !== JSON.stringify(s))
    .map(({ id, enabled, lastRunAt, nextRunAt }) => ({
      id,
      enabled,
      lastRunAt,
      nextRunAt,
    }));
  if (changes.length)
    port.postMessage({
      scheduleUpdates: changes,
      generation: workspace.generation,
    });
}, 1000).unref();

async function handle(method: string, args: unknown[]): Promise<unknown> {
  if (method === "init") {
    const init = args[0] as RunnerInit;
    workspace = init.workspace;
    native = new NativeAdapter({ binaryPath: init.binaryPath });
    browser = new BrowserAdapter({
      profilesDir: join(init.dataDir, "browser-profiles"),
    });
    await browser.startBridge();
    engine = new WorkflowEngine({
      getFlows: () => workspace.flows,
      getTargets: () => workspace.targets,
      validationContext: () => ({
        targets: workspace.targets,
        connections: workspace.connections,
        settings: workspace.settings,
      }),
      executeNode: execute,
      onRun: (run) => port.postMessage({ event: { type: "run", run } }),
      releaseInputs: async (runId, physicalInput) => {
        const cleanup = await Promise.allSettled([
          browser.releaseAll(runId),
          ...(physicalInput ? [native.releaseAll()] : []),
        ]);
        const failed = cleanup.find((result) => result.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
      },
    });
    recording = new RecordingController({
      initialState: init.recording,
      getTarget: (id) => workspace.targets.find((target) => target.id === id),
      getFlow: (id) => workspace.flows.find((flow) => flow.id === id),
      canStart: () => {
        if (stoppingRuns || disposing || engine.isActive())
          throw new Error(
            "Stop active workflows and input cleanup before recording.",
          );
      },
      persist: (state) => recordingStore<RecordingState>("save", state),
      insert: (state, options) =>
        recordingStore<RecordingInsertResult>("insert", state, options),
      startDirect: (target, callback) =>
        (target.kind === "browser" ? browser : native).startRecording(
          target,
          callback,
        ),
      stopDirect: (target) =>
        target?.kind === "browser"
          ? browser.stopRecording()
          : native.stopRecording(),
      execute: (action, target, signal, ownerId) =>
        (target.kind === "browser" ? browser : native).execute(
          action.kind,
          action.config,
          target,
          signal,
          ownerId,
        ),
      releaseInputs: async (ownerId) => {
        const results = await Promise.allSettled([
          native.releaseAll(),
          browser.releaseAll(ownerId),
        ]);
        const failed = results.find((result) => result.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
      },
      onState: (state) =>
        port.postMessage({ event: { type: "recording", recording: state } }),
    });
    initialized = true;
    lastTick = new Date();
    return true;
  }
  if (!initialized)
    throw new Error("The automation service is starting. Try again shortly.");
  if (
    disposing &&
    !["dispose", "stopAll", "stopRecording", "recording"].includes(method)
  )
    throw new Error("The automation service is shutting down.");
  if (method === "sync") {
    workspace = args[0] as RunnerWorkspace;
    return true;
  }
  if (method === "capabilities") return native.capabilities();
  if (method === "browserBridge") return browser.getBridgeInfo();
  if (method === "capture") return capture(targetFor(args[0]));
  if (method === "testDetector") {
    if (engine.isActive())
      throw new Error("Stop active workflows before testing a detector.");
    return detect(args[0] as Record<string, Json>);
  }
  if (method === "inspectNativeLocator") {
    if (engine.isActive() || recordingLocked())
      throw new Error(
        "Stop active workflows and recording before inspecting native controls.",
      );
    const target = targetFor(args[0]);
    if (target.kind !== "desktop")
      throw new Error("Native inspection requires a desktop target.");
    return native.inspectLocator(
      target,
      args[1] as import("../shared/native-locators").NativeInspectionQuery,
    );
  }
  if (method === "inspectBrowserLocator") {
    const target = targetFor(args[0]);
    if (target.kind !== "browser")
      throw new Error("Locator inspection requires a browser target.");
    if (engine.isActive())
      throw new Error("Stop active workflows before testing a locator.");
    return browser.inspectLocator(
      target,
      args[1] as import("../shared/types").BrowserLocator | string,
    );
  }
  if (method === "recording") return recording.getState();
  if (method === "runFlow") {
    if (recordingLocked() || stoppingRuns)
      throw new Error(
        "Wait for recording or run cleanup to finish before starting a workflow.",
      );
    return engine.submit(
      String(args[0]),
      (args[1] as Record<string, Json>) ?? {},
    );
  }
  if (method === "trigger") {
    if (recordingLocked() || stoppingRuns)
      throw new Error("Recording or cleanup currently owns desktop input.");
    return engine.submit(String(args[0]), {}, args[1] as "hotkey" | "schedule");
  }
  if (method === "controlRun") {
    engine.control(
      String(args[0]),
      args[1] as "pause" | "resume" | "step" | "stop",
    );
    return true;
  }
  if (method === "stopAll") {
    if (stoppingRuns) {
      await stoppingRuns;
      return true;
    }
    const roots = engine.activeRuns().filter((run) => !run.parentId);
    const stop = async () => {
      for (const run of roots) engine.control(run.id, "stop");
      await Promise.all(roots.map((run) => engine.wait(run.id)));
      if (recordingLocked() || recording.getState().phase !== "idle")
        await recording.stopCurrent();
      await Promise.all([native.releaseAll(), browser.releaseAll()]);
    };
    stoppingRuns = stop();
    try {
      await stoppingRuns;
      return true;
    } finally {
      stoppingRuns = undefined;
    }
  }
  if (method === "pauseAll") {
    for (const run of engine.activeRuns())
      if (!run.parentId) engine.control(run.id, "pause");
    const state = recording.getState();
    if (state.phase === "capturing" && state.sessionId)
      await recording.pause(state.sessionId);
    return true;
  }
  if (method === "testConnection") {
    const connection = workspace.connections.find((c) => c.id === args[0]);
    if (!connection) throw new Error("Connection not found.");
    const expected = args[2] as {
      connectionRevision: number;
      credentialRevision: number;
    };
    if (
      (connection.revision ?? 0) !== expected.connectionRevision ||
      (connection.credentialRevision ?? 0) !== expected.credentialRevision
    )
      throw new Error(
        "Connection changed before the probe started. Try again.",
      );
    const snapshot = structuredClone(connection),
      key = workspace.keys[connection.id];
    return new AIService(() => key).test(
      snapshot,
      aiCheckOperationSchema.parse(args[1]),
    );
  }
  if (method === "startRecording")
    return recording.start(args[0] as RecordingStartOptions);
  if (method === "recordAction") {
    const sessionId = String(args[0]);
    const state = recording.getState();
    // Validate the session before reading or preparing an action for an adapter.
    if (state.sessionId !== sessionId)
      throw new Error("This recording session is no longer current.");
    const source = structuredClone(args[1]) as Omit<
      RecordedAction,
      "id" | "at"
    >;
    const latest = [...captures.values()]
      .reverse()
      .find((frame) => frame.targetId === state.targetId);
    if (latest && ["click", "move", "drag"].includes(source.kind))
      Object.assign(source.config, {
        expectedWidth: latest.width,
        expectedHeight: latest.height,
      });
    return recording.record(sessionId, source, Boolean(args[2]));
  }
  if (method === "pauseRecording") return recording.pause(String(args[0]));
  if (method === "resumeRecording") return recording.resume(String(args[0]));
  if (method === "setRecordingTarget")
    return recording.setTarget(String(args[0]), String(args[1]));
  if (method === "stopRecording") return recording.stop(String(args[0]));
  if (method === "updateRecording")
    return recording.update(
      String(args[0]),
      Number(args[1]),
      args[2] as RecordedAction[],
    );
  if (method === "discardRecording")
    return recording.discard(String(args[0]), Number(args[1]));
  if (method === "insertRecording")
    return recording.insert(
      String(args[0]),
      Number(args[1]),
      args[2] as RecordingInsertOptions,
    );
  if (method === "dispose") {
    disposing = true;
    try {
      await handle("stopAll", []);
    } finally {
      await Promise.allSettled([browser.dispose(), native.dispose()]);
      initialized = false;
    }
    return true;
  }
  throw new Error("Unknown automation service command.");
}
port.on("message", ({ data }) => {
  if (data.method === "recordingStoreResult") {
    const pending = recordingRequests.get(data.id);
    if (pending) {
      recordingRequests.delete(data.id);
      clearTimeout(pending.timer);
      const response = data.args[0] as { result?: unknown; error?: string };
      if (response.error) pending.reject(new Error(response.error));
      else pending.resolve(response.result);
    }
    return;
  }
  void handle(data.method, data.args)
    .then((result) => port.postMessage({ id: data.id, result }))
    .catch((error) =>
      port.postMessage({
        id: data.id,
        error: safeAIError(error),
        ...(error instanceof NativeServiceError
          ? { nativeError: { ...error.details, message: safeAIError(error) } }
          : {}),
      }),
    );
});
