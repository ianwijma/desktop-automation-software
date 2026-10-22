import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import {
  addSchemaProperty,
  canEditSchemaProperties,
  changeSchemaType,
  removeSchemaProperty,
  renameSchemaProperty,
  schemaEditorType,
  setSchemaDescription,
  setSchemaEnum,
  setSchemaItems,
  setSchemaRequired,
  updateSchemaProperty,
  type SchemaObject,
  type SchemaPrimitive,
} from "../src/shared/schema-authoring";

describe("schema authoring preserves imported schemas", () => {
  it.each([
    { type: ["string", "null"], enum: ["ready", null] },
    { $ref: "#/$defs/result", $defs: { result: { type: "number" } } },
    { type: "object", anyOf: [{ required: ["one"] }, { required: ["two"] }] },
    { allOf: [{ type: "integer" }, { minimum: 2 }] },
    { if: { const: 1 }, then: { title: "One" }, else: { title: "Other" } },
  ] as SchemaObject[])(
    "preserves custom schema %j when editing its description",
    (imported) => {
      const original = structuredClone(imported);
      expect(schemaEditorType(imported)).toBeUndefined();
      expect(setSchemaDescription(imported, "Expected result")).toEqual({
        ...imported,
        description: "Expected result",
      });
      expect(imported).toEqual(original);
    },
  );

  it.each([true, false, '{"type":"object","x-legacy":true}'])(
    "leaves non-object schema %j in advanced mode until an explicit type change",
    (value) => {
      expect(schemaEditorType(value)).toBeUndefined();
      expect(() => setSchemaDescription(value, "Description")).toThrow(/JSON/);
      expect(changeSchemaType(value, "boolean")).toEqual({ type: "boolean" });
    },
  );

  it("keeps extensions, definitions, custom constraints and nested references through property edits", () => {
    const source: SchemaObject = {
      type: "object",
      title: "Provider result",
      properties: {
        before: { $ref: "#/$defs/item", "x-child": 5 },
        untouched: false,
      },
      required: ["before", "external"],
      additionalProperties: { type: "string" },
      patternProperties: { "^x-": true },
      dependencies: { untouched: ["external"] },
      $defs: { item: { type: "integer", minimum: 1 } },
      "x-provider": { preserve: true },
    };
    const original = structuredClone(source);
    let changed = addSchemaProperty(source, "temporary");
    changed = updateSchemaProperty(changed, "temporary", {
      type: "boolean",
      description: "New flag",
    });
    expect(changed).toEqual({
      ...source,
      properties: {
        ...(source.properties as SchemaObject),
        temporary: { type: "boolean", description: "New flag" },
      },
    });
    expect(source).toEqual(original);
    expect(setSchemaDescription(changed, "")).toEqual(changed);
  });

  it("updates required names on rename and removal without requiring unrelated properties", () => {
    let schema = addSchemaProperty(
      changeSchemaType(undefined, "object"),
      "count",
      { type: "integer" },
    );
    schema = addSchemaProperty(schema, "note");
    schema = setSchemaRequired(schema, "count", true);
    schema = setSchemaRequired(schema, "count", true);
    expect(schema.required).toEqual(["count"]);
    schema = renameSchemaProperty(schema, "count", "total");
    expect(schema.required).toEqual(["total"]);
    expect(Object.keys(schema.properties as object)).toEqual(["total", "note"]);
    schema = removeSchemaProperty(schema, "total");
    expect(schema.required).toEqual([]);
    expect(schema.properties).toEqual({ note: { type: "string" } });
    expect(() => setSchemaRequired(schema, "missing", true)).toThrow(
      /no longer exists/,
    );
    expect(() => renameSchemaProperty(schema, "missing", "other")).toThrow(
      /no longer exists/,
    );
  });

  it("rejects duplicate or unsafe property names without modifying the source", () => {
    const original = {
      type: "object",
      properties: { first: true, second: false },
      required: ["first"],
    };
    for (const name of ["__proto__", "prototype", "constructor", "", "  "]) {
      expect(() => addSchemaProperty(original, name)).toThrow();
      expect(() => renameSchemaProperty(original, "first", name)).toThrow();
      expect(() => updateSchemaProperty(original, name, true)).toThrow();
    }
    expect(() => addSchemaProperty(original, "first")).toThrow(
      /already exists/,
    );
    expect(() => renameSchemaProperty(original, "first", "second")).toThrow(
      /already exists/,
    );
    expect(original).toEqual({
      type: "object",
      properties: { first: true, second: false },
      required: ["first"],
    });
    const imported = JSON.parse(
      '{"type":"object","properties":{"__proto__":{"type":"string"},"safe":true},"required":["__proto__"]}',
    ) as SchemaObject;
    expect(removeSchemaProperty(imported, "__proto__")).toEqual({
      type: "object",
      properties: { safe: true },
      required: [],
    });
    expect(
      renameSchemaProperty(imported, "__proto__", "renamed").required,
    ).toEqual(["renamed"]);
    expect(({} as Record<string, unknown>).type).toBeUndefined();
  });

  it("routes malformed imported property maps and required lists to JSON instead of overwriting them", () => {
    const imports: SchemaObject[] = [
      { type: "object", properties: [true] },
      { type: "object", properties: {}, required: "name" },
    ];
    for (const schema of imports) {
      expect(canEditSchemaProperties(schema)).toBe(false);
      expect(setSchemaDescription(schema, "Preserve")).toEqual({
        ...schema,
        description: "Preserve",
      });
    }
    expect(() => addSchemaProperty({ properties: [true] }, "name")).toThrow(
      /JSON/,
    );
    expect(() =>
      setSchemaRequired(
        { properties: { name: true }, required: "name" },
        "name",
        false,
      ),
    ).toThrow(/JSON/);
  });

  it("refuses destructive property renames and removals when imported dependencies need coordinated changes", () => {
    const schema: SchemaObject = {
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" } },
      dependencies: { a: ["b"] },
      additionalProperties: false,
    };
    const before = structuredClone(schema);
    const ajv = new Ajv({ strict: false });
    expect(ajv.compile(schema)({ a: "x", b: "y" })).toBe(true);
    expect(ajv.compile(schema)({ a: "x" })).toBe(false);
    expect(() => renameSchemaProperty(schema, "b", "c")).toThrow(
      /dependencies.*JSON/,
    );
    expect(() => removeSchemaProperty(schema, "b")).toThrow(
      /dependencies.*JSON/,
    );
    expect(schema).toEqual(before);
    expect(ajv.compile(schema)({ a: "x", b: "y" })).toBe(true);
    for (const keyword of [
      "dependentRequired",
      "dependentSchemas",
      "patternProperties",
      "propertyNames",
      "anyOf",
    ]) {
      const imported: SchemaObject = {
        type: "object",
        properties: { b: true },
        [keyword]: {},
      };
      expect(() => renameSchemaProperty(imported, "b", "c")).toThrow(/JSON/);
      expect(() => removeSchemaProperty(imported, "b")).toThrow(/JSON/);
    }
  });

  it("protects local property references, including escaped names and references outside a nested editor", () => {
    const schema: SchemaObject = {
      type: "object",
      properties: { a: { type: "string" }, b: { $ref: "#/properties/a" } },
    };
    const before = structuredClone(schema);
    expect(
      new Ajv({ strict: false }).compile(schema)({ a: "one", b: "two" }),
    ).toBe(true);
    expect(() => renameSchemaProperty(schema, "a", "c")).toThrow(
      /local schema reference.*JSON/,
    );
    expect(() => removeSchemaProperty(schema, "a")).toThrow(
      /local schema reference.*JSON/,
    );
    expect(schema).toEqual(before);
    const escaped: SchemaObject = {
      type: "object",
      properties: { "a/b~": true, use: { $ref: "#/properties/a~1b~0" } },
    };
    expect(() => removeSchemaProperty(escaped, "a/b~")).toThrow(
      /local schema reference/,
    );
    const child: SchemaObject = {
      type: "object",
      properties: { nested: { type: "string" } },
    };
    const document: SchemaObject = {
      type: "object",
      properties: {
        child,
        use: { $ref: "#/properties/child/properties/nested" },
      },
    };
    expect(() =>
      renameSchemaProperty(child, "nested", "renamed", document),
    ).toThrow(/local schema reference/);
    expect(removeSchemaProperty(child, "nested")).toEqual({
      type: "object",
      properties: {},
    });
  });
});

describe("explicit schema type changes", () => {
  it("removes incompatible active constraints while retaining annotations, extensions and compatible numeric constraints", () => {
    const imported: SchemaObject = {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
      dependentRequired: { name: ["other"] },
      items: { type: "string" },
      prefixItems: [true],
      contains: false,
      minContains: 1,
      minLength: 4,
      pattern: "x",
      contentSchema: { type: "object" },
      minimum: -3,
      maximum: 10,
      multipleOf: 1,
      $ref: "#/$defs/old",
      allOf: [{ type: "object" }],
      anyOf: [true],
      if: true,
      then: true,
      else: false,
      enum: [1, 2.5, "3", null],
      const: "old",
      default: "old",
      examples: [1, "old"],
      $id: "urn:example:preserved",
      $defs: { old: { type: "object" } },
      title: "Count",
      description: "How many",
      "x-provider": { active: true },
    };
    const original = structuredClone(imported);
    expect(changeSchemaType(imported, "integer")).toEqual({
      type: "integer",
      minimum: -3,
      maximum: 10,
      multipleOf: 1,
      enum: [1],
      examples: [1],
      $id: "urn:example:preserved",
      $defs: { old: { type: "object" } },
      title: "Count",
      description: "How many",
      "x-provider": { active: true },
    });
    expect(imported).toEqual(original);
  });

  it("retains applicable constraints when moving between number and integer and drops incompatible enum constraints", () => {
    expect(
      changeSchemaType(
        { type: "number", minimum: 0, enum: [0.5], const: 1, default: 2 },
        "integer",
      ),
    ).toEqual({ type: "integer", minimum: 0, const: 1, default: 2 });
    expect(
      changeSchemaType(
        { type: "integer", minimum: 1, multipleOf: 2, enum: [2, 4] },
        "number",
      ),
    ).toEqual({ type: "number", minimum: 1, multipleOf: 2, enum: [2, 4] });
    expect(changeSchemaType(undefined, "object")).toEqual({
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    });
    expect(changeSchemaType(undefined, "array")).toEqual({
      type: "array",
      items: { type: "string" },
    });
  });
});

describe("typed enums and nested output schemas", () => {
  it("keeps number, text, boolean and null enum values distinct through JSON persistence", () => {
    const result = setSchemaEnum(
      { description: "Mixed union enum", "x-keep": true },
      [1, "1", false, null],
    );
    expect(JSON.parse(JSON.stringify(result))).toEqual({
      description: "Mixed union enum",
      "x-keep": true,
      enum: [1, "1", false, null],
    });
    expect(setSchemaEnum(result, [])).toEqual({
      description: "Mixed union enum",
      "x-keep": true,
    });
    expect(setSchemaEnum(result, undefined)).toEqual({
      description: "Mixed union enum",
      "x-keep": true,
    });
    expect(() => setSchemaEnum(result, ["same", "same"])).toThrow(/different/);
    for (const entries of [
      [Number.NaN],
      [Infinity],
      [{}],
    ] as unknown as SchemaPrimitive[][])
      expect(() => setSchemaEnum(result, entries)).toThrow(/finite numbers/);
  });

  it("builds a nested object/array schema that validates typed results and rejects wrong types, missing required fields and extra properties", () => {
    let item = changeSchemaType(undefined, "object");
    item = addSchemaProperty(
      item,
      "score",
      setSchemaEnum(changeSchemaType(undefined, "number"), [-2.5, 1]),
    );
    item = addSchemaProperty(
      item,
      "accepted",
      setSchemaEnum(changeSchemaType(undefined, "boolean"), [false]),
    );
    item = addSchemaProperty(
      item,
      "empty",
      setSchemaEnum(changeSchemaType(undefined, "null"), [null]),
    );
    for (const name of ["score", "accepted", "empty"])
      item = setSchemaRequired(item, name, true);
    let schema = changeSchemaType(undefined, "object");
    schema = addSchemaProperty(
      schema,
      "items",
      setSchemaItems(changeSchemaType(undefined, "array"), item),
    );
    schema = setSchemaRequired(schema, "items", true);
    schema = addSchemaProperty(
      schema,
      "state",
      setSchemaEnum(changeSchemaType(undefined, "string"), [
        "ready",
        "waiting",
      ]),
    );
    schema = updateSchemaProperty(
      schema,
      "state",
      setSchemaDescription(
        (schema.properties as SchemaObject).state,
        "Current state",
      ),
    );
    const saved = JSON.parse(JSON.stringify(schema));
    const validate = new Ajv({ strict: false }).compile(saved);
    expect(
      validate({
        items: [{ score: -2.5, accepted: false, empty: null }],
        state: "ready",
      }),
    ).toBe(true);
    for (const result of [
      { items: [{ score: "-2.5", accepted: false, empty: null }] },
      { items: [{ score: -2.5, accepted: "false", empty: null }] },
      { items: [{ score: -2.5, accepted: false, empty: "null" }] },
      { items: [{ score: -2.5, accepted: false }] },
      { items: [], state: "unexpected" },
      { items: [], extra: true },
      { state: "ready" },
    ])
      expect(validate(result), JSON.stringify(result)).toBe(false);
  });
});
