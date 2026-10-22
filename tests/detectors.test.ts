import { describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  DetectorService,
  cropFrame,
  regionFor,
} from "../src/integrations/detectors";
import type { CaptureFrame } from "../src/shared/types";

async function frameOf(buffer: Buffer, id = "frame"): Promise<CaptureFrame> {
  const metadata = await sharp(buffer).metadata();
  return {
    id,
    targetId: "target",
    width: metadata.width!,
    height: metadata.height!,
    capturedAt: 1,
    dataUrl: `data:image/png;base64,${buffer.toString("base64")}`,
  };
}
const solid = (color: string, width = 32, height = 24) =>
  sharp({ create: { width, height, channels: 3, background: color } })
    .png()
    .toBuffer();

describe("local detector regions and visual evidence", () => {
  it("crops within capture coordinates while retaining frame identity and rejects invalid regions", async () => {
    const frame = await frameOf(await solid("#ff0000"));
    expect(regionFor(frame, undefined)).toEqual({
      x: 0,
      y: 0,
      width: 32,
      height: 24,
    });
    const crop = await cropFrame(frame, { x: 4, y: 5, width: 10, height: 12 });
    expect(crop.frame).toMatchObject({
      id: frame.id,
      targetId: frame.targetId,
      width: 10,
      height: 12,
    });
    expect(
      (
        await sharp(
          Buffer.from(crop.frame.dataUrl.split(",")[1], "base64"),
        ).metadata()
      ).width,
    ).toBe(10);
    expect(() =>
      regionFor(frame, { x: 30, y: 5, width: 10, height: 10 }),
    ).toThrow("outside");
    expect(() =>
      regionFor(frame, { x: -1, y: 0, width: 10, height: 10 }),
    ).toThrow("outside");
    expect(() =>
      regionFor(frame, { x: 0, y: 0, width: 0, height: 10 }),
    ).toThrow("outside");
  });

  it("reports color matches, mismatches and image-change baseline explicitly", async () => {
    const detector = new DetectorService();
    const red = await frameOf(await solid("#ff0000"));
    const blue = await frameOf(await solid("#0000ff"), "blue");
    expect(
      await detector.detect(red, {
        detector: "color",
        color: "#ff0000",
        threshold: 0.99,
      }),
    ).toMatchObject({ outcome: "match", confidence: 1, frameId: "frame" });
    expect(
      (
        await detector.detect(red, {
          detector: "color",
          color: "#0000ff",
          threshold: 0.99,
        })
      ).outcome,
    ).toBe("no-match");
    expect(
      (
        await detector.detect(red, {
          detector: "change",
          watchId: "watch",
          threshold: 0.1,
        })
      ).outcome,
    ).toBe("uncertain");
    expect(
      (
        await detector.detect(red, {
          detector: "change",
          watchId: "watch",
          threshold: 0.1,
        })
      ).outcome,
    ).toBe("no-match");
    expect(
      (
        await detector.detect(blue, {
          detector: "change",
          watchId: "watch",
          threshold: 0.1,
        })
      ).outcome,
    ).toBe("match");
    expect(
      (
        await detector.detect(blue, {
          detector: "change",
          watchId: "another",
          threshold: 0.1,
        })
      ).outcome,
    ).toBe("uncertain");
  });

  it("rejects invalid thresholds, templates, and cancelled work", async () => {
    const detector = new DetectorService();
    const frame = await frameOf(await solid("#ffffff"));
    await expect(
      detector.detect(frame, { detector: "color", threshold: 1.1 }),
    ).rejects.toThrow("Threshold");
    await expect(
      detector.detect(frame, { detector: "color", color: "red" }),
    ).rejects.toThrow("#RRGGBB");
    await expect(
      detector.detect(frame, {
        detector: "image",
        template: "https://example.invalid/image.png",
      }),
    ).rejects.toThrow("PNG or JPEG");
    const controller = new AbortController();
    controller.abort(new Error("Stopped"));
    await expect(
      detector.detect(frame, { detector: "change" }, controller.signal),
    ).rejects.toThrow("Stopped");
  });

  it("compares grayscale captures using RGB color channels", async () => {
    const gray = await sharp(await solid("#808080"))
      .greyscale()
      .png()
      .toBuffer();
    const detector = new DetectorService();
    expect(
      (
        await detector.detect(await frameOf(gray), {
          detector: "color",
          color: "#808080",
          threshold: 0.99,
        })
      ).outcome,
    ).toBe("match");
  });

  it("uses actual OpenCV matching, returns crop-adjusted boxes and refuses ambiguous targets", async () => {
    const template = await sharp({
      create: { width: 8, height: 8, channels: 3, background: "#ef3e57" },
    })
      .composite([{ input: await solid("#12cfa8", 4, 4), left: 0, top: 0 }])
      .png()
      .toBuffer();
    const one = await sharp(await solid("#292d39", 60, 40))
      .composite([{ input: template, left: 20, top: 14 }])
      .png()
      .toBuffer();
    const two = await sharp(one)
      .composite([{ input: template, left: 42, top: 25 }])
      .png()
      .toBuffer();
    const detector = new DetectorService();
    const config = {
      detector: "image",
      template: `data:image/png;base64,${template.toString("base64")}`,
      threshold: 0.99,
    };
    const found = await detector.detect(await frameOf(one), {
      ...config,
      region: { x: 10, y: 8, width: 30, height: 25 },
    });
    expect(found.outcome).toBe("match");
    expect(found.box).toEqual({ x: 20, y: 14, width: 8, height: 8 });
    expect(found.confidence).toBeGreaterThan(0.99);
    const ambiguous = await detector.detect(await frameOf(two), config);
    expect(ambiguous.outcome).toBe("uncertain");
    expect(ambiguous.box).toBeUndefined();
    expect(
      (
        await detector.detect(
          await frameOf(await solid("#292d39", 60, 40)),
          config,
        )
      ).outcome,
    ).toBe("no-match");
  });
});
