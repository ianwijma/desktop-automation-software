import assert from "node:assert/strict";
import sharp from "sharp";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
export async function runAuthoringAttachmentsSmoke(page) {
  const bodies = [];
  let hold = false,
    held = false,
    closed = false,
    release;
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    bodies.push(body);
    const send = () => {
      if (res.destroyed) return;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          model: "attachment-fixture",
          message: {
            content: JSON.stringify({
              kind: "clarification",
              explanation: "The image is available for this goal.",
              questions: ["Which export button should the flow wait for?"],
              graph: null,
            }),
          },
        }),
      );
    };
    if (hold) {
      hold = false;
      held = true;
      release = send;
      res.on("close", () => {
        closed = true;
      });
    } else send();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const sessionId = randomUUID(),
    other = randomUUID();
  const connection = {
    id: "attachment-smoke-model",
    name: "Attachment smoke",
    provider: "ollama",
    model: "fixture",
    baseUrl: "http://127.0.0.1:" + server.address().port,
    hasKey: false,
    capabilities: { text: true, structured: true, vision: true },
  };
  const request = (ids, patch = {}) => ({
    requestId: randomUUID(),
    sessionId,
    connectionId: connection.id,
    prompt: "Use only the images I selected for this turn.",
    targetIds: [],
    connectionIds: [],
    childFlowIds: [],
    attachmentIds: ids,
    ...patch,
  });
  const send = (r) =>
    page.evaluate((r) => window.relay.requestFlowProposal(r), r);
  const list = () =>
    page.evaluate((s) => window.relay.listAuthoringImages(s), sessionId);
  const before = await page.evaluate(async () => {
    const w = await window.relay.bootstrap();
    return {
      flows: w.flows,
      targets: w.targets,
      schedules: w.schedules,
      runs: w.runs,
    };
  });
  const bytes = await sharp({
    create: { width: 800, height: 450, channels: 3, background: "blue" },
  })
    .withMetadata({ orientation: 6 })
    .withExif({ IFD0: { ImageDescription: "private-exif-gps-like-fixture" } })
    .jpeg()
    .toBuffer();
  try {
    await page.evaluate((c) => window.relay.saveConnection(c), connection);
    const info = await page.evaluate(
      async ({ sessionId, bytes }) => {
        const binary = Uint8Array.from(atob(bytes), (c) => c.charCodeAt(0));
        return window.relay.importAuthoringImage({
          sessionId,
          name: "oriented.jpg",
          source: "paste",
          bytes: binary,
        });
      },
      { sessionId, bytes: bytes.toString("base64") },
    );
    assert.equal(info.width, 450);
    assert.equal(info.height, 800);
    assert.equal(info.state, "draft");
    assert.equal(bodies.length, 0);
    assert.equal(info.frameId, undefined);
    assert.equal(info.path, undefined);
    const preview = await page.evaluate(
      async ({ sessionId, id }) => {
        const p = await window.relay.previewAuthoringImage({
          sessionId,
          attachmentId: id,
        });
        // Exercise binary output across the context-isolated sandbox preload, too.
        return {
          isBinary: p.bytes instanceof Uint8Array,
          bytes: btoa(String.fromCharCode(...p.bytes)),
          mimeType: p.mimeType,
        };
      },
      { sessionId, id: info.id },
    );
    assert.equal(preview.isBinary, true);
    assert.equal(preview.mimeType, "image/png");
    const metadata = await sharp(
      Buffer.from(preview.bytes, "base64"),
    ).metadata();
    assert.equal(metadata.orientation, undefined);
    assert.equal(metadata.exif, undefined);
    assert.equal(metadata.icc, undefined);
    assert.equal(
      (await send(request([info.id], { prompt: "" }))).status,
      "clarification",
    );
    assert.equal(bodies.length, 0, "Image-only clarification can be local.");
    // Sent history requires explicit reuse, with a new app-owned attachment identity.
    assert.equal((await send(request([info.id]))).code, "attachment");
    const reused = await page.evaluate(
      (ref) => window.relay.reuseAuthoringImage(ref),
      { sessionId, attachmentId: info.id },
    );
    assert.notEqual(reused.id, info.id);
    const result = await send(request([reused.id]));
    assert.equal(result.status, "clarification");
    assert.equal(bodies.length, 1);
    const wireImages = bodies[0].messages[0].images;
    assert.equal(wireImages.length, 1);
    assert.deepEqual(
      await sharp(Buffer.from(wireImages[0], "base64"))
        .metadata()
        .then((m) => [m.width, m.height, m.exif]),
      [450, 800, undefined],
    );
    assert(
      !JSON.stringify(bodies[0]).includes("private-exif-gps-like-fixture"),
    );
    assert(!JSON.stringify(bodies[0]).includes(info.id));
    assert(!JSON.stringify(bodies[0]).includes("oriented.jpg"));
    await send(request([]));
    assert.equal(bodies.length, 2);
    assert.equal(
      bodies[1].messages[0].images,
      undefined,
      "History images cannot be inherited by a text turn.",
    );
    const wrongSession = await send(request([info.id], { sessionId: other }));
    assert.equal(wrongSession.code, "attachment");
    assert.equal(bodies.length, 2);
    await assert.rejects(
      page.evaluate(
        ({ sessionId, id }) =>
          window.relay.previewAuthoringImage({ sessionId, attachmentId: id }),
        { sessionId: other, id: info.id },
      ),
      /another session/,
    );
    const forText = await page.evaluate(
      (ref) => window.relay.reuseAuthoringImage(ref),
      { sessionId, attachmentId: info.id },
    );
    await page.evaluate(
      (c) =>
        window.relay.saveConnection({
          ...c,
          capabilities: { ...c.capabilities, vision: false },
        }),
      connection,
    );
    const textOnly = await send(request([forText.id]));
    assert.equal(textOnly.code, "configuration");
    assert.equal(bodies.length, 2);
    await page.evaluate((c) => window.relay.saveConnection(c), connection);
    const pendingImage = await page.evaluate(
      (ref) => window.relay.reuseAuthoringImage(ref),
      { sessionId, attachmentId: info.id },
    );
    hold = true;
    await page.evaluate(
      (r) => {
        window.__imagePending = window.relay.requestFlowProposal(r);
      },
      request([pendingImage.id]),
    );
    const deadline = Date.now() + 10000;
    while (!held) {
      if (Date.now() > deadline)
        throw new Error("Attachment HTTP did not start");
      await new Promise((r) => setTimeout(r, 20));
    }
    await page.evaluate((ref) => window.relay.deleteAuthoringImage(ref), {
      sessionId,
      attachmentId: pendingImage.id,
    });
    const discarded = await page.evaluate(() => window.__imagePending);
    assert.equal(discarded.code, "attachment");
    while (!closed) {
      if (Date.now() > deadline)
        throw new Error("Attachment deletion did not abort HTTP");
      await new Promise((r) => setTimeout(r, 20));
    }
    release();
    assert.equal(bodies.length, 3);
    assert((await list()).every((i) => i.state === "sent"));
    await assert.rejects(
      page.evaluate(
        (s) =>
          window.relay.importAuthoringImage({
            sessionId: s,
            name: "bad",
            source: "drop",
            bytes: new Uint8Array([1, 2, 3]),
          }),
        sessionId,
      ),
      /corrupt or unsupported/,
    );
    await assert.rejects(
      page.evaluate(
        (s) =>
          window.relay.importAuthoringImage({
            sessionId: s,
            name: "large",
            source: "file",
            bytes: new Uint8Array(8 * 1024 * 1024 + 1),
          }),
        sessionId,
      ),
      /8 MiB/,
    );
    await assert.rejects(
      page.evaluate(
        (s) =>
          window.relay.captureAuthoringImage({
            sessionId: s,
            targetId: "missing",
          }),
        sessionId,
      ),
      /could not be captured/,
    );
    // Full renderer -> sandbox preload -> main/disk -> production adapter journey.
    await page
      .getByRole("button", { name: "Flow assistant", exact: true })
      .click();
    await page
      .getByLabel("Authoring model", { exact: true })
      .selectOption(connection.id);
    await page
      .getByLabel("Choose authoring images", { exact: true })
      .setInputFiles({
        name: "renderer-oriented.jpg",
        mimeType: "image/jpeg",
        buffer: bytes,
      });
    await page
      .getByRole("button", {
        name: "Preview renderer-oriented.jpg",
        exact: true,
      })
      .click();
    await page
      .getByRole("dialog", { name: "Prepared image", exact: true })
      .waitFor();
    const preparedImage = page.getByRole("img", {
      name: "Prepared renderer-oriented.jpg",
      exact: true,
    });
    await preparedImage.waitFor();
    await page.waitForFunction(() => {
      const image = document.querySelector(".authoring-full-image img");
      return (
        image?.complete &&
        image.naturalWidth === 450 &&
        image.naturalHeight === 800
      );
    });
    await page.keyboard.press("Escape");
    assert.equal(
      bodies.length,
      3,
      "Actual composer import and preview remain local.",
    );
    await page
      .getByLabel("What would you like to automate?", { exact: true })
      .fill("Use the prepared image to propose an export workflow.");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page
      .getByText("Which export button should the flow wait for?", {
        exact: true,
      })
      .waitFor();
    assert.equal(bodies.length, 4);
    assert.equal(bodies[3].messages[0].images.length, 1);
    await page
      .getByText("Images from earlier turns (1)", { exact: true })
      .click();
    await page.getByRole("button", { name: "Reuse", exact: true }).click();
    await page.waitForFunction(
      () =>
        document.querySelectorAll(".authoring-composer .authoring-image")
          .length === 1,
    );
    assert.equal(bodies.length, 4, "Actual Reuse stays local.");
    await page
      .getByRole("button", { name: "Clear session", exact: true })
      .click();
    await page
      .getByText("Start with the task you repeat.", { exact: true })
      .waitFor();
    await page.getByRole("button", { name: "Workflows", exact: true }).click();
    await page.evaluate(
      (s) => window.relay.closeAuthoringSession(s),
      sessionId,
    );
    await assert.rejects(
      page.evaluate((s) => window.relay.listAuthoringImages(s), sessionId),
      /closed/,
    );
    const after = await page.evaluate(async () => {
      const w = await window.relay.bootstrap();
      return {
        flows: w.flows,
        targets: w.targets,
        schedules: w.schedules,
        runs: w.runs,
      };
    });
    assert.deepEqual(after, before);
    console.log(
      "PASS: real binary attachment IPC, stripped oriented previews, explicit image Send/reuse, no implicit history, text-only rejection, image-only clarification, wrong-session/deleted images, deletion aborts actual HTTP and no workspace mutation; actual composer file/preview/Send/reuse journey; private loopback only.",
    );
  } finally {
    await page
      .evaluate((id) => window.relay.deleteConnection(id), connection.id)
      .catch(() => {});
    await page
      .evaluate((s) => window.relay.closeAuthoringSession(s), sessionId)
      .catch(() => {});
    await page
      .evaluate((s) => window.relay.closeAuthoringSession(s), other)
      .catch(() => {});
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}
