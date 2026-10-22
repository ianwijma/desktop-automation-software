import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const KEY = "relay.preview.v1";
const node = (id, kind, label, config = {}, x = 0, y = 0) => ({
  id,
  kind,
  label,
  config,
  position: { x, y },
});
function flow(id, name, nodes, edges, inputs = {}) {
  return {
    schemaVersion: 2,
    id,
    name,
    description: "Isolated reference authoring fixture",
    folder: "Reference QA",
    revision: 1,
    nodes,
    edges:
      edges ??
      nodes.slice(1).map((item, index) => ({
        id: `${id}-e${index}`,
        source: nodes[index].id,
        target: item.id,
      })),
    inputs,
    outputs: {},
    createdAt: "2026-10-22T00:00:00.000Z",
    updatedAt: "2026-10-22T00:00:00.000Z",
  };
}
const visual = flow("reference-visual", "Reference picker fixture", [
  node("start", "start", "Start", {}, 0, 0),
  node(
    "detector-stable-id",
    "detect",
    "Find ready button",
    {
      targetId: "fixture-window",
      detector: "image",
      template:
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
    },
    250,
    0,
  ),
  node(
    "click-stable-id",
    "click",
    "Click detected button",
    { targetId: "fixture-window", x: 0, y: 0, button: "left" },
    500,
    0,
  ),
  node("end", "end", "Finish", {}, 500, 200),
]);
const typed = flow(
  "reference-typed",
  "Typed values fixture",
  [
    node("start", "start", "Start", {}, 0, 0),
    node(
      "typed-value",
      "set",
      "Assign typed value",
      { variable: "selected", value: "initial" },
      250,
      0,
    ),
    node("end", "end", "Finish", {}, 500, 0),
  ],
  undefined,
  {
    numberValue: 42.5,
    objectValue: { count: 7, enabled: true, nothing: null },
    arrayValue: [0, false, null],
    flagValue: false,
    emptyValue: null,
  },
);
const conditional = flow(
  "reference-conditional",
  "Conditional reference fixture",
  [
    node("start", "start", "Start", {}, 0, 0),
    node(
      "branch",
      "condition",
      "Choose a path",
      { left: "${inputs.ready}", operator: "truthy" },
      250,
      0,
    ),
    node(
      "branch-source",
      "set",
      "Only on true branch",
      { variable: "branchValue", value: 100 },
      0,
      180,
    ),
    node("fallback", "wait", "Other path", { durationMs: 1 }, 250, 180),
    node(
      "branch-consumer",
      "set",
      "Read conditional value",
      { variable: "chosen", value: "" },
      500,
      180,
    ),
    node("end", "end", "Finish", {}, 500, 360),
  ],
  [
    { id: "c1", source: "start", target: "branch" },
    { id: "c2", source: "branch", target: "branch-source", port: "true" },
    { id: "c3", source: "branch", target: "fallback", port: "false" },
    { id: "c4", source: "branch-source", target: "branch-consumer" },
    { id: "c5", source: "fallback", target: "branch-consumer" },
    { id: "c6", source: "branch-consumer", target: "end" },
  ],
  { ready: true },
);
const child = flow("reference-child", "Reference child fixture", [
  node("start", "start", "Start", {}, 0, 0),
  node("end", "end", "Finish", {}, 250, 0),
]);
const looping = flow(
  "reference-loop",
  "Loop reference fixture",
  [
    node("start", "start", "Start", {}, 0, 0),
    node(
      "loop-value",
      "loop",
      "Map loop values",
      {
        flowId: child.id,
        items: "${inputs.items}",
        count: 3,
        maxIterations: 5,
        inputs: {},
      },
      250,
      0,
    ),
    node("end", "end", "Finish", {}, 500, 0),
  ],
  undefined,
  { items: [{ label: "one" }, { label: "two" }] },
);

export async function runReferencePickerSmoke({
  browser,
  url,
  outputDir = "test-results",
}) {
  const context = await browser.newContext({
    viewport: { width: 1560, height: 1020 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const fixture = {
    flows: [visual, typed, conditional, looping, child],
    targets: [
      { id: "fixture-window", name: "Synthetic window", kind: "desktop" },
    ],
    connections: [],
    schedules: [],
    settings: { theme: "dark" },
  };
  try {
    await page.goto(url);
    await page.getByRole("button", { name: "Run flow", exact: true }).waitFor();
    await page.evaluate(
      ({ key, state }) => localStorage.setItem(key, JSON.stringify(state)),
      { key: KEY, state: fixture },
    );
    await page.reload();
    await selectFlow(visual.name);
    await selectNode("click-stable-id");
    const beforeNodes = await page
      .locator(".react-flow__node")
      .evaluateAll((nodes) =>
        nodes.map((item) => item.getAttribute("data-id")).sort(),
      );
    await openPicker("Detected result (optional)");
    const search = page.getByRole("textbox", {
      name: "Search values",
      exact: true,
    });
    await search.fill("Delete this search only");
    await search.press("Control+a");
    await search.press("Backspace");
    await search.press("Delete");
    await search.press("Control+c");
    await search.press("Control+v");
    await search.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    assert.deepEqual(
      await page
        .locator(".react-flow__node")
        .evaluateAll((nodes) =>
          nodes.map((item) => item.getAttribute("data-id")).sort(),
        ),
      beforeNodes,
      "Picker keys must not delete or duplicate graph nodes",
    );
    await save();
    assert.deepEqual(
      (await savedFlow(visual.id)).nodes,
      visual.nodes,
      "Cancelling the picker must not edit node configuration",
    );

    await openPicker("Detected result (optional)");
    await search.fill("Find ready button");
    await mkdir(outputDir, { recursive: true });
    await page.screenshot({
      path: join(outputDir, "relay-reference-picker.png"),
      animations: "disabled",
    });
    await search.press("ArrowDown");
    assert.equal(
      await page.locator("button:focus").getAttribute("data-reference"),
      "${nodes.detector-stable-id}",
      "Keyboard navigation should choose the complete detector result",
    );
    await page.keyboard.press("Enter");
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    assert.equal(
      await page
        .getByLabel("Detected result (optional)", { exact: true })
        .inputValue(),
      "${nodes.detector-stable-id}",
    );
    await save();
    assert.equal(
      (await savedFlow(visual.id)).nodes.find(
        (item) => item.id === "click-stable-id",
      ).config.detection,
      "${nodes.detector-stable-id}",
    );

    await selectNode("detector-stable-id");
    await page
      .getByLabel("Node name", { exact: true })
      .fill("Renamed ready detector");
    await page
      .getByRole("button", { name: "Copy node reference", exact: true })
      .click();
    assert.equal(
      await page.evaluate(() => navigator.clipboard.readText()),
      "${nodes.detector-stable-id}",
    );
    await save();
    await page.reload();
    await selectFlow(visual.name);
    await selectNode("click-stable-id");
    assert.equal(
      await page
        .getByLabel("Detected result (optional)", { exact: true })
        .inputValue(),
      "${nodes.detector-stable-id}",
    );
    await page
      .locator(".inspector")
      .getByText(/Renamed ready detector/)
      .first()
      .waitFor();
    await openPicker("Detected result (optional)");
    await search.fill("Renamed ready detector");
    const renamedOption = referenceOption("${nodes.detector-stable-id}");
    assert.match(
      await renamedOption.getAttribute("aria-label"),
      /Renamed ready detector/,
    );
    await search.press("Escape");
    await selectNode("detector-stable-id");
    await page
      .getByRole("button", { name: "Delete node", exact: true })
      .click();
    await selectNode("click-stable-id");
    await page
      .locator("[data-reference-warning]")
      .filter({ hasText: /no longer exists/ })
      .waitFor();
    await page.getByRole("button", { name: "Validate", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByText(/Reference points to a missing node/)
      .waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await save();
    await page.reload();
    await selectFlow(visual.name);
    await selectNode("click-stable-id");
    await page
      .locator("[data-reference-warning]")
      .filter({ hasText: /no longer exists/ })
      .waitFor();

    await selectFlow(typed.name);
    await selectNode("typed-value");
    for (const [type, value] of [
      ["string", "literal text"],
      ["number", -2.5],
      ["boolean", false],
      ["null", null],
    ]) {
      await page
        .getByLabel("Value type for Value", { exact: true })
        .selectOption(type);
      if (type === "boolean")
        await page.getByLabel("Value", { exact: true }).setChecked(value);
      else if (type === "number") {
        await page.getByLabel("Value", { exact: true }).fill("");
        await page
          .getByLabel("Value", { exact: true })
          .pressSequentially("-2.5");
      } else if (type !== "null")
        await page.getByLabel("Value", { exact: true }).fill(String(value));
      await assertValueRoundtrip(value, type);
    }
    await chooseReference("Value", "${inputs.numberValue}", "numberValue");
    await page
      .getByRole("button", { name: "Use literal for Value", exact: true })
      .click();
    assert.equal(
      await page
        .getByLabel("Value type for Value", { exact: true })
        .inputValue(),
      "null",
      "Switching back from a reference must retain a null literal",
    );
    await assertValueRoundtrip(null, "null");
    await page
      .getByLabel("Value type for Value", { exact: true })
      .selectOption("object");
    await addProperty("Value", "count");
    await page
      .getByLabel("Value type for Value.count", { exact: true })
      .selectOption("number");
    await page.getByLabel("Value.count", { exact: true }).fill("7");
    await addProperty("Value", "enabled");
    await page
      .getByLabel("Value type for Value.enabled", { exact: true })
      .selectOption("boolean");
    await page.getByLabel("Value.enabled", { exact: true }).check();
    await addProperty("Value", "nothing");
    await page
      .getByLabel("Value type for Value.nothing", { exact: true })
      .selectOption("null");
    await page.screenshot({ path: join(outputDir, "relay-typed-object.png") });
    await assertValueRoundtrip(
      { count: 7, enabled: true, nothing: null },
      "object",
    );
    await page
      .getByLabel("Value type for Value", { exact: true })
      .selectOption("array");
    for (let index = 0; index < 3; index++)
      await page
        .getByRole("button", { name: "Add item to Value", exact: true })
        .click();
    await page
      .getByLabel("Value type for Value[0]", { exact: true })
      .selectOption("number");
    await page.getByLabel("Value[0]", { exact: true }).fill("0");
    await page
      .getByLabel("Value type for Value[1]", { exact: true })
      .selectOption("boolean");
    await page.getByLabel("Value[1]", { exact: true }).uncheck();
    await page
      .getByLabel("Value type for Value[2]", { exact: true })
      .selectOption("null");
    await assertValueRoundtrip([0, false, null], "array");
    for (const key of [
      "numberValue",
      "objectValue",
      "arrayValue",
      "flagValue",
      "emptyValue",
    ]) {
      await chooseReference("Value", `\${inputs.${key}}`, key);
      await save();
      assert.equal(
        (await savedFlow(typed.id)).nodes.find(
          (item) => item.id === "typed-value",
        ).config.value,
        `\${inputs.${key}}`,
      );
      await page.reload();
      await selectFlow(typed.name);
      await selectNode("typed-value");
      assert.equal(
        await page.getByLabel("Value", { exact: true }).inputValue(),
        `\${inputs.${key}}`,
      );
    }
    await openPicker("Value");
    assert.equal(await referenceOption("${item}").count(), 0);
    assert.equal(await referenceOption("${index}").count(), 0);
    await search.press("Escape");

    await selectFlow(conditional.name);
    await selectNode("branch-consumer");
    await chooseReference(
      "Value",
      "${nodes.branch-source}",
      "Only on true branch",
    );
    await page
      .locator("[data-reference-warning]")
      .filter({ hasText: /may not run on every path/ })
      .waitFor();
    await save();
    assert.equal(
      (await savedFlow(conditional.id)).nodes.find(
        (item) => item.id === "branch-consumer",
      ).config.value,
      "${nodes.branch-source}",
    );

    await selectFlow(looping.name);
    await selectNode("loop-value");
    await addProperty("Child inputs", "chosen");
    await openPicker("Child inputs.chosen");
    assert.equal(await referenceOption("${item}").count(), 1);
    assert.equal(await referenceOption("${index}").count(), 1);
    await referenceOption("${item}").focus();
    await page.keyboard.press("Enter");
    await addProperty("Child inputs", "position");
    await chooseReference("Child inputs.position", "${index}", "index");
    await openPicker("Items (optional)");
    assert.equal(await referenceOption("${item}").count(), 0);
    assert.equal(await referenceOption("${index}").count(), 0);
    await search.press("Escape");
    await save();
    assert.deepEqual(
      (await savedFlow(looping.id)).nodes.find(
        (item) => item.id === "loop-value",
      ).config.inputs,
      { chosen: "${item}", position: "${index}" },
    );
    assert.equal(errors.length, 0, errors.join("\n"));
    console.log(
      "PASS: keyboard reference picker/cancel isolation; stable references across rename/reload; deleted and conditional references; typed literal/reference roundtrips; loop item/index scope.",
    );
  } catch (error) {
    await mkdir(outputDir, { recursive: true });
    await page.screenshot({
      path: join(outputDir, "relay-reference-failure.png"),
    });
    throw error;
  } finally {
    await context.close();
  }

  async function selectFlow(name) {
    await page.getByRole("button", { name, exact: true }).click();
    await page.getByRole("button", { name: "Run flow", exact: true }).waitFor();
  }
  async function selectNode(id) {
    await page.locator(`.react-flow__node[data-id="${id}"] .node-name`).click();
    await page.getByLabel("Node name", { exact: true }).waitFor();
  }
  async function save() {
    await page.getByText("Node properties", { exact: true }).click();
    const button = page.getByRole("button", { name: "Save", exact: true });
    if (await button.isEnabled()) await button.click();
    await page.getByText("All changes saved", { exact: true }).waitFor();
  }
  async function savedFlow(id) {
    return page.evaluate(
      ({ key, id }) =>
        JSON.parse(localStorage.getItem(key)).flows.find(
          (item) => item.id === id,
        ),
      { key: KEY, id },
    );
  }
  async function openPicker(label) {
    await page
      .getByRole("button", { name: `Use value from for ${label}`, exact: true })
      .focus();
    await page.keyboard.press("Enter");
    await page
      .getByRole("dialog", { name: "Use value from…", exact: true })
      .waitFor();
  }
  function referenceOption(reference) {
    return page
      .getByRole("dialog")
      .locator(`button[data-reference='${reference}']`);
  }
  async function chooseReference(label, reference, query) {
    await openPicker(label);
    await page
      .getByRole("textbox", { name: "Search values", exact: true })
      .fill(query);
    await referenceOption(reference).focus();
    await page.keyboard.press("Enter");
    await page.getByRole("dialog").waitFor({ state: "hidden" });
  }
  async function addProperty(label, property) {
    await page
      .getByLabel(`New property for ${label}`, { exact: true })
      .fill(property);
    await page
      .getByRole("button", { name: `Add property to ${label}`, exact: true })
      .click();
  }
  async function assertValueRoundtrip(value, type) {
    await save();
    assert.deepEqual(
      (await savedFlow(typed.id)).nodes.find(
        (item) => item.id === "typed-value",
      ).config.value,
      value,
    );
    await page.reload();
    await selectFlow(typed.name);
    await selectNode("typed-value");
    assert.equal(
      await page
        .getByLabel("Value type for Value", { exact: true })
        .inputValue(),
      type,
    );
    await save();
    assert.deepEqual(
      (await savedFlow(typed.id)).nodes.find(
        (item) => item.id === "typed-value",
      ).config.value,
      value,
      "Reload and save must preserve the authored JSON type",
    );
  }
}
