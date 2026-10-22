import type { Json } from "./types";

export const schemaTypes = [
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
  "null",
] as const;
export type SchemaType = (typeof schemaTypes)[number];
export type SchemaObject = Record<string, Json>;
export type SchemaPrimitive = string | number | boolean | null;
export type SchemaPrimitiveType = "string" | "number" | "boolean" | "null";

const composition = [
  "$ref",
  "$dynamicRef",
  "$recursiveRef",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
];
const keywords: Record<string, readonly string[]> = {
  object: [
    "properties",
    "patternProperties",
    "additionalProperties",
    "required",
    "propertyNames",
    "minProperties",
    "maxProperties",
    "dependencies",
    "dependentRequired",
    "dependentSchemas",
    "unevaluatedProperties",
  ],
  array: [
    "items",
    "prefixItems",
    "additionalItems",
    "contains",
    "minContains",
    "maxContains",
    "minItems",
    "maxItems",
    "uniqueItems",
    "unevaluatedItems",
  ],
  string: [
    "minLength",
    "maxLength",
    "pattern",
    "format",
    "contentEncoding",
    "contentMediaType",
    "contentSchema",
  ],
  number: [
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "multipleOf",
  ],
};
const forbiddenNames = new Set(["__proto__", "prototype", "constructor"]);

export function schemaObject(
  value: Json | undefined,
): SchemaObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined;
}

/** Complex schemas are never inferred or flattened into a simpler type. */
export function schemaEditorType(
  value: Json | undefined,
): SchemaType | undefined {
  const schema = schemaObject(value);
  if (!schema || composition.some((key) => Object.hasOwn(schema, key)))
    return undefined;
  return schemaTypes.includes(schema.type as SchemaType)
    ? (schema.type as SchemaType)
    : undefined;
}

export function primitiveType(value: Json): SchemaPrimitiveType | undefined {
  if (value === null) return "null";
  if (["string", "boolean"].includes(typeof value))
    return typeof value as "string" | "boolean";
  return typeof value === "number" && Number.isFinite(value)
    ? "number"
    : undefined;
}

export function matchesSchemaType(value: Json, type: SchemaType): boolean {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return Boolean(schemaObject(value));
  if (type === "integer")
    return typeof value === "number" && Number.isInteger(value);
  return typeof value === type && (type !== "number" || Number.isFinite(value));
}

/** Only an explicit type change removes incompatible constraints. Unknown extensions survive. */
export function changeSchemaType(
  value: Json | undefined,
  type: SchemaType,
): SchemaObject {
  const result = { ...schemaObject(value), type } as SchemaObject;
  for (const key of composition) delete result[key];
  const family = type === "integer" ? "number" : type;
  for (const [kind, keys] of Object.entries(keywords))
    if (kind !== family) for (const key of keys) delete result[key];
  if (Array.isArray(result.enum)) {
    const matching = result.enum.filter((item) =>
      matchesSchemaType(item, type),
    );
    if (matching.length) result.enum = matching;
    else delete result.enum;
  } else if (Object.hasOwn(result, "enum")) delete result.enum;
  for (const key of ["const", "default"])
    if (Object.hasOwn(result, key) && !matchesSchemaType(result[key], type))
      delete result[key];
  if (Array.isArray(result.examples))
    result.examples = result.examples.filter((item) =>
      matchesSchemaType(item, type),
    );
  if (type === "object") {
    if (!Object.hasOwn(result, "properties")) result.properties = {};
    if (!Object.hasOwn(result, "required")) result.required = [];
    if (!Object.hasOwn(result, "additionalProperties"))
      result.additionalProperties = false;
  } else if (type === "array" && !Object.hasOwn(result, "items"))
    result.items = { type: "string" };
  return result;
}

function objectOrThrow(value: Json | undefined): SchemaObject {
  const schema = schemaObject(value);
  if (!schema)
    throw new Error(
      "Edit this schema as JSON or explicitly choose a schema type first.",
    );
  return schema;
}
export function setSchemaDescription(
  value: Json | undefined,
  description: string,
): SchemaObject {
  const result = { ...objectOrThrow(value) };
  if (description) result.description = description;
  else delete result.description;
  return result;
}
function propertyMap(schema: SchemaObject): SchemaObject {
  if (schema.properties === undefined) return {};
  const properties = schemaObject(schema.properties);
  if (!properties)
    throw new Error("This imported properties value needs the JSON editor.");
  return properties;
}
function requiredNames(schema: SchemaObject): string[] {
  if (schema.required === undefined) return [];
  if (
    !Array.isArray(schema.required) ||
    !schema.required.every((item) => typeof item === "string")
  )
    throw new Error("This imported required list needs the JSON editor.");
  return schema.required as string[];
}
export function canEditSchemaProperties(value: Json | undefined): boolean {
  try {
    const schema = objectOrThrow(value);
    propertyMap(schema);
    requiredNames(schema);
    return true;
  } catch {
    return false;
  }
}
function validateName(name: string): void {
  if (!name.trim()) throw new Error("Enter a property name.");
  if (forbiddenNames.has(name))
    throw new Error("That property name is reserved. Choose another name.");
}
function define(properties: SchemaObject, name: string, value: Json): void {
  Object.defineProperty(properties, name, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function assertPropertyNameEditable(
  schema: SchemaObject,
  name: string,
  document: Json | undefined,
): void {
  const nameBound = [
    "dependencies",
    "dependentRequired",
    "dependentSchemas",
    "propertyNames",
    "patternProperties",
    ...composition,
  ];
  const keyword = nameBound.find((key) => Object.hasOwn(schema, key));
  if (keyword)
    throw new Error(
      `This schema uses ${keyword}. Rename or remove properties in JSON so its related constraints can be updated together.`,
    );
  const hasLocalReference = (value: Json | undefined): boolean => {
    if (!value || typeof value !== "object") return false;
    for (const [key, child] of Object.entries(value)) {
      if (
        ["$ref", "$dynamicRef", "$recursiveRef"].includes(key) &&
        typeof child === "string" &&
        child.startsWith("#")
      ) {
        try {
          const segments = decodeURIComponent(child.slice(1))
            .split("/")
            .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
          if (
            segments.some(
              (part, index) =>
                part === "properties" && segments[index + 1] === name,
            )
          )
            return true;
        } catch {
          return true;
        }
      }
      if (hasLocalReference(child)) return true;
    }
    return false;
  };
  if (hasLocalReference(document ?? schema))
    throw new Error(
      "A local schema reference uses this property name. Rename or remove it in JSON and update the reference together.",
    );
}

export function addSchemaProperty(
  value: Json | undefined,
  name: string,
  child: Json = { type: "string" },
): SchemaObject {
  const schema = objectOrThrow(value),
    properties = { ...propertyMap(schema) };
  validateName(name);
  if (Object.hasOwn(properties, name))
    throw new Error("That property already exists.");
  define(properties, name, child);
  return { ...schema, properties };
}
export function updateSchemaProperty(
  value: Json | undefined,
  name: string,
  child: Json,
): SchemaObject {
  const schema = objectOrThrow(value),
    properties = { ...propertyMap(schema) };
  validateName(name);
  if (!Object.hasOwn(properties, name))
    throw new Error("That property no longer exists.");
  define(properties, name, child);
  return { ...schema, properties };
}
export function removeSchemaProperty(
  value: Json | undefined,
  name: string,
  document?: Json,
): SchemaObject {
  const schema = objectOrThrow(value),
    properties = { ...propertyMap(schema) };
  assertPropertyNameEditable(schema, name, document);
  delete properties[name];
  return {
    ...schema,
    properties,
    ...(schema.required !== undefined
      ? { required: requiredNames(schema).filter((item) => item !== name) }
      : {}),
  };
}
export function renameSchemaProperty(
  value: Json | undefined,
  from: string,
  to: string,
  document?: Json,
): SchemaObject {
  const schema = objectOrThrow(value),
    previous = propertyMap(schema);
  validateName(to);
  if (from !== to) assertPropertyNameEditable(schema, from, document);
  if (!Object.hasOwn(previous, from))
    throw new Error("That property no longer exists.");
  if (from !== to && Object.hasOwn(previous, to))
    throw new Error("That property already exists.");
  const properties: SchemaObject = {};
  for (const [key, child] of Object.entries(previous))
    define(properties, key === from ? to : key, child);
  return {
    ...schema,
    properties,
    ...(schema.required !== undefined
      ? {
          required: [
            ...new Set(
              requiredNames(schema).map((name) => (name === from ? to : name)),
            ),
          ],
        }
      : {}),
  };
}
export function setSchemaRequired(
  value: Json | undefined,
  name: string,
  required: boolean,
): SchemaObject {
  const schema = objectOrThrow(value);
  if (!Object.hasOwn(propertyMap(schema), name))
    throw new Error("That property no longer exists.");
  const names = requiredNames(schema).filter((item) => item !== name);
  if (required) names.push(name);
  return { ...schema, required: names };
}
export function setSchemaItems(
  value: Json | undefined,
  items: Json,
): SchemaObject {
  return { ...objectOrThrow(value), items };
}
export function setSchemaEnum(
  value: Json | undefined,
  entries: SchemaPrimitive[] | undefined,
): SchemaObject {
  const result = { ...objectOrThrow(value) };
  if (!entries?.length) delete result.enum;
  else {
    if (entries.some((item) => !primitiveType(item)))
      throw new Error(
        "Allowed values must be text, finite numbers, booleans, or null.",
      );
    if (
      new Set(entries.map((item) => JSON.stringify(item))).size !==
      entries.length
    )
      throw new Error(
        "Each allowed value must be different. This edit has not been applied.",
      );
    result.enum = [...entries];
  }
  return result;
}
