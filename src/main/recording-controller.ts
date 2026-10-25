import { randomUUID } from "node:crypto";
import { nodeDefinitions } from "../shared/node-definitions";
import { emptyRecording, recordableKinds } from "../shared/recording";
import { boundedJson, recordingStateSchema } from "../shared/validation";
import type {
  FlowDefinition,
  RecordedAction,
  RecordingInsertOptions,
  RecordingInsertResult,
  RecordingStartOptions,
  RecordingState,
  TargetDescriptor,
} from "../shared/types";

export interface RecordingControllerOptions {
  initialState?: RecordingState;
  getTarget(id: string): TargetDescriptor | undefined;
  getFlow(id: string): FlowDefinition | undefined;
  canStart(): void;
  persist(state: RecordingState): Promise<RecordingState>;
  insert(
    state: RecordingState,
    options: RecordingInsertOptions,
  ): Promise<RecordingInsertResult>;
  startDirect(
    target: TargetDescriptor,
    onAction: (action: RecordedAction) => void,
  ): Promise<void>;
  stopDirect(): Promise<void>;
  execute(
    action: RecordedAction,
    target: TargetDescriptor,
    signal: AbortSignal,
    ownerId: string,
  ): Promise<unknown>;
  releaseInputs(ownerId: string): Promise<void>;
  onState(state: RecordingState): void;
  now?: () => number;
  newId?: () => string;
}

const allowed: ReadonlySet<string> = new Set(recordableKinds);
const performable = new Set([
  "click",
  "move",
  "drag",
  "scroll",
  "type",
  "key",
  "focus",
  "navigate",
  "read",
  "select",
]);
const message = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);
export class RecordingStorageTimeoutError extends Error {}

/** Owns capture boundaries; review mutations have no path to an input adapter. */
export class RecordingController {
  private state: RecordingState;
  private pending?: RecordingState;
  private queue: Promise<void> = Promise.resolve();
  private transitions = 0;
  private epoch = 0;
  private controller?: AbortController;
  private target?: TargetDescriptor;
  private ownsInputs = false;
  private cleanupBlocked = false;
  private queuedEvents = 0;
  private limitStopping = false;
  private insertUncertain = false;

  constructor(private options: RecordingControllerOptions) {
    this.state = structuredClone(options.initialState ?? emptyRecording());
    // Main normally supplies recovery state; never start capture from persisted data.
    if (this.state.phase === "capturing" || this.state.phase === "paused")
      this.state = {
        ...this.state,
        active: false,
        phase: "review",
        recovered: true,
      };
  }

  getState(): RecordingState {
    return structuredClone(this.state);
  }
  isLocked(): boolean {
    return (
      this.state.phase === "capturing" ||
      this.transitions > 0 ||
      this.cleanupBlocked ||
      Boolean(this.pending)
    );
  }
  private working(): RecordingState {
    return this.pending ?? this.state;
  }
  private enqueue<T>(operation: () => Promise<T>, lock = false): Promise<T> {
    if (lock) this.transitions++;
    const result = this.queue.then(operation).finally(() => {
      if (lock) this.transitions--;
    });
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  private session(id: string): RecordingState {
    const state = this.working();
    if (!id || state.sessionId !== id || state.phase === "idle")
      throw new Error(
        "This recording session is no longer current. Refresh the recording draft.",
      );
    return state;
  }
  private review(
    id: string,
    revision: number,
    retryInsert = false,
  ): RecordingState {
    const state = this.session(id);
    if (state.phase !== "review" || this.cleanupBlocked || this.pending)
      throw new Error(
        "Stop recording and finish input cleanup before editing the review.",
      );
    if (state.revision !== revision)
      throw new Error(
        "This recording draft changed. Refresh it before editing.",
      );
    if (this.insertUncertain && !retryInsert)
      throw new Error(
        "The previous insertion was not acknowledged. Retry Insert before editing or discarding this draft.",
      );
    return state;
  }
  private interrupt(): void {
    this.epoch++;
    this.controller?.abort(new Error("Recording interrupted"));
  }
  private prepare(next: RecordingState): RecordingState {
    const candidate = {
      ...next,
      active: next.phase === "capturing",
      ...(next.error ? { error: next.error.slice(0, 4000) } : {}),
    };
    boundedJson(candidate);
    return recordingStateSchema.parse(candidate);
  }
  private preflightActions(actions: RecordedAction[]): void {
    // Reserve room for a cleanup/recovery warning before input can happen.
    // An already-observed direct event must not strand an unsaveable candidate.
    this.prepare({
      ...this.working(),
      actions,
      phase: "paused",
      revision: Number.MAX_SAFE_INTEGER,
      recovered: true,
      error: "\0".repeat(4000),
    });
  }
  private async commit(next: RecordingState): Promise<RecordingState> {
    // Deterministic validation failures never replace the last retryable draft.
    this.pending = this.prepare(next);
    const saved = await this.options.persist(structuredClone(this.pending));
    this.state = structuredClone(saved);
    this.pending = undefined;
    this.options.onState(this.getState());
    return this.getState();
  }
  private async change(
    patch: Partial<RecordingState>,
  ): Promise<RecordingState> {
    const previous = this.working();
    return this.commit({
      ...previous,
      ...patch,
      revision: previous.revision + 1,
    });
  }
  private async retryReviewWrite(
    sessionId: string,
    revision: number,
  ): Promise<RecordingState | undefined> {
    if (
      !this.pending ||
      this.state.phase !== "review" ||
      this.state.sessionId !== sessionId ||
      this.state.revision !== revision ||
      !["review", "idle"].includes(this.pending.phase)
    )
      return undefined;
    return this.commit(this.pending);
  }
  private currentTarget(): TargetDescriptor {
    const id = this.working().targetId;
    const current = id && this.options.getTarget(id);
    if (!current)
      throw new Error(
        "The recording target no longer exists. Choose a target while paused.",
      );
    if (!this.target || JSON.stringify(current) !== JSON.stringify(this.target))
      throw new Error(
        "The recording target changed. Select it again while paused before resuming.",
      );
    return structuredClone(this.target);
  }
  private async cleanup(): Promise<void> {
    if (!this.ownsInputs && !this.cleanupBlocked) return;
    const owner = this.working().sessionId!;
    const results = await Promise.allSettled([
      this.options.stopDirect(),
      this.options.releaseInputs(owner),
    ]);
    const failed = results.find((result) => result.status === "rejected");
    this.cleanupBlocked = failed?.status === "rejected";
    if (failed?.status === "rejected")
      throw new Error(
        `Recording input cleanup failed: ${message(failed.reason)}. Retry Stop before running another workflow.`,
      );
    this.ownsInputs = false;
  }
  private async fail(cause: unknown): Promise<never> {
    this.interrupt();
    let error = message(cause);
    if (!this.cleanupBlocked) {
      try {
        await this.cleanup();
      } catch (cleanupError) {
        error += ` ${message(cleanupError)}`;
      }
    }
    if (this.working().sessionId) {
      try {
        await this.change({ phase: "paused", error });
      } catch (saveError) {
        throw new Error(
          `${error} The draft could not be saved: ${message(saveError)}. Retry Stop; application actions will not be repeated.`,
        );
      }
    }
    throw new Error(error);
  }
  private callback(
    sessionId: string,
    epoch: number,
  ): (action: RecordedAction) => void {
    return (source) => {
      if (
        this.epoch !== epoch ||
        this.controller?.signal.aborted ||
        this.working().phase !== "capturing" ||
        this.working().sessionId !== sessionId
      )
        return;
      if (this.working().actions.length + this.queuedEvents >= 2000) {
        if (!this.limitStopping) {
          this.limitStopping = true;
          this.interrupt();
          void this.enqueue(async () => {
            try {
              await this.cleanup();
              await this.change({
                phase: "paused",
                error:
                  "Recording reached the 2000-step limit. Review or discard this draft before recording more.",
              });
            } catch (error) {
              await this.fail(error);
            } finally {
              this.limitStopping = false;
            }
          }, true).catch(() => undefined);
        }
        return;
      }
      this.queuedEvents++;
      void this.enqueue(async () => {
        try {
          // This event was observed before the boundary. Drain accepted events even
          // when pause/stop has already invalidated callbacks that arrive later.
          if (this.working().sessionId !== sessionId) return;
          const action = this.makeAction(source, this.target!);
          const actions = [...this.working().actions, action];
          this.preflightActions(actions);
          await this.change({ actions });
        } catch (error) {
          await this.fail(
            new Error(
              `The observed action could not be added to the recording. ${message(error)} The previously saved steps are preserved.`,
            ),
          );
        } finally {
          this.queuedEvents--;
        }
      }).catch(() => undefined);
    };
  }
  private makeAction(
    source: Omit<RecordedAction, "id" | "at">,
    target: TargetDescriptor,
  ): RecordedAction {
    if (
      !allowed.has(source.kind) ||
      typeof source.label !== "string" ||
      !source.config ||
      typeof source.config !== "object" ||
      Array.isArray(source.config)
    )
      throw new Error("This action cannot be recorded.");
    return {
      kind: source.kind,
      label: source.label.slice(0, 200),
      config: { ...structuredClone(source.config), targetId: target.id },
      id: (this.options.newId ?? randomUUID)(),
      at: (this.options.now ?? Date.now)(),
    };
  }

  start(options: RecordingStartOptions): Promise<RecordingState> {
    options = structuredClone(options);
    const requestedEpoch = this.epoch;
    return this.enqueue(async () => {
      if (requestedEpoch !== this.epoch)
        throw new Error("Recording start was cancelled.");
      if (this.working().phase !== "idle" || this.cleanupBlocked)
        throw new Error(
          "Insert or discard the current recording draft before starting another.",
        );
      this.options.canStart();
      const flow = this.options.getFlow(options.flowId);
      if (!flow || flow.revision !== options.flowRevision)
        throw new Error(
          "The destination workflow changed. Save or refresh it before recording.",
        );
      const target = this.options.getTarget(options.targetId);
      if (!target) throw new Error("Choose an available recording target.");
      this.target = structuredClone(target);
      const sessionId = (this.options.newId ?? randomUUID)();
      const controller = (this.controller = new AbortController());
      const epoch = ++this.epoch;
      try {
        await this.commit({
          phase: "capturing",
          active: true,
          revision: 1,
          sessionId,
          mode: options.mode,
          targetId: target.id,
          destination: {
            flowId: flow.id,
            flowRevision: flow.revision,
            flowName: flow.name,
            ...(options.anchorNodeId
              ? { anchorNodeId: options.anchorNodeId }
              : {}),
            ...(options.anchor ? { anchor: options.anchor } : {}),
          },
          actions: [],
        });
        controller.signal.throwIfAborted();
        this.ownsInputs = true;
        if (options.mode === "direct")
          await this.options.startDirect(
            structuredClone(target),
            this.callback(sessionId, epoch),
          );
        controller.signal.throwIfAborted();
        return this.getState();
      } catch (error) {
        return this.fail(error);
      }
    }, true);
  }
  record(
    sessionId: string,
    source: Omit<RecordedAction, "id" | "at">,
    perform: boolean,
  ): Promise<RecordingState> {
    this.session(sessionId);
    source = structuredClone(source);
    const epoch = this.epoch;
    return this.enqueue(async () => {
      const state = this.session(sessionId);
      if (
        state.phase !== "capturing" ||
        epoch !== this.epoch ||
        this.controller?.signal.aborted
      )
        throw new Error(
          "Recording is paused or stopped. Resume explicitly before adding actions.",
        );
      if (state.actions.length >= 2000)
        throw new Error("A recording cannot contain more than 2000 steps.");
      const target = this.currentTarget();
      const action = this.makeAction(source, target);
      if (perform && !performable.has(action.kind))
        throw new Error(
          "This step can be added to the draft but cannot be performed while recording.",
        );
      if (perform) {
        const issues = nodeDefinitions[action.kind]
          .validateConfig(
            action.config,
            { targets: [target] },
            { resolved: true },
          )
          .filter((issue) => issue.severity === "error");
        if (issues.length)
          throw new Error(issues.map((issue) => issue.message).join("; "));
      }
      const uncertainAction = {
        ...action,
        label: `${action.label.slice(0, 178)} (execution uncertain)`.slice(
          0,
          200,
        ),
        config: { ...action.config, recordingUncertain: true },
      };
      this.preflightActions([
        ...state.actions,
        perform ? uncertainAction : action,
      ]);
      let executionError: unknown;
      if (perform) {
        try {
          await this.options.execute(
            action,
            target,
            AbortSignal.any([
              this.controller!.signal,
              AbortSignal.timeout(15000),
            ]),
            sessionId,
          );
        } catch (error) {
          executionError = error;
        }
      }
      if (perform && (executionError || this.controller!.signal.aborted)) {
        action.label = uncertainAction.label;
        action.config.recordingUncertain = true;
      }
      try {
        await this.change({
          actions: [...this.working().actions, action],
          ...(action.config.recordingUncertain
            ? {
                error:
                  "The last action may have affected the application before it stopped. Review this step before inserting or replaying it.",
              }
            : {}),
        });
      } catch (error) {
        return this.fail(
          new Error(
            `The action was not acknowledged as saved. ${message(error)}`,
          ),
        );
      }
      if (executionError && !this.controller!.signal.aborted)
        return this.fail(
          new Error(`${this.working().error} ${message(executionError)}`),
        );
      return this.getState();
    }, true);
  }
  pause(sessionId: string): Promise<RecordingState> {
    this.session(sessionId);
    this.interrupt();
    return this.enqueue(async () => {
      const state = this.session(sessionId);
      if (state.phase === "review")
        throw new Error("This recording has already stopped.");
      try {
        await this.cleanup();
        return await this.change({ phase: "paused" });
      } catch (error) {
        return this.fail(error);
      }
    }, true);
  }
  resume(sessionId: string): Promise<RecordingState> {
    this.session(sessionId);
    const requestedEpoch = this.epoch;
    return this.enqueue(async () => {
      const state = this.session(sessionId);
      if (state.phase !== "paused" || this.cleanupBlocked || this.pending)
        throw new Error(
          "Only a paused recording with completed cleanup can resume.",
        );
      if (requestedEpoch !== this.epoch)
        throw new Error("Recording resume was cancelled.");
      if (state.actions.length >= 2000)
        throw new Error("This recording has reached its step limit.");
      this.options.canStart();
      const target = this.currentTarget();
      const controller = (this.controller = new AbortController());
      const epoch = ++this.epoch;
      try {
        await this.change({ phase: "capturing", error: undefined });
        controller.signal.throwIfAborted();
        this.ownsInputs = true;
        if (state.mode === "direct")
          await this.options.startDirect(
            target,
            this.callback(sessionId, epoch),
          );
        controller.signal.throwIfAborted();
        return this.getState();
      } catch (error) {
        return this.fail(error);
      }
    }, true);
  }
  setTarget(sessionId: string, targetId: string): Promise<RecordingState> {
    return this.enqueue(async () => {
      if (
        this.pending?.phase === "paused" &&
        this.state.phase === "paused" &&
        this.state.sessionId === sessionId &&
        !this.cleanupBlocked &&
        !this.ownsInputs
      ) {
        const saved = await this.commit(this.pending);
        if (saved.targetId === targetId) return saved;
      }
      const state = this.session(sessionId);
      if (state.phase !== "paused" || this.cleanupBlocked || this.pending)
        throw new Error(
          "Pause recording and finish input cleanup before switching targets.",
        );
      const target = this.options.getTarget(targetId);
      if (!target) throw new Error("Choose an available recording target.");
      this.target = structuredClone(target);
      return this.change({ targetId, error: undefined });
    });
  }
  stop(sessionId: string): Promise<RecordingState> {
    this.session(sessionId);
    return this.stopCurrent(sessionId);
  }
  /** Emergency stop also fences a start whose first durable acknowledgement is pending. */
  stopCurrent(sessionId?: string): Promise<RecordingState> {
    this.interrupt();
    return this.enqueue(async () => {
      const state = sessionId ? this.session(sessionId) : this.working();
      if (state.phase === "idle")
        return this.pending ? this.commit(this.pending) : this.getState();
      if (state.phase === "review" && !this.pending && !this.cleanupBlocked)
        return this.getState();
      try {
        await this.cleanup();
        return await this.change({ phase: "review" });
      } catch (error) {
        return this.fail(error);
      }
    }, true);
  }
  update(
    sessionId: string,
    revision: number,
    actions: RecordedAction[],
  ): Promise<RecordingState> {
    actions = structuredClone(actions);
    return this.enqueue(async () => {
      const retried = await this.retryReviewWrite(sessionId, revision);
      if (
        retried?.phase === "review" &&
        JSON.stringify(retried.actions) === JSON.stringify(actions)
      )
        return retried;
      this.review(sessionId, revision);
      if (
        actions.length > 2000 ||
        new Set(actions.map((action) => action.id)).size !== actions.length
      )
        throw new Error(
          "Recording steps must have unique IDs and contain at most 2000 steps.",
        );
      for (const action of actions)
        if (!allowed.has(action.kind))
          throw new Error("This action cannot be recorded.");
      this.preflightActions(actions);
      return this.change({ actions: structuredClone(actions) });
    });
  }
  discard(sessionId: string, revision: number): Promise<RecordingState> {
    return this.enqueue(async () => {
      const retried = await this.retryReviewWrite(sessionId, revision);
      if (retried?.phase === "idle") return retried;
      this.review(sessionId, revision);
      return this.commit(emptyRecording());
    });
  }
  insert(
    sessionId: string,
    revision: number,
    options: RecordingInsertOptions,
  ): Promise<RecordingInsertResult> {
    options = structuredClone(options);
    return this.enqueue(async () => {
      await this.retryReviewWrite(sessionId, revision);
      const state = this.review(sessionId, revision, true);
      let result: RecordingInsertResult;
      try {
        result = await this.options.insert(structuredClone(state), options);
      } catch (error) {
        if (error instanceof RecordingStorageTimeoutError)
          this.insertUncertain = true;
        throw error;
      }
      this.state = structuredClone(result.recording);
      this.insertUncertain = false;
      this.options.onState(this.getState());
      return structuredClone(result);
    });
  }
}
