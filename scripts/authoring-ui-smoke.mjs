import assert from "node:assert/strict";
import sharp from "sharp";
import { join } from "node:path";
export async function runAuthoringUISmoke({
  browser,
  url,
  outputDir = "test-results",
}) {
  const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    }),
    page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.setDefaultTimeout(10000);
  await page.goto(url);
  // Browser preview stays honest and does not invoke image/native services.
  await page
    .getByRole("button", { name: "Flow assistant", exact: true })
    .click();
  assert.equal(
    await page
      .getByRole("button", { name: "Add images", exact: true })
      .isDisabled(),
    true,
  );
  await page
    .getByText("Open the desktop app to attach images", { exact: false })
    .waitFor();
  const state = await page.evaluate(async () =>
    (await import("/src/renderer/preview-api.ts")).previewAPI.bootstrap(),
  );
  state.desktop = true;
  state.connections = [
    {
      id: "vision",
      name: "Local vision",
      model: "vision-fixture",
      provider: "ollama",
      baseUrl: "http://localhost:11434",
      hasKey: false,
      capabilities: { text: true, structured: true, vision: true },
    },
    {
      id: "text",
      name: "Text only",
      model: "text-fixture",
      provider: "openai",
      baseUrl: "https://fixture.invalid",
      hasKey: false,
      capabilities: { text: true, structured: true, vision: false },
    },
  ];
  state.targets = [
    { id: "window", name: "Chosen editor window", kind: "desktop" },
  ];
  const prepared = await sharp({
    create: { width: 800, height: 450, channels: 3, background: "#33394d" },
  })
    .png()
    .toBuffer();
  await page.addInitScript(
    ({ state, prepared }) => {
      const bytes = Uint8Array.from(atob(prepared), (c) => c.charCodeAt(0));
      const images = new Map(),
        listeners = new Set();
      window.__hiddenGraphSaves = 0;
      window.__imageCalls = [];
      window.__imageSends = [];
      window.__imageCancels = [];
      window.__imageCloses = [];
      function add(sessionId, name, source) {
        const info = {
          id: crypto.randomUUID(),
          sessionId,
          name,
          source,
          state: "draft",
          width: 800,
          height: 450,
          byteLength: bytes.length,
          createdAt: Date.now(),
        };
        images.set(info.id, info);
        return structuredClone(info);
      }
      window.relay = {
        bootstrap: async () => structuredClone(state),
        saveFlow: async (flow) => {
          window.__hiddenGraphSaves++;
          return { status: "saved", flow };
        },
        onEvent: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        importAuthoringImage: async (upload) => {
          window.__imageCalls.push({
            source: upload.source,
            binary: upload.bytes instanceof Uint8Array,
            length: upload.bytes.byteLength,
          });
          if (upload.name === "corrupt.png")
            throw new Error("This image is corrupt or unsupported.");
          return add(upload.sessionId, upload.name, upload.source);
        },
        captureAuthoringImage: async ({ sessionId, targetId }) => {
          window.__imageCalls.push({ source: "capture", targetId });
          if (window.__captureUnavailable)
            throw new Error(
              "The chosen window could not be captured. Check capture permissions.",
            );
          return add(sessionId, "Window capture", "capture");
        },
        listAuthoringImages: async (sessionId) => {
          if (window.__holdImageList) {
            window.__holdImageList = false;
            await new Promise((resolve) => {
              window.__releaseImageList = resolve;
            });
          }
          return [...images.values()]
            .filter((i) => i.sessionId === sessionId)
            .map((i) => structuredClone(i));
        },
        previewAuthoringImage: async ({ attachmentId }) => ({
          attachment: structuredClone(images.get(attachmentId)),
          mimeType: "image/png",
          bytes,
        }),
        deleteAuthoringImage: async ({ attachmentId }) => {
          images.delete(attachmentId);
        },
        reuseAuthoringImage: async ({ sessionId, attachmentId }) =>
          add(sessionId, images.get(attachmentId).name, "reuse"),
        closeAuthoringSession: async (sessionId) => {
          window.__imageCloses.push(sessionId);
          for (const [id, image] of images)
            if (image.sessionId === sessionId) images.delete(id);
        },
        requestFlowProposal: async (request) => {
          window.__imageSends.push(structuredClone(request));
          for (const id of request.attachmentIds) images.get(id).state = "sent";
          listeners.forEach((listener) =>
            listener({
              type: "authoring-progress",
              progress: {
                sessionId: request.sessionId,
                requestId: request.requestId,
                phase: "generating",
              },
            }),
          );
          if (window.__holdImageSend) {
            window.__holdImageSend = false;
            return new Promise((resolve) => {
              window.__pendingImageSend = () =>
                resolve({
                  requestId: request.requestId,
                  sessionId: request.sessionId,
                  status: "cancelled",
                  message: "Proposal request cancelled. No workflow changed.",
                });
            });
          }
          return {
            requestId: request.requestId,
            sessionId: request.sessionId,
            status: "clarification",
            explanation: "Ready to help with this image.",
            questions: ["Which result should the workflow save?"],
          };
        },
        cancelFlowProposal: async (sessionId, requestId) => {
          window.__imageCancels.push({ sessionId, requestId });
          window.__pendingImageSend?.();
          return true;
        },
      };
    },
    { state, prepared: prepared.toString("base64") },
  );
  await page.reload();
  await page
    .getByRole("button", { name: "Flow assistant", exact: true })
    .click();
  await page
    .getByLabel("Authoring model", { exact: true })
    .selectOption("vision");
  const file = {
    name: "file.png",
    mimeType: "image/png",
    buffer: Buffer.from("file bytes are prepared by controlled fixture"),
  };
  await page
    .getByLabel("Choose authoring images", { exact: true })
    .setInputFiles(file);
  await page.getByRole("article", { name: "file.png", exact: true }).waitFor();
  await page.getByText("Static PNG, JPEG or WebP", { exact: false }).waitFor();
  await page
    .getByRole("button", { name: "Preview file.png", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Prepared image", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Actual pixels", exact: true })
    .click();
  await page.getByRole("button", { name: "Fit preview", exact: true }).click();
  await page.keyboard.press("Escape");
  await page.waitForFunction(
    () =>
      document.activeElement?.getAttribute("aria-label") === "Preview file.png",
  );
  // Navigation must preserve the same unsent local session and never capture/resend.
  await page.getByRole("button", { name: "Workflows", exact: true }).click();
  await page
    .getByRole("button", { name: "Flow assistant", exact: true })
    .click();
  await page.getByRole("article", { name: "file.png", exact: true }).waitFor();
  for (const type of ["paste", "drop"]) {
    await page.evaluate((type) => {
      const transfer = new DataTransfer();
      transfer.items.add(
        new File([new Uint8Array([1, 2, 3])], type + ".png", {
          type: "image/png",
        }),
      );
      const composer = document.querySelector(".authoring-composer");
      const event =
        type === "paste"
          ? new ClipboardEvent("paste", {
              clipboardData: transfer,
              bubbles: true,
              cancelable: true,
            })
          : new DragEvent("drop", {
              dataTransfer: transfer,
              bubbles: true,
              cancelable: true,
            });
      composer.dispatchEvent(event);
    }, type);
    await page
      .getByRole("article", { name: type + ".png", exact: true })
      .waitFor();
    await page
      .getByText("Static PNG, JPEG or WebP", { exact: false })
      .waitFor();
  }
  assert.equal(
    await page
      .getByRole("button", {
        name: "Capture selected window once",
        exact: true,
      })
      .isDisabled(),
    true,
  );
  await page
    .getByLabel("Application context", { exact: true })
    .selectOption("window");
  await page
    .getByRole("button", { name: "Capture selected window once", exact: true })
    .click();
  await page
    .getByRole("article", { name: "Window capture", exact: true })
    .waitFor();
  await page.getByText("Static PNG, JPEG or WebP", { exact: false }).waitFor();
  let calls = await page.evaluate(() => window.__imageCalls);
  assert.deepEqual(
    calls.map((c) => c.source),
    ["file", "paste", "drop", "capture"],
  );
  assert(calls.slice(0, 3).every((c) => c.binary));
  assert.equal((await page.evaluate(() => window.__imageSends)).length, 0);
  assert.equal(
    await page
      .getByRole("button", { name: "Add images", exact: true })
      .isDisabled(),
    true,
  );
  await page
    .getByLabel("Authoring model", { exact: true })
    .selectOption("text");
  await page
    .getByLabel("What would you like to automate?", { exact: true })
    .fill("Wait for the export and save it");
  assert.equal(
    await page.getByRole("button", { name: "Send", exact: true }).isDisabled(),
    true,
  );
  await page
    .getByText("This model does not support images.", { exact: false })
    .waitFor();
  await page
    .getByLabel("Authoring model", { exact: true })
    .selectOption("vision");
  await page.keyboard.press("Control+s");
  assert.equal(await page.evaluate(() => window.__hiddenGraphSaves), 0);
  await page.screenshot({
    path: join(outputDir, "relay-authoring-images-dark.png"),
  });
  await page.evaluate(() => {
    window.__holdImageList = true;
  });
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page
    .getByText("Which result should the workflow save?", { exact: true })
    .waitFor();
  await page.waitForFunction(
    () => typeof window.__releaseImageList === "function",
  );
  assert.equal(
    await page.getByRole("button", { name: "Send", exact: true }).count(),
    0,
  );
  await page.evaluate(() => window.__releaseImageList());
  await page
    .getByText("Images from earlier turns (4)", { exact: true })
    .click();
  assert.equal(
    (await page.evaluate(() => window.__imageSends))[0].attachmentIds.length,
    4,
  );
  assert.equal(
    await page.locator('[aria-label="Images for next Send"]').count(),
    0,
  );
  await page
    .getByLabel("What would you like to automate?", { exact: true })
    .fill("The export result");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page
    .getByLabel("What would you like to automate?", { exact: true })
    .fill("Reuse just the file image");
  const sent = await page.evaluate(() => window.__imageSends);
  assert.deepEqual(sent[1].attachmentIds, []);
  await page
    .getByRole("article", { name: "file.png", exact: true })
    .getByRole("button", { name: "Reuse", exact: true })
    .click();
  await page.getByText("Static PNG, JPEG or WebP", { exact: false }).waitFor();
  assert.equal(
    await page.locator(".authoring-composer .authoring-image").count(),
    1,
  );
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page
    .getByText("Images from earlier turns (5)", { exact: true })
    .waitFor();
  const next = (await page.evaluate(() => window.__imageSends))[2];
  assert.equal(next.attachmentIds.length, 1);
  assert(!sent[0].attachmentIds.includes(next.attachmentIds[0]));
  await page.evaluate(() => {
    window.__holdImageSend = true;
  });
  await page
    .getByLabel("What would you like to automate?", { exact: true })
    .fill("Cancellation fixture");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page
    .getByRole("button", { name: "Cancel request", exact: true })
    .click();
  await page
    .getByText("Proposal request cancelled. No workflow changed.", {
      exact: true,
    })
    .waitFor();
  assert.equal((await page.evaluate(() => window.__imageCancels)).length, 1);
  await page
    .getByRole("button", { name: "Clear session", exact: true })
    .click();
  await page
    .getByText("Start with the task you repeat.", { exact: true })
    .waitFor();
  assert.equal(await page.locator(".authoring-image").count(), 0);
  await page
    .getByLabel("Application context", { exact: true })
    .selectOption("window");
  await page.evaluate(() => {
    window.__captureUnavailable = true;
  });
  await page
    .getByRole("button", { name: "Capture selected window once", exact: true })
    .click();
  await page
    .getByText(
      "The chosen window could not be captured. Check capture permissions.",
      { exact: true },
    )
    .waitFor();
  await page
    .getByLabel("Choose authoring images", { exact: true })
    .setInputFiles({ ...file, name: "corrupt.png" });
  await page
    .getByText("This image is corrupt or unsupported.", { exact: true })
    .waitFor();
  // Partial import rejection still exposes the valid image for removal.
  await page
    .getByLabel("Choose authoring images", { exact: true })
    .setInputFiles([
      { ...file, name: "valid.png" },
      { ...file, name: "corrupt.png" },
    ]);
  await page.getByRole("article", { name: "valid.png", exact: true }).waitFor();
  await page
    .getByText("This image is corrupt or unsupported.", { exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Remove valid.png", exact: true })
    .click();
  await page.getByText("Static PNG, JPEG or WebP", { exact: false }).waitFor();
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "light";
  });
  await page.waitForFunction(
    () =>
      getComputedStyle(document.querySelector(".authoring-heading .button"))
        .backgroundColor === "rgb(238, 238, 245)",
  );
  await page.screenshot({
    path: join(outputDir, "relay-authoring-images-light.png"),
  });
  assert.equal((await page.evaluate(() => window.__imageSends)).length, 4);
  assert.equal(errors.length, 0, errors.join("\n"));
  await context.close();
  console.log(
    "PASS: authoring composer file/paste/drop/explicit capture, prepared previews, navigation retention, four-image limit, text-only vision gate, Send exclusion/reuse, cancellation, clear, partial import errors and desktop-only preview (controlled API).",
  );
}
