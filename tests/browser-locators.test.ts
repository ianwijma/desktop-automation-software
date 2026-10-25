import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
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
      server = createServer((request, response) => {
        response.setHeader("Content-Type", "text/html");
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
      if (directory) await rm(directory, { recursive: true, force: true });
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
  });
