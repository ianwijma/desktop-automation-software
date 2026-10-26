import { describe, expect, it } from "vitest";
import { nativeLocatorSchema } from "../src/shared/native-locators";
import { nodeDefinitions } from "../src/shared/node-definitions";
import { flowSchema } from "../src/shared/validation";
import { setNativeTargeting } from "../src/renderer/native-locator-field";
const locator = {
  version: 1,
  backend: "uia",
  selector: { automationId: "apply", controlType: "button" },
} as const;
describe("persisted semantic locators", () => {
  it("persists AX identifiers without converting Windows locators", () => {
    const ax = nativeLocatorSchema.parse({ ...locator, backend: "ax" });
    expect(ax.backend).toBe("ax");
    expect(nativeLocatorSchema.parse(locator).backend).toBe("uia");
    expect(
      setNativeTargeting({ targetId: "desktop" }, true, "ax").nativeLocator,
    ).toMatchObject({ backend: "ax" });
    expect(
      nativeLocatorSchema.safeParse({ ...ax, selector: { pid: 42 } }).success,
    ).toBe(false);
  });
  it("rejects transient identities rather than stripping them", () => {
    for (const key of ["runtimeId", "hwnd", "pointer", "pid", "x"]) {
      expect(
        nativeLocatorSchema.safeParse({
          ...locator,
          selector: { ...locator.selector, [key]: 42 },
        }).success,
      ).toBe(false);
      expect(
        nativeLocatorSchema.safeParse({ ...locator, [key]: 42 }).success,
      ).toBe(false);
    }
    expect(
      nativeLocatorSchema.safeParse({ ...locator, selector: {} }).success,
    ).toBe(false);
    expect(
      nativeLocatorSchema.safeParse({
        ...locator,
        ancestors: Array(9).fill({ name: "scope" }),
      }).success,
    ).toBe(false);
  });
  it("validates desktop read/invoke/value/selection and element detection without browser requirements", () => {
    const context = {
      targets: [
        { id: "desktop", name: "Editor", kind: "desktop" as const },
        { id: "web", name: "Web", kind: "browser" as const },
      ],
    };
    for (const kind of [
      "click",
      "type",
      "read",
      "select",
      "detect",
      "wait",
    ] as const) {
      const config = {
        targetId: "desktop",
        nativeLocator: locator,
        ...(["detect", "wait"].includes(kind) ? { detector: "element" } : {}),
      };
      expect(nodeDefinitions[kind].validateConfig(config, context)).toEqual([]);
      expect(nodeDefinitions[kind].requirements(config).target?.kinds).toEqual([
        "desktop",
      ]);
      expect(
        nodeDefinitions[kind]
          .validateConfig({ ...config, targetId: "web" }, context)
          .some((i) => i.message.includes("desktop target")),
      ).toBe(true);
    }
    expect(
      nodeDefinitions.click.validateConfig({
        nativeLocator: locator,
        button: "right",
      }),
    ).not.toEqual([]);
    expect(
      nodeDefinitions.select.validateConfig({
        nativeLocator: locator,
        value: "browser-option",
      }),
    ).not.toEqual([]);
  });
  it("persists semantic JSON through the workflow schema and explicitly switches modes", () => {
    const flow = flowSchema.parse({
      schemaVersion: 2,
      revision: 1,
      id: "semantic",
      name: "Semantic",
      description: "",
      folder: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      nodes: [
        {
          id: "invoke",
          kind: "click",
          label: "Apply",
          position: { x: 0, y: 0 },
          config: { targetId: "desktop", nativeLocator: locator },
        },
      ],
      edges: [],
      inputs: {},
      outputs: {},
    });
    expect(
      flowSchema.safeParse({
        ...flow,
        nodes: [
          {
            ...flow.nodes[0],
            config: {
              nativeLocator: { ...locator, selector: { pointer: 42 } },
            },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      JSON.parse(JSON.stringify(flow)).nodes[0].config.nativeLocator,
    ).toEqual(locator);
    const enabled = setNativeTargeting(
      {
        selector: "body",
        frameId: "stale",
        detection: "old",
        button: "right",
        extension: true,
      },
      true,
    );
    expect(enabled).not.toHaveProperty("selector");
    expect(enabled).not.toHaveProperty("frameId");
    expect(enabled).not.toHaveProperty("button");
    expect(enabled.extension).toBe(true);
    expect(setNativeTargeting(enabled, false)).not.toHaveProperty(
      "nativeLocator",
    );
  });
});
