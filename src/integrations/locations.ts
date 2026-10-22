import type { Json } from "../shared/types";

/** Convert a successful detector result into a guarded action at its box center. */
export function detectionCoordinates(
  config: Record<string, Json>,
): Record<string, Json> {
  if (config.detection === undefined || config.detection === "") return config;
  if (config.selector)
    throw new Error(
      "Choose one location source: a detected result or a browser selector.",
    );
  const result = config.detection;
  if (
    !result ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    result.outcome !== "match"
  )
    throw new Error(
      "A detected-location action requires a matching detector result.",
    );
  if (typeof result.frameId !== "string" || !result.frameId)
    throw new Error(
      "The detector result has no source capture. Use a browser selector for element detection.",
    );
  const box = result.box;
  if (!box || typeof box !== "object" || Array.isArray(box))
    throw new Error(
      "The detector found no location. Enable location detection or choose an image/text detector.",
    );
  const { x, y, width, height } = box;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof width !== "number" ||
    typeof height !== "number" ||
    ![x, y, width, height].every(Number.isFinite) ||
    x < 0 ||
    y < 0 ||
    width <= 0 ||
    height <= 0
  )
    throw new Error("The detector location is invalid.");
  return {
    ...config,
    x: x + width / 2,
    y: y + height / 2,
    frameId: result.frameId,
  };
}
