import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const KEY = "relay.preview.v1";
const node = (id, kind, config = {}, index = 0) => ({
  id,
  kind,
  label: id,
  config,
  position: { x: (index % 3) * 250, y: Math.floor(index / 3) * 180 },
});
const flow = (id, name, nodes, inputs = {}) => ({
  id,
  name,
  nodes,
  inputs,
  outputs: {},
  schemaVersion: 2,
  revision: 1,
  description: "Structured authoring acceptance fixture",
  folder: "Inspector QA",
  createdAt: "2026-10-22T00:00:00.000Z",
  updatedAt: "2026-10-22T00:00:00.000Z",
  edges: nodes.slice(1).map((item, index) => ({
    id: `${id}-edge-${index}`,
    source: nodes[index].id,
    target: item.id,
    ...(nodes[index].kind === "condition" ? { port: "true" } : {}),
  })),
});
const child = flow(
  "inspector-child",
  "Structured child",
  [node("child-start", "start"), node("child-end", "end", {}, 1)],
  { value: 9, enabled: true, item: "child default", index: -1 },
);
const parent = flow("inspector-parent", "Structured authoring", [
  node("start", "start"),
  node("wait", "wait", { durationMs: 1000, "x-extension": "preserved" }, 1),
  node("condition", "condition", { left: "", operator: "eq", right: "" }, 2),
  node(
    "ai",
    "ai",
    { mode: "text", connectionId: "model", prompt: "Extract rows" },
    3,
  ),
  node(
    "loop",
    "loop",
    { flowId: child.id, count: 3, maxIterations: 10, inputs: {} },
    4,
  ),
  node(
    "group",
    "group",
    {
      mode: "sequence",
      children: [
        { flowId: child.id, inputs: {}, "x-child": "preserved" },
        { flowId: child.id, inputs: {} },
      ],
    },
    5,
  ),
  node("end", "end", {}, 6),
]);
parent.edges.push({
  id: "condition-false",
  source: "condition",
  target: "end",
  port: "false",
});

export async function runStructuredInspectorSmoke({
  browser,
  url,
  outputDir = "test-results",
}) {
  const context = await browser.newContext({
    viewport: { width: 1560, height: 1020 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(url);
    await page.getByRole("button", { name: "Run flow", exact: true }).waitFor();
    await page.evaluate(
      ({ key, state }) => localStorage.setItem(key, JSON.stringify(state)),
      {
        key: KEY,
        state: {
          flows: [parent, child],
          targets: [
            { id: "fixture-window", name: "Synthetic window", kind: "desktop" },
          ],
          connections: [
            {
              id: "model",
              name: "Synthetic model",
              provider: "ollama",
              baseUrl: "http://127.0.0.1:11434",
              model: "fixture",
              hasKey: false,
              capabilities: { text: true, vision: true, structured: true },
            },
          ],
          schedules: [],
          settings: { theme: "dark" },
        },
      },
    );
    await page.reload();
    await page.getByRole("button", { name: parent.name, exact: true }).click();

    // Input defaults are literal data. Even reference-shaped strings have no picker or warning.
    await addProperty("Flow inputs", "literal");
    await page
      .getByLabel("Flow inputs.literal", { exact: true })
      .fill("${nodes.missing}");
    assert.equal(
      await page
        .getByRole("button", {
          name: "Use value from for Flow inputs.literal",
          exact: true,
        })
        .count(),
      0,
    );
    assert.equal(await page.locator("[data-reference-warning]").count(), 0);
    await addProperty("Flow inputs", "threshold");
    await typeValue("Flow inputs.threshold", "number", "2.5");
    await addProperty("Flow inputs", "rows");
    await page
      .getByLabel("Value type for Flow inputs.rows", { exact: true })
      .selectOption("array");
    await page
      .getByRole("button", {
        name: "Add item to Flow inputs.rows",
        exact: true,
      })
      .click();
    await typeValue("Flow inputs.rows[0]", "number", "7");
    await save();
    assert.deepEqual((await saved()).inputs, {
      literal: "${nodes.missing}",
      threshold: 2.5,
      rows: [7],
    });

    await selectNode("wait");
    await page.getByLabel("Wait for", { exact: true }).selectOption("detector");
    await page
      .getByLabel("Application or browser", { exact: true })
      .selectOption("fixture-window");
    await page.getByLabel("Detector", { exact: true }).selectOption("text");
    await page.getByLabel("Text or question", { exact: true }).fill("Ready");
    await page.getByLabel("Timeout (ms)", { exact: true }).fill("5000");
    await page.getByLabel("Check every (ms)", { exact: true }).fill("100");
    await save();
    assert.equal((await config("wait")).durationMs, undefined);
    assert.equal((await config("wait")).prompt, "Ready");
    await page.getByLabel("Wait for", { exact: true }).selectOption("duration");
    await save();
    assert.equal((await config("wait")).detector, undefined);
    assert.equal((await config("wait")).prompt, undefined);
    assert.equal((await config("wait"))["x-extension"], "preserved");
    await page.getByLabel("Wait for", { exact: true }).selectOption("detector");
    await page
      .getByLabel("Application or browser", { exact: true })
      .selectOption("fixture-window");
    await page.getByLabel("Text or question", { exact: true }).fill("Ready");

    await selectNode("condition");
    await page.getByLabel("Operator", { exact: true }).selectOption("gt");
    await typeValue("Value", "number", "3");
    await chooseReference("Compare with", "${inputs.threshold}", "threshold");
    await save();
    assert.equal((await config("condition")).left, 3);
    assert.equal((await config("condition")).right, "${inputs.threshold}");
    await page.getByLabel("Operator", { exact: true }).selectOption("truthy");
    await save();
    assert.equal((await config("condition")).right, undefined);
    await page.getByLabel("Operator", { exact: true }).selectOption("gt");
    await chooseReference("Compare with", "${inputs.threshold}", "threshold");

    await selectNode("loop");
    await page.getByLabel("Loop mode", { exact: true }).selectOption("foreach");
    assert.equal(
      await page
        .getByRole("button", {
          name: "Override Child inputs.item",
          exact: true,
        })
        .isDisabled(),
      true,
    );
    assert.equal(
      await page
        .getByRole("button", {
          name: "Override Child inputs.index",
          exact: true,
        })
        .isDisabled(),
      true,
    );
    await chooseReference("Items (optional)", "${inputs.rows}", "rows");
    await page
      .getByRole("button", { name: "Override Child inputs.value", exact: true })
      .click();
    await chooseReference("Child inputs.value", "${item}", "item");
    await save();
    assert.deepEqual((await config("loop")).inputs, { value: "${item}" });
    assert.equal((await config("loop")).count, undefined);
    await page.getByLabel("Loop mode", { exact: true }).selectOption("count");
    await page.getByLabel("Iterations", { exact: true }).fill("2");
    await save();
    assert.equal((await config("loop")).items, undefined);
    assert.equal((await config("loop")).count, 2);
    await page.getByLabel("Loop mode", { exact: true }).selectOption("foreach");
    await chooseReference("Items (optional)", "${inputs.rows}", "rows");

    await selectNode("group");
    await page.locator("details.child-inputs > summary").nth(0).click();
    await page
      .getByRole("button", {
        name: "Override Inputs for child 1.value",
        exact: true,
      })
      .click();
    await page
      .getByLabel("Inputs for child 1.value", { exact: true })
      .fill("4");
    await page.locator("details.child-inputs > summary").nth(1).click();
    await page
      .getByRole("button", {
        name: "Override Inputs for child 2.value",
        exact: true,
      })
      .click();
    await page
      .getByLabel("Inputs for child 2.value", { exact: true })
      .fill("8");
    await save();
    assert.deepEqual((await config("group")).children, [
      { flowId: child.id, inputs: { value: 4 }, "x-child": "preserved" },
      { flowId: child.id, inputs: { value: 8 } },
    ]);
    await mkdir(outputDir, { recursive: true });
    await page
      .getByLabel("Inputs for child 1.value", { exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: join(outputDir, "relay-child-inputs.png"),
      animations: "disabled",
    });

    await selectNode("ai");
    await page.getByLabel("Mode", { exact: true }).selectOption("structured");
    const schemaLabel = "Output schema (optional)";
    await page
      .getByLabel(`${schemaLabel} description`, { exact: true })
      .fill("Extracted rows");
    await addProperty(schemaLabel, "rows");
    await page
      .getByLabel(`Required ${schemaLabel}.rows`, { exact: true })
      .check();
    await page
      .getByLabel(`Schema type for ${schemaLabel}.rows`, { exact: true })
      .selectOption("array");
    await page
      .getByLabel(`Schema type for ${schemaLabel}.rows[]`, { exact: true })
      .selectOption("object");
    await addProperty(`${schemaLabel}.rows[]`, "amount");
    await page
      .getByLabel(`Schema type for ${schemaLabel}.rows[].amount`, {
        exact: true,
      })
      .selectOption("number");
    await page
      .getByLabel(`Required ${schemaLabel}.rows[].amount`, { exact: true })
      .check();
    await page
      .getByLabel(`Limit ${schemaLabel}.rows[].amount to allowed values`, {
        exact: true,
      })
      .check();
    await page
      .getByLabel(`Allowed value 1 for ${schemaLabel}.rows[].amount`, {
        exact: true,
      })
      .fill("7.5");
    await save();
    const authoredSchema = (await config("ai")).schema;
    await page
      .getByLabel(`Schema type for ${schemaLabel}.rows[]`, { exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: join(outputDir, "relay-schema-builder.png"),
      animations: "disabled",
    });
    assert.deepEqual(authoredSchema, {
      type: "object",
      description: "Extracted rows",
      additionalProperties: false,
      required: ["rows"],
      properties: {
        rows: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["amount"],
            properties: { amount: { type: "number", enum: [7.5] } },
          },
        },
      },
    });

    // Advanced imported keywords survive ordinary field editing. The builder exposes
    // them only via JSON, preserving their shape instead of flattening them.
    const extendedSchema = {
      ...authoredSchema,
      "x-fixture": { retained: true },
      minProperties: 1,
      properties: {
        ...authoredSchema.properties,
        custom: { oneOf: [{ type: "string" }, { type: "null" }] },
        blocked: false,
      },
    };
    await page
      .getByRole("button", { name: `Edit ${schemaLabel} as JSON`, exact: true })
      .click();
    await page
      .getByLabel(`JSON for ${schemaLabel}`, { exact: true })
      .fill(JSON.stringify(extendedSchema));
    await save();
    await page
      .getByRole("button", { name: `Edit ${schemaLabel} fields`, exact: true })
      .click();
    await page
      .getByLabel(`${schemaLabel} description`, { exact: true })
      .fill("Structured extraction");
    await save();
    assert.deepEqual((await config("ai")).schema, {
      ...extendedSchema,
      description: "Structured extraction",
    });

    await selectNode("loop");
    await chooseReference("Items (optional)", "${nodes.ai.rows}", "rows");
    await chooseReference("Child inputs.value", "${item}", "item");
    await save();
    await page
      .locator(".react-flow__pane")
      .click({ position: { x: 20, y: 20 } });
    await page.getByLabel("Flow name", { exact: true }).waitFor();
    await addProperty("Flow outputs", "rows");
    await chooseReference("Flow outputs.rows", "${nodes.ai.rows}", "rows");
    await save();
    assert.deepEqual((await saved()).outputs, { rows: "${nodes.ai.rows}" });

    const original = await saved();
    const downloadPromise = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "Export flow", exact: true })
      .click();
    const download = await downloadPromise;
    const chunks = [];
    for await (const chunk of await download.createReadStream())
      chunks.push(chunk);
    const bundleBytes = Buffer.concat(chunks);
    const bundle = JSON.parse(bundleBytes.toString());
    assert.deepEqual(
      bundle.flows.find((f) => f.id === parent.id).nodes,
      original.nodes,
    );
    const chooserPromise = page.waitForEvent("filechooser");
    await page
      .getByRole("button", { name: "Import a workflow", exact: true })
      .click();
    const chooser = await chooserPromise;
    await chooser.setFiles({
      name: "structured.relay",
      mimeType: "application/json",
      buffer: bundleBytes,
    });
    await page.getByText("Flow imported.", { exact: true }).waitFor();
    const imported = await page.evaluate(
      ({ key, id }) =>
        JSON.parse(localStorage.getItem(key)).flows.find(
          (f) => f.name === "Structured authoring" && f.id !== id,
        ),
      { key: KEY, id: parent.id },
    );
    assert.deepEqual(imported.inputs, original.inputs);
    assert.deepEqual(imported.outputs, original.outputs);
    assert.deepEqual(
      imported.nodes.find((n) => n.id === "ai").config.schema,
      original.nodes.find((n) => n.id === "ai").config.schema,
    );
    assert.deepEqual(
      imported.nodes.find((n) => n.id === "loop").config.inputs,
      { value: "${item}" },
    );
    assert.notEqual(
      imported.nodes.find((n) => n.id === "loop").config.flowId,
      child.id,
    );
    assert.deepEqual(
      imported.nodes
        .find((n) => n.id === "group")
        .config.children.map((c) => c.inputs),
      [{ value: 4 }, { value: 8 }],
    );
    await page.reload();
    // The imported flow is selected after import; selecting its AI node checks reload rendering.
    await page
      .getByRole("button", { name: parent.name, exact: true })
      .last()
      .click();
    await selectNode("ai");
    assert.equal(
      await page
        .getByLabel(`${schemaLabel} description`, { exact: true })
        .inputValue(),
      "Structured extraction",
    );

    await page.getByLabel("Mode", { exact: true }).selectOption("vision");
    await page
      .getByLabel(`${schemaLabel} description`, { exact: true })
      .waitFor();
    await page.getByLabel("Mode", { exact: true }).selectOption("text");
    assert.equal(
      await page
        .getByLabel(`Schema type for ${schemaLabel}`, { exact: true })
        .count(),
      0,
    );
    await page.getByRole("button", { name: /^Undo/ }).click();
    await page
      .getByLabel(`${schemaLabel} description`, { exact: true })
      .waitFor();

    await mkdir(outputDir, { recursive: true });
    await page.screenshot({
      path: join(outputDir, "relay-structured-inspector.png"),
      animations: "disabled",
    });
    assert.deepEqual(errors, []);
    console.log(
      "PASS: structured waits/conditions/loops; literal flow defaults; independent child inputs; AI schema builder and property references; import/export; mode cleanup and undo; no page errors.",
    );
  } catch (error) {
    await mkdir(outputDir, { recursive: true });
    await page.screenshot({
      path: join(outputDir, "relay-structured-failure.png"),
      animations: "disabled",
    });
    throw error;
  } finally {
    await context.close();
  }
  async function selectNode(id) {
    await page.locator(`.react-flow__node[data-id="${id}"] .node-name`).click();
    await page.getByLabel("Node name", { exact: true }).waitFor();
  }
  async function save() {
    await page.locator(".inspector-title").click();
    const button = page.getByRole("button", { name: "Save", exact: true });
    if (await button.isEnabled()) await button.click();
    await page.getByText("All changes saved", { exact: true }).waitFor();
  }
  async function saved() {
    return page.evaluate(
      ({ key, id }) =>
        JSON.parse(localStorage.getItem(key)).flows.find((f) => f.id === id),
      { key: KEY, id: parent.id },
    );
  }
  async function config(id) {
    return (await saved()).nodes.find((item) => item.id === id).config;
  }
  async function addProperty(label, property) {
    await page
      .getByLabel(`New property for ${label}`, { exact: true })
      .fill(property);
    await page
      .getByRole("button", { name: `Add property to ${label}`, exact: true })
      .click();
  }
  async function typeValue(label, type, value) {
    await page
      .getByLabel(`Value type for ${label}`, { exact: true })
      .selectOption(type);
    await page.getByLabel(label, { exact: true }).fill(value);
  }
  async function chooseReference(label, reference, query) {
    await page
      .getByRole("button", { name: `Use value from for ${label}`, exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Use value from…",
      exact: true,
    });
    await dialog.getByLabel("Search values", { exact: true }).fill(query);
    await dialog.locator(`button[data-reference='${reference}']`).click();
    await dialog.waitFor({ state: "hidden" });
  }
}
