import { describe, expect, it } from "vitest";
import { browserLocatorSchema } from "../src/shared/browser-locators";
import { nodeDefinitions } from "../src/shared/node-definitions";
import { setWaitMode, updateNodeConfig } from "../src/shared/node-authoring";
import type { BrowserLocator, Json, NodeKind } from "../src/shared/types";
const locator: BrowserLocator = {
  version: 1,
  selector: { kind: "role", role: "button", name: "Save" },
  path: [
    {
      kind: "frame",
      selector: {
        kind: "testId",
        attribute: "data-testid",
        value: "workspace",
      },
    },
    { kind: "shadow", selector: { kind: "id", value: "panel" } },
  ],
};
const context = {
  targets: [
    { id: "browser", name: "Browser", kind: "browser" as const },
    { id: "desktop", name: "Desktop", kind: "desktop" as const },
  ],
};
describe("browser locator contracts", () => {
  it("validates structured strategies and bounded paths, rejecting future or malformed descriptors", () => {
    expect(browserLocatorSchema.parse(locator)).toEqual(locator);
    for (const invalid of [
      { ...locator, version: 2 },
      { ...locator, selector: { kind: "xpath", value: "//*" } },
      {
        ...locator,
        selector: { kind: "testId", attribute: "onclick", value: "x" },
      },
      { ...locator, selector: { kind: "css", value: "" } },
      { ...locator, path: Array.from({ length: 13 }, () => locator.path![0]) },
    ])
      expect(browserLocatorSchema.safeParse(invalid).success).toBe(false);
  });
  it("uses browser requirements for structured input and accepts locators for selection and element detection", () => {
    for (const kind of ["click", "type", "read", "select", "detect"] as const) {
      const config = {
        targetId: "browser",
        locator,
        value: "x",
        text: "Hello",
        ...(kind === "detect" ? { detector: "element" } : {}),
      };
      expect(
        nodeDefinitions[kind]
          .validateConfig(config, context)
          .filter((issue) => issue.severity === "error"),
      ).toEqual([]);
      expect(nodeDefinitions[kind].requirements(config).target?.kinds).toEqual([
        "browser",
      ]);
    }
  });
  it("rejects conflicting targeting and invalid descriptors before adapter execution", () => {
    expect(
      nodeDefinitions.click
        .validateConfig(
          { targetId: "browser", locator, selector: "button" },
          context,
        )
        .some((issue) => issue.message.includes("one browser locator")),
    ).toBe(true);
    expect(
      nodeDefinitions.click
        .validateConfig(
          { targetId: "browser", locator, detection: { outcome: "match" } },
          context,
        )
        .some((issue) => issue.message.includes("one location source")),
    ).toBe(true);
    expect(
      nodeDefinitions.click
        .validateConfig(
          { targetId: "browser", locator: { version: 99 } },
          context,
        )
        .some((issue) => issue.message.includes("invalid")),
    ).toBe(true);
  });
  it("removes element locator fields on explicit detector/wait mode changes without changing unrelated configuration", () => {
    const config = {
      detector: "element",
      locator,
      timeoutMs: 4000,
      custom: { keep: true },
    };
    expect(setWaitMode(config, "duration").locator).toBeUndefined();
    const changed = updateNodeConfig("detect", config, "detector", "image");
    expect(changed.locator).toBeUndefined();
    expect(changed.custom).toEqual({ keep: true });
    expect(config.locator).toEqual(locator);
  });
  it("validates replay states and destination locators while retaining typed multi-select values", () => {
    const cases: [NodeKind, Record<string, Json>][] = [
      [
        "click",
        { locator, checked: true, modifiers: ["Shift"], clickCount: 2 },
      ],
      [
        "drag",
        {
          locator,
          toLocator: locator,
          fromOffset: { x: 0.5, y: 0.5 },
          toOffset: { x: 0.25, y: 0.75 },
        },
      ],
      ["scroll", { locator, scrollTop: 240, scrollLeft: 0 }],
      ["select", { locator, value: ["a", "b"] }],
    ];
    for (const [kind, config] of cases)
      expect(
        nodeDefinitions[kind]
          .validateConfig({ ...config, targetId: "browser" }, context)
          .filter((issue) => issue.severity === "error"),
      ).toEqual([]);
    const invalid: Record<string, Json>[] = [
      { checked: "yes" },
      { checked: true },
      { modifiers: ["Other"] },
      { toLocator: { version: 99 } },
      { fromOffset: { x: 2, y: 0 } },
    ];
    for (const config of invalid)
      expect(
        nodeDefinitions.click
          .validateConfig(config)
          .some((issue) => issue.severity === "error"),
      ).toBe(true);
    expect(
      nodeDefinitions.select
        .validateConfig({ value: [5] })
        .some((issue) => issue.severity === "error"),
    ).toBe(true);
  });
  it("blocks manual-configuration markers until explicitly acknowledged", () => {
    const config = {
      targetId: "browser",
      locator,
      text: "",
      requiresConfiguration: true,
      recordingWarning: "Configure omitted password",
    };
    expect(
      nodeDefinitions.type
        .validateConfig(config, context)
        .some((issue) => issue.message.includes("omitted password")),
    ).toBe(true);
    expect(
      nodeDefinitions.type
        .validateConfig(
          { ...config, text: "configured", requiresConfiguration: false },
          context,
        )
        .filter((issue) => issue.severity === "error"),
    ).toEqual([]);
  });
});
