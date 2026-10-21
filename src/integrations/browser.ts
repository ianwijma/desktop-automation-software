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
import type { BrowserContext, Page } from "playwright";
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
export function installRecorder() {
  const global = window as Window & {
    __relayRecorder?: boolean;
    relayRecordEvent?: (event: unknown) => void;
  };
  if (global.__relayRecorder) return;
  global.__relayRecorder = true;
  const selector = (element: Element) => {
    if (element.id) return `#${CSS.escape(element.id)}`;
    if (element.getAttribute("data-testid"))
      return `[data-testid="${CSS.escape(element.getAttribute("data-testid")!)}"]`;
    const parts: string[] = [];
    let current: Element | null = element;
    while (current && current !== document.documentElement) {
      let part = current.tagName.toLowerCase();
      const parent: Element | null = current.parentElement;
      if (parent) {
        const siblings = [...parent.children].filter(
          (child) => child.tagName === current!.tagName,
        );
        if (siblings.length > 1)
          part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      }
      parts.unshift(part);
      if (parts.length >= 7) break;
      current = parent;
    }
    return parts.join(" > ");
  };
  const send = (kind: string, label: string, config: unknown) => {
    void global.relayRecordEvent?.({ kind, label, config, at: Date.now() });
  };
  document.addEventListener(
    "click",
    (event) => {
      if (!(event.target instanceof Element) || !event.isTrusted) return;
      const element =
        event.target.closest(
          'button,a,input,select,textarea,[role="button"]',
        ) ?? event.target;
      send(
        "click",
        `Click ${(element.textContent ?? element.tagName).trim().slice(0, 40)}`,
        {
          selector: selector(element),
          x: event.clientX,
          y: event.clientY,
          button: "left",
        },
      );
    },
    true,
  );
  document.addEventListener(
    "change",
    (event) => {
      if (event.target instanceof HTMLSelectElement)
        send("select", "Select option", {
          selector: selector(event.target),
          value: event.target.value,
        });
      else if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement
      ) {
        const secret =
          event.target instanceof HTMLInputElement &&
          event.target.type === "password";
        send(
          "type",
          secret ? "Enter password (configure value)" : "Type text",
          {
            selector: selector(event.target),
            text: secret ? "" : event.target.value,
            ...(secret ? { secret: true } : {}),
          },
        );
      }
    },
    true,
  );
  document.addEventListener(
    "keydown",
    (event) => {
      if (["Enter", "Tab", "Escape"].includes(event.key))
        send("key", `Press ${event.key}`, { key: event.key });
    },
    true,
  );
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
    target: TargetDescriptor;
    callback: (action: RecordedAction) => void;
  };
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
      };
      try {
        result = JSON.parse(Buffer.concat(chunks).toString());
      } catch {
        this.reply(response, 400, { error: "Invalid JSON" });
        return;
      }
      if (result.action) {
        this.recording?.callback({
          ...result.action,
          config: {
            ...result.action.config,
            targetId: this.recording.target.id,
          },
          id: randomUUID(),
          at: Date.now(),
        });
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
        (source, event: Omit<RecordedAction, "id">) => {
          if (
            this.recording &&
            this.pages.get(this.recording.target.id) === source.page
          )
            this.recording.callback({
              ...event,
              config: { ...event.config, targetId: this.recording.target.id },
              id: randomUUID(),
            });
        },
      );
      await context.addInitScript(installRecorder);
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
    await page.evaluate(installRecorder);
    if (target.url && page.url() === "about:blank") await page.goto(target.url);
    return page;
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
  async execute(
    kind: NodeKind,
    config: Record<string, Json>,
    target: TargetDescriptor,
    signal?: AbortSignal,
    ownerId = "interactive",
  ): Promise<Json> {
    if (signal?.aborted) throw new Error("Cancelled");
    if (kind === "screenshot")
      return (await this.capture(target, signal)) as unknown as Json;
    if (
      ["click", "move", "drag", "scroll"].includes(kind) &&
      !config.selector
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
    const page = await this.page(target);
    const abort = () => {
      void page.close().catch(() => {});
      this.pages.delete(target.id);
    };
    signal?.addEventListener("abort", abort, { once: true });
    const selector =
      typeof config.selector === "string" && config.selector
        ? page.locator(config.selector)
        : undefined;
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
      switch (kind) {
        case "launch":
        case "navigate":
          if (config.url || target.url)
            await page.goto(String(config.url ?? target.url), {
              timeout,
              waitUntil: "domcontentloaded",
            });
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
        case "click":
          if (selector)
            await selector.click({
              button,
              clickCount: Number(config.clickCount ?? 1),
              timeout,
            });
          else
            await page.mouse.click(x, y, {
              button,
              clickCount: Number(config.clickCount ?? 1),
            });
          return true;
        case "move":
          if (selector) await selector.hover({ timeout });
          else await page.mouse.move(x, y);
          return true;
        case "drag":
          await page.mouse.move(x, y);
          await page.mouse.down({ button });
          try {
            await page.mouse.move(Number(config.toX), Number(config.toY), {
              steps: 20,
            });
          } finally {
            await page.mouse.up({ button });
          }
          return true;
        case "scroll":
          if (config.x !== undefined) await page.mouse.move(x, y);
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
          if (selector) await selector.focus({ timeout });
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
          return selector
            ? await selector.innerText({ timeout })
            : await page.locator("body").innerText({ timeout });
        case "detect": {
          if (!selector)
            throw new Error("Element detection requires a selector");
          const count = await selector.count();
          if (count > 1)
            return {
              outcome: "uncertain",
              evidence: `${count} elements match; use a more specific selector`,
            };
          const present = count === 1 && (await selector.isVisible());
          const value = present ? await selector.innerText({ timeout }) : "";
          const expected = config.text ?? config.prompt;
          const match =
            present &&
            (typeof expected !== "string" || value.includes(expected));
          return {
            outcome: match ? "match" : "no-match",
            confidence: 1,
            value,
            evidence: present
              ? "Element is visible"
              : "No visible element matches",
          };
        }
        case "select":
          if (!selector) throw new Error("Select requires a selector");
          return await selector.selectOption(String(config.value ?? ""), {
            timeout,
          });
        case "tab": {
          if (config.action === "new") {
            const next = await page.context().newPage();
            this.pages.set(target.id, next);
            if (config.url) await next.goto(String(config.url));
            return { url: next.url() };
          }
          if (config.action === "close") {
            await page.close();
            this.pages.delete(target.id);
            return true;
          }
          const matches = page
            .context()
            .pages()
            .filter((candidate) =>
              config.url ? candidate.url().includes(String(config.url)) : true,
            );
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
    }
  }
  async startRecording(
    target: TargetDescriptor,
    callback: (action: RecordedAction) => void,
  ): Promise<void> {
    this.recording = { target, callback };
    try {
      if (target.browserMode === "extension")
        await this.extension("recordStart", target);
      else await (await this.page(target)).evaluate(installRecorder);
    } catch (error) {
      this.recording = undefined;
      throw error;
    }
  }
  async stopRecording(): Promise<void> {
    const recording = this.recording;
    this.recording = undefined;
    if (recording?.target.browserMode === "extension")
      await this.extension("recordStop", recording.target);
  }
  async releaseAll(ownerId?: string): Promise<void> {
    const owners = ownerId === undefined ? [...this.held.keys()] : [ownerId];
    for (const owner of owners) {
      const held = this.held.get(owner);
      this.held.delete(owner);
      for (const entry of held?.values() ?? []) {
        if (!entry.keys.size) continue;
        if (entry.target.browserMode === "extension")
          await this.extension("releaseInputs", entry.target, undefined, {
            keys: [...entry.keys],
          });
        else {
          const page = this.pages.get(entry.target.id);
          if (!page || page.isClosed()) continue;
          for (const key of entry.keys)
            for (const part of keyParts(key).reverse())
              await page.keyboard.up(part);
          for (const button of ["left", "right", "middle"] as const)
            await page.mouse.up({ button });
        }
      }
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
