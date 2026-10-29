import { afterEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { randomUUID, randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareAuthoringImage } from "../src/main/authoring-images";
import {
  AuthoringAttachments,
  captureChosenAuthoringWindow,
} from "../src/main/authoring-attachments";
import {
  attachmentLimits,
  attachmentUploadSchema,
} from "../src/shared/chat-attachments";
import { flowProposalRequestSchema } from "../src/shared/chat-authoring";

const directories: string[] = [];
async function store(now?: () => number) {
  const root = await mkdtemp(join(tmpdir(), "relay-attachment-test-"));
  directories.push(root);
  return {
    root,
    service: new AuthoringAttachments(join(root, "scratch"), now),
  };
}
const image = () =>
  sharp({ create: { width: 40, height: 20, channels: 3, background: "red" } })
    .png()
    .toBuffer();
const upload = (sessionId: string, bytes: Uint8Array, name = "image.png") => ({
  sessionId,
  name,
  source: "file" as const,
  bytes,
});
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
describe("bounded authoring image preparation", () => {
  it.each(["png", "jpeg", "webp"] as const)(
    "decodes actual static %s independent of extension and stores stripped upright PNG",
    async (format) => {
      const source = await sharp({
        create: { width: 40, height: 20, channels: 3, background: "red" },
      })
        .withMetadata({ orientation: 6 })
        .withExif({ IFD0: { ImageDescription: "private-photo-metadata" } })
        .toFormat(format)
        .toBuffer();
      const output = await prepareAuthoringImage(source);
      expect(output.width).toBe(20);
      expect(output.height).toBe(40);
      const metadata = await sharp(output.bytes).metadata();
      expect(metadata.format).toBe("png");
      expect(metadata.orientation).toBeUndefined();
      expect(metadata.exif).toBeUndefined();
      expect(metadata.icc).toBeUndefined();
      expect(metadata.xmp).toBeUndefined();
      expect(output.bytes.includes(Buffer.from("private-photo-metadata"))).toBe(
        false,
      );
    },
  );
  it("bounds dimensions and compressibility without enlarging small images", async () => {
    const large = await sharp({
      create: { width: 4100, height: 2100, channels: 3, background: "blue" },
    })
      .png()
      .toBuffer();
    const prepared = await prepareAuthoringImage(large);
    expect(prepared.width).toBe(2048);
    expect(prepared.height).toBeLessThan(2048);
    expect((await prepareAuthoringImage(await image())).width).toBe(40);
    const noise = await sharp(randomBytes(1024 * 1024 * 4), {
      raw: { width: 1024, height: 1024, channels: 4 },
    })
      .png()
      .toBuffer();
    const bounded = await prepareAuthoringImage(noise);
    expect(bounded.bytes.length).toBeLessThanOrEqual(
      attachmentLimits.preparedBytes,
    );
    expect(bounded.width).toBeLessThan(1024);
  }, 30000);
  it("rejects byte/decompression limits, corruption, nonrasters and truncated containers", async () => {
    await expect(
      prepareAuthoringImage(new Uint8Array(attachmentLimits.sourceBytes + 1)),
    ).rejects.toMatchObject({ code: "source-limit" });
    const big = await sharp({
      create: { width: 8000, height: 5001, channels: 3, background: "white" },
    })
      .png()
      .toBuffer();
    await expect(prepareAuthoringImage(big)).rejects.toMatchObject({
      code: "source-limit",
    });
    for (const invalid of [
      Buffer.from('<svg onload="private-token">'),
      Buffer.from("GIF89a"),
      Buffer.from("private-decoder-token"),
      (await image()).subarray(0, 60),
    ]) {
      await expect(prepareAuthoringImage(invalid)).rejects.toMatchObject({
        code: "invalid-image",
      });
      await expect(prepareAuthoringImage(invalid)).rejects.not.toThrow(
        "private",
      );
    }
    const webp = await sharp(await image())
      .webp()
      .toBuffer();
    await expect(
      prepareAuthoringImage(webp.subarray(0, webp.length - 1)),
    ).rejects.toMatchObject({ code: "invalid-image" });
  });
  it("rejects APNG control chunks and real animated WebP without selecting the first frame", async () => {
    const png = await image(),
      chunk = Buffer.alloc(20);
    chunk.writeUInt32BE(8, 0);
    chunk.write("acTL", 4);
    await expect(
      prepareAuthoringImage(
        Buffer.concat([png.subarray(0, 33), chunk, png.subarray(33)]),
      ),
    ).rejects.toMatchObject({ code: "animated-image" });
    const animation = await sharp(randomBytes(4 * 4 * 3), {
      raw: { width: 4, height: 4, channels: 3, pageHeight: 2 },
    })
      .webp({ delay: [100, 100], loop: 0 })
      .toBuffer();
    expect((await sharp(animation).metadata()).pages).toBe(2);
    await expect(prepareAuthoringImage(animation)).rejects.toMatchObject({
      code: "animated-image",
    });
  });
  it("accepts only bounded binary upload descriptors and unique selected IDs", async () => {
    const sessionId = randomUUID(),
      bytes = await image();
    expect(
      attachmentUploadSchema.safeParse(upload(sessionId, bytes)).success,
    ).toBe(true);
    for (const patch of [
      { bytes: bytes.toString("base64") },
      { bytes: [] },
      { path: "/private/file" },
      { frameId: randomUUID() },
      { source: "capture" },
      { bytes: new Uint8Array() },
    ])
      expect(
        attachmentUploadSchema.safeParse({
          ...upload(sessionId, bytes),
          ...patch,
        }).success,
      ).toBe(false);
    const id = randomUUID();
    const request = {
      sessionId,
      requestId: randomUUID(),
      connectionId: "model",
      prompt: "goal",
      targetIds: [],
      connectionIds: [],
      childFlowIds: [],
      attachmentIds: [id],
    };
    expect(flowProposalRequestSchema.safeParse(request).success).toBe(true);
    expect(
      flowProposalRequestSchema.safeParse({
        ...request,
        attachmentIds: [id, id],
      }).success,
    ).toBe(false);
    expect(
      flowProposalRequestSchema.safeParse({
        ...request,
        images: ["data:image/png;base64,..."],
      }).success,
    ).toBe(false);
  });
});
describe("session-owned local authoring attachments", () => {
  it("defers scratch cleanup until first use and never stores source metadata or exposes disk/runtime identities", async () => {
    const { root, service } = await store(),
      session = randomUUID();
    expect(await readdir(root)).toEqual([]);
    const source = await sharp(await image())
      .withMetadata()
      .withExif({ IFD0: { ImageDescription: "source-private" } })
      .jpeg()
      .toBuffer();
    const info = await service.import(
      upload(session, source, "../private\\image.jpeg"),
    );
    expect(info).toMatchObject({
      sessionId: session,
      state: "draft",
      source: "file",
      width: 40,
      height: 20,
    });
    expect(info.name).toBe("..privateimage.jpeg");
    expect(Object.keys(info).sort()).toEqual(
      [
        "byteLength",
        "createdAt",
        "height",
        "id",
        "name",
        "sessionId",
        "source",
        "state",
        "width",
      ].sort(),
    );
    const files = await readdir(join(root, "scratch"));
    expect(files).toEqual([info.id + ".png"]);
    const bytes = await readFile(join(root, "scratch", files[0]));
    expect(bytes.includes(Buffer.from("source-private"))).toBe(false);
    const preview = await service.preview({
      sessionId: session,
      attachmentId: info.id,
    });
    expect(Buffer.from(preview.bytes)).toEqual(bytes);
    expect(preview.mimeType).toBe("image/png");
    expect(JSON.stringify(info)).not.toContain(root);
  });
  it("copies imported binary input before async preparation", async () => {
    const { service } = await store(),
      bytes = new Uint8Array(await image()),
      session = randomUUID();
    const pending = service.import(upload(session, bytes));
    bytes.fill(0);
    expect((await pending).width).toBe(40);
  });
  it("bounds queued binary imports before asynchronous initialization", async () => {
    const { service } = await store(),
      session = randomUUID(),
      bytes = await image();
    const first = service.import(upload(session, bytes)),
      second = service.import(upload(session, bytes));
    await expect(service.import(upload(session, bytes))).rejects.toMatchObject({
      code: "busy",
    });
    await Promise.all([first, second]);
    expect(await service.list(session)).toHaveLength(2);
  });
  it("enforces four draft images and explicit reuse after Send; text-only turns contain no historical images", async () => {
    const { service } = await store(),
      session = randomUUID(),
      bytes = await image();
    const images = [];
    for (let i = 0; i < 4; i++)
      images.push(await service.import(upload(session, bytes)));
    await expect(service.import(upload(session, bytes))).rejects.toMatchObject({
      code: "capacity",
    });
    const lease = await service.lease(
      session,
      images.map((i) => i.id),
      () => {},
    );
    expect(lease.images).toHaveLength(4);
    expect(lease.images.every((i) => !("id" in i) && !("targetId" in i))).toBe(
      true,
    );
    expect((await service.list(session)).every((i) => i.state === "sent")).toBe(
      true,
    );
    await expect(
      service.lease(session, [images[0].id], () => {}),
    ).rejects.toMatchObject({ code: "missing" });
    const text = await service.lease(session, [], () => {});
    expect(text.images).toEqual([]);
    const reused = await service.reuse({
      sessionId: session,
      attachmentId: images[0].id,
    });
    expect(reused.id).not.toBe(images[0].id);
    expect(reused.state).toBe("draft");
    expect(reused.source).toBe("reuse");
    const next = await service.lease(session, [reused.id], () => {});
    expect(next.images).toEqual([lease.images[0]]);
    lease.release();
    text.release();
    next.release();
  });
  it("rejects wrong-session, missing, expired and deleted references without reading arbitrary paths", async () => {
    let time = 100;
    const { service } = await store(() => time),
      session = randomUUID(),
      other = randomUUID(),
      bytes = await image();
    const first = await service.import(upload(session, bytes));
    for (const action of [
      () => service.preview({ sessionId: other, attachmentId: first.id }),
      () => service.reuse({ sessionId: other, attachmentId: first.id }),
      () => service.lease(other, [first.id], () => {}),
      () => service.delete({ sessionId: other, attachmentId: first.id }),
    ])
      await expect(action()).rejects.toMatchObject({ code: "missing" });
    const second = await service.import(upload(session, bytes));
    await service.delete({ sessionId: session, attachmentId: second.id });
    await expect(
      service.preview({ sessionId: session, attachmentId: second.id }),
    ).rejects.toMatchObject({ code: "missing" });
    time += attachmentLimits.unsentAgeMs;
    expect(await service.list(session)).toEqual([]);
    await expect(
      service.lease(session, [first.id], () => {}),
    ).rejects.toMatchObject({ code: "missing" });
  });
  it("invalidates active generation on deletion or session close and protects other sessions", async () => {
    const { service } = await store(),
      session = randomUUID(),
      other = randomUUID(),
      bytes = await image();
    const a = await service.import(upload(session, bytes)),
      b = await service.import(upload(other, bytes));
    const cancel = vi.fn(),
      otherCancel = vi.fn();
    const lease = await service.lease(session, [a.id], cancel),
      otherLease = await service.lease(other, [b.id], otherCancel);
    await service.delete({ sessionId: session, attachmentId: a.id });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(lease.current()).toBe(false);
    expect(otherCancel).not.toHaveBeenCalled();
    expect(otherLease.current()).toBe(true);
    await service.close(other);
    expect(otherCancel).toHaveBeenCalledOnce();
    expect(otherLease.current()).toBe(false);
    await expect(service.import(upload(other, bytes))).rejects.toMatchObject({
      code: "closed-session",
    });
    lease.release();
    otherLease.release();
  });
  it("reserves pending import/capture capacity and discards a late capture for a closed session", async () => {
    const { root, service } = await store(),
      session = randomUUID(),
      bytes = await image();
    let release!: (b: Uint8Array) => void;
    const pending = service.capture(
      session,
      "Chosen window",
      () =>
        new Promise<Uint8Array>((r) => {
          release = r;
        }),
    );
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const other = service.capture(randomUUID(), "Other window", async () => {
      await new Promise((r) => setTimeout(r, 50));
      return bytes;
    });
    await vi.waitFor(() =>
      expect(service.import(upload(session, bytes))).rejects.toMatchObject({
        code: "busy",
      }),
    );
    await service.close(session);
    release(bytes);
    await expect(pending).rejects.toMatchObject({ code: "closed-session" });
    await other;
    expect((await readdir(join(root, "scratch"))).length).toBe(1);
  });
  it("detects changed prepared files and keeps storage errors curated", async () => {
    const { root, service } = await store(),
      session = randomUUID(),
      info = await service.import(upload(session, await image()));
    await writeFile(
      join(root, "scratch", info.id + ".png"),
      "private-file-content",
    );
    await expect(
      service.preview({ sessionId: session, attachmentId: info.id }),
    ).rejects.toMatchObject({ code: "storage" });
    await expect(
      service.lease(session, [info.id], () => {}),
    ).rejects.not.toThrow("private-file-content");
  });
  it("makes scratch state unavailable after disposal; a new instance starts clean", async () => {
    const { root, service } = await store(),
      session = randomUUID();
    const info = await service.import(upload(session, await image()));
    const cancel = vi.fn(),
      lease = await service.lease(session, [info.id], cancel);
    service.dispose();
    expect(cancel).toHaveBeenCalledOnce();
    expect(lease.current()).toBe(false);
    await expect(service.list(session)).rejects.toMatchObject({
      code: "closed-session",
    });
    const fresh = new AuthoringAttachments(join(root, "scratch"));
    expect(await fresh.list(randomUUID())).toEqual([]);
    expect(await readdir(join(root, "scratch"))).toEqual([]);
    fresh.dispose();
  });
  it("captures only an explicitly selected desktop target and rejects changed identity without input or retained frame IDs", async () => {
    const { service } = await store(),
      sessionId = randomUUID(),
      bytes = await image();
    let target: import("../src/shared/types").TargetDescriptor | undefined = {
      id: "chosen",
      name: "Chosen",
      kind: "desktop",
      application: "fixture",
    };
    const capture = vi.fn(async () => ({
      dataUrl: "data:image/png;base64," + bytes.toString("base64"),
      id: "not-a-runtime-frame",
    }));
    const options = { target: () => target, capture };
    const info = await captureChosenAuthoringWindow(
      service,
      { sessionId, targetId: "chosen" },
      options,
    );
    expect(info.source).toBe("capture");
    expect(info).not.toHaveProperty("frameId");
    expect(info).not.toHaveProperty("targetId");
    expect(capture).toHaveBeenCalledTimes(1);
    target = { id: "browser", name: "Browser", kind: "browser" };
    await expect(
      captureChosenAuthoringWindow(
        service,
        { sessionId, targetId: "browser" },
        options,
      ),
    ).rejects.toMatchObject({ code: "capture-unavailable" });
    expect(capture).toHaveBeenCalledTimes(1);
    target = { id: "chosen", name: "Chosen", kind: "desktop" };
    capture.mockImplementationOnce(async () => {
      target = { ...target!, windowTitle: "Changed during capture" };
      return {
        dataUrl: "data:image/png;base64," + bytes.toString("base64"),
        id: "ignored",
      };
    });
    await expect(
      captureChosenAuthoringWindow(
        service,
        { sessionId, targetId: "chosen" },
        options,
      ),
    ).rejects.toMatchObject({ code: "stale-capture" });
    expect(await service.list(sessionId)).toHaveLength(1);
    capture.mockRejectedValueOnce(new Error("private-helper-payload"));
    await expect(
      captureChosenAuthoringWindow(
        service,
        { sessionId, targetId: "chosen" },
        options,
      ),
    ).rejects.toMatchObject({ code: "capture-unavailable" });
  });
});
