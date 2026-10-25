import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { browserRuntime } from "../extension/browser-runtime.js";

/** Inspector acceptance uses a controlled API backed by the production DOM matcher. */
export async function runBrowserLocatorSmoke({
  browser,
  url,
  outputDir = "test-results",
}) {
  const context = await browser.newContext({
    viewport: { width: 1560, height: 1050 },
  });
  const target = await context.newPage();
  await target.setContent(
    '<label>Private value<input value="unchanged"></label><button data-testid="run">Run task</button><button>Duplicate</button><button>Duplicate</button><button>Slow</button><iframe id="workpane" srcdoc="<div id=frame-host></div>"></iframe>',
  );
  await target.frames()[1].evaluate(() => {
    document
      .querySelector("#frame-host")
      .attachShadow({ mode: "open" }).innerHTML =
      '<button data-testid="inner-action">Frame shadow</button>';
  });
  const initialTarget = await target.evaluate(() => ({
    focus: document.activeElement?.tagName,
    value: document.querySelector("input").value,
  }));
  const page = await context.newPage(),
    errors = [];
  page.setDefaultTimeout(10000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url);
  const fixture = await page.evaluate(async () =>
    (await import("/src/renderer/preview-api.ts")).previewAPI.bootstrap(),
  );
  const original = fixture.flows[0];
  fixture.flows = [
    {
      ...original,
      id: "locator-ui",
      name: "Locator authoring",
      hotkey: undefined,
      inputs: { selector: "[data-testid=run]" },
      outputs: {},
      nodes: [
        {
          id: "start",
          kind: "start",
          label: "Start",
          config: {},
          position: { x: 0, y: 0 },
        },
        {
          id: "action",
          kind: "click",
          label: "Browser action",
          config: { targetId: "web", x: 20, y: 20 },
          position: { x: 310, y: 0 },
        },
        {
          id: "finish",
          kind: "end",
          label: "Finish",
          config: {},
          position: { x: 620, y: 0 },
        },
      ],
      edges: [
        { id: "one", source: "start", target: "action", port: "next" },
        { id: "two", source: "action", target: "finish", port: "next" },
      ],
    },
  ];
  fixture.targets = [
    {
      id: "web",
      name: "Fixture browser",
      kind: "browser",
      browserMode: "managed",
    },
  ];
  fixture.runs = [];
  fixture.schedules = [];
  fixture.desktop = true;
  let releaseSlow,
    slowSubmitted = false;
  await page.exposeFunction("locatorInspect", async (query) => {
    const result = await target.evaluate(browserRuntime, {
      operation: "inspect",
      ...(typeof query === "string" ? { selector: query } : { locator: query }),
    });
    if (query?.selector?.name === "Slow") {
      slowSubmitted = true;
      await new Promise((resolve) => {
        releaseSlow = resolve;
      });
    }
    return result;
  });
  await page.addInitScript((fixture) => {
    const key = "relay.locator.ui",
      prior = sessionStorage.getItem(key),
      state = prior ? JSON.parse(prior) : fixture;
    window.__locatorQA = state;
    const persist = () => sessionStorage.setItem(key, JSON.stringify(state));
    persist();
    window.relay = {
      bootstrap: async () => structuredClone(state),
      onEvent: () => () => {},
      validateFlow: async () => [],
      inspectBrowserLocator: async (_targetId, query) =>
        window.locatorInspect(query),
      saveFlow: async (flow, options) => {
        if (state.flows[0].revision !== options.expectedRevision)
          return {
            status: "conflict",
            current: structuredClone(state.flows[0]),
            reason: "Revision conflict",
          };
        state.flows[0] = {
          ...structuredClone(flow),
          revision: state.flows[0].revision + 1,
        };
        persist();
        return { status: "saved", flow: structuredClone(state.flows[0]) };
      },
    };
  }, fixture);
  const choose = (label, value) =>
    page.getByLabel(label, { exact: true }).selectOption(value);
  const fill = (label, value) =>
    page.getByLabel(label, { exact: true }).fill(value);
  const test = () =>
    page.getByRole("button", { name: "Test match", exact: true }).click();
  const save = async () => {
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll(".toolbar-actions button")].find(
          (button) => button.textContent.trim() === "Save",
        )?.disabled,
    );
  };
  try {
    await page.reload();
    await page.locator('.react-flow__node[data-id="action"]').click();
    await choose("Browser targeting", "locator");
    await choose("Locator strategy", "role");
    await fill("Locator name", "Run task");
    await test();
    await page.getByText("1 element matches", { exact: true }).waitFor();
    await page
      .getByRole("button", { name: "Use inspected locator", exact: true })
      .click();
    assert.equal(
      await page.getByLabel("Locator strategy", { exact: true }).inputValue(),
      "testId",
    );
    assert.equal(
      await page.getByLabel("Locator value", { exact: true }).inputValue(),
      "run",
    );
    await save();
    await page.reload();
    await page.locator('.react-flow__node[data-id="action"]').click();
    assert.equal(
      await page.getByLabel("Locator value", { exact: true }).inputValue(),
      "run",
    );
    await choose("Locator strategy", "role");
    await fill("Locator name", "Slow");
    await test();
    for (let attempt = 0; attempt < 100 && !slowSubmitted; attempt++)
      await page.waitForTimeout(20);
    assert.equal(slowSubmitted, true);
    await fill("Locator name", "Duplicate");
    releaseSlow();
    await page.waitForTimeout(100);
    assert.equal(
      await page.getByText("1 element matches", { exact: true }).count(),
      0,
      "A late result cannot validate changed locator fields",
    );
    await test();
    await page
      .getByText("2 elements match — ambiguous", { exact: true })
      .waitFor();
    await choose("Browser targeting", "css");
    await fill("Browser selector", "#missing");
    await test();
    await page.getByText("No elements match", { exact: true }).waitFor();
    await fill("Browser selector", "${inputs.selector}");
    assert.equal(
      await page
        .getByRole("button", { name: "Test match", exact: true })
        .isDisabled(),
      true,
    );
    await choose("Browser targeting", "locator");
    await choose("Locator strategy", "role");
    await fill("Locator name", "Frame shadow");
    await page
      .getByRole("button", { name: "Add frame scope", exact: true })
      .click();
    await choose("Scope 1 strategy", "id");
    await fill("Scope 1 value", "workpane");
    await page
      .getByRole("button", { name: "Add shadow scope", exact: true })
      .click();
    await choose("Scope 2 strategy", "id");
    await fill("Scope 2 value", "frame-host");
    await test();
    await page.getByText("1 element matches", { exact: true }).waitFor();
    await page
      .getByRole("button", { name: "Use inspected locator", exact: true })
      .click();
    await save();
    const saved = await page.evaluate(() =>
      structuredClone(
        window.__locatorQA.flows[0].nodes.find((node) => node.id === "action")
          .config,
      ),
    );
    assert.equal(saved.selector, undefined);
    assert.equal(saved.locator.path.length, 2);
    assert.equal(saved.locator.selector.value, "inner-action");
    await mkdir(outputDir, { recursive: true });
    await page.screenshot({
      path: join(outputDir, "relay-browser-locator.png"),
      animations: "disabled",
    });
    assert.deepEqual(
      await target.evaluate(() => ({
        focus: document.activeElement?.tagName,
        value: document.querySelector("input").value,
      })),
      initialTarget,
      "Inspection never clicks, types, or focuses the application",
    );
    // Unknown versions remain intact and editable through the existing advanced editor.
    await page.evaluate(() => {
      const config = window.__locatorQA.flows[0].nodes.find(
        (node) => node.id === "action",
      ).config;
      config.locator = {
        version: 99,
        selector: { kind: "future", value: "keep" },
      };
      sessionStorage.setItem(
        "relay.locator.ui",
        JSON.stringify(window.__locatorQA),
      );
    });
    await page.reload();
    await page.locator('.react-flow__node[data-id="action"]').click();
    await page.getByText(/cannot be edited with these controls/).waitFor();
    assert.equal(
      await page
        .getByRole("button", { name: "Test match", exact: true })
        .isDisabled(),
      true,
    );
    assert.equal(
      (
        await page.evaluate(
          () =>
            window.__locatorQA.flows[0].nodes.find(
              (node) => node.id === "action",
            ).config.locator,
        )
      ).version,
      99,
    );
    await page.evaluate(() => {
      const node = window.__locatorQA.flows[0].nodes.find(
        (node) => node.id === "action",
      );
      node.kind = "type";
      node.config = {
        targetId: "web",
        selector: "input",
        text: "",
        secret: true,
        requiresConfiguration: true,
        recordingWarning:
          "Password values are omitted. Configure a value before running.",
      };
      sessionStorage.setItem(
        "relay.locator.ui",
        JSON.stringify(window.__locatorQA),
      );
    });
    await page.reload();
    await page.locator('.react-flow__node[data-id="action"]').click();
    await page.getByText("Configure before running", { exact: true }).waitFor();
    assert.equal(
      await page
        .getByRole("button", { name: "Mark as configured", exact: true })
        .isDisabled(),
      true,
    );
    await page.screenshot({
      path: join(outputDir, "relay-recording-warning.png"),
      animations: "disabled",
    });
    await fill("Text", "explicitly configured fixture value");
    await page
      .getByRole("button", { name: "Mark as configured", exact: true })
      .click();
    await save();
    assert.equal(
      await page.evaluate(
        () =>
          window.__locatorQA.flows[0].nodes.find((node) => node.id === "action")
            .config.requiresConfiguration,
      ),
      false,
    );
    assert.deepEqual(
      await target.evaluate(() => ({
        focus: document.activeElement?.tagName,
        value: document.querySelector("input").value,
      })),
      initialTarget,
    );
    assert.deepEqual(errors, []);
    console.log(
      "PASS: structured locator controls; read-only unique/missing/ambiguous inspection; suggested locator; frame/shadow paths; save/reload; stale-response rejection; unresolved references and future-version preservation; recording configuration warning and explicit acknowledgement without input.",
    );
  } catch (error) {
    await mkdir(outputDir, { recursive: true });
    await page.screenshot({
      path: join(outputDir, "relay-browser-locator-failure.png"),
      animations: "disabled",
    });
    throw error;
  } finally {
    releaseSlow?.();
    await context.close();
  }
}
