import sharp from "sharp";
import { createHash } from "node:crypto";
import type { CaptureFrame, DetectionResult } from "../shared/types";
import type { VisualCase } from "./ai-conformance-config";
export async function conformanceImage(scenario: VisualCase) {
  const scale = scenario.endsWith("2x") ? 2 : 1;
  const bg = scenario.startsWith("dark") ? "#17181c" : "#ffffff";
  const button = (x: number, y: number) =>
    `<rect x="${x}" y="${y}" width="160" height="90" fill="#dc2626"/><circle cx="${x + 80}" cy="${y + 45}" r="15" fill="#22d3ee"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${480 * scale}" height="${320 * scale}" viewBox="0 0 480 320"><rect width="480" height="320" fill="${bg}"/>${scenario === "absent" ? "" : button(100, 90)}${scenario === "duplicate" ? button(300, 190) : ""}${scenario === "obscured" ? `<rect x="160" y="70" width="120" height="140" fill="${bg}"/>` : ""}</svg>`;
  const data = await sharp(Buffer.from(svg)).png().toBuffer();
  const frame: CaptureFrame = {
    id: `conformance-${scenario}`,
    targetId: "synthetic-conformance",
    capturedAt: Date.now(),
    width: 480 * scale,
    height: 320 * scale,
    dataUrl: `data:image/png;base64,${data.toString("base64")}`,
  };
  return {
    frame,
    sha256: createHash("sha256").update(data).digest("hex"),
    expected: ["absent", "duplicate", "obscured"].includes(scenario)
      ? ("no-usable-target" as const)
      : ("unique-target" as const),
    box: {
      x: 100 * scale,
      y: 90 * scale,
      width: 160 * scale,
      height: 90 * scale,
    },
  };
}
export function visualOutcomeValid(
  fixture: Awaited<ReturnType<typeof conformanceImage>>,
  result: DetectionResult,
) {
  if (fixture.expected === "no-usable-target")
    return ["no-match", "uncertain"].includes(result.outcome) && !result.box;
  const box = result.box,
    expected = fixture.box;
  if (
    result.outcome !== "match" ||
    !box ||
    !Object.values(box).every(Number.isFinite) ||
    box.width <= 0 ||
    box.height <= 0 ||
    box.x < 0 ||
    box.y < 0 ||
    box.x + box.width > fixture.frame.width ||
    box.y + box.height > fixture.frame.height
  )
    return false;
  const intersection =
    Math.max(
      0,
      Math.min(expected.x + expected.width, box.x + box.width) -
        Math.max(expected.x, box.x),
    ) *
    Math.max(
      0,
      Math.min(expected.y + expected.height, box.y + box.height) -
        Math.max(expected.y, box.y),
    );
  return (
    intersection /
      (expected.width * expected.height +
        box.width * box.height -
        intersection) >=
    0.5
  );
}
export const visualPrompt =
  "Is there exactly one fully visible red rectangular button with a cyan circular center in the image? If absent, duplicated, or partially obscured, do not report a usable match. Locate it only when exactly one complete button is visible.";
