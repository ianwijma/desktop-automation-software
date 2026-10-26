import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { browserRuntime } from "../extension/browser-runtime.js";
import { BrowserAdapter } from "../src/integrations/browser";
import type {
  BrowserLocator,
  RecordedAction,
  TargetDescriptor,
} from "../src/shared/types";

const recordedByMode = new Map<string, unknown>();
const locator = (
  selector: BrowserLocator["selector"],
  scope: BrowserLocator["path"] = [],
): BrowserLocator => ({
  version: 1,
  selector,
  ...(scope.length ? { path: scope } : {}),
});
const frame = (id: string) => ({
  kind: "frame" as const,
  selector: { kind: "id" as const, value: id },
});
const shadow = (id: string) => ({
  kind: "shadow" as const,
  selector: { kind: "id" as const, value: id },
});

for (const mode of ["managed", "extension"] as const)
  describe(`${mode} structured browser locators`, () => {
    let adapter: BrowserAdapter,
      target: TargetDescriptor,
      page: Page,
      directory: string,
      server: Server,
      context: BrowserContext | undefined;
    beforeAll(async () => {
      directory = await mkdtemp(path.join(tmpdir(), "relay-locators-"));
      let port = 0;
      const coverageHtml = await readFile(
        new URL("./fixtures/browser-recording.html", import.meta.url),
        "utf8",
      );
      server = createServer((request, response) => {
        response.setHeader("Content-Type", "text/html");
        if (request.url?.startsWith("/coverage"))
          return response.end(coverageHtml);
        if (request.url?.startsWith("/frame"))
          return response.end(
            '<!doctype html><button onclick="document.body.dataset.clicked=\'yes\'">Frame action</button><label>Frame name<input id="frame-name"></label><div id="inner-host"></div><script>document.querySelector("#inner-host").attachShadow({mode:"open"}).innerHTML=`<label>Deep name<input data-qa="deep-input"></label>`</script>',
          );
        response.end(
          `<!doctype html><title>Locator fixture</title><label>Full name<input id="full-name"></label><label>Choice<select id="choice"><option value="a">A</option><option value="b">B</option></select></label><label>Passcode<input id="password" type="password"></label><button id="stable" data-testid="stable" class="changing" onclick="document.body.dataset.clicks=String(Number(document.body.dataset.clicks||0)+1)">Run task</button><button class="duplicate">Duplicate</button><button class="duplicate">Duplicate</button><div id="hidden" style="display:none">Hidden</div><div id="host"></div><script>const root=document.querySelector('#host').attachShadow({mode:'open'});const button=document.createElement('button');button.textContent='Shadow action';button.onclick=()=>button.textContent='Shadow done';root.append(button);</script><iframe id="same" src="/frame"></iframe><iframe id="foreign" src="http://localhost:${port}/frame"></iframe><iframe id="foreign-twin" src="http://localhost:${port}/frame"></iframe>`,
        );
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      port = (server.address() as { port: number }).port;
      target = {
        id: "locator-fixture",
        kind: "browser",
        name: "Locator fixture",
        browserMode: mode,
        url: `http://127.0.0.1:${port}/`,
      };
      adapter = new BrowserAdapter({
        profilesDir: path.join(directory, "managed"),
        headless: true,
        executablePath: process.env.RELAY_TEST_CHROMIUM,
      });
      if (mode === "extension") {
        const bridge = await adapter.startBridge(),
          extensionPath = path.resolve("extension");
        context = await chromium.launchPersistentContext(
          path.join(directory, "extension-profile"),
          {
            headless: true,
            executablePath:
              process.env.RELAY_TEST_CHROMIUM ?? chromium.executablePath(),
            args: [
              `--disable-extensions-except=${extensionPath}`,
              `--load-extension=${extensionPath}`,
            ],
          },
        );
        const worker =
          context.serviceWorkers()[0] ??
          (await context.waitForEvent("serviceworker"));
        const popup = await context.newPage();
        await popup.goto(
          `chrome-extension://${new URL(worker.url()).host}/popup.html`,
        );
        // Storage initialization can otherwise overwrite fields filled immediately after load.
        await popup.waitForFunction(() =>
          Boolean(document.querySelector("#status")?.textContent),
        );
        await popup.locator("#port").fill(String(bridge.port));
        await popup.locator("#token").fill(bridge.token);
        await popup
          .getByRole("button", { name: "Connect", exact: true })
          .click();
        await vi.waitFor(
          () => {
            expect(
              adapter.getBridgeInfo().connected,
              "The paired extension must start polling the actual bridge",
            ).toBe(true);
          },
          { timeout: 10000 },
        );
        page = await context.newPage();
        await page.goto(target.url!);
        await page.waitForLoadState("load");
      } else {
        await adapter.execute("launch", {}, target);
        page = (adapter as unknown as { pages: Map<string, Page> }).pages.get(
          target.id,
        )!;
        await page.waitForLoadState("load");
      }
    }, 30000);
    afterAll(async () => {
      await adapter?.dispose();
      await context?.close();
      if (server)
        await new Promise<void>((resolve) => server.close(() => resolve()));
      if (directory)
        await rm(directory, {
          recursive: true,
          force: true,
          // Chromium can retain its log handle briefly after close on Windows.
          maxRetries: 5,
          retryDelay: 200,
        });
    });
    it("inspects test attributes, roles, labels, IDs and CSS without input or focus changes", async () => {
      const before = await page.evaluate(() => ({
        clicks: document.body.dataset.clicks,
        focus: document.activeElement?.id,
      }));
      for (const query of [
        locator({ kind: "testId", attribute: "data-testid", value: "stable" }),
        locator({ kind: "role", role: "button", name: "Run task" }),
        locator({ kind: "id", value: "stable" }),
        "#stable",
      ]) {
        expect(await adapter.inspectLocator(target, query)).toMatchObject({
          status: "unique",
          count: 1,
          visible: true,
          element: {
            tag: "button",
            role: "button",
            name: "Run task",
            locator: { selector: { kind: "testId", value: "stable" } },
          },
        });
      }
      expect(
        await adapter.inspectLocator(
          target,
          locator({ kind: "label", value: "Full name" }),
        ),
      ).toMatchObject({
        status: "unique",
        element: { id: "full-name", role: "textbox", name: "Full name" },
      });
      expect(await adapter.inspectLocator(target, "#hidden")).toMatchObject({
        status: "unique",
        visible: false,
      });
      expect(
        await page.evaluate(() => ({
          clicks: document.body.dataset.clicks,
          focus: document.activeElement?.id,
        })),
      ).toEqual(before);
    });
    it("keeps semantic matches stable across CSS changes and preserves old selectors", async () => {
      await page.locator("#stable").evaluate((element) => {
        element.setAttribute("class", "a-new-class");
      });
      await adapter.execute(
        "click",
        {
          locator: locator({
            kind: "testId",
            attribute: "data-testid",
            value: "stable",
          }),
        },
        target,
      );
      expect(await page.evaluate(() => document.body.dataset.clicks)).toBe("1");
      await adapter.execute(
        "type",
        { selector: "#full-name", text: "Legacy" },
        target,
      );
      expect(await page.locator("#full-name").inputValue()).toBe("Legacy");
      await adapter.execute(
        "type",
        {
          locator: locator({ kind: "label", value: "Full name" }),
          text: "Structured",
        },
        target,
      );
      expect(await page.locator("#full-name").inputValue()).toBe("Structured");
    });
    it("selects by a label locator while preserving legacy selector result types", async () => {
      expect(
        await adapter.execute(
          "select",
          { locator: locator({ kind: "label", value: "Choice" }), value: "b" },
          target,
        ),
      ).toEqual(["b"]);
      expect(await page.locator("#choice").inputValue()).toBe("b");
      expect(
        await adapter.execute(
          "select",
          { selector: "#choice", value: "a" },
          target,
        ),
      ).toEqual(mode === "managed" ? ["a"] : "a");
    });
    it("distinguishes missing and ambiguous matches and never acts on the first match", async () => {
      const duplicate = locator({
        kind: "role",
        role: "button",
        name: "Duplicate",
      });
      expect(await adapter.inspectLocator(target, duplicate)).toMatchObject({
        status: "ambiguous",
        count: 2,
      });
      expect(await adapter.inspectLocator(target, "#absent")).toMatchObject({
        status: "missing",
        count: 0,
      });
      for (const kind of ["click", "read", "key", "type", "select"] as const)
        await expect(
          adapter.execute(
            kind,
            { locator: duplicate, key: "Enter", text: "Wrong", value: "bad" },
            target,
          ),
        ).rejects.toThrow(/ambiguous/i);
      await expect(
        adapter.execute("read", { selector: "#absent" }, target),
      ).rejects.toThrow(/missing/i);
      await expect(adapter.inspectLocator(target, ":not(")).rejects.toThrow(
        /invalid/i,
      );
      expect(
        await adapter.execute("detect", { locator: duplicate }, target),
      ).toMatchObject({ outcome: "uncertain" });
      expect(
        await adapter.execute("detect", { selector: "#absent" }, target),
      ).toMatchObject({ outcome: "no-match" });
      const focusBefore = await page.evaluate(() => document.activeElement?.id);
      await expect(
        adapter.execute("key", { selector: "#hidden", key: "Enter" }, target),
      ).rejects.toThrow(/focus/i);
      await expect(
        adapter.execute("key", { selector: "#host", key: "Enter" }, target),
      ).rejects.toThrow(/focus/i);
      expect(await page.evaluate(() => document.activeElement?.id)).toBe(
        focusBefore,
      );
      expect(await page.locator(".duplicate").allTextContents()).toEqual([
        "Duplicate",
        "Duplicate",
      ]);
    });
    it("resolves explicit frame/shadow paths and reports missing or ambiguous frame owners", async () => {
      const deep = locator(
        { kind: "testId", attribute: "data-qa", value: "deep-input" },
        [frame("same"), shadow("inner-host")],
      );
      await adapter.execute("type", { locator: deep, text: "Nested" }, target);
      expect(
        await page.frameLocator("#same").getByLabel("Deep name").inputValue(),
      ).toBe("Nested");
      expect(await adapter.inspectLocator(target, deep)).toMatchObject({
        status: "unique",
        element: { locator: deep },
      });
      await adapter.execute(
        "click",
        {
          locator: locator(
            { kind: "role", role: "button", name: "Shadow action" },
            [shadow("host")],
          ),
        },
        target,
      );
      expect(
        await adapter.execute(
          "read",
          {
            locator: locator(
              { kind: "role", role: "button", name: "Shadow done" },
              [shadow("host")],
            ),
          },
          target,
        ),
      ).toBe("Shadow done");
      await expect(
        adapter.inspectLocator(
          target,
          locator({ kind: "css", value: "button" }, [
            { kind: "frame", selector: { kind: "css", value: "iframe" } },
          ]),
        ),
      ).rejects.toThrow(/ambiguous/i);
      await expect(
        adapter.inspectLocator(
          target,
          locator({ kind: "css", value: "button" }, [frame("absent")]),
        ),
      ).rejects.toThrow(/missing/i);
    });
    it("does not detect a leaf inside a hidden frame", async () => {
      const scoped = locator(
        { kind: "role", role: "button", name: "Frame action" },
        [frame("same")],
      );
      await page.locator("#same").evaluate((element) => {
        element.style.display = "none";
      });
      try {
        expect(await adapter.inspectLocator(target, scoped)).toMatchObject({
          status: "unique",
          visible: false,
        });
        expect(
          await adapter.execute("detect", { locator: scoped }, target),
        ).toMatchObject({ outcome: "no-match" });
      } finally {
        await page.locator("#same").evaluate((element) => {
          element.style.display = "";
        });
      }
    });
    it("measures frame geometry after delayed layout rather than before the paint wait", async () => {
      const owner = await page.locator("#foreign").elementHandle();
      const previous = await owner!.evaluate(
        (element) => element.style.marginTop,
      );
      try {
        await page.evaluate(() => {
          const original = window.requestAnimationFrame;
          window.requestAnimationFrame = (callback) => {
            window.requestAnimationFrame = original;
            return original.call(window, (time) => {
              (
                document.querySelector("#foreign") as HTMLElement
              ).style.marginTop = "52px";
              callback(time);
            });
          };
        });
        const geometry = await page.evaluate(browserRuntime, {
          operation: "frameGeometry",
          element: owner,
        });
        const actual = await owner!.evaluate((element) => {
          const frame = element as HTMLElement;
          const r = frame.getBoundingClientRect();
          return {
            x: r.x + (frame.clientLeft * r.width) / frame.offsetWidth,
            y: r.y + (frame.clientTop * r.height) / frame.offsetHeight,
          };
        });
        expect(geometry.x).toBeCloseTo(actual.x, 5);
        expect(geometry.y).toBeCloseTo(actual.y, 5);
      } finally {
        await owner!.evaluate((element, margin) => {
          element.style.marginTop = margin;
        }, previous);
        await owner!.dispose();
      }
    });
    it("targets a cross-origin frame by its exact owner and maps click coordinates correctly", async () => {
      const scoped = locator(
        { kind: "role", role: "button", name: "Frame action" },
        [frame("foreign")],
      );
      expect(await adapter.inspectLocator(target, scoped)).toMatchObject({
        status: "unique",
        element: { locator: scoped },
      });
      await adapter.execute("click", { locator: scoped }, target);
      // CDP input acknowledgement can precede event handling in a child renderer.
      // Wait for the application effect without repeating the click.
      await expect
        .poll(
          () =>
            page
              .frameLocator("#foreign")
              .locator("body")
              .getAttribute("data-clicked"),
          { timeout: 5000 },
        )
        .toBe("yes");
      expect(
        await page
          .frameLocator("#same")
          .locator("body")
          .getAttribute("data-clicked"),
      ).toBeNull();
      expect(
        await page
          .frameLocator("#foreign-twin")
          .locator("body")
          .getAttribute("data-clicked"),
      ).toBeNull();
    });
    it("records equivalent scoped actions in both modes, replays them, and removes frame listeners on Stop", async () => {
      const actions: RecordedAction[] = [];
      await adapter.startRecording(target, (action) => actions.push(action));
      await page.getByTestId("stable").click();
      await page.getByLabel("Full name", { exact: true }).fill("Recorded");
      await page.getByTestId("stable").click();
      await page
        .locator("#host")
        .getByRole("button", { name: "Shadow done", exact: true })
        .click();
      await page
        .frameLocator("#same")
        .getByRole("button", { name: "Frame action", exact: true })
        .click();
      await page
        .frameLocator("#foreign")
        .getByRole("button", { name: "Frame action", exact: true })
        .click();
      await page
        .getByLabel("Passcode", { exact: true })
        .fill("never-save-this-password");
      await page.getByTestId("stable").click();
      await vi.waitFor(() => expect(actions).toHaveLength(8));
      await adapter.stopRecording();
      expect(JSON.stringify(actions)).not.toContain("never-save-this-password");
      expect(actions.find((action) => action.config.secret)).toMatchObject({
        kind: "type",
        config: { text: "", secret: true },
      });
      const normalized = actions.map(({ kind, label, config }) => ({
        kind,
        label,
        config: Object.fromEntries(
          Object.entries(config).filter(([key]) => key !== "targetId"),
        ),
      }));
      recordedByMode.set(mode, normalized);
      if (mode === "extension")
        expect(normalized).toEqual(recordedByMode.get("managed"));
      const scoped = actions.filter((action) =>
        (action.config.locator as unknown as BrowserLocator).path?.some(
          (step) => step.kind === "frame",
        ),
      );
      expect(scoped).toHaveLength(2);
      expect(
        scoped.map(
          (action) =>
            (
              (action.config.locator as unknown as BrowserLocator).path![0]
                .selector as { value: string }
            ).value,
        ),
      ).toEqual(["same", "foreign"]);
      for (const action of actions.filter((item) => !item.config.secret)) {
        expect(
          await adapter.inspectLocator(
            target,
            action.config.locator as unknown as BrowserLocator,
          ),
        ).toMatchObject({ status: "unique" });
        await adapter.execute(action.kind, action.config, target);
      }
      expect(
        await page.getByLabel("Full name", { exact: true }).inputValue(),
      ).toBe("Recorded");
      await page
        .frameLocator("#same")
        .getByRole("button", { name: "Frame action", exact: true })
        .click();
      await page
        .frameLocator("#foreign")
        .getByRole("button", { name: "Frame action", exact: true })
        .click();
      await page.waitForTimeout(100);
      expect(actions).toHaveLength(8);
    });
    it("records and replays the broader interaction fixture with equivalent normalized actions", async () => {
      await adapter.execute(
        "navigate",
        { url: `${new URL(target.url!).origin}/coverage` },
        target,
      );
      await page.bringToFront();
      const actions: RecordedAction[] = [];
      await adapter.startRecording(target, (action) => actions.push(action));
      await page.locator("#text").pressSequentially("first");
      await page
        .locator("#text")
        .press(process.platform === "darwin" ? "Meta+A" : "Control+A");
      await page.locator("#text").pressSequentially("replacement");
      await page
        .context()
        .grantPermissions(["clipboard-read", "clipboard-write"]);
      await page.evaluate(() => navigator.clipboard.writeText(" pasted"));
      await page
        .locator("#text")
        .press(process.platform === "darwin" ? "Meta+V" : "Control+V");
      await page.locator("#multi").fill("line one\nline two");
      await page.locator("#rich").fill("Rich content");
      await page.locator("#ime").focus();
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Input.imeSetComposition", {
        text: "に",
        selectionStart: 1,
        selectionEnd: 1,
      });
      await cdp.send("Input.imeSetComposition", {
        text: "日本",
        selectionStart: 2,
        selectionEnd: 2,
      });
      await cdp.send("Input.insertText", { text: "日本語" });
      await cdp.detach();
      await page.locator("#enabled").check();
      await page.locator("#second").check();
      await page.locator('#options option[value="a"]').click();
      await page.locator('#options option[value="c"]').click({
        modifiers: [process.platform === "darwin" ? "Meta" : "Control"],
      });
      await page.locator("#double").dblclick();
      await page.locator("#right").click({ button: "right" });
      await page.locator("#middle").click({ button: "middle" });
      await page.locator("#modified").click({ modifiers: ["Shift"] });
      await page.locator("#modified").focus();
      await page.keyboard.down("Control");
      await page.keyboard.down("Shift");
      await page.keyboard.down("K");
      await page.keyboard.up("K");
      await page.keyboard.up("Shift");
      await page.keyboard.up("Control");
      await page.locator("#scrollbox").hover();
      await page.mouse.wheel(0, 200);
      await expect
        .poll(() =>
          page.locator("#scrollbox").evaluate((element) => element.scrollTop),
        )
        .toBeGreaterThan(0);
      const source = (await page.locator("#source").boundingBox())!,
        drop = (await page.locator("#drop").boundingBox())!;
      await page.mouse.move(
        source.x + source.width / 2,
        source.y + source.height / 2,
      );
      await page.mouse.down();
      await page.mouse.move(drop.x + drop.width / 2, drop.y + drop.height / 2, {
        steps: 12,
      });
      await page.mouse.up();
      actions.push(...(await adapter.stopRecording()));
      const expected = await page.evaluate(() => (window as any).snapshot());
      expect(expected).toMatchObject({
        text: "replacement pasted",
        ime: "日本語",
        enabled: true,
        choice: "second",
        selected: ["a", "c"],
        double: 1,
        right: 1,
        middle: 1,
        modified: 1,
        shortcut: 1,
        keyHeld: false,
        drag: 1,
      });
      const types = actions.filter((action) => action.kind === "type");
      expect(types).toHaveLength(4);
      expect(types.map((action) => action.config.text)).toEqual([
        "replacement pasted",
        "line one\nline two",
        "Rich content",
        "日本語",
      ]);
      expect(
        actions.filter(
          (action) =>
            action.kind === "click" && action.config.checked !== undefined,
        ),
      ).toHaveLength(2);
      expect(
        actions.filter((action) => action.config.clickCount === 2),
      ).toHaveLength(1);
      expect(actions.filter((action) => action.kind === "drag")).toHaveLength(
        1,
      );
      expect(
        actions.some((action) => action.config.requiresConfiguration),
      ).toBe(false);
      const normalized = actions.map(({ kind, config }) => ({
        kind,
        config: Object.fromEntries(
          Object.entries(config).filter(
            ([key]) =>
              !["targetId", "durationMs", "fromOffset", "toOffset"].includes(
                key,
              ),
          ),
        ),
      }));
      recordedByMode.set(`${mode}-coverage`, normalized);
      if (mode === "extension")
        expect(normalized).toEqual(recordedByMode.get("managed-coverage"));
      await page.reload();
      for (const action of actions)
        await adapter.execute(action.kind, action.config, target);
      await expect
        .poll(() => page.evaluate(() => (window as any).snapshot()))
        .toEqual(expected);
      // Checked-state replay is idempotent, rather than a second toggle.
      for (const action of actions.filter(
        (action) => action.config.checked !== undefined,
      ))
        await adapter.execute(action.kind, action.config, target);
      expect(await page.locator("#enabled").isChecked()).toBe(true);
      await page
        .locator("#enabled")
        .evaluate((element) =>
          element.addEventListener("click", (event) => event.preventDefault()),
        );
      await expect(
        adapter.execute(
          "click",
          {
            locator: locator({ kind: "id", value: "enabled" }),
            checked: false,
            timeoutMs: 150,
          },
          target,
        ),
      ).rejects.toThrow(/checked|state/i);
      expect(await page.locator("#enabled").isChecked()).toBe(true);
    }, 30000);
    it("returns pending text and held-key releases on Stop without retaining passwords or files", async () => {
      await adapter.execute(
        "navigate",
        { url: `${new URL(target.url!).origin}/coverage` },
        target,
      );
      const actions: RecordedAction[] = [];
      await adapter.startRecording(target, (action) => actions.push(action));
      await page.locator("#private").fill("private-value-never-export");
      const chooser = page.waitForEvent("filechooser");
      await page.locator("#file").click();
      await (
        await chooser
      ).setFiles({
        name: "private-file.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("private-file-bytes"),
      });
      await page.locator("#text").pressSequentially("last edit without blur");
      actions.push(...(await adapter.stopRecording()));
      expect(actions.at(-1)).toMatchObject({
        kind: "type",
        config: { text: "last edit without blur" },
      });
      expect(JSON.stringify(actions)).not.toMatch(
        /private-value-never-export|private-file-bytes|private-file.txt/,
      );
      const blocked = actions.filter(
        (action) => action.config.requiresConfiguration,
      );
      expect(blocked).toHaveLength(2);
      for (const action of blocked)
        await expect(
          adapter.execute(action.kind, action.config, target),
        ).rejects.toThrow(/omitted|not recorded/);
      const count = actions.length;
      await page.locator("#text").fill("after stop");
      expect(actions).toHaveLength(count);
    });
    it("records and replays document navigation and an owned popup without duplicate navigation or closing the return tab", async () => {
      const url = `${new URL(target.url!).origin}/coverage`;
      await adapter.execute("navigate", { url }, target);
      const actions: RecordedAction[] = [];
      await adapter.startRecording(target, (action) => actions.push(action));
      const sessionId = (adapter as any).installedRecording.id;
      const ready = async (candidate: Page) => {
        await expect
          .poll(
            async () => {
              if (mode === "managed")
                return candidate
                  .evaluate(
                    (id) => (window as any).__relayRecorder?.recordingId === id,
                    sessionId,
                  )
                  .catch(() => false);
              return context!.serviceWorkers()[0].evaluate(
                async ({ url, id }) => {
                  const api = (globalThis as any).chrome;
                  const tabs = (await api.tabs.query({})).filter(
                    (tab: any) => tab.url === url,
                  );
                  if (tabs.length !== 1) return false;
                  try {
                    const source = { tabId: tabs[0].id };
                    const tree = await api.debugger.sendCommand(
                      source,
                      "Page.getFrameTree",
                    );
                    const world = await api.debugger.sendCommand(
                      source,
                      "Page.createIsolatedWorld",
                      {
                        frameId: tree.frameTree.frame.id,
                        worldName: "Relay locator inspection",
                      },
                    );
                    const result = await api.debugger.sendCommand(
                      source,
                      "Runtime.evaluate",
                      {
                        contextId: world.executionContextId,
                        expression: `window.__relayRecorder?.recordingId === ${JSON.stringify(id)}`,
                        returnByValue: true,
                      },
                    );
                    return Boolean(result.result.value);
                  } catch {
                    return false;
                  }
                },
                { url: candidate.url(), id: sessionId },
              );
            },
            { timeout: 10000 },
          )
          .toBe(true);
      };
      await page.locator("#text").fill("before navigation");
      await page.locator("#navigate").click();
      await page.waitForURL(`${url}?next=1`);
      await ready(page);
      await page.locator("#text").fill("popup parent");
      const created = page.waitForEvent("popup");
      await page.locator("#popup").click();
      const child = await created;
      await child.waitForLoadState();
      await ready(child);
      await child.locator("#text").fill("child value");
      await page.bringToFront();
      await page.locator("#text").fill("parent while popup open");
      await expect
        .poll(
          () =>
            actions.filter(
              (action) =>
                action.kind === "tab" && action.config.action === "switch",
            ).length,
          { timeout: 10000 },
        )
        .toBe(2);
      await child.bringToFront();
      await child.locator("#close").focus();
      await expect
        .poll(
          () =>
            actions.filter(
              (action) =>
                action.kind === "tab" && action.config.action === "switch",
            ).length,
          { timeout: 10000 },
        )
        .toBe(3);
      const closed = child.waitForEvent("close");
      await child
        .locator("#close")
        .click()
        .catch((error: Error) => {
          if (
            !child.isClosed() ||
            !error.message.includes("has been closed") ||
            !error.message.includes("performing click action")
          )
            throw error;
        });
      await closed;
      await expect.poll(() => child.isClosed()).toBe(true);
      await ready(page);
      await page.locator("#text").fill("after popup");
      actions.push(...(await adapter.stopRecording()));
      expect(
        actions
          .filter((action) => action.kind === "type")
          .map((action) => action.config.text),
      ).toEqual([
        "before navigation",
        "popup parent",
        "child value",
        "parent while popup open",
        "after popup",
      ]);
      expect(
        actions.filter((action) => action.kind === "navigate"),
      ).toHaveLength(1);
      expect(
        actions.filter(
          (action) =>
            action.kind === "tab" && action.config.action === "switch",
        ),
      ).toHaveLength(3);
      expect(
        actions.filter(
          (action) => action.kind === "tab" && action.config.action === "close",
        ),
      ).toHaveLength(1);
      expect(actions.at(-1)).toMatchObject({
        kind: "type",
        config: { text: "after popup" },
      });
      const normalized = actions.map(({ kind, config }) => ({
        kind,
        config: JSON.parse(
          JSON.stringify(config).replaceAll(new URL(url).origin, "ORIGIN"),
        ),
      }));
      recordedByMode.set(`${mode}-navigation`, normalized);
      if (mode === "extension")
        expect(normalized).toEqual(recordedByMode.get("managed-navigation"));
      await page.goto(url);
      for (const action of actions)
        await adapter.execute(action.kind, action.config, target);
      expect(page.isClosed()).toBe(false);
      expect(await page.locator("#text").inputValue()).toBe("after popup");
      expect(
        page
          .context()
          .pages()
          .filter((candidate) => candidate.url().includes("popup=1")),
      ).toHaveLength(0);
    }, 30000);
    it("flushes text before same-document navigation and releases held keys in the Stop tail", async () => {
      const url = `${new URL(target.url!).origin}/coverage`;
      await adapter.execute("navigate", { url }, target);
      const actions: RecordedAction[] = [];
      await adapter.startRecording(target, (action) => actions.push(action));
      await page.locator("#text").fill("before history");
      await page.locator("#history").click();
      await expect
        .poll(() => actions.some((action) => action.kind === "navigate"))
        .toBe(true);
      expect(actions.slice(0, 3).map((action) => action.kind)).toEqual([
        "type",
        "click",
        "navigate",
      ]);
      await page.locator("#modified").focus();
      await page.keyboard.down("Control");
      await page.keyboard.down("Shift");
      await page.keyboard.down("K");
      actions.push(...(await adapter.stopRecording()));
      await page.keyboard.up("K");
      await page.keyboard.up("Shift");
      await page.keyboard.up("Control");
      expect(actions.slice(-2).map((action) => action.config.action)).toEqual([
        "down",
        "up",
      ]);
      await page.goto(url);
      for (const action of actions)
        await adapter.execute(action.kind, action.config, target);
      expect(page.url()).toBe(`${url}?history=1`);
      expect(await page.locator("#text").inputValue()).toBe("before history");
      expect(
        await page.evaluate(() => (window as any).snapshot().keyHeld),
      ).toBe(false);
    });
    it("recovers a lost Stop reply and flags composition interrupted by Stop", async () => {
      const url = `${new URL(target.url!).origin}/coverage`;
      await adapter.execute("navigate", { url }, target);
      const actions: RecordedAction[] = [];
      await adapter.startRecording(target, (action) => actions.push(action));
      await page.locator("#text").fill("pending receipt");
      const id = (adapter as any).installedRecording.id;
      const lost =
        mode === "managed"
          ? await page.evaluate(browserRuntime, {
              operation: "record",
              recordingId: null,
              expectedRecordingId: id,
            })
          : await (adapter as any).extension("recordStop", target, undefined, {
              recordingId: id,
            });
      expect(lost).toHaveLength(1);
      const retried = await adapter.stopRecording();
      expect(retried).toHaveLength(1);
      expect(retried[0].id).toBe(lost[0].id);
      expect(retried[0].config.text).toBe("pending receipt");
      expect(await adapter.stopRecording()).toEqual([]);
      await adapter.startRecording(target, (action) => actions.push(action));
      await page.locator("#ime").focus();
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Input.imeSetComposition", {
        text: "編集中",
        selectionStart: 3,
        selectionEnd: 3,
      });
      const interrupted = await adapter.stopRecording();
      expect(interrupted, JSON.stringify(interrupted)).toHaveLength(1);
      expect(interrupted[0]).toMatchObject({
        kind: "type",
        config: { requiresConfiguration: true, text: "編集中" },
      });
      await expect(
        adapter.execute(interrupted[0].kind, interrupted[0].config, target),
      ).rejects.toThrow(/Composition/);
      await cdp.send("Input.imeSetComposition", {
        text: "",
        selectionStart: 0,
        selectionEnd: 0,
      });
      await cdp.detach();
    });
  });
