import {
  randomBytes,
  randomUUID,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { BrowserContext, Page, Frame, ElementHandle } from "playwright";
import { browserRuntime } from "../../extension/browser-runtime.js";
import { browserLocatorSchema } from "../shared/browser-locators";
import type { BrowserLocator, BrowserLocatorInspection } from "../shared/types";
import type {
  CaptureFrame,
  Json,
  NodeKind,
  RecordedAction,
  TargetDescriptor,
} from "../shared/types";

export interface BrowserAdapterOptions {
  profilesDir: string;
  extensionPort?: number;
  headless?: boolean;
  executablePath?: string;
}
interface BridgeCommand {
  id: string;
  method: string;
  target?: TargetDescriptor;
  kind?: NodeKind;
  config?: Record<string, Json>;
}
interface WaitingCommand {
  resolve: (value: Json) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}
function keyParts(value: unknown): string[] {
  const aliases: Record<string, string> = {
    ctrl: "Control",
    control: "Control",
    command: "Meta",
    meta: "Meta",
    super: "Meta",
    alt: "Alt",
    shift: "Shift",
    return: "Enter",
    enter: "Enter",
    escape: "Escape",
    esc: "Escape",
    left: "ArrowLeft",
    right: "ArrowRight",
    up: "ArrowUp",
    down: "ArrowDown",
    space: "Space",
  };
  return String(value ?? "")
    .split("+")
    .map((key) => aliases[key.toLowerCase()] ?? key);
}
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Cancelled"));
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    const abort = () => {
      done();
      reject(new Error("Cancelled"));
    };
    const timer = setTimeout(() => {
      done();
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
export class BrowserAdapter {
  private contexts = new Map<string, BrowserContext>();
  private pages = new Map<string, Page>();
  private frames = new Map<string, CaptureFrame>();
  private held = new Map<
    string,
    Map<string, { target: TargetDescriptor; keys: Set<string> }>
  >();
  private recording?: {
    id: string;
    target: TargetDescriptor;
    callback: (action: RecordedAction) => void;
    page?: Page;
    pages: Set<Page>;
    seen: Set<string>;
    stopTail: Map<string, RecordedAction>;
    delivery: Promise<unknown>;
  };
  private installedRecording?: BrowserAdapter["recording"];
  private recordingGeneration = 0;
  private recordingOperation: Promise<unknown> = Promise.resolve();
  private recordingInstalls = new Set<Promise<unknown>>();
  private server?: Server;
  private token = randomBytes(32).toString("hex");
  private port = 0;
  private lastPoll = 0;
  private queue: BridgeCommand[] = [];
  private pending = new Map<string, WaitingCommand>();
  private cancelled = new Map<string, number>();
  private poll?: { response: ServerResponse; timer: NodeJS.Timeout };
  constructor(private options: BrowserAdapterOptions) {}
  getBridgeInfo(): { port: number; token: string; connected: boolean } {
    return {
      port: this.port,
      token: this.token,
      connected: Date.now() - this.lastPoll < 35000,
    };
  }
  async startBridge(): Promise<{ port: number; token: string }> {
    if (this.server) return { port: this.port, token: this.token };
    const server = createServer((req, res) => {
      void this.handle(req, res).catch((error) => {
        if (!res.headersSent)
          this.reply(res, 500, { error: (error as Error).message });
        else res.end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.options.extensionPort ?? 0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    this.server = server;
    const address = server.address();
    this.port = typeof address === "object" && address ? address.port : 0;
    return { port: this.port, token: this.token };
  }
  private reply(response: ServerResponse, status: number, value: unknown) {
    response.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    response.end(JSON.stringify(value));
  }
  private async handle(request: IncomingMessage, response: ServerResponse) {
    const origin = request.headers.origin;
    if (origin && !/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) {
      this.reply(response, 403, { error: "Origin is not an extension" });
      return;
    }
    if (origin) response.setHeader("Access-Control-Allow-Origin", origin);
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Allow-Methods": "GET, POST",
        "Access-Control-Allow-Private-Network": "true",
      });
      response.end();
      return;
    }
    const supplied = Buffer.from(
      (request.headers.authorization ?? "").replace(/^Bearer /, ""),
    );
    const expected = Buffer.from(this.token);
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    ) {
      this.reply(response, 401, { error: "Invalid pairing token" });
      return;
    }
    if (request.method === "GET" && request.url?.startsWith("/cancelled?")) {
      const id =
        new URL(request.url, "http://127.0.0.1").searchParams.get("id") ?? "";
      for (const [key, at] of this.cancelled)
        if (Date.now() - at > 180000) this.cancelled.delete(key);
      this.reply(response, 200, { cancelled: this.cancelled.has(id) });
      return;
    }
    if (request.method === "GET" && request.url === "/next") {
      this.lastPoll = Date.now();
      if (this.poll) {
        clearTimeout(this.poll.timer);
        this.reply(this.poll.response, 200, { command: null });
        this.poll = undefined;
      }
      const command = this.queue.shift();
      if (command) {
        this.reply(response, 200, { command });
        return;
      }
      const timer = setTimeout(() => {
        if (this.poll?.response === response) {
          this.poll = undefined;
          this.reply(response, 200, { command: null });
        }
      }, 20000);
      this.poll = { response, timer };
      request.on("close", () => {
        if (this.poll?.response === response && response.destroyed) {
          clearTimeout(timer);
          this.poll = undefined;
        }
      });
      return;
    }
    if (request.method === "POST" && request.url === "/result") {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        const buffer = Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > 24 * 1024 * 1024) {
          this.reply(response, 413, { error: "Response too large" });
          return;
        }
        chunks.push(buffer);
      }
      let result: {
        id?: string;
        result?: Json;
        error?: string;
        action?: RecordedAction;
        recordingId?: string;
      };
      try {
        result = JSON.parse(Buffer.concat(chunks).toString());
      } catch {
        this.reply(response, 400, { error: "Invalid JSON" });
        return;
      }
      if (result.action) {
        const recording = this.recording;
        let accepted = false;
        if (
          recording?.target.browserMode === "extension" &&
          result.recordingId === recording.id
        ) {
          accepted = recording.seen.has(result.action.id);
          if (!accepted) {
            accepted =
              (recording.callback({
                ...result.action,
                config: {
                  ...result.action.config,
                  targetId: recording.target.id,
                },
                id: randomUUID(),
              }) as unknown) !== false;
            if (accepted) recording.seen.add(result.action.id);
          }
        }
        this.reply(response, 200, { ok: true, accepted });
        return;
      } else if (result.id) {
        this.cancelled.delete(result.id);
        const pending = this.pending.get(result.id);
        if (pending) {
          pending.cleanup();
          this.pending.delete(result.id);
          if (result.error) pending.reject(new Error(result.error));
          else pending.resolve(result.result ?? null);
        }
      }
      this.reply(response, 200, { ok: true });
      return;
    }
    this.reply(response, 404, { error: "Not found" });
  }
  private async extension(
    method: string,
    target?: TargetDescriptor,
    kind?: NodeKind,
    config?: Record<string, Json>,
    signal?: AbortSignal,
  ): Promise<Json> {
    if (signal?.aborted) throw new Error("Cancelled");
    await this.startBridge();
    if (!this.getBridgeInfo().connected)
      throw new Error(
        "Browser extension is not paired. Open Settings and pair the Relay extension.",
      );
    const id = randomUUID();
    const command: BridgeCommand = { id, method, target, kind, config };
    return new Promise<Json>((resolve, reject) => {
      const abort = () => {
        this.cancelled.set(id, Date.now());
        this.pending.delete(id);
        this.queue = this.queue.filter((command) => command.id !== id);
        cleanup();
        reject(
          new Error(
            signal?.aborted
              ? "Cancelled"
              : "Browser extension command timed out",
          ),
        );
      };
      const timer = setTimeout(
        abort,
        Math.max(
          30000,
          Math.min(120000, Number(config?.durationMs ?? 0)) + 5000,
        ),
      );
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      };
      this.pending.set(id, { resolve, reject, cleanup });
      signal?.addEventListener("abort", abort, { once: true });
      if (this.poll) {
        const poll = this.poll;
        this.poll = undefined;
        clearTimeout(poll.timer);
        this.reply(poll.response, 200, { command });
      } else this.queue.push(command);
    });
  }
  private async page(target: TargetDescriptor): Promise<Page> {
    const existing = this.pages.get(target.id);
    if (existing && !existing.isClosed()) return existing;
    const profile = target.profile || target.id;
    const profileKey = createHash("sha256")
      .update(profile)
      .digest("hex")
      .slice(0, 24);
    let context = this.contexts.get(profileKey);
    if (!context) {
      const directory = path.join(this.options.profilesDir, profileKey);
      await mkdir(directory, { recursive: true });
      const { chromium } = await import("playwright");
      context = await chromium.launchPersistentContext(directory, {
        headless: this.options.headless ?? false,
        executablePath: this.options.executablePath,
        viewport: { width: 1280, height: 800 },
      });
      await context.exposeBinding(
        "relayRecordEvent",
        (source, event: RecordedAction & { recordingId?: string }) => {
          const recording = this.recording;
          if (!recording) return false;
          return this.queueRecordingEvent(recording, async () => {
            if (
              this.recording !== recording ||
              event.recordingId !== recording.id ||
              !recording.pages.has(source.page)
            )
              return false;
            if (event.kind === "tab") {
              if (recording.page === source.page || recording.page?.isClosed())
                return true;
              if (recording.page)
                await this.drainManagedRecorder(recording.page, recording);
              if (this.recording !== recording) return false;
              recording.page = source.page;
              this.pages.set(recording.target.id, source.page);
              event.config = {
                action: "switch",
                url: source.page.url(),
                exact: true,
                waitForExisting: true,
              };
            }
            if (recording.page !== source.page) return true;
            if (recording.seen.has(event.id)) return true;
            const accepted =
              (recording.callback({
                kind: event.kind,
                label: event.label,
                at: event.at,
                config: { ...event.config, targetId: recording.target.id },
                id: randomUUID(),
              }) as unknown) !== false;
            if (accepted) recording.seen.add(event.id);
            return accepted;
          });
        },
      );
      context.on("page", (child) => {
        const recording = this.recording;
        if (!recording || recording.target.browserMode === "extension") return;
        void (async () => {
          const opener = await child.opener();
          if (
            !opener ||
            !recording.pages.has(opener) ||
            this.recording !== recording
          )
            return;
          recording.pages.add(child);
          this.watchRecordingPage(child);
          await this.drainManagedRecorder(opener, recording);
          await child.waitForLoadState("domcontentloaded");
          if (this.recording !== recording || child.isClosed()) return;
          recording.page = child;
          this.pages.set(recording.target.id, child);
          recording.callback(
            this.observedBrowserAction(recording, "tab", "Switch browser tab", {
              action: "switch",
              url: child.url(),
              exact: true,
              waitForExisting: true,
            }),
          );
          await this.installManagedRecorder(child, recording);
        })().catch(() => {});
      });
      this.contexts.set(profileKey, context);
      context.on("close", () => {
        this.contexts.delete(profileKey);
      });
    }
    const page =
      context
        .pages()
        .find((page) => ![...this.pages.values()].includes(page)) ??
      (await context.newPage());
    this.pages.set(target.id, page);
    this.watchRecordingPage(page);
    if (target.url && page.url() === "about:blank") await page.goto(target.url);
    return page;
  }
  private queueRecordingEvent<T>(
    recording: NonNullable<BrowserAdapter["recording"]>,
    operation: () => Promise<T>,
  ): Promise<T> {
    const work = recording.delivery.then(operation);
    recording.delivery = work.catch(() => {});
    this.recordingInstalls.add(work);
    void work
      .catch(() => {})
      .finally(() => this.recordingInstalls.delete(work));
    return work;
  }
  private observedBrowserAction(
    recording: NonNullable<BrowserAdapter["recording"]>,
    kind: NodeKind,
    label: string,
    config: Record<string, Json>,
  ): RecordedAction {
    return {
      id: randomUUID(),
      at: Date.now(),
      kind,
      label,
      config: { ...config, targetId: recording.target.id },
    };
  }
  private async drainManagedRecorder(
    page: Page,
    recording: NonNullable<BrowserAdapter["recording"]>,
  ) {
    const operation = (async () => {
      for (const frame of page.frames()) {
        const tail = await frame
          .evaluate(browserRuntime, { operation: "recordFlush" })
          .catch(() => []);
        for (const action of tail as RecordedAction[]) {
          if (recording.seen.has(action.id)) continue;
          if (
            this.recording !== recording ||
            (recording.callback({
              ...action,
              config: { ...action.config, targetId: recording.target.id },
            }) as unknown) === false
          )
            recording.stopTail.set(action.id, action);
          else recording.seen.add(action.id);
        }
      }
    })();
    this.recordingInstalls.add(operation);
    try {
      await operation;
    } finally {
      this.recordingInstalls.delete(operation);
    }
  }
  private watchRecordingPage(page: Page) {
    page.on("domcontentloaded", () => {
      const recording = this.recording;
      if (recording?.page === page)
        void this.installManagedRecorder(page, recording).catch(() => {});
    });
    page.on("framenavigated", (frame) => {
      const recording = this.recording;
      if (recording?.page !== page) return;
      if (frame !== page.mainFrame())
        void this.installManagedRecorder(page, recording, frame).catch(
          () => {},
        );
      else if (/^https?:|^file:/.test(frame.url())) {
        const action = this.observedBrowserAction(
          recording,
          "navigate",
          "Navigate browser",
          { url: frame.url(), action: "ensure" },
        );
        const operation = (async () => {
          await this.drainManagedRecorder(page, recording);
          if (this.recording === recording) recording.callback(action);
        })();
        this.recordingInstalls.add(operation);
        void operation
          .catch(() => {})
          .finally(() => this.recordingInstalls.delete(operation));
      }
    });
    page.on("close", () => {
      const recording = this.recording;
      if (!recording?.pages.has(page)) return;
      void this.queueRecordingEvent(recording, async () => {
        recording.pages.delete(page);
        if (this.recording !== recording || recording.page !== page) return;
        const next = [...recording.pages].find(
          (candidate) => !candidate.isClosed(),
        );
        recording.callback(
          this.observedBrowserAction(recording, "tab", "Close browser tab", {
            action: "close",
            closedUrl: page.url(),
            ...(next ? { returnUrl: next.url() } : {}),
          }),
        );
        recording.page = next;
        if (next) this.pages.set(recording.target.id, next);
      }).catch(() => {});
    });
  }
  async capture(
    target: TargetDescriptor,
    signal?: AbortSignal,
  ): Promise<CaptureFrame> {
    if (signal?.aborted) throw new Error("Cancelled");
    let frame: CaptureFrame;
    if (target.browserMode === "extension")
      frame = (await this.extension(
        "capture",
        target,
        undefined,
        undefined,
        signal,
      )) as unknown as CaptureFrame;
    else {
      const page = await this.page(target);
      const data = await page.screenshot({ type: "png", scale: "css" });
      frame = {
        id: randomUUID(),
        targetId: target.id,
        capturedAt: Date.now(),
        width: data.readUInt32BE(16),
        height: data.readUInt32BE(20),
        scale: 1,
        dataUrl: `data:image/png;base64,${data.toString("base64")}`,
      };
    }
    if (signal?.aborted) throw new Error("Cancelled");
    if (
      !frame ||
      frame.targetId !== target.id ||
      !Number.isFinite(frame.width) ||
      !Number.isFinite(frame.height) ||
      frame.width <= 0 ||
      frame.height <= 0 ||
      !Number.isFinite(frame.scale ?? 1) ||
      (frame.scale ?? 1) <= 0
    )
      throw new Error("Browser returned invalid capture geometry");
    this.frames.set(target.id, frame);
    return frame;
  }
  private async domScope(page: Page, query: Record<string, unknown>) {
    let frame: Frame = page.mainFrame();
    const owners: { frame: Frame; element: ElementHandle<Element> }[] = [];
    const locator = query.locator as BrowserLocator | undefined;
    let shadow: NonNullable<BrowserLocator["path"]> = [],
      prefix: NonNullable<BrowserLocator["path"]> = [];
    try {
      for (const [index, step] of (locator?.path ?? []).entries()) {
        if (step.kind === "shadow") {
          shadow.push(step);
          continue;
        }
        const handle = await frame.evaluateHandle(browserRuntime, {
          operation: "resolve",
          locator: { version: 1, selector: step.selector, path: shadow },
        });
        const element = handle.asElement() as ElementHandle<Element> | null;
        if (!element) {
          await handle.dispose();
          throw new Error("Frame locator did not identify an element");
        }
        owners.push({ frame, element });
        const child = await element.contentFrame();
        if (!child) throw new Error("The frame document is unavailable");
        frame = child;
        shadow = [];
        prefix = locator!.path!.slice(0, index + 1);
      }
      return {
        frame,
        owners,
        prefix,
        query: locator
          ? ({ locator: { ...locator, path: shadow } } as Record<
              string,
              unknown
            >)
          : query,
      };
    } catch (error) {
      await Promise.all(owners.map((owner) => owner.element.dispose()));
      throw error;
    }
  }
  private async domPoint(
    scope: Awaited<ReturnType<BrowserAdapter["domScope"]>>,
    offset?: Json,
  ) {
    const point = await scope.frame.evaluate(browserRuntime, {
      operation: "point",
      ...scope.query,
      offset: offset as unknown,
    });
    for (const owner of [...scope.owners].reverse()) {
      const geometry = await owner.frame.evaluate(browserRuntime, {
        operation: "frameGeometry",
        element: owner.element,
      });
      point.x = geometry.x + point.x * geometry.scaleX;
      point.y = geometry.y + point.y * geometry.scaleY;
      await owner.frame.evaluate(browserRuntime, {
        operation: "verifyPoint",
        element: owner.element,
        x: point.x,
        y: point.y,
      });
    }
    return point as { x: number; y: number };
  }
  async execute(
    kind: NodeKind,
    config: Record<string, Json>,
    target: TargetDescriptor,
    signal?: AbortSignal,
    ownerId = "interactive",
  ): Promise<Json> {
    if (signal?.aborted) throw new Error("Cancelled");
    if (config.requiresConfiguration)
      throw new Error(
        String(
          config.recordingWarning ??
            "Configure this recorded step before running",
        ),
      );
    if (config.toLocator) browserLocatorSchema.parse(config.toLocator);
    if (config.locator) {
      browserLocatorSchema.parse(config.locator);
      if (config.selector)
        throw new Error("Choose one browser locator or legacy selector.");
    }
    if (kind === "screenshot")
      return (await this.capture(target, signal)) as unknown as Json;
    if (
      ["click", "move", "drag", "scroll"].includes(kind) &&
      !config.selector &&
      !config.locator
    ) {
      let frame = this.frames.get(target.id);
      if (config.frameId && config.frameId !== frame?.id)
        throw new Error(
          "Capture is stale; capture and detect the target again",
        );
      if (
        typeof config.expectedWidth === "number" &&
        typeof config.expectedHeight === "number"
      ) {
        frame = await this.capture(target, signal);
        if (
          frame.width !== config.expectedWidth ||
          frame.height !== config.expectedHeight
        )
          throw new Error(
            "Target dimensions changed since recording; recapture and update this action",
          );
      }
      if (target.browserMode === "extension") {
        frame ??= await this.capture(target, signal);
        config = { ...config };
        for (const key of ["x", "y", "toX", "toY"])
          if (typeof config[key] === "number") config[key] /= frame.scale ?? 1;
      }
    }
    if (kind === "key" && config.action !== "up") {
      let owned = this.held.get(ownerId);
      if (!owned) {
        owned = new Map();
        this.held.set(ownerId, owned);
      }
      let entry = owned.get(target.id);
      if (!entry) {
        entry = { target: structuredClone(target), keys: new Set() };
        owned.set(target.id, entry);
      }
      entry.keys.add(String(config.key));
    }
    if (target.browserMode === "extension") {
      const result = await this.extension(
        "execute",
        target,
        kind,
        config,
        signal,
      );
      if (kind === "key" && config.action !== "down")
        this.held.get(ownerId)?.get(target.id)?.keys.delete(String(config.key));
      return result;
    }
    if (kind === "tab" && config.action === "close" && config.closedUrl) {
      const pages = [...this.contexts.values()].flatMap((context) =>
        context.pages(),
      );
      const closing = pages.filter(
        (candidate) => candidate.url() === config.closedUrl,
      );
      if (closing.length > 1) throw new Error("The closing tab is ambiguous");
      if (!closing.length) {
        const returns = config.returnUrl
          ? pages.filter((candidate) => candidate.url() === config.returnUrl)
          : [];
        if (config.returnUrl && returns.length !== 1)
          throw new Error("The return tab is missing or ambiguous");
        if (returns[0]) this.pages.set(target.id, returns[0]);
        return true;
      }
      this.pages.set(target.id, closing[0]);
    }
    const page = await this.page(target);
    const abort = () => {
      void page.close().catch(() => {});
      this.pages.delete(target.id);
    };
    signal?.addEventListener("abort", abort, { once: true });
    let selector: ElementHandle<Element> | null = null;
    let scope: Awaited<ReturnType<BrowserAdapter["domScope"]>> | undefined;
    let query: Record<string, unknown> = {
      ...(config.locator
        ? { locator: config.locator }
        : { selector: config.selector }),
    };
    const timeout = Math.max(
      100,
      Math.min(120000, Number(config.timeoutMs ?? 15000)),
    );
    const x = Number(config.x ?? 0),
      y = Number(config.y ?? 0);
    const button = ["left", "right", "middle"].includes(String(config.button))
      ? (config.button as "left" | "right" | "middle")
      : "left";
    try {
      scope = await this.domScope(page, query);
      query = scope.query;
      const frame = scope.frame;
      if (
        (config.locator || config.selector) &&
        ["click", "move", "drag", "scroll", "type", "key", "select"].includes(
          kind,
        )
      ) {
        selector = (
          await frame.evaluateHandle(browserRuntime, {
            operation: "resolve",
            ...query,
          })
        ).asElement() as ElementHandle<Element> | null;
        if (!selector)
          throw new Error("Browser locator did not resolve to an element");
      }
      switch (kind) {
        case "launch":
        case "navigate":
          if (config.url || target.url) {
            const url = String(config.url ?? target.url);
            if (config.action === "ensure" && page.url() !== url)
              await page
                .waitForURL(url, {
                  timeout: Math.min(timeout, 1000),
                  waitUntil: "domcontentloaded",
                })
                .catch(() => {});
            if (config.action !== "ensure" || page.url() !== url)
              await page.goto(url, { timeout, waitUntil: "domcontentloaded" });
            else await page.waitForLoadState("domcontentloaded", { timeout });
          }
          return { url: page.url() };
        case "attach":
          return { url: page.url(), title: await page.title() };
        case "focus":
          await page.bringToFront();
          return true;
        case "close":
          await page.close();
          this.pages.delete(target.id);
          return true;
        case "click": {
          const modifiers = Array.isArray(config.modifiers)
            ? config.modifiers.map(String)
            : [];
          try {
            for (const modifier of modifiers)
              await page.keyboard.down(modifier);
            if (typeof config.checked === "boolean") {
              if (!selector)
                throw new Error("Checked state requires a browser locator");
              await frame.evaluate(browserRuntime, {
                operation: "checked",
                ...query,
                checked: config.checked,
              });
              await selector.setChecked(config.checked, { timeout });
            } else if (selector)
              await selector
                .click({
                  button,
                  clickCount: Number(config.clickCount ?? 1),
                  timeout,
                })
                .catch((error: Error) => {
                  // A dispatched click may close its own popup before the
                  // browser acknowledges it. Never retry that input.
                  if (
                    !page.isClosed() ||
                    !error.message.includes("has been closed") ||
                    !error.message.includes("performing click action")
                  )
                    throw error;
                });
            else
              await page.mouse.click(x, y, {
                button,
                clickCount: Number(config.clickCount ?? 1),
              });
          } finally {
            for (const modifier of [...modifiers].reverse())
              await page.keyboard.up(modifier).catch(() => {});
          }
          return true;
        }
        case "move":
          if (selector) await selector.hover({ timeout });
          else await page.mouse.move(x, y);
          return true;
        case "drag": {
          const start = selector
            ? await this.domPoint(scope, config.fromOffset)
            : { x, y };
          let end = { x: Number(config.toX), y: Number(config.toY) };
          if (config.toLocator) {
            const destination = await this.domScope(page, {
              locator: config.toLocator,
            });
            try {
              end = await this.domPoint(destination, config.toOffset);
            } finally {
              await Promise.all(
                destination.owners.map((owner) =>
                  owner.element.dispose().catch(() => {}),
                ),
              );
            }
            const current = await this.domPoint(scope, config.fromOffset);
            if (
              Math.abs(current.x - start.x) > 1 ||
              Math.abs(current.y - start.y) > 1
            )
              throw new Error(
                "Both drag endpoints must remain visible in the viewport",
              );
          }
          await page.mouse.move(start.x, start.y);
          await page.mouse.down({ button });
          try {
            const duration = Math.min(120000, Number(config.durationMs ?? 200));
            for (let step = 1; step <= 20; step++) {
              await page.mouse.move(
                start.x + ((end.x - start.x) * step) / 20,
                start.y + ((end.y - start.y) * step) / 20,
              );
              if (duration) await sleep(duration / 20, signal);
            }
          } finally {
            await page.mouse.up({ button });
          }
          return true;
        }
        case "scroll":
          if (
            config.scrollTop !== undefined ||
            config.scrollLeft !== undefined
          ) {
            if (!selector)
              throw new Error("Absolute scrolling requires a browser locator");
            return await frame.evaluate(browserRuntime, {
              operation: "scroll",
              ...query,
              scrollTop: config.scrollTop as unknown,
              scrollLeft: config.scrollLeft as unknown,
            });
          }
          if (selector) {
            const start = await this.domPoint(scope);
            await page.mouse.move(start.x, start.y);
          } else if (config.x !== undefined) await page.mouse.move(x, y);
          await page.mouse.wheel(
            Number(config.deltaX ?? 0),
            Number(config.deltaY ?? 0),
          );
          return true;
        case "type":
          if (selector)
            await selector.fill(String(config.text ?? ""), { timeout });
          else await page.keyboard.insertText(String(config.text ?? ""));
          return true;
        case "key": {
          if (selector)
            await frame.evaluate(browserRuntime, {
              operation: "focus",
              ...query,
            });
          const keys = keyParts(config.key);
          if (config.action === "down")
            for (const key of keys) await page.keyboard.down(key);
          else if (config.action === "up")
            for (const key of keys.reverse()) await page.keyboard.up(key);
          else if (Number(config.durationMs) > 0) {
            try {
              for (const key of keys) await page.keyboard.down(key);
              await sleep(Math.min(120000, Number(config.durationMs)), signal);
            } finally {
              if (!page.isClosed())
                for (const key of [...keys].reverse())
                  await page.keyboard.up(key).catch(() => {});
            }
          } else await page.keyboard.press(keys.join("+"));
          if (config.action !== "down")
            this.held
              .get(ownerId)
              ?.get(target.id)
              ?.keys.delete(String(config.key));
          return true;
        }
        case "read":
          return await frame.evaluate(browserRuntime, {
            operation: "read",
            ...query,
          });
        case "detect":
          if (!config.locator && !config.selector)
            throw new Error("Element detection requires a browser locator");
          return await frame.evaluate(browserRuntime, {
            operation: "detect",
            ...query,
            text: (config.text ?? config.prompt) as unknown,
          });
        case "select":
          if (!selector) throw new Error("Select requires a selector");
          return await selector.selectOption(
            Array.isArray(config.value)
              ? config.value.map(String)
              : String(config.value ?? ""),
            {
              timeout,
            },
          );
        case "tab": {
          if (config.action === "new") {
            const next = await page.context().newPage();
            this.pages.set(target.id, next);
            if (config.url) await next.goto(String(config.url));
            return { url: next.url() };
          }
          if (config.action === "close") {
            const matches = config.returnUrl
              ? page
                  .context()
                  .pages()
                  .filter(
                    (candidate) =>
                      candidate !== page &&
                      candidate.url() === config.returnUrl,
                  )
              : [];
            if (config.returnUrl && matches.length !== 1)
              throw new Error("The return tab is missing or ambiguous");
            await page.close();
            if (matches[0]) this.pages.set(target.id, matches[0]);
            else this.pages.delete(target.id);
            return true;
          }
          const matching = () =>
            page
              .context()
              .pages()
              .filter((candidate) =>
                config.url
                  ? config.exact
                    ? candidate.url() === config.url
                    : candidate.url().includes(String(config.url))
                  : true,
              );
          if (config.waitForExisting) {
            const deadline = Date.now() + timeout;
            while (!matching().length && Date.now() < deadline)
              await sleep(25, signal);
          }
          const matches = matching();
          const next =
            config.index !== undefined
              ? matches[Number(config.index)]
              : matches.length === 1
                ? matches[0]
                : undefined;
          if (!next) throw new Error("Tab selection is missing or ambiguous");
          this.pages.set(target.id, next);
          return { url: next.url() };
        }
        default:
          throw new Error(`Unsupported browser action: ${kind}`);
      }
    } finally {
      signal?.removeEventListener("abort", abort);
      await selector?.dispose().catch(() => {});
      await Promise.all(
        scope?.owners.map((owner) => owner.element.dispose().catch(() => {})) ??
          [],
      );
    }
  }
  async inspectLocator(
    target: TargetDescriptor,
    locator: BrowserLocator | string,
  ): Promise<BrowserLocatorInspection> {
    const query =
      typeof locator === "string"
        ? { selector: locator }
        : { locator: browserLocatorSchema.parse(locator) };
    if (target.browserMode === "extension")
      return (await this.extension(
        "inspectLocator",
        target,
        undefined,
        query as unknown as Record<string, Json>,
      )) as unknown as BrowserLocatorInspection;
    const scope = await this.domScope(await this.page(target), query);
    try {
      const result: BrowserLocatorInspection = await scope.frame.evaluate(
        browserRuntime,
        { operation: "inspect", ...scope.query },
      );
      if (result.element && scope.prefix.length)
        result.element.locator.path = [
          ...scope.prefix,
          ...(result.element.locator.path ?? []),
        ];
      if (result.visible)
        for (const owner of scope.owners)
          result.visible = result.visible && (await owner.element.isVisible());
      return result;
    } finally {
      await Promise.all(
        scope.owners.map((owner) => owner.element.dispose().catch(() => {})),
      );
    }
  }
  async startRecording(
    target: TargetDescriptor,
    callback: (action: RecordedAction) => void,
  ): Promise<void> {
    const generation = ++this.recordingGeneration;
    this.recording = undefined;
    const operation = this.recordingOperation
      .catch(() => {})
      .then(async () => {
        await this.uninstallRecorder();
        if (generation !== this.recordingGeneration) return;
        const recording: NonNullable<BrowserAdapter["recording"]> = {
          id: randomUUID(),
          target: structuredClone(target),
          callback,
          pages: new Set(),
          seen: new Set(),
          stopTail: new Map(),
          delivery: Promise.resolve(),
        };
        this.installedRecording = recording;
        try {
          if (target.browserMode !== "extension")
            recording.page = await this.page(target);
          if (recording.page) recording.pages.add(recording.page);
          if (generation !== this.recordingGeneration) {
            await this.uninstallRecorder();
            return;
          }
          this.recording = recording;
          if (target.browserMode === "extension")
            await this.extension("recordStart", target, undefined, {
              recordingId: recording.id,
            });
          else await this.installManagedRecorder(recording.page!, recording);
        } catch (error) {
          this.recording = undefined;
          await this.uninstallRecorder();
          throw error;
        }
      });
    this.recordingOperation = operation;
    return operation;
  }
  async stopRecording(): Promise<RecordedAction[]> {
    this.recordingGeneration++;
    this.recording = undefined;
    const operation = this.recordingOperation
      .catch(() => {})
      .then(() => this.uninstallRecorder());
    this.recordingOperation = operation;
    return operation;
  }
  private async installManagedRecorder(
    page: Page,
    recording: NonNullable<BrowserAdapter["recording"]>,
    selectedFrame?: Frame,
  ): Promise<void> {
    if (this.recording !== recording || page.isClosed()) return;
    const operation = (async () => {
      for (const frame of selectedFrame ? [selectedFrame] : page.frames()) {
        if (frame.isDetached()) continue;
        await frame.waitForLoadState("domcontentloaded", { timeout: 10000 });
        const basePath: NonNullable<BrowserLocator["path"]> = [];
        let current = frame;
        while (current.parentFrame()) {
          const parent = current.parentFrame()!,
            element = await current.frameElement();
          try {
            const owner: BrowserLocator = await parent.evaluate(
              browserRuntime,
              { operation: "describe", element },
            );
            basePath.unshift(...(owner.path ?? []), {
              kind: "frame",
              selector: owner.selector,
            });
          } finally {
            await element.dispose();
          }
          current = parent;
        }
        if (this.recording !== recording || frame.isDetached()) return;
        await frame.evaluate(browserRuntime, {
          operation: "record",
          recordingId: recording.id,
          transport: "managed",
          singleDocument: true,
          basePath,
        });
      }
    })();
    this.recordingInstalls.add(operation);
    try {
      await operation;
    } finally {
      this.recordingInstalls.delete(operation);
    }
  }
  private async uninstallRecorder(): Promise<RecordedAction[]> {
    const recording = this.installedRecording;
    await Promise.allSettled([...this.recordingInstalls]);
    if (!recording) return [];
    let tail: RecordedAction[] = [];
    if (recording.target.browserMode === "extension") {
      const result = await this.extension(
        "recordStop",
        recording.target,
        undefined,
        {
          recordingId: recording.id,
        },
      );
      if (Array.isArray(result)) tail = result as unknown as RecordedAction[];
    } else
      tail = (
        await Promise.all(
          [...recording.pages]
            .filter((page) => !page.isClosed())
            .flatMap((page) => page.frames())
            .map(async (frame) => {
              try {
                const result = (await frame.evaluate(browserRuntime, {
                  operation: "record",
                  recordingId: null,
                })) as RecordedAction[];
                for (const action of result)
                  recording.stopTail.set(action.id, action);
                return result;
              } catch (error) {
                if (!frame.isDetached()) throw error;
                return [];
              }
            }),
        )
      ).flat();
    for (const action of tail) recording.stopTail.set(action.id, action);
    if (this.installedRecording === recording)
      this.installedRecording = undefined;
    return [...recording.stopTail.values()]
      .filter(
        (action) =>
          !recording.seen.has(action.id) && !action.config.recordingActivation,
      )
      .map((action) => ({
        ...action,
        config: { ...action.config, targetId: recording.target.id },
      }));
  }
  async releaseAll(ownerId?: string): Promise<void> {
    const owners = ownerId === undefined ? [...this.held.keys()] : [ownerId];
    for (const owner of owners) {
      const held = this.held.get(owner);
      for (const entry of held?.values() ?? []) {
        if (!entry.keys.size) continue;
        if (entry.target.browserMode === "extension")
          await this.extension("releaseInputs", entry.target, undefined, {
            keys: [...entry.keys],
          });
        else {
          const page = this.pages.get(entry.target.id);
          if (!page || page.isClosed()) {
            entry.keys.clear();
            continue;
          }
          for (const key of entry.keys)
            for (const part of keyParts(key).reverse())
              await page.keyboard.up(part);
          for (const button of ["left", "right", "middle"] as const)
            await page.mouse.up({ button });
        }
        entry.keys.clear();
      }
      this.held.delete(owner);
    }
  }
  async dispose(): Promise<void> {
    await this.stopRecording().catch(() => {});
    await this.releaseAll().catch(() => {});
    for (const command of this.pending.values()) {
      command.cleanup();
      command.reject(new Error("Browser adapter closed"));
    }
    this.pending.clear();
    this.queue = [];
    if (this.poll) {
      clearTimeout(this.poll.timer);
      this.reply(this.poll.response, 200, { command: null });
      this.poll = undefined;
    }
    for (const context of this.contexts.values())
      await context.close().catch(() => {});
    this.contexts.clear();
    this.pages.clear();
    this.frames.clear();
    const server = this.server;
    this.server = undefined;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
}
