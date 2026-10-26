import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";

// Controlled renderer API only. Real UIA effects are verified by the Win32 matrix.
export async function runNativeLocatorSmoke({
  browser,
  url,
  outputDir = "test-results",
}) {
  const context = await browser.newContext({
    viewport: { width: 1560, height: 1050 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  await page.goto(url);
  const state = await page.evaluate(async () =>
    (await import("/src/renderer/preview-api.ts")).previewAPI.bootstrap(),
  );
  const flow = {
    ...state.flows[0],
    id: "native-locator-ui",
    name: "Native locator authoring",
    hotkey: undefined,
    nodes: [
      {
        id: "start",
        kind: "start",
        label: "Start",
        config: {},
        position: { x: 0, y: 0 },
      },
      {
        id: "native-action",
        kind: "click",
        label: "Native action",
        config: { targetId: "desktop", x: 20, y: 20 },
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
      { id: "a", source: "start", target: "native-action", port: "next" },
      { id: "b", source: "native-action", target: "finish", port: "next" },
    ],
    inputs: {},
    outputs: {},
  };
  state.flows = [flow];
  state.targets = [
    {
      id: "desktop",
      name: "Synthetic native window",
      kind: "desktop",
      windowTitle: "Fixture",
      windowsCaptureBackend: "wgc",
    },
  ];
  state.desktop = true;
  state.capabilities = {
    ...state.capabilities,
    platform: "win32",
    accessibility: true,
  };
  const image = await sharp({
    create: { width: 400, height: 200, channels: 3, background: "#34374b" },
  })
    .png()
    .toBuffer();
  const frame = {
    id: "preview-frame",
    targetId: "desktop",
    width: 400,
    height: 200,
    capturedAt: Date.now(),
    scale: 1,
    dataUrl: `data:image/png;base64,${image.toString("base64")}`,
  };
  let releaseSlow,
    slowSubmitted = false;
  const queries = [];
  await page.exposeFunction("nativeInspect", async (query) => {
    queries.push(query);
    const name = query.locator?.selector?.name;
    if (name === "Slow") {
      slowSubmitted = true;
      await new Promise((resolve) => {
        releaseSlow = resolve;
      });
    }
    if (name === "Duplicate") return { status: "ambiguous", count: 2 };
    if (name === "Missing") return { status: "missing", count: 0 };
    return {
      status: "unique",
      count: 1,
      element: {
        locator: query.point
          ? {
              version: 1,
              backend: "uia",
              selector: { automationId: "apply", controlType: "button" },
            }
          : query.locator,
        name: "Apply",
        controlType: "button",
        automationId: "apply",
        className: "Button",
        secure: false,
        enabled: true,
        offscreen: false,
        virtualized: false,
        actions: ["read", "invoke"],
        bounds: { x: 20, y: 20, width: 100, height: 30 },
      },
    };
  });
  await page.addInitScript(
    ({ state, frame }) => {
      const key = "relay.native-locator.qa";
      const workspace =
        JSON.parse(sessionStorage.getItem(key) ?? "null") ?? state;
      const persist = () =>
        sessionStorage.setItem(key, JSON.stringify(workspace));
      persist();
      window.relay = {
        bootstrap: async () => structuredClone(workspace),
        onEvent: () => () => {},
        validateFlow: async () => [],
        capture: async () => structuredClone(frame),
        inspectNativeLocator: async (_id, query) => window.nativeInspect(query),
        saveFlow: async (flow, { expectedRevision }) => {
          assertRevision();
          function assertRevision() {
            if (workspace.flows[0].revision !== expectedRevision)
              throw new Error("Revision conflict");
          }
          workspace.flows[0] = {
            ...structuredClone(flow),
            revision: expectedRevision + 1,
          };
          persist();
          return { status: "saved", flow: structuredClone(workspace.flows[0]) };
        },
      };
    },
    { state, frame },
  );
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await page.reload();
    await page.locator('.react-flow__node[data-id="native-action"]').click();
    await page
      .getByLabel("Desktop targeting", { exact: true })
      .selectOption("uia");
    await page.getByLabel("Accessible name", { exact: true }).fill("Duplicate");
    await page
      .getByRole("button", { name: "Test native match", exact: true })
      .click();
    await page
      .getByText("2 native controls match — ambiguous", { exact: true })
      .waitFor();
    await page.getByLabel("Accessible name", { exact: true }).fill("Slow");
    await page
      .getByRole("button", { name: "Test native match", exact: true })
      .click();
    for (let i = 0; i < 100 && !slowSubmitted; i++)
      await page.waitForTimeout(20);
    assert.ok(slowSubmitted);
    await page.getByLabel("Accessible name", { exact: true }).fill("Missing");
    releaseSlow();
    await page.waitForTimeout(100);
    assert.equal(
      await page.getByText("1 native control matches", { exact: true }).count(),
      0,
      "A late response cannot validate edited fields",
    );
    await page
      .getByRole("button", { name: "Test native match", exact: true })
      .click();
    await page
      .getByText("No realized native controls match", { exact: true })
      .waitFor();
    await page
      .getByRole("button", { name: "Pick native control", exact: true })
      .click();
    await page.getByRole("dialog").waitFor();
    await page
      .getByRole("button", { name: "Inspect control in preview", exact: true })
      .click({ position: { x: 120, y: 50 } });
    await page
      .getByRole("dialog")
      .getByText("1 native control matches", { exact: true })
      .waitFor();
    assert.ok(queries.some((q) => q.point?.frameId === "preview-frame"));
    await mkdir(outputDir, { recursive: true });
    await page.screenshot({
      path: join(outputDir, "relay-native-picker.png"),
      fullPage: true,
    });
    await page
      .getByRole("button", {
        name: "Use inspected native locator",
        exact: true,
      })
      .click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    assert.equal(
      await page.getByLabel("Automation ID", { exact: true }).inputValue(),
      "apply",
    );
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByText("All changes saved", { exact: true }).waitFor();
    await page.reload();
    await page.locator('.react-flow__node[data-id="native-action"]').click();
    assert.equal(
      await page.getByLabel("Automation ID", { exact: true }).inputValue(),
      "apply",
    );
    await page.screenshot({
      path: join(outputDir, "relay-native-locator.png"),
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "Pick native control", exact: true })
      .click();
    await page.getByRole("dialog").waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    assert.equal(
      await page
        .getByRole("button", { name: "Pick native control", exact: true })
        .evaluate((el) => el === document.activeElement),
      true,
    );
    await page
      .getByLabel("Desktop targeting", { exact: true })
      .selectOption("none");
    await page.getByLabel("X position", { exact: true }).waitFor();
    assert.deepEqual(errors, []);
    console.log(
      "PASS: native semantic editor, read-only preview picking, ambiguous/missing states, stale async results, persistence, keyboard modal close and explicit coordinate mode (controlled API).",
    );
  } finally {
    if (releaseSlow) releaseSlow();
    await context.close();
  }
}
