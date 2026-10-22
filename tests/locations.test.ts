import { expect, it } from "vitest";
import { detectionCoordinates } from "../src/integrations/locations";

it("targets the detected box center while retaining the source capture guard", () => {
  expect(
    detectionCoordinates({
      targetId: "app",
      button: "right",
      x: 0,
      y: 0,
      detection: {
        outcome: "match",
        frameId: "frame",
        box: { x: 30, y: 20, width: 40, height: 10 },
      },
    }),
  ).toMatchObject({
    targetId: "app",
    button: "right",
    x: 50,
    y: 25,
    frameId: "frame",
  });
});
it("refuses uncertain, absent, unlocated and invalid detector answers", () => {
  for (const outcome of ["uncertain", "no-match"])
    expect(() => detectionCoordinates({ detection: { outcome } })).toThrow(
      "matching",
    );
  expect(() =>
    detectionCoordinates({ detection: { outcome: "match" } }),
  ).toThrow("source capture");
  expect(() =>
    detectionCoordinates({ detection: { outcome: "match", frameId: "f" } }),
  ).toThrow("no location");
  expect(() =>
    detectionCoordinates({
      detection: {
        outcome: "match",
        frameId: "f",
        box: { x: 0, y: 0, width: 0, height: 10 },
      },
    }),
  ).toThrow("invalid");
});
it("leaves explicit coordinate and selector actions unchanged", () => {
  const config = { x: 20, y: 40, selector: "#save" };
  expect(detectionCoordinates(config)).toBe(config);
});
