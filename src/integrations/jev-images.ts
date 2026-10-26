import sharp from "sharp";
import { randomUUID } from "node:crypto";
import type { CaptureFrame, DetectionResult } from "../shared/types";

export interface PreparedJevImage {
  reference: string;
  asset: { type: "image"; format: "png"; data_base64: string };
  width: number;
  height: number;
  content: { x: number; y: number; width: number; height: number };
  source: { width: number; height: number };
}
export async function prepareJevImage(
  frame: CaptureFrame,
): Promise<PreparedJevImage> {
  if (
    !Number.isSafeInteger(frame.width) ||
    !Number.isSafeInteger(frame.height) ||
    frame.width < 1 ||
    frame.height < 1 ||
    frame.width * frame.height > 40_000_000
  )
    throw new Error(
      "Jev source image dimensions are invalid or exceed 40 megapixels.",
    );
  const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(
    frame.dataUrl,
  );
  if (!match || match[2]!.length > Math.ceil((32 * 1024 * 1024) / 3) * 4)
    throw new Error(
      "Jev requires a still PNG or JPEG, at most 32 MiB before preparation.",
    );
  const bytes = Buffer.from(match[2]!, "base64");
  if (bytes.toString("base64") !== match[2] || bytes.length > 32 * 1024 * 1024)
    throw new Error("Jev image base64 is invalid or exceeds 32 MiB.");
  if (match[1] === "png") {
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const length = bytes.readUInt32BE(offset);
      if (offset + 12 + length > bytes.length)
        throw new Error("Jev PNG is truncated.");
      if (bytes.toString("ascii", offset + 4, offset + 8) === "acTL")
        throw new Error("Animated PNGs are not supported by Jev.");
      offset += length + 12;
    }
  }
  const image = sharp(bytes, {
    limitInputPixels: 40_000_000,
    failOn: "error",
    animated: true,
  });
  const metadata = await image.metadata();
  if (
    metadata.format !== match[1] ||
    (metadata.pages ?? 1) !== 1 ||
    (metadata.orientation ?? 1) !== 1
  )
    throw new Error(
      "Jev captures must be upright, still PNG/JPEG images with matching format.",
    );
  if (metadata.width !== frame.width || metadata.height !== frame.height)
    throw new Error("Capture dimensions do not match the image pixels.");
  const scale = Math.min(1, 1568 / frame.width, 1568 / frame.height);
  const w = Math.max(1, Math.round(frame.width * scale)),
    h = Math.max(1, Math.round(frame.height * scale));
  const width = Math.max(280, w),
    height = Math.max(280, h);
  const x = Math.floor((width - w) / 2),
    y = Math.floor((height - h) / 2);
  const output = await image
    .resize(w, h, { fit: "fill" })
    .flatten({ background: "white" })
    .removeAlpha()
    .extend({
      left: x,
      right: width - w - x,
      top: y,
      bottom: height - h - y,
      background: "white",
    })
    .png()
    .toBuffer();
  if (output.length > 16 * 1024 * 1024)
    throw new Error("Prepared Jev image exceeds 16 MiB.");
  return {
    reference: randomUUID(),
    asset: {
      type: "image",
      format: "png",
      data_base64: output.toString("base64"),
    },
    width,
    height,
    content: { x, y, width: w, height: h },
    source: { width: frame.width, height: frame.height },
  };
}
export function restoreJevBox(
  prepared: PreparedJevImage,
  value: unknown,
): NonNullable<DetectionResult["box"]> {
  if (!value || typeof value !== "object")
    throw new Error("Jev returned an invalid target box.");
  const box = value as Record<string, unknown>,
    edges = [box.left, box.right, box.top, box.bottom];
  if (
    !edges.every(
      (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1,
    ) ||
    Number(box.left) >= Number(box.right) ||
    Number(box.top) >= Number(box.bottom)
  )
    throw new Error("Jev returned an invalid target box.");
  const c = prepared.content;
  const left = Number(box.left) * prepared.width - c.x,
    right = Number(box.right) * prepared.width - c.x;
  const top = Number(box.top) * prepared.height - c.y,
    bottom = Number(box.bottom) * prepared.height - c.y;
  const epsilon = 1e-6;
  if (
    left < -epsilon ||
    top < -epsilon ||
    right > c.width + epsilon ||
    bottom > c.height + epsilon
  )
    throw new Error(
      "Jev returned a target box in image padding or outside the source image.",
    );
  const sx = prepared.source.width / c.width,
    sy = prepared.source.height / c.height;
  const x = Math.max(0, left) * sx,
    y = Math.max(0, top) * sy;
  return {
    x,
    y,
    width: Math.min(prepared.source.width, right * sx) - x,
    height: Math.min(prepared.source.height, bottom * sy) - y,
  };
}
