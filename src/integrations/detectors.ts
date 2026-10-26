import sharp from "sharp";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import type cvType from "@techstark/opencv-js";
import type { CaptureFrame, DetectionResult, Json } from "../shared/types";

const exec = promisify(execFile);
let cvPromise: Promise<typeof cvType> | undefined;
async function openCV(): Promise<typeof cvType> {
  return (cvPromise ??= (async () => {
    // The OpenCV CommonJS export is itself thenable. Dynamic import would
    // assimilate the module namespace with the wrong Promise receiver.
    const require = createRequire(
      typeof __filename === "string" ? __filename : import.meta.url,
    );
    const mod = require("@techstark/opencv-js") as
      typeof cvType | Promise<typeof cvType>;
    if (mod instanceof Promise) return await mod;
    if (mod.Mat) return mod;
    await new Promise<void>((resolve) => {
      mod.onRuntimeInitialized = () => resolve();
    });
    return mod;
  })());
}
function imageBytes(dataUrl: string): Buffer {
  if (!/^data:image\/(png|jpeg);base64,/.test(dataUrl))
    throw new Error("Choose a PNG or JPEG image.");
  const bytes = Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
  if (bytes.length > 20_000_000)
    throw new Error("Image is too large (20 MB maximum).");
  return bytes;
}
export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}
export function regionFor(
  frame: CaptureFrame,
  value: Json | undefined,
): Region {
  if (value == null)
    return { x: 0, y: 0, width: frame.width, height: frame.height };
  if (typeof value !== "object" || Array.isArray(value))
    throw new Error("A detector region needs x, y, width, and height.");
  const values = [value.x, value.y, value.width, value.height];
  if (!values.every((v) => typeof v === "number" && Number.isFinite(v)))
    throw new Error("Region coordinates must be finite numbers.");
  const region = {
    x: Math.round(Number(value.x)),
    y: Math.round(Number(value.y)),
    width: Math.round(Number(value.width)),
    height: Math.round(Number(value.height)),
  };
  if (
    region.x < 0 ||
    region.y < 0 ||
    region.width < 1 ||
    region.height < 1 ||
    region.x + region.width > frame.width ||
    region.y + region.height > frame.height
  )
    throw new Error(
      "The selected region is outside the current capture. Select it again.",
    );
  return region;
}
export async function cropFrame(
  frame: CaptureFrame,
  value: Json | undefined,
): Promise<{ frame: CaptureFrame; region: Region }> {
  const region = regionFor(frame, value);
  if (value == null) return { frame, region };
  const png = await sharp(imageBytes(frame.dataUrl))
    .extract({
      left: region.x,
      top: region.y,
      width: region.width,
      height: region.height,
    })
    .png()
    .toBuffer();
  return {
    region,
    frame: {
      ...frame,
      width: region.width,
      height: region.height,
      dataUrl: `data:image/png;base64,${png.toString("base64")}`,
    },
  };
}
/** Restore crop coordinates once without mutating the adapter result. */
export function restoreDetectionRegion(
  result: DetectionResult,
  frame: CaptureFrame,
  region: Region,
): DetectionResult {
  if (!result.box) return { ...result, frameId: frame.id };
  const b = result.box;
  if (
    result.outcome !== "match" ||
    result.frameId !== frame.id ||
    ![b.x, b.y, b.width, b.height].every(Number.isFinite) ||
    b.x < 0 ||
    b.y < 0 ||
    b.width <= 0 ||
    b.height <= 0 ||
    b.x + b.width > region.width + 1e-6 ||
    b.y + b.height > region.height + 1e-6
  )
    throw new Error(
      "AI localization is not a valid match within the captured region.",
    );
  return {
    ...result,
    frameId: frame.id,
    box: { ...b, x: b.x + region.x, y: b.y + region.y },
  };
}
export class DetectorService {
  private previous = new Map<string, Buffer>();
  async detect(
    frame: CaptureFrame,
    config: Record<string, Json>,
    signal?: AbortSignal,
  ): Promise<DetectionResult> {
    signal?.throwIfAborted();
    const { frame: cropped, region } = await cropFrame(frame, config.region);
    const image = imageBytes(cropped.dataUrl);
    const detector = String(config.detector ?? "text");
    const threshold = Number(
      config.threshold ?? (detector === "change" ? 0.05 : 0.9),
    );
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1)
      throw new Error("Threshold must be between 0 and 1.");
    if (detector === "text") {
      const dir = await mkdtemp(join(tmpdir(), "relay-ocr-"));
      try {
        const path = join(dir, "capture.png");
        await writeFile(path, image);
        const language = String(config.language ?? "eng");
        if (!/^[a-zA-Z0-9_+]+$/.test(language))
          throw new Error("Invalid OCR language.");
        const { stdout } = await exec(
          "tesseract",
          [path, "stdout", "-l", language, "--psm", "11"],
          { signal, timeout: 30_000, maxBuffer: 2_000_000, windowsHide: true },
        );
        const expected = String(config.text ?? config.prompt ?? "").trim();
        if (!expected) throw new Error("Enter the text to detect.");
        const text = stdout.trim();
        return {
          outcome: text.toLowerCase().includes(expected.toLowerCase())
            ? "match"
            : "no-match",
          value: text,
          evidence: text || "No text found.",
          frameId: frame.id,
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          throw new Error(
            "Install Tesseract OCR and add it to PATH to use text detection.",
          );
        throw error;
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
    if (detector === "color") {
      const hex = String(config.color ?? "#000000");
      if (!/^#[0-9a-f]{6}$/i.test(hex))
        throw new Error("Choose a color in #RRGGBB format.");
      const stats = await sharp(image).removeAlpha().stats();
      const expected = [1, 3, 5].map((offset) =>
        parseInt(hex.slice(offset, offset + 2), 16),
      );
      const distance =
        Math.sqrt(
          expected.reduce(
            (sum, value, index) =>
              sum + (value - stats.channels[index].mean) ** 2,
            0,
          ),
        ) / Math.sqrt(3 * 255 ** 2);
      const score = 1 - distance;
      return {
        outcome: score >= threshold ? "match" : "no-match",
        confidence: score,
        evidence: `Region color similarity ${Math.round(score * 100)}%`,
        frameId: frame.id,
      };
    }
    if (detector === "change") {
      const key = `${String(config.watchId ?? frame.targetId)}:${JSON.stringify(region)}`;
      const raw = await sharp(image)
        .resize(128, 128, { fit: "fill" })
        .removeAlpha()
        .raw()
        .toBuffer();
      const before = this.previous.get(key);
      this.previous.set(key, raw);
      if (this.previous.size > 200)
        this.previous.delete(this.previous.keys().next().value!);
      if (!before || before.length !== raw.length)
        return {
          outcome: "uncertain",
          evidence: "Baseline captured. Test again to compare.",
          frameId: frame.id,
        };
      let changed = 0;
      for (let i = 0; i < raw.length; i++)
        changed += Math.abs(raw[i] - before[i]);
      const fraction = changed / (raw.length * 255);
      return {
        outcome: fraction >= threshold ? "match" : "no-match",
        value: fraction,
        evidence: `${(fraction * 100).toFixed(1)}% average pixel change`,
        frameId: frame.id,
      };
    }
    if (detector !== "image")
      throw new Error(`Unknown local detector: ${detector}`);
    if (typeof config.template !== "string" || !config.template)
      throw new Error("Select a template image before testing this detector.");
    const templateBytes = imageBytes(config.template);
    const cv = await openCV();
    const source = await sharp(image)
      .removeAlpha()
      .toColourspace("srgb")
      .raw()
      .toBuffer({ resolveWithObject: true });
    const template = await sharp(templateBytes)
      .removeAlpha()
      .toColourspace("srgb")
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (
      template.info.width > source.info.width ||
      template.info.height > source.info.height
    )
      throw new Error("Template is larger than the selected region.");
    const src = cv.matFromArray(
      source.info.height,
      source.info.width,
      cv.CV_8UC3,
      source.data,
    );
    const needle = cv.matFromArray(
      template.info.height,
      template.info.width,
      cv.CV_8UC3,
      template.data,
    );
    const result = new cv.Mat();
    const mask = new cv.Mat();
    try {
      cv.matchTemplate(src, needle, result, cv.TM_SQDIFF_NORMED, mask);
      signal?.throwIfAborted();
      const best = cv.minMaxLoc(result, mask);
      const confidence = Math.max(0, 1 - best.minVal);
      let ambiguous = false;
      if (confidence >= threshold)
        for (let y = 0; y < result.rows && !ambiguous; y++)
          for (let x = 0; x < result.cols; x++) {
            if (
              Math.abs(x - best.minLoc.x) < template.info.width &&
              Math.abs(y - best.minLoc.y) < template.info.height
            )
              continue;
            if (
              result.data32F[y * result.cols + x] <=
              Math.min(1 - threshold, best.minVal + 0.02)
            ) {
              ambiguous = true;
              break;
            }
          }
      return {
        outcome: ambiguous
          ? "uncertain"
          : confidence >= threshold
            ? "match"
            : "no-match",
        confidence,
        frameId: frame.id,
        box:
          confidence >= threshold && !ambiguous
            ? {
                x: region.x + best.minLoc.x,
                y: region.y + best.minLoc.y,
                width: template.info.width,
                height: template.info.height,
              }
            : undefined,
        evidence: ambiguous
          ? "Multiple similar targets found. Narrow the search region."
          : `Template similarity ${Math.round(confidence * 100)}%`,
      };
    } finally {
      src.delete();
      needle.delete();
      result.delete();
      mask.delete();
    }
  }
}
