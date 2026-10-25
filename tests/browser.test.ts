import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { appendFile, cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BrowserAdapter } from "../src/integrations/browser";
import type { TargetDescriptor, RecordedAction } from "../src/shared/types";
import { chromium, type Page } from "playwright";

declare const chrome: {
  debugger: {
    sendCommand(target: object, method: string, params?: object): Promise<any>;
  };
  tabs: { query(options: object): Promise<{ id?: number; url?: string }[]> };
  scripting: {
    executeScript(options: {
      target: { tabId: number };
      func: () => unknown;
    }): Promise<{ result?: unknown }[]>;
  };
};

describe("managed browser actions", () => {
  let server: Server, browser: BrowserAdapter, directory: string;
  let target: TargetDescriptor;
  beforeAll(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "relay-browser-test-"));
    server = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html");
      response.end(
        '<!doctype html><title>Relay fixture</title><label>Name<input id="name"></label><select id="choice"><option value="a">A</option><option value="b">B</option></select><button id="submit" onclick="document.querySelector(\'#result\').textContent=document.querySelector(\'#name\').value+\':\'+document.querySelector(\'#choice\').value">Submit</button><p id="result">waiting</p>',
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    target = {
      id: "browser-fixture",
      name: "Browser fixture",
      kind: "browser",
      browserMode: "managed",
      url: `http://127.0.0.1:${port}`,
    };
    browser = new BrowserAdapter({
      profilesDir: directory,
      headless: true,
      executablePath: process.env.RELAY_TEST_CHROMIUM,
    });
  });
  afterAll(async () => {
    await browser?.dispose();
    if (server)
      await new Promise<void>((resolve) => server.close(() => resolve()));
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  it("executes DOM nodes and captures the same managed page", async () => {
    await browser.execute("launch", {}, target);
    await browser.execute("type", { selector: "#name", text: "Relay" }, target);
    await browser.execute(
      "select",
      { selector: "#choice", value: "b" },
      target,
    );
    await browser.execute("click", { selector: "#submit" }, target);
    expect(await browser.execute("read", { selector: "#result" }, target)).toBe(
      "Relay:b",
    );
    const frame = await browser.capture(target);
    expect(frame.width).toBe(1280);
    expect(frame.height).toBe(800);
    expect(frame.dataUrl).toMatch(/^data:image\/png;base64,/);
  });
  it("records semantic user actions as editable nodes", async () => {
    const actions: RecordedAction[] = [];
    await browser.startRecording(target, (action) => actions.push(action));
    await browser.execute("click", { selector: "#submit" }, target);
    await browser.stopRecording();
    expect(
      actions.some(
        (action) =>
          action.kind === "click" &&
          JSON.stringify(action.config.locator) ===
            JSON.stringify({
              version: 1,
              selector: { kind: "role", role: "button", name: "Submit" },
            }),
      ),
    ).toBe(true);
  });
  it("uninstalls managed listeners and rejects delayed events from earlier recordings", async () => {
    const before: RecordedAction[] = [],
      after: RecordedAction[] = [];
    await browser.startRecording(target, (action) => before.push(action));
    const page = (browser as unknown as { pages: Map<string, Page> }).pages.get(
      target.id,
    )!;
    const oldToken = await page.evaluate(
      () =>
        (window as unknown as { __relayRecorder: { recordingId: string } })
          .__relayRecorder.recordingId,
    );
    await browser.execute("click", { selector: "#submit" }, target);
    await browser.stopRecording();
    expect(
      await page.evaluate(() => Object.hasOwn(window, "__relayRecorder")),
    ).toBe(false);
    const oldCount = before.length;
    await browser.execute("click", { selector: "#submit" }, target);
    expect(before).toHaveLength(oldCount);
    await browser.startRecording(target, (action) => after.push(action));
    await page.evaluate(async (recordingId) => {
      await (
        window as unknown as {
          relayRecordEvent: (value: unknown) => Promise<void>;
        }
      ).relayRecordEvent({
        recordingId,
        kind: "click",
        label: "Stale event",
        config: { selector: "#submit" },
        at: Date.now(),
      });
    }, oldToken);
    expect(after).toHaveLength(0);
    await browser.execute("navigate", { url: target.url! }, target);
    await page.waitForFunction(() => Object.hasOwn(window, "__relayRecorder"));
    await browser.execute("click", { selector: "#submit" }, target);
    expect(after).toHaveLength(1);
    expect(after[0].config.targetId).toBe(target.id);
    await browser.stopRecording();
    expect(
      await page.evaluate(() => Object.hasOwn(window, "__relayRecorder")),
    ).toBe(false);
  });
  it("returns selector errors without clicking arbitrary coordinates", async () => {
    await expect(
      browser.execute(
        "click",
        { selector: "#missing", timeoutMs: 150 },
        target,
      ),
    ).rejects.toThrow();
  });
  it("detects present, missing, and ambiguous browser elements", async () => {
    expect(
      await browser.execute("detect", { selector: "#submit" }, target),
    ).toMatchObject({ outcome: "match" });
    expect(
      await browser.execute("detect", { selector: "#missing" }, target),
    ).toMatchObject({ outcome: "no-match" });
    expect(
      await browser.execute("detect", { selector: "option" }, target),
    ).toMatchObject({ outcome: "uncertain" });
    expect(
      await browser.execute(
        "detect",
        { selector: "#submit", prompt: "not the button text" },
        target,
      ),
    ).toMatchObject({ outcome: "no-match" });
  });
  it("releases only the browser inputs owned by the completed run", async () => {
    await browser.execute(
      "select",
      { selector: "#choice", value: "b" },
      target,
    );
    await browser.execute("type", { selector: "#name", text: "" }, target);
    await browser.execute(
      "key",
      { selector: "#name", key: "Shift", action: "down" },
      target,
      undefined,
      "owner-a",
    );
    await browser.releaseAll("owner-b");
    await browser.execute("key", { key: "KeyA" }, target);
    await browser.releaseAll("owner-a");
    await browser.execute("key", { key: "KeyB" }, target);
    await browser.execute("click", { selector: "#submit" }, target);
    expect(await browser.execute("read", { selector: "#result" }, target)).toBe(
      "Ab:b",
    );
  });
  it("honors key press duration and cancels a held key promptly", async () => {
    const timedTarget = { ...target, id: "duration-fixture" };
    const started = Date.now();
    await browser.execute(
      "key",
      { key: "Shift", durationMs: 180 },
      timedTarget,
      undefined,
      "timed-owner",
    );
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    const abort = new AbortController();
    const cancelled = browser.execute(
      "key",
      { key: "Shift", durationMs: 5000 },
      timedTarget,
      abort.signal,
      "timed-owner",
    );
    setTimeout(() => abort.abort(), 100);
    await expect(cancelled).rejects.toThrow();
    await browser.releaseAll("timed-owner");
  });
});

describe("real Chromium extension", () => {
  it("pairs, controls a page, records actions and cancels a timed key in an isolated profile", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "relay-real-extension-"),
    );
    const browser = new BrowserAdapter({
      profilesDir: path.join(directory, "managed"),
    });
    const info = await browser.startBridge();
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html");
      response.end(
        '<!doctype html><title>Extension fixture</title><input id="name"><button id="submit" onclick="document.querySelector(\'#result\').textContent=document.querySelector(\'#name\').value">Submit</button><p id="result">waiting</p>',
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const extensionPath = path.join(directory, "extension");
    await cp(path.resolve("extension"), extensionPath, { recursive: true });
    // A temporary fixture hook models the module-local state lost when Chrome
    // suspends the worker, without depending on DevTools worker lifecycle rules.
    await appendFile(
      path.join(extensionPath, "background.js"),
      "\nglobalThis.__relayForgetRecordingForTest = () => { recording = undefined; targets.clear(); };\n",
    );
    const context = await chromium.launchPersistentContext(
      path.join(directory, "chromium"),
      {
        executablePath:
          process.env.RELAY_TEST_CHROMIUM ?? chromium.executablePath(),
        headless: true,
        args: [
          `--disable-extensions-except=${extensionPath}`,
          `--load-extension=${extensionPath}`,
        ],
      },
    );
    try {
      const worker =
        context.serviceWorkers()[0] ??
        (await context.waitForEvent("serviceworker"));
      const extensionId = new URL(worker.url()).host;
      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${extensionId}/popup.html`);
      await popup.locator("#port").fill(String(info.port));
      await popup.locator("#token").fill(info.token);
      await popup.getByRole("button", { name: "Connect", exact: true }).click();
      for (let i = 0; i < 100 && !browser.getBridgeInfo().connected; i++)
        await new Promise((resolve) => setTimeout(resolve, 25));
      expect(browser.getBridgeInfo().connected).toBe(true);
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${port}/original`);
      const target: TargetDescriptor = {
        id: "real-extension",
        name: "Extension fixture",
        kind: "browser",
        browserMode: "extension",
        url: page.url(),
      };
      await browser.execute(
        "type",
        { selector: "#name", text: "Extension works" },
        target,
      );
      await browser.execute("click", { selector: "#submit" }, target);
      expect(
        await browser.execute("read", { selector: "#result" }, target),
      ).toBe("Extension works");
      expect(
        await browser.execute(
          "detect",
          { selector: "#submit", prompt: "Submit" },
          target,
        ),
      ).toMatchObject({ outcome: "match" });
      const frame = await browser.capture(target);
      expect(frame.width).toBeGreaterThan(100);
      expect(frame.dataUrl).toMatch(/^data:image\/png;base64,/);
      const actions: RecordedAction[] = [];
      await browser.startRecording(target, (action) => actions.push(action));
      await browser.execute("click", { selector: "#submit" }, target);
      for (let i = 0; i < 40 && !actions.length; i++)
        await new Promise((resolve) => setTimeout(resolve, 25));
      await browser.stopRecording();
      expect(
        actions.some(
          (action) =>
            JSON.stringify(action.config.locator) ===
              JSON.stringify({
                version: 1,
                selector: { kind: "role", role: "button", name: "Submit" },
              }) && action.config.targetId === target.id,
        ),
      ).toBe(true);
      const tabId = await worker.evaluate(
        async (url) =>
          (await chrome.tabs.query({})).find((tab) => tab.url === url)!.id!,
        page.url(),
      );
      const listenerToken = async () =>
        worker.evaluate(async (tabId) => {
          const tree = await chrome.debugger.sendCommand(
            { tabId },
            "Page.getFrameTree",
          );
          const world = await chrome.debugger.sendCommand(
            { tabId },
            "Page.createIsolatedWorld",
            {
              frameId: tree.frameTree.frame.id,
              worldName: "Relay locator inspection",
            },
          );
          const result = await chrome.debugger.sendCommand(
            { tabId },
            "Runtime.evaluate",
            {
              expression: "window.__relayRecorder?.recordingId ?? null",
              contextId: world.executionContextId,
              returnByValue: true,
            },
          );
          return result.result.value;
        }, tabId);
      expect(await listenerToken()).toBeNull();
      const nextActions: RecordedAction[] = [];
      await browser.startRecording(target, (action) =>
        nextActions.push(action),
      );
      const oldToken = await listenerToken();
      expect(typeof oldToken).toBe("string");
      await browser.stopRecording();
      expect(await listenerToken()).toBeNull();
      await browser.startRecording(target, (action) =>
        nextActions.push(action),
      );
      expect(await listenerToken()).not.toBe(oldToken);
      await fetch(`http://127.0.0.1:${info.port}/result`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${info.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          recordingId: oldToken,
          action: {
            kind: "click",
            label: "Delayed previous session",
            config: { selector: "#submit" },
          },
        }),
      });
      expect(nextActions).toHaveLength(0);
      await page.locator("#submit").click();
      for (let i = 0; i < 40 && !nextActions.length; i++)
        await new Promise((resolve) => setTimeout(resolve, 25));
      expect(nextActions).toHaveLength(1);
      await browser.stopRecording();
      expect(await listenerToken()).toBeNull();
      await browser.startRecording(target, (action) =>
        nextActions.push(action),
      );
      await page.goto(`http://127.0.0.1:${port}/navigated`);
      for (let i = 0; i < 40 && !(await listenerToken()); i++)
        await new Promise((resolve) => setTimeout(resolve, 25));
      expect(typeof (await listenerToken())).toBe("string");
      const decoy = await context.newPage();
      await decoy.goto(target.url!);
      // Emulate worker memory loss while preserving storage.session and the
      // tab's isolated-world listener. Cleanup must use the stored tab ID,
      // even though another tab now matches the target's original URL.
      await worker.evaluate("globalThis.__relayForgetRecordingForTest()");
      await browser.stopRecording();
      expect(await listenerToken()).toBeNull();
      await decoy.close();
      await page.goto(target.url!);
      await browser.execute(
        "type",
        { selector: "#name", text: "Extension works" },
        target,
      );
      await browser.execute("click", { selector: "#submit" }, target);
      const abort = new AbortController(),
        started = Date.now();
      const key = browser.execute(
        "key",
        { key: "Shift", durationMs: 5000 },
        target,
        abort.signal,
        "extension-owner",
      );
      setTimeout(() => abort.abort(), 150);
      await expect(key).rejects.toThrow("Cancelled");
      await browser.releaseAll("extension-owner");
      expect(Date.now() - started).toBeLessThan(3000);
      expect(
        await browser.execute("read", { selector: "#result" }, target),
      ).toBe("Extension works");
    } finally {
      await browser.dispose();
      await context.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  }, 30000);
});

describe("authenticated extension bridge", () => {
  let browser: BrowserAdapter, directory: string, base: string, token: string;
  beforeAll(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "relay-bridge-test-"));
    browser = new BrowserAdapter({ profilesDir: directory });
    const info = await browser.startBridge();
    base = `http://127.0.0.1:${info.port}`;
    token = info.token;
  });
  afterAll(async () => {
    await browser.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  it("rejects unauthenticated clients and ordinary web origins", async () => {
    expect((await fetch(`${base}/next`)).status).toBe(401);
    expect(
      (
        await fetch(`${base}/next`, {
          headers: {
            Authorization: `Bearer ${token}`,
            Origin: "https://evil.example",
          },
        })
      ).status,
    ).toBe(403);
    const options = await fetch(`${base}/next`, {
      method: "OPTIONS",
      headers: { Origin: "https://evil.example" },
    });
    expect(options.status).toBe(403);
    expect(options.headers.get("access-control-allow-origin")).toBeNull();
  });
  it("dispatches a paired browser command and correlates its result", async () => {
    const poll = fetch(`${base}/next`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: `chrome-extension://${"a".repeat(32)}`,
      },
    });
    for (let i = 0; i < 20 && !browser.getBridgeInfo().connected; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    const target: TargetDescriptor = {
      id: "paired-tab",
      kind: "browser",
      browserMode: "extension",
      name: "Paired tab",
      url: "https://example.com",
    };
    const result = browser.execute("read", { selector: "h1" }, target);
    const response = await poll;
    expect(response.headers.get("access-control-allow-origin")).toBe(
      `chrome-extension://${"a".repeat(32)}`,
    );
    const { command } = await response.json();
    expect(command.kind).toBe("read");
    await fetch(`${base}/result`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ id: command.id, result: "Example" }),
    });
    expect(await result).toBe("Example");
  });
  it("converts image pixels to CSS coordinates on high-DPI extension captures", async () => {
    const target: TargetDescriptor = {
      id: "paired-hidpi",
      kind: "browser",
      browserMode: "extension",
      name: "HiDPI tab",
      url: "https://example.com",
    };
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };
    const capturePoll = fetch(`${base}/next`, { headers });
    const capture = browser.capture(target);
    const { command: captureCommand } = await (await capturePoll).json();
    await fetch(`${base}/result`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        id: captureCommand.id,
        result: {
          id: "hidpi",
          targetId: target.id,
          capturedAt: Date.now(),
          width: 2560,
          height: 1600,
          scale: 2,
          dataUrl: "data:image/png;base64,",
        },
      }),
    });
    await capture;
    const actionPoll = fetch(`${base}/next`, { headers });
    const action = browser.execute(
      "click",
      { x: 400, y: 200, frameId: "hidpi" },
      target,
    );
    const { command } = await (await actionPoll).json();
    expect(command.config).toMatchObject({ x: 200, y: 100 });
    await fetch(`${base}/result`, {
      method: "POST",
      headers,
      body: JSON.stringify({ id: command.id, result: true }),
    });
    expect(await action).toBe(true);
  });
});
