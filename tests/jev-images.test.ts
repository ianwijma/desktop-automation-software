import { describe, it, expect, vi } from "vitest";
import sharp from "sharp";
import { prepareJevImage, restoreJevBox } from "../src/integrations/jev-images";
import { AIService } from "../src/integrations/ai";
import {
  cropFrame,
  restoreDetectionRegion,
} from "../src/integrations/detectors";
import { updateNodeConfig } from "../src/shared/node-authoring";
import { nodeDefinitions } from "../src/shared/node-definitions";
import type { AIConnection, CaptureFrame } from "../src/shared/types";
const connection: AIConnection = {
  id: "jev",
  name: "Jev",
  provider: "jev",
  baseUrl: "https://fixture.invalid",
  model: "pinned",
  hasKey: true,
  capabilities: { text: false, vision: true, structured: false },
  experimentalVision: true,
};
async function frame(width: number, height: number): Promise<CaptureFrame> {
  const png = await sharp({
    create: { width, height, channels: 3, background: "red" },
  })
    .png()
    .toBuffer();
  return {
    id: "source",
    targetId: "target",
    width,
    height,
    capturedAt: 1,
    dataUrl: `data:image/png;base64,${png.toString("base64")}`,
  };
}
const response = (noul: number, confidence: unknown, box: unknown) =>
  new Response(
    JSON.stringify({
      answers: { present: { noul }, location: { confidence, box } },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
function edges(
  p: Awaited<ReturnType<typeof prepareJevImage>>,
  b: { x: number; y: number; width: number; height: number },
) {
  return {
    left: (p.content.x + (b.x * p.content.width) / p.source.width) / p.width,
    right:
      (p.content.x + ((b.x + b.width) * p.content.width) / p.source.width) /
      p.width,
    top: (p.content.y + (b.y * p.content.height) / p.source.height) / p.height,
    bottom:
      (p.content.y + ((b.y + b.height) * p.content.height) / p.source.height) /
      p.height,
  };
}
describe("Jev image preparation and localization", () => {
  it("prepares a 4K source larger than the provider upload limit before sending", async () => {
    const bytes = await sharp({
      create: { width: 3840, height: 2160, channels: 3, background: "red" },
    })
      .png({ compressionLevel: 0 })
      .toBuffer();
    expect(bytes.length).toBeGreaterThan(16 * 1024 * 1024);
    const p = await prepareJevImage({
      id: "large",
      targetId: "target",
      capturedAt: 1,
      width: 3840,
      height: 2160,
      dataUrl: `data:image/png;base64,${bytes.toString("base64")}`,
    });
    expect(p.width).toBe(1568);
    expect(Buffer.from(p.asset.data_base64, "base64").length).toBeLessThan(
      16 * 1024 * 1024,
    );
  });
  it.each([
    [3840, 2160],
    [2160, 3840],
    [4, 3],
    [4000, 3],
    [3, 4000],
    [1568, 280],
    [280, 1568],
  ])(
    "fits %ix%i into provider limits with an invertible content mapping",
    async (w, h) => {
      const p = await prepareJevImage(await frame(w, h));
      expect(p.width).toBeGreaterThanOrEqual(280);
      expect(p.height).toBeGreaterThanOrEqual(280);
      expect(p.width).toBeLessThanOrEqual(1568);
      expect(p.height).toBeLessThanOrEqual(1568);
      const metadata = await sharp(
        Buffer.from(p.asset.data_base64, "base64"),
      ).metadata();
      expect(metadata.width).toBe(p.width);
      expect(metadata.height).toBe(p.height);
      const expected = {
          x: w * 0.25,
          y: h * 0.25,
          width: w * 0.5,
          height: h * 0.5,
        },
        actual = restoreJevBox(p, edges(p, expected));
      for (const key of ["x", "y", "width", "height"] as const)
        expect(actual[key]).toBeCloseTo(expected[key], 5);
      const whole = restoreJevBox(
        p,
        edges(p, { x: 0, y: 0, width: w, height: h }),
      );
      expect(whole.x).toBeCloseTo(0);
      expect(whole.y).toBeCloseTo(0);
      expect(whole.width).toBeCloseTo(w);
      expect(whole.height).toBeCloseTo(h);
    },
  );
  it("rejects malformed source formats, geometry, size, animation and padding coordinates", async () => {
    const source = await frame(8, 8),
      p = await prepareJevImage(source);
    await expect(prepareJevImage({ ...source, width: 9 })).rejects.toThrow(
      "dimensions",
    );
    await expect(
      prepareJevImage({ ...source, width: 10000, height: 10000 }),
    ).rejects.toThrow("40 megapixels");
    await expect(
      prepareJevImage({ ...source, dataUrl: "data:image/png;base64,%%%" }),
    ).rejects.toThrow("PNG or JPEG");
    await expect(
      prepareJevImage({
        ...source,
        dataUrl: source.dataUrl.replace("image/png", "image/jpeg"),
      }),
    ).rejects.toThrow("matching format");
    await expect(
      prepareJevImage({
        ...source,
        dataUrl: `data:image/png;base64,${"A".repeat(48_000_000)}`,
      }),
    ).rejects.toThrow("32 MiB");
    const bytes = Buffer.from(source.dataUrl.split(",")[1]!, "base64"),
      chunk = Buffer.alloc(20);
    chunk.writeUInt32BE(8);
    chunk.write("acTL", 4);
    const animated = Buffer.concat([
      bytes.subarray(0, 33),
      chunk,
      bytes.subarray(33),
    ]);
    await expect(
      prepareJevImage({
        ...source,
        dataUrl: `data:image/png;base64,${animated.toString("base64")}`,
      }),
    ).rejects.toThrow("Animated");
    expect(() =>
      restoreJevBox(p, { left: 0, right: 1, top: 0, bottom: 1 }),
    ).toThrow("padding");
    for (const box of [
      { left: 0, right: 2, top: 0, bottom: 1 },
      { left: 0.5, right: 0.4, top: 0, bottom: 1 },
      { left: NaN, right: 0.5, top: 0, bottom: 1 },
    ])
      expect(() => restoreJevBox(p, box)).toThrow("invalid target box");
  });
  it("keeps presence and location confidence separate and exposes no low-confidence coordinates", async () => {
    const source = await frame(400, 300),
      valid = { left: 0.1, right: 0.3, top: 0.2, bottom: 0.5 };
    const fetcher = vi.fn<typeof fetch>(async () => response(0.99, 0.2, valid)),
      service = new AIService(() => "fixture", fetcher);
    const uncertain = await service.detect(connection, {
      prompt: "Find red",
      frame: source,
      locate: true,
    });
    expect(uncertain).toMatchObject({
      outcome: "uncertain",
      presenceConfidence: 0.99,
      locationConfidence: 0.2,
    });
    expect(uncertain.box).toBeUndefined();
    fetcher.mockImplementationOnce(async () => response(0.99, 0.9, valid));
    const matched = await service.detect(connection, {
      prompt: "Find red",
      frame: source,
      locate: true,
      locationThreshold: 0.88,
    });
    expect(matched.outcome).toBe("match");
    expect(matched.box).toMatchObject({ x: 40, y: 60, width: 80, height: 90 });
    for (const confidence of [undefined, -1, 2, "high"]) {
      fetcher.mockImplementationOnce(async () =>
        response(0.99, confidence, valid),
      );
      await expect(
        service.detect(connection, {
          prompt: "Find",
          frame: source,
          locate: true,
        }),
      ).rejects.toThrow("localization confidence");
    }
    fetcher.mockImplementationOnce(async () =>
      response(0.01, undefined, { left: 9, right: 1 }),
    );
    const absent = await service.detect(connection, {
      prompt: "Find",
      frame: source,
      locate: true,
    });
    expect(absent.outcome).toBe("no-match");
    expect(absent.box).toBeUndefined();
  });
  it("uses fresh asset references and restores detector crop offsets without mutating the adapter result", async () => {
    const full = await frame(1000, 700),
      { frame: crop, region } = await cropFrame(full, {
        x: 100,
        y: 200,
        width: 300,
        height: 200,
      });
    const p = await prepareJevImage(crop),
      fetcher = vi.fn<typeof fetch>(async () =>
        response(0.99, 0.99, edges(p, { x: 30, y: 40, width: 60, height: 50 })),
      );
    const service = new AIService(() => "fixture", fetcher),
      request = { prompt: "Find relay-capture", frame: crop, locate: true };
    const result = await service.detect(connection, request),
      second = await service.detect(connection, request);
    expect(second.box).toEqual(result.box);
    const bodies = fetcher.mock.calls.map((c) =>
      JSON.parse(String(c[1]?.body)),
    );
    const refs = bodies.map((b) => Object.keys(b.assets)[0]);
    expect(refs[0]).not.toBe(refs[1]);
    expect(bodies[0].state.screenshot).toBe(refs[0]);
    expect(bodies[0].questions.present.instructions).toBe("Find relay-capture");
    const restored = restoreDetectionRegion(result, full, region);
    expect(restored.box).toMatchObject({
      x: 130,
      y: 240,
      width: 60,
      height: 50,
    });
    expect(result.box).toMatchObject({ x: 30, y: 40 });
    expect(restoreDetectionRegion(result, full, region)).toEqual(restored);
    expect(() =>
      restoreDetectionRegion({ ...result, frameId: "wrong" }, full, region),
    ).toThrow("valid match");
  });
  it("rejects bad input before HTTP and validates/normalizes the separate threshold", async () => {
    const fetcher = vi.fn<typeof fetch>(),
      service = new AIService(() => "fixture", fetcher);
    await expect(
      service.detect(connection, {
        prompt: "Find",
        frame: {
          ...(await frame(1, 1)),
          dataUrl: "data:image/png;base64,broken",
        },
        locate: true,
      }),
    ).rejects.toThrow();
    await expect(
      service.detect(connection, {
        prompt: "Find",
        frame: await frame(3, 3),
        locationThreshold: 0,
      }),
    ).rejects.toThrow("location confidence threshold");
    expect(fetcher).not.toHaveBeenCalled();
    expect(
      nodeDefinitions.detect.validateConfig({
        detector: "ai",
        locationThreshold: 0,
      }),
    ).not.toEqual([]);
    expect(
      updateNodeConfig(
        "detect",
        { detector: "ai", locationThreshold: 0.9 },
        "detector",
        "text",
      ),
    ).not.toHaveProperty("locationThreshold");
  });
});
