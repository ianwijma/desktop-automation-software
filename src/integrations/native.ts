import {
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import {
  NATIVE_PROTOCOL_VERSION,
  NativeServiceError,
  nativeErrorSchema,
  nativeHandshakeSchema,
  nativeCaptureSchema,
  nativeWindowSchema,
  nativeCapabilitiesSchema,
  type NativeHandshake,
  type NativeErrorDetails,
} from "../shared/native-protocol";
import type {
  CaptureFrame,
  Json,
  NativeWindow,
  NodeKind,
  PlatformCapabilities,
  RecordedAction,
  TargetDescriptor,
} from "../shared/types";

import {
  nativeInspectionQuerySchema,
  nativeInspectionSchema,
  nativeLocatorSchema,
  type NativeInspectionQuery,
  type NativeLocatorInspection,
} from "../shared/native-locators";

export interface NativeAdapterOptions {
  binaryPath?: string;
  binaryArgs?: string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}
type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
};
export class NativeAdapter {
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<string, Pending>();
  private bindings = new Map<string, string>();
  private bindingDescriptors = new Map<string, string>();
  private frames = new Map<string, CaptureFrame>();
  private recording?: (action: RecordedAction) => void;
  private recordingId?: string;
  private recordingGeneration = 0;
  private recordingOperation: Promise<void> = Promise.resolve();
  private disposed = false;
  private platformSession?: string;
  private handshake?: Promise<NativeHandshake>;
  private helper?: NativeHandshake;
  private lastError?: NativeErrorDetails;
  private bindingIdentities = new Map<string, string>();
  private cleanupTask: Promise<void> = Promise.resolve();
  private heldKeys = new Set<string>();
  private inputAttempted = false;
  private portalCleanupFailed = false;
  readonly binaryPath: string;
  constructor(private options: NativeAdapterOptions = {}) {
    const resources = (process as NodeJS.Process & { resourcesPath?: string })
      .resourcesPath;
    const name =
      process.platform === "win32" ? "relay-native.exe" : "relay-native";
    const candidates = [
      resources && path.join(resources, "native", name),
      path.resolve("native/target/release", name),
      path.resolve("native/target/debug", name),
    ].filter(Boolean) as string[];
    this.binaryPath =
      options.binaryPath ??
      candidates.find(existsSync) ??
      candidates[candidates.length - 1]!;
  }
  private start() {
    if (this.disposed) throw new Error("Native adapter is closed");
    if (this.child) return this.child;
    if (!existsSync(this.binaryPath))
      throw this.serviceError(
        "DEPENDENCY_UNAVAILABLE",
        "startup",
        "Native service is not built. Run npm run build:native.",
      );
    const child = spawn(this.binaryPath, this.options.binaryArgs ?? [], {
      env: { ...process.env, ...this.options.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    this.child = child;
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      if (this.child !== child) return;
      let message: {
        protocolVersion?: number;
        id?: string;
        result?: unknown;
        error?: NativeErrorDetails;
        event?: string;
        recordingId?: string;
        action?: RecordedAction;
      };
      try {
        message = JSON.parse(line);
        if (!message || typeof message !== "object" || Array.isArray(message))
          throw new Error("Invalid envelope");
      } catch {
        this.fail(
          this.serviceError(
            "INVALID_REQUEST",
            "response",
            "Native service returned malformed JSON",
          ),
        );
        return;
      }
      if (message.protocolVersion !== NATIVE_PROTOCOL_VERSION) {
        this.fail(
          this.serviceError(
            "PROTOCOL_MISMATCH",
            "handshake",
            "Native protocol version mismatch; rebuild or reinstall the matching helper",
          ),
        );
        return;
      }
      if (message.event === "recordedAction" && message.action) {
        if (message.recordingId === this.recordingId)
          this.recording?.({ ...message.action, id: randomUUID() });
        return;
      }
      if (message.event === "nativeCleanup") return;
      if (message.event === "recordingStopped") {
        if (message.recordingId === this.recordingId)
          this.recording = undefined;
        return;
      }
      if (
        typeof message.id !== "string" ||
        "error" in message === "result" in message
      ) {
        this.fail(
          this.serviceError(
            "INVALID_REQUEST",
            "response",
            "Native service returned an invalid response envelope",
          ),
        );
        return;
      }
      const pending = message.id && this.pending.get(message.id);
      if (!pending || !message.id) return;
      this.pending.delete(message.id);
      pending.cleanup();
      if (message.error) {
        const parsed = nativeErrorSchema.safeParse(message.error);
        const error = parsed.success
          ? new NativeServiceError(parsed.data)
          : this.serviceError(
              "INVALID_REQUEST",
              "response",
              "Native service returned an invalid error envelope",
            );
        this.lastError = error.details;
        if (
          this.platformSession === "wayland" &&
          ["CAPTURE_LOST", "STALE_CAPTURE", "PERMISSION_DENIED"].includes(
            error.details.code,
          )
        )
          this.frames.clear();
        pending.reject(error);
        if (!parsed.success) this.fail(error);
      } else pending.resolve(message.result);
    });
    // Read stderr so a native dependency cannot fill its pipe; never log typed text or request payloads.
    child.stderr.on("data", () => {});
    child.once("error", (error) => {
      if (this.child === child)
        this.fail(
          this.serviceError(
            "HELPER_EXITED",
            "startup",
            "Native helper could not start; check file permissions and dependencies",
          ),
        );
    });
    child.once("exit", (code, signal) => {
      lines.close();
      if (this.child === child)
        this.fail(
          this.serviceError(
            "HELPER_EXITED",
            "transport",
            `Native service exited (${signal ?? code})`,
          ),
        );
    });
    return child;
  }
  private fail(error: Error, release = true) {
    const child = this.child;
    const wayland =
      this.platformSession === "wayland" ||
      this.helper?.backend.startsWith("wayland-") === true;
    const mayHoldInput = this.inputAttempted || this.heldKeys.size > 0;
    this.child = undefined;
    this.handshake = undefined;
    this.helper = undefined;
    this.platformSession = undefined;
    this.bindings.clear();
    this.bindingIdentities.clear();
    this.frames.clear();
    if (error instanceof NativeServiceError) this.lastError = error.details;
    const stopped = child ? this.terminate(child, wayland) : Promise.resolve();
    this.recording = undefined;
    this.recordingId = undefined;
    if (child)
      this.trackCleanup(
        wayland
          ? stopped.catch((error) => {
              this.portalCleanupFailed = true;
              throw error;
            })
          : release && mayHoldInput
            ? stopped.then(() => this.emergencyRelease())
            : stopped,
      );
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    this.pending.clear();
  }
  private serviceError(
    code: NativeErrorDetails["code"],
    operation: string,
    message: string,
  ): NativeServiceError {
    const error = new NativeServiceError({
      code,
      operation,
      message,
      backend: this.helper?.backend ?? "unavailable",
      permission: "unknown",
      retryable: false,
    });
    this.lastError = error.details;
    return error;
  }
  private terminate(child: ChildProcess, wayland = false): Promise<void> {
    if (wayland) {
      // Only the existing helper owns this grant. A fresh cleanup helper cannot
      // release it and must not open a replacement chooser after cancellation.
      let acknowledged = false;
      const replies = child.stdout
        ? createInterface({ input: child.stdout })
        : undefined;
      replies?.on("line", (line) => {
        try {
          const reply = JSON.parse(line);
          if (
            reply.protocolVersion === NATIVE_PROTOCOL_VERSION &&
            reply.event === "nativeCleanup" &&
            reply.result === true
          )
            acknowledged = true;
        } catch {
          /* Never log payloads. */
        }
      });
      try {
        // Keep capture/input connections alive until this helper has released
        // them. Forced termination below still kills its whole process group.
        child.kill("SIGTERM");
      } catch {
        child.kill();
      }
      return this.waitForExit(child, 6000).then(() => {
        replies?.close();
        if (!acknowledged || child.exitCode !== 0)
          throw new Error(
            "Wayland session cleanup was not acknowledged. Close the portal sharing session and restart Relay before sending more input.",
          );
        this.heldKeys.clear();
        this.inputAttempted = false;
      });
    }
    if (process.platform === "win32" && child.pid && child.exitCode === null) {
      return new Promise((resolve) => {
        // The persistent Windows helper has no per-request subprocesses.
        // Its launched applications must survive cancellation/restart.
        const killer = spawn("taskkill", ["/PID", String(child.pid), "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
        const done = () => {
          child.kill();
          void this.waitForExit(child).then(resolve);
        };
        killer.once("exit", done);
        killer.once("error", done);
      });
    }
    try {
      if (child.pid) process.kill(-child.pid, "SIGTERM");
      else child.kill();
    } catch {
      child.kill();
    }
    return this.waitForExit(child);
  }
  private waitForExit(child: ChildProcess, timeoutMs = 1000): Promise<void> {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null)
      return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          if (process.platform !== "win32" && child.pid)
            process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          /* Already stopped. */
        }
      }, timeoutMs);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.once("error", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  private trackCleanup(task: Promise<void>): void {
    this.cleanupTask = task;
    // A failed request rejects immediately; cleanup is checked by its caller's
    // Stop/release barrier, which may arrive after the cleanup process exits.
    void task.catch(() => {});
  }
  private async finishCleanup(retry: boolean): Promise<void> {
    const previous = this.cleanupTask;
    try {
      await previous;
    } catch (error) {
      if (!retry || this.portalCleanupFailed) throw error;
      if (this.cleanupTask === previous)
        this.trackCleanup(this.emergencyRelease());
      await this.cleanupTask;
    }
  }
  private emergencyRelease(): Promise<void> {
    if (!existsSync(this.binaryPath))
      return Promise.reject(
        new Error("Native input cleanup service is missing"),
      );
    return new Promise<void>((resolve, reject) => {
      const cleanup = spawn(this.binaryPath, this.options.binaryArgs ?? [], {
        env: { ...process.env, ...this.options.env },
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
        detached: process.platform !== "win32",
      });
      let finished = false;
      let failure: Error | undefined;
      const acknowledgements = new Set<string>();
      const lines = createInterface({ input: cleanup.stdout! });
      lines.on("line", (line) => {
        try {
          const reply = JSON.parse(line) as {
            protocolVersion?: number;
            id?: string;
            error?: { message?: string };
            result?: unknown;
          };
          if (reply.id !== "cleanup-keys" && reply.id !== "cleanup") return;
          if (reply.protocolVersion !== NATIVE_PROTOCOL_VERSION)
            failure = this.serviceError(
              "PROTOCOL_MISMATCH",
              "cleanup",
              "Native input cleanup protocol is incompatible",
            );
          else if (reply.error) {
            const details = nativeErrorSchema.safeParse(reply.error);
            failure = details.success
              ? new NativeServiceError(details.data)
              : new Error("Native cleanup returned an invalid error");
          } else if (reply.result !== true)
            failure = new Error("Native input cleanup was not acknowledged");
          else acknowledgements.add(reply.id);
        } catch {
          failure = new Error("Native cleanup returned malformed JSON");
        }
      });
      const done = (code: number | null = null) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        lines.close();
        if (failure || code !== 0 || acknowledgements.size !== 2) {
          reject(
            failure ?? new Error("Native input cleanup was not acknowledged"),
          );
          return;
        }
        this.heldKeys.clear();
        this.inputAttempted = false;
        resolve();
      };
      const timer = setTimeout(
        () => {
          failure = new Error("Native input cleanup timed out");
          if (process.platform === "win32") {
            void this.terminate(cleanup).then(() => done());
            return;
          }
          try {
            if (cleanup.pid) process.kill(-cleanup.pid, "SIGKILL");
            else cleanup.kill("SIGKILL");
          } catch {
            /* Exit handler completes the barrier. */
          }
        },
        process.platform === "win32" ? 15000 : 5000,
      );
      timer.unref();
      cleanup.once("error", (error) => {
        failure = error;
        done();
      });
      cleanup.once("close", done);
      cleanup.stdin?.on("error", () => {});
      cleanup.stdin?.end(
        `${JSON.stringify({ protocolVersion: NATIVE_PROTOCOL_VERSION, id: "cleanup-keys", method: "releaseKeys", params: { keys: [...this.heldKeys] } })}\n${JSON.stringify({ protocolVersion: NATIVE_PROTOCOL_VERSION, id: "cleanup", method: "releaseAll", params: {} })}\n`,
      );
    });
  }
  private async rpc<T>(
    method: string,
    params: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<T> {
    await this.cleanupTask;
    if (signal?.aborted)
      return Promise.reject(signal.reason ?? new Error("Cancelled"));
    const child = this.start();
    if (!this.handshake) {
      this.handshake = this.request<unknown>(
        child,
        "handshake",
        {},
        signal,
      ).then((value) => {
        const parsed = nativeHandshakeSchema.safeParse(value);
        if (!parsed.success) {
          const error = this.serviceError(
            "PROTOCOL_MISMATCH",
            "handshake",
            "Native helper handshake is incompatible; rebuild or reinstall the matching helper",
          );
          this.fail(error, false);
          throw error;
        }
        this.helper = parsed.data;
        return parsed.data;
      });
    }
    await this.handshake;
    if (this.child !== child)
      throw this.serviceError(
        "HELPER_EXITED",
        method,
        "Native helper changed before the operation could start",
      );
    if (signal?.aborted)
      throw this.serviceError("CANCELLED", method, "Cancelled");
    return this.request<T>(child, method, params, signal);
  }
  private request<T>(
    child: ChildProcessWithoutNullStreams,
    method: string,
    params: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = randomUUID();
      const abort = () => {
        this.fail(
          this.serviceError(
            signal?.aborted ? "CANCELLED" : "TIMEOUT",
            method,
            signal?.aborted ? "Cancelled" : `Native ${method} timed out`,
          ),
        );
      };
      const timer = setTimeout(
        abort,
        this.options.timeoutMs ??
          Math.max(
            this.platformSession === "wayland" ? 120000 : 30000,
            Math.min(120000, Number(params.durationMs ?? 0)) + 5000,
          ),
      );
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      };
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        cleanup,
      });
      signal?.addEventListener("abort", abort, { once: true });
      child.stdin.write(
        `${JSON.stringify({ protocolVersion: NATIVE_PROTOCOL_VERSION, id, method, params })}\n`,
        (error) => {
          if (error && this.child === child)
            this.fail(
              this.serviceError(
                "HELPER_EXITED",
                method,
                "Native helper request could not be delivered",
              ),
            );
        },
      );
    });
  }
  async capabilities(signal?: AbortSignal): Promise<PlatformCapabilities> {
    try {
      const raw = await this.rpc<unknown>("capabilities", {}, signal);
      const parsed = nativeCapabilitiesSchema.safeParse(raw);
      if (!parsed.success)
        throw this.serviceError(
          "INVALID_REQUEST",
          "capabilities",
          `Native helper returned invalid capability metadata (${parsed.error.issues
            .map((issue) => {
              // Record keys can be arbitrary; report only fixed schema paths.
              const limit =
                issue.path[0] === "native" &&
                ["permissions", "operations"].includes(String(issue.path[1]))
                  ? 2
                  : 4;
              return issue.path.slice(0, limit).join(".");
            })
            .join(", ")})`,
        );
      const result: PlatformCapabilities = parsed.data;
      if (
        result.native?.helper &&
        (result.native.helper.instanceId !== this.helper?.instanceId ||
          result.native.helper.backend !== this.helper?.backend)
      )
        throw this.serviceError(
          "INVALID_REQUEST",
          "capabilities",
          "Native capability metadata identifies a different helper",
        );
      this.platformSession = result.session;
      result.native = {
        ...result.native,
        helper: this.helper,
        ...(this.lastError ? { lastError: this.lastError } : {}),
      };
      return result;
    } catch (error) {
      if (signal?.aborted) throw error;
      this.lastError = (
        error instanceof NativeServiceError
          ? error
          : this.serviceError(
              "BACKEND_FAILURE",
              "capabilities",
              (error as Error).message,
            )
      ).details;
      return {
        platform: process.platform,
        session: "unavailable",
        capture: false,
        input: false,
        accessibility: false,
        directRecording: false,
        globalShortcuts: false,
        windows: [],
        reasons: [(error as Error).message],
        native: {
          ...(this.helper ? { helper: this.helper } : {}),
          ...(this.lastError ? { lastError: this.lastError } : {}),
        },
      };
    }
  }
  async listWindows(signal?: AbortSignal): Promise<NativeWindow[]> {
    const parsed = nativeWindowSchema
      .array()
      .safeParse(await this.rpc("listWindows", {}, signal));
    if (!parsed.success)
      throw this.serviceError(
        "INVALID_REQUEST",
        "listWindows",
        "Native helper returned invalid window metadata",
      );
    return parsed.data;
  }
  private async resolve(
    target: TargetDescriptor,
    signal?: AbortSignal,
  ): Promise<NativeWindow> {
    if (signal?.aborted) throw new Error("Cancelled");
    if (!this.platformSession) {
      const capabilities = await this.capabilities(signal);
      if (capabilities.session === "unavailable")
        throw this.lastError
          ? new NativeServiceError(this.lastError)
          : new Error(capabilities.reasons.join(" "));
    }
    if (this.platformSession === "wayland") {
      const frame = this.frames.get(target.id);
      return {
        id: `portal:${target.id}`,
        title: target.name,
        bounds: frame?.bounds ?? { x: 0, y: 0, width: 0, height: 0 },
      };
    }
    const windows = await this.listWindows(signal);
    const descriptor = JSON.stringify([
      target.application,
      target.windowTitle,
      target.windowsCaptureBackend,
    ]);
    if (this.bindingDescriptors.get(target.id) !== descriptor) {
      this.bindings.delete(target.id);
      this.frames.delete(target.id);
    }
    const binding = this.bindings.get(target.id);
    const identity = (window: NativeWindow) =>
      JSON.stringify(window.applicationIdentity ?? null);
    const bound = windows.find(
      (window) =>
        window.id === binding &&
        identity(window) === this.bindingIdentities.get(target.id),
    );
    if (bound) return bound;
    let matches = windows;
    if (target.application)
      matches = matches.filter((window) =>
        window.application
          ?.toLowerCase()
          .includes(target.application!.toLowerCase()),
      );
    if (target.windowTitle) {
      const exact = matches.filter(
        (window) => window.title === target.windowTitle,
      );
      matches = exact.length
        ? exact
        : matches.filter((window) =>
            window.title
              .toLowerCase()
              .includes(target.windowTitle!.toLowerCase()),
          );
    }
    if (!target.application && !target.windowTitle)
      throw new Error(
        "Choose an application or window title for this desktop target",
      );
    if (!matches.length)
      throw this.serviceError(
        "TARGET_UNAVAILABLE",
        "attach",
        `Target window not found: ${target.name}`,
      );
    if (matches.length !== 1)
      throw this.serviceError(
        "AMBIGUOUS_TARGET",
        "attach",
        `Multiple windows match ${target.name}; use a more specific window title`,
      );
    this.bindings.set(target.id, matches[0]!.id);
    this.bindingIdentities.set(target.id, identity(matches[0]!));
    this.bindingDescriptors.set(target.id, descriptor);
    return matches[0]!;
  }
  private assertSemanticBackend(
    backend: string | undefined,
    operation: string,
  ) {
    const expected =
      this.helper?.backend === "win32-wgc"
        ? "uia"
        : this.helper?.backend === "macos-screencapturekit"
          ? "ax"
          : undefined;
    if (!expected || (backend !== undefined && backend !== expected))
      throw this.serviceError(
        "UNSUPPORTED_OPERATION",
        operation,
        "Choose a semantic locator matching this target platform (Windows UIA or macOS AX)",
      );
  }
  async inspectLocator(
    target: TargetDescriptor,
    query: NativeInspectionQuery,
    signal?: AbortSignal,
  ): Promise<NativeLocatorInspection> {
    if (target.kind !== "desktop")
      throw new Error("Native inspection requires a desktop target");
    const parsed = nativeInspectionQuerySchema.parse(query);
    const window = await this.resolve(target, signal);
    this.assertSemanticBackend(
      "locator" in parsed ? parsed.locator.backend : undefined,
      "inspectNativeLocator",
    );
    let params: Record<string, unknown> = parsed;
    if ("point" in parsed) {
      const { x, y, frameId } = parsed.point;
      const frame = this.frames.get(target.id);
      if (
        !frame ||
        frame.id !== frameId ||
        !frame.native ||
        frame.native.helperInstanceId !== this.helper?.instanceId ||
        frame.native.windowId !== window.id ||
        JSON.stringify(frame.bounds) !== JSON.stringify(window.bounds) ||
        frame.native.geometry.dpi !== window.dpi ||
        (this.helper?.backend === "macos-screencapturekit" &&
          frame.native.geometry.displayScale !== window.displayScale) ||
        x >= frame.width ||
        y >= frame.height
      )
        throw this.serviceError(
          "STALE_CAPTURE",
          "inspectNativeLocator",
          "Capture changed; refresh the picker preview",
        );
      const transform = frame.native.geometry.pixelToInput;
      params = {
        point: {
          x: window.bounds.x + x * transform.scaleX + (transform.offsetX ?? 0),
          y: window.bounds.y + y * transform.scaleY + (transform.offsetY ?? 0),
        },
        expectedBounds: window.bounds,
      };
    }
    return nativeInspectionSchema.parse(
      await this.rpc(
        "inspectNativeLocator",
        {
          ...params,
          windowId: window.id,
          applicationIdentity: window.applicationIdentity,
        },
        signal,
      ),
    );
  }
  async capture(
    target: TargetDescriptor,
    signal?: AbortSignal,
  ): Promise<CaptureFrame> {
    const window = await this.resolve(target, signal);
    this.frames.delete(target.id);
    if (this.helper?.backend === "win32-wgc" && !target.windowsCaptureBackend)
      throw this.serviceError(
        "CAPTURE_UNAVAILABLE",
        "capture",
        "Choose a Windows capture method for this application in Settings before capturing",
      );
    const raw = await this.rpc<unknown>(
      "capture",
      {
        windowId: window.id,
        applicationIdentity: window.applicationIdentity,
        captureBackend: target.windowsCaptureBackend,
      },
      signal,
    );
    const parsed = nativeCaptureSchema.safeParse(raw);
    if (!parsed.success)
      throw this.serviceError(
        "INVALID_REQUEST",
        "capture",
        "Native capture returned invalid geometry metadata",
      );
    const result = parsed.data;
    const metadata: CaptureFrame["native"] = result.native;
    const source = metadata.geometry.captureBounds ?? result.bounds;
    const expectedBackend =
      this.helper?.backend === "win32-wgc" &&
      target.windowsCaptureBackend === "printwindow"
        ? "win32-printwindow"
        : this.helper?.backend;
    if (
      metadata.helperInstanceId !== this.helper?.instanceId ||
      metadata.backend !== expectedBackend ||
      metadata.windowId !== window.id ||
      metadata.geometry.inputSpace !== this.helper?.coordinateSpace ||
      Math.abs(
        (metadata.geometry.pixelToInput.offsetX ?? 0) -
          (source.x - result.bounds.x),
      ) > 1e-9 ||
      Math.abs(
        (metadata.geometry.pixelToInput.offsetY ?? 0) -
          (source.y - result.bounds.y),
      ) > 1e-9 ||
      source.x < result.bounds.x ||
      source.y < result.bounds.y ||
      source.x + source.width > result.bounds.x + result.bounds.width ||
      source.y + source.height > result.bounds.y + result.bounds.height ||
      Math.abs(
        metadata.geometry.pixelToInput.scaleX - source.width / result.width,
      ) > 1e-9 ||
      Math.abs(
        metadata.geometry.pixelToInput.scaleY - source.height / result.height,
      ) > 1e-9
    )
      throw this.serviceError(
        "INVALID_REQUEST",
        "capture",
        "Native capture returned invalid identity or coordinate transform",
      );
    if (this.platformSession === "wayland" && !metadata.sourceToken)
      throw this.serviceError(
        "INVALID_REQUEST",
        "capture",
        "Wayland capture did not identify its granted source",
      );
    metadata.application = window.applicationIdentity;
    const frame: CaptureFrame = {
      ...result,
      id: randomUUID(),
      targetId: target.id,
      scale: 1 / metadata.geometry.pixelToInput.scaleX,
    };
    this.frames.set(target.id, frame);
    return frame;
  }
  async execute(
    kind: NodeKind,
    config: Record<string, Json>,
    target: TargetDescriptor,
    signal?: AbortSignal,
  ): Promise<Json> {
    if (kind === "launch") {
      const configured =
        target.launch?.[process.platform as "linux" | "win32" | "darwin"];
      const command =
        typeof config.command === "string"
          ? config.command
          : configured?.command;
      const args = Array.isArray(config.args)
        ? config.args
        : (configured?.args ?? []);
      if (!command)
        throw new Error(`No launch command configured for ${process.platform}`);
      this.bindings.delete(target.id);
      const result = await this.rpc<Json>("launch", { command, args }, signal);
      const deadline = Date.now() + Number(config.timeoutMs ?? 10000);
      while (Date.now() < deadline) {
        if (signal?.aborted) throw new Error("Cancelled");
        try {
          await this.resolve(target, signal);
          return result;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }
      throw new Error(
        "Application launched, but its target window did not appear before the timeout",
      );
    }
    const window = await this.resolve(target, signal);
    if (kind === "attach") {
      if (this.platformSession === "wayland")
        throw this.serviceError(
          "UNSUPPORTED_OPERATION",
          "attach",
          "Wayland cannot attach by application or title; capture this target to select a source in the portal chooser",
        );
      return { windowId: window.id };
    }
    if (kind === "screenshot")
      return (await this.capture(target, signal)) as unknown as Json;
    if (kind === "focus" || kind === "close") {
      const result = await this.rpc<Json>(
        kind,
        {
          windowId: window.id,
          applicationIdentity: window.applicationIdentity,
        },
        signal,
      );
      if (kind === "close") this.bindings.delete(target.id);
      return result;
    }
    if (config.nativeLocator !== undefined) {
      const locator = nativeLocatorSchema.parse(config.nativeLocator);
      this.assertSemanticBackend(locator.backend, "nativeElement");
      if (
        config.locator ||
        config.selector ||
        config.detection ||
        config.checked !== undefined ||
        config.modifiers ||
        (kind === "click" &&
          ((config.button && config.button !== "left") ||
            Number(config.clickCount ?? 1) !== 1))
      )
        throw new Error(
          "Choose one semantic action; pointer buttons, repeated clicks and browser options require explicit coordinate/browser mode",
        );
      if (kind === "detect") {
        const result = await this.inspectLocator(target, { locator }, signal);
        if (result.status === "ambiguous")
          throw this.serviceError(
            "AMBIGUOUS_ELEMENT",
            "nativeElement",
            "Multiple controls match; refine the semantic locator",
          );
        return {
          outcome: result.status === "unique" ? "match" : "no-match",
          value: result as unknown as Json,
        };
      }
      const action = {
        click: "invoke",
        type: "setValue",
        read: "read",
        select: "select",
      }[kind as "click" | "type" | "read" | "select"];
      if (!action)
        throw this.serviceError(
          "UNSUPPORTED_OPERATION",
          "nativeElement",
          "This node has no supported semantic action",
        );
      if (
        kind === "select" &&
        config.value !== undefined &&
        config.value !== ""
      )
        throw new Error(
          "Native Select selects the matched item; choose that item's locator instead of a browser option value",
        );
      if (config.requiresConfiguration)
        throw new Error("Configure this recorded interaction before running");
      if (action !== "read") this.inputAttempted = true;
      return this.rpc<Json>(
        "nativeElement",
        {
          windowId: window.id,
          applicationIdentity: window.applicationIdentity,
          locator,
          action,
          ...(action === "setValue" ? { text: String(config.text ?? "") } : {}),
        },
        signal,
      );
    }
    if (config.requiresConfiguration)
      throw new Error(
        String(
          config.recordingWarning ??
            "Configure this recorded step before running",
        ),
      );
    if (
      config.selector ||
      config.locator ||
      config.toLocator ||
      config.checked !== undefined ||
      config.scrollTop !== undefined ||
      config.scrollLeft !== undefined ||
      config.modifiers
    )
      throw new Error(
        "Native accessibility selectors are not implemented; use a visual detector or window-relative coordinates",
      );
    const sourceFrame = this.frames.get(target.id);
    if (
      this.platformSession === "wayland" &&
      !sourceFrame?.native?.sourceToken &&
      !(kind === "key" && config.action === "up")
    )
      throw this.serviceError(
        "PERMISSION_DENIED",
        "input",
        "Capture this Wayland target to explicitly grant a source before sending input",
      );
    if (
      typeof config.frameId === "string" &&
      (!sourceFrame ||
        config.frameId !== sourceFrame.id ||
        sourceFrame.native?.helperInstanceId !== this.helper?.instanceId ||
        sourceFrame.native?.windowId !== window.id ||
        sourceFrame.native?.backend !==
          (this.helper?.backend === "win32-wgc" &&
          target.windowsCaptureBackend === "printwindow"
            ? "win32-printwindow"
            : this.helper?.backend) ||
        (sourceFrame.native?.geometry.dpi !== undefined &&
          sourceFrame.native.geometry.dpi !== window.dpi) ||
        (sourceFrame.native?.geometry.displayScale !== undefined &&
          sourceFrame.native.geometry.displayScale !== window.displayScale) ||
        JSON.stringify(sourceFrame.native?.application ?? null) !==
          JSON.stringify(window.applicationIdentity ?? null) ||
        (sourceFrame.bounds &&
          (sourceFrame.bounds.width !== window.bounds.width ||
            sourceFrame.bounds.height !== window.bounds.height)))
    )
      throw this.serviceError(
        "STALE_CAPTURE",
        "input",
        "Capture geometry changed; capture and detect the target again",
      );
    if (
      typeof config.expectedWidth === "number" &&
      typeof config.expectedHeight === "number"
    ) {
      const latest = await this.capture(target, signal);
      if (
        latest.width !== config.expectedWidth ||
        latest.height !== config.expectedHeight
      )
        throw new Error(
          "Target dimensions changed since recording; recapture and update this action",
        );
    }
    const input = { ...config };
    if (this.platformSession === "wayland" && sourceFrame?.native?.sourceToken)
      input.sourceToken = sourceFrame.native.sourceToken;
    const frame = this.frames.get(target.id);
    if (frame?.bounds) {
      const sx = frame.native!.geometry.pixelToInput.scaleX,
        sy = frame.native!.geometry.pixelToInput.scaleY;
      for (const key of ["x", "toX"])
        if (typeof input[key] === "number")
          input[key] =
            input[key] * sx +
            (frame.native!.geometry.pixelToInput.offsetX ?? 0);
      for (const key of ["y", "toY"])
        if (typeof input[key] === "number")
          input[key] =
            input[key] * sy +
            (frame.native!.geometry.pixelToInput.offsetY ?? 0);
    }
    if (
      kind === "key" &&
      config.action !== "up" &&
      typeof config.key === "string"
    )
      this.heldKeys.add(config.key);
    this.inputAttempted = true;
    const result = await this.rpc<Json>(
      "input",
      {
        ...input,
        kind,
        windowId: window.id,
        applicationIdentity: window.applicationIdentity,
      },
      signal,
    );
    if (
      kind === "key" &&
      config.action !== "down" &&
      typeof config.key === "string"
    )
      this.heldKeys.delete(config.key);
    return result;
  }
  async startRecording(
    target: TargetDescriptor,
    onAction: (action: RecordedAction) => void,
  ): Promise<void> {
    const descriptor = structuredClone(target);
    const generation = ++this.recordingGeneration;
    this.recording = undefined;
    this.recordingId = undefined;
    const operation = this.recordingOperation
      .catch(() => {})
      .then(async () => {
        if (this.child) await this.rpc("stopRecording");
        if (generation !== this.recordingGeneration) return;
        const window = await this.resolve(descriptor);
        if (generation !== this.recordingGeneration) return;
        this.recording = (action) =>
          onAction({
            ...action,
            config: { ...action.config, targetId: descriptor.id },
          });
        this.recordingId = randomUUID();
        try {
          await this.rpc("startRecording", {
            windowId: window.id,
            applicationIdentity: window.applicationIdentity,
            recordingId: this.recordingId,
          });
        } catch (error) {
          this.recording = undefined;
          this.recordingId = undefined;
          throw error;
        }
      });
    this.recordingOperation = operation;
    return operation;
  }
  async stopRecording(): Promise<void> {
    if (
      (this.platformSession === "wayland" ||
        this.helper?.backend.startsWith("wayland-")) &&
      this.pending.size
    )
      this.fail(this.serviceError("CANCELLED", "stop", "Cancelled"));
    this.recordingGeneration++;
    this.recording = undefined;
    this.recordingId = undefined;
    const operation = this.recordingOperation
      .catch(() => {})
      .then(async () => {
        await this.finishCleanup(true);
        if (this.child) await this.rpc("stopRecording");
      });
    this.recordingOperation = operation;
    return operation;
  }
  async releaseAll(): Promise<void> {
    if (
      (this.platformSession === "wayland" ||
        this.helper?.backend.startsWith("wayland-")) &&
      this.pending.size
    )
      this.fail(this.serviceError("CANCELLED", "stop", "Cancelled"));
    await this.finishCleanup(true);
    if (this.platformSession === "wayland") this.frames.clear();
    if (this.child) {
      if (this.inputAttempted || this.heldKeys.size) {
        if (this.platformSession !== "wayland")
          await this.rpc("releaseKeys", { keys: [...this.heldKeys] });
        await this.rpc("releaseAll");
        this.heldKeys.clear();
        this.inputAttempted = false;
      } else await this.rpc("releaseCapture");
    }
  }
  /** Releases owned input before replacing the helper; never replays a request. */
  async restart(): Promise<NativeHandshake> {
    await this.stopRecording();
    await this.releaseAll();
    const child = this.child;
    this.fail(
      this.serviceError("HELPER_EXITED", "restart", "Native helper restarted"),
      false,
    );
    if (child) await this.waitForExit(child);
    await this.rpc("ping");
    return this.helper!;
  }
  async dispose(): Promise<void> {
    if (this.disposed) return;
    try {
      await this.stopRecording();
      await this.releaseAll();
    } finally {
      this.disposed = true;
      this.fail(new Error("Native adapter closed"), false);
      await this.cleanupTask;
    }
  }
}
