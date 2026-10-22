import {
  nodeDefinitions,
  nodeOutputPorts,
  type OutputSpec,
} from "./node-definitions";
import type { FlowDefinition, FlowNode, Json } from "./types";

export interface ReferenceOption {
  reference: string;
  label: string;
  group: "Flow inputs" | "Variables" | "Node outputs" | "Loop values";
  type: OutputSpec["type"];
  description?: string;
  warning?: string;
  nodeId?: string;
}
export interface ReferenceOptions {
  loopInputs?: boolean;
}
export interface ReferenceInspector {
  referenceOptions(
    consumerNodeId?: string,
    options?: ReferenceOptions,
  ): ReferenceOption[];
  /** Omitting the consumer inspects flow outputs, evaluated after a Finish node. */
  describeReference(
    value: unknown,
    consumerNodeId?: string,
    options?: ReferenceOptions,
  ): ReferenceOption | null;
}
const forbidden = new Set(["__proto__", "prototype", "constructor"]);
const safeSegment = (key: string) =>
  Boolean(key) &&
  key.trim() === key &&
  !/[.{}\u0000-\u001f\u007f]/.test(key) &&
  !forbidden.has(key);
const exactPath = (value: unknown): string[] | null => {
  if (typeof value !== "string") return null;
  const match = /^\$\{([^{}]+)\}$/.exec(value);
  if (!match) return null;
  const parts = match[1].trim().split(".");
  return parts.every(safeSegment) ? parts : null;
};
const reference = (parts: readonly string[]) => `\${${parts.join(".")}}`;
/** Some imported IDs cannot be represented by the runtime's dot-path syntax. */
export function nodeReference(id: string): string | null {
  return safeSegment(id) ? reference(["nodes", id]) : null;
}
const jsonType = (value: Json): OutputSpec["type"] =>
  value === null
    ? "null"
    : Array.isArray(value)
      ? "array"
      : (typeof value as "string" | "number" | "boolean" | "object");
const mergeTypes = (types: OutputSpec["type"][]): OutputSpec["type"] =>
  types.length && types.every((type) => type === types[0]) ? types[0] : "json";
const warningText = (...warnings: (string | undefined)[]) =>
  [
    ...new Set(
      warnings.filter((warning): warning is string => Boolean(warning)),
    ),
  ].join(" ") || undefined;
// Drafts can reach the standalone validator before their configuration is valid.
const nodeConfig = (node: FlowNode): Record<string, Json> | undefined =>
  node.config && typeof node.config === "object" && !Array.isArray(node.config)
    ? node.config
    : undefined;
const assignedValue = (node: FlowNode): Json | undefined => {
  const config = nodeConfig(node);
  return config ? (config.value ?? null) : undefined;
};
const variableName = (node: FlowNode) => {
  const config = nodeConfig(node);
  const name =
    node.kind === "set" ? (config?.variable ?? config?.name) : undefined;
  return typeof name === "string" &&
    /^[a-zA-Z_][\w-]*$/.test(name) &&
    safeSegment(name)
    ? name
    : undefined;
};
const bit = (set: Uint32Array, index: number) =>
  Boolean(set[index >>> 5] & (1 << (index & 31)));
const addBit = (set: Uint32Array, index: number) => {
  set[index >>> 5] |= 1 << (index & 31);
};
interface Edge {
  source: string;
  target: string;
  port: string;
}

/** Infer only explicit local schema types; never rewrite or resolve advanced schemas. */
function schemaOutputs(value: Json): OutputSpec[] {
  let schema = value;
  if (typeof schema === "string") {
    try {
      schema = JSON.parse(schema) as Json;
    } catch {
      /* Dynamic or incomplete schema. */
    }
  }
  const specs: OutputSpec[] = [];
  const object = (value: Json | undefined): value is Record<string, Json> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  const walk = (
    current: Json,
    path: string[],
    optional: boolean,
    depth: number,
  ) => {
    if (specs.length >= 1000 || depth > 12) return;
    const record = object(current) ? current : undefined;
    const advanced =
      record &&
      [
        "$ref",
        "$dynamicRef",
        "$recursiveRef",
        "anyOf",
        "oneOf",
        "allOf",
        "not",
        "if",
        "then",
        "else",
      ].some((key) => Object.hasOwn(record, key));
    const declared = advanced ? undefined : record?.type;
    const type: OutputSpec["type"] =
      declared === "integer"
        ? "number"
        : typeof declared === "string" &&
            ["object", "array", "string", "number", "boolean", "null"].includes(
              declared,
            )
          ? (declared as OutputSpec["type"])
          : "json";
    specs.push({
      path: path.join("."),
      type,
      description:
        typeof record?.description === "string"
          ? record.description
          : path.length
            ? `Structured output: ${path.join(" → ")}`
            : "Schema-validated AI result",
      ...(optional ? { optional: true } : {}),
    });
    if (type !== "object" || !object(record?.properties)) return;
    const required = Array.isArray(record.required) ? record.required : [];
    for (const [name, child] of Object.entries(record.properties))
      if (safeSegment(name))
        walk(
          child,
          [...path, name],
          optional || !required.includes(name),
          depth + 1,
        );
  };
  walk(schema, [], false, 0);
  return specs;
}

/** Make one inspector per immutable flow revision/render. It never caches mutable flows globally. */
export function createReferenceInspector(
  flow: FlowDefinition,
): ReferenceInspector {
  const nodes = new Map(flow.nodes.map((node) => [node.id, node]));
  let completion = "__relay_completion__";
  while (nodes.has(completion)) completion += "_";
  const ids = [...nodes.keys(), completion];
  const indices = new Map(ids.map((id, i) => [id, i]));
  const incoming = new Map(ids.map((id) => [id, [] as Edge[]]));
  const outgoing = new Map(ids.map((id) => [id, [] as Edge[]]));
  const addEdge = (edge: Edge) => {
    outgoing.get(edge.source)!.push(edge);
    incoming.get(edge.target)!.push(edge);
  };
  for (const edge of flow.edges) {
    const source = nodes.get(edge.source),
      target = nodes.get(edge.target);
    const port = edge.port || "next";
    if (
      source &&
      target &&
      target.kind !== "start" &&
      Object.hasOwn(nodeDefinitions, source.kind) &&
      nodeOutputPorts(source.kind).includes(port)
    )
      addEdge({ source: edge.source, target: edge.target, port });
  }
  for (const node of nodes.values())
    if (node.kind === "end")
      addEdge({ source: node.id, target: completion, port: "next" });
  const starts = [...nodes.values()]
    .filter((node) => node.kind === "start")
    .map((node) => node.id);
  const reachable = new Set<string>();
  const pending = [...starts];
  while (pending.length) {
    const id = pending.pop()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const edge of outgoing.get(id) ?? []) pending.push(edge.target);
  }
  const degree = new Map(ids.map((id) => [id, incoming.get(id)!.length]));
  const ready = ids.filter((id) => degree.get(id) === 0),
    ordered: string[] = [];
  for (let i = 0; i < ready.length; i++) {
    const id = ready[i];
    ordered.push(id);
    for (const edge of outgoing.get(id)!) {
      const remaining = degree.get(edge.target)! - 1;
      degree.set(edge.target, remaining);
      if (!remaining) ready.push(edge.target);
    }
  }
  const cyclic = ordered.length !== ids.length;
  const words = Math.ceil(ids.length / 32);
  const ancestors = new Map<string, Uint32Array>(),
    dominators = new Map<string, Uint32Array>();
  for (const id of ordered) {
    const before = new Uint32Array(words);
    let dominating: Uint32Array | undefined;
    for (const edge of incoming.get(id)!) {
      const parent = ancestors.get(edge.source)!;
      for (let i = 0; i < words; i++) before[i] |= parent[i];
      addBit(before, indices.get(edge.source)!);
      if (reachable.has(edge.source)) {
        const parentDom = dominators.get(edge.source)!;
        if (!dominating) dominating = parentDom.slice();
        else for (let i = 0; i < words; i++) dominating[i] &= parentDom[i];
      }
    }
    ancestors.set(id, before);
    dominating ??= new Uint32Array(words);
    addBit(dominating, indices.get(id)!);
    dominators.set(id, dominating);
  }
  const before = (producer: string, consumer: string) => {
    const index = indices.get(producer),
      available = ancestors.get(consumer);
    return (
      index !== undefined && available !== undefined && bit(available, index)
    );
  };
  const consumerLabel = (id: string) =>
    id === completion
      ? "the flow finishes"
      : `“${nodes.get(id)?.label || "this node"}”`;
  const availability = (
    producer: FlowNode,
    consumer: string,
  ): string | undefined => {
    if (!indices.has(consumer)) return "The consuming node no longer exists.";
    if (producer.id === consumer)
      return "This node does not run before its own fields are evaluated.";
    if (!reachable.has(producer.id))
      return `“${producer.label}” is not reachable from Start.`;
    if (!before(producer.id, consumer))
      return cyclic
        ? "Availability cannot be established while the graph contains a cycle."
        : `“${producer.label}” does not run before ${consumerLabel(consumer)}.`;
    const branch = !bit(dominators.get(consumer)!, indices.get(producer.id)!)
      ? `“${producer.label}” may not run on every path to ${consumerLabel(consumer)}.`
      : undefined;
    const error = outgoing
      .get(producer.id)!
      .some(
        (edge) =>
          edge.port === "error" &&
          (edge.target === consumer || before(edge.target, consumer)),
      )
      ? `Its error path can reach ${consumerLabel(consumer)} without the normal output; the result contains an error instead.`
      : undefined;
    return warningText(branch, error);
  };

  // Reaching assignments account for overwrites and for setters that fail along an error edge.
  // Unchanged sets are shared along linear stretches; analysis is built only for variables requested.
  const assignments = new Map<string, Map<string, ReadonlySet<string>>>();
  const reachingAssignments = (name: string) => {
    const known = assignments.get(name);
    if (known) return known;
    const values = new Map<string, ReadonlySet<string>>();
    const unassigned = new Set([""]);
    for (const id of ordered) {
      if (!reachable.has(id)) {
        values.set(id, new Set());
        continue;
      }
      const possibilities: ReadonlySet<string>[] = [];
      if (starts.includes(id)) possibilities.push(unassigned);
      for (const edge of incoming.get(id)!) {
        if (!reachable.has(edge.source)) continue;
        const source = nodes.get(edge.source);
        possibilities.push(
          source && variableName(source) === name && edge.port !== "error"
            ? new Set([source.id])
            : (values.get(edge.source) ?? unassigned),
        );
      }
      values.set(
        id,
        possibilities.length === 1
          ? possibilities[0]
          : new Set(possibilities.flatMap((possible) => [...possible])),
      );
    }
    assignments.set(name, values);
    return values;
  };
  const variableInfo = (name: string, consumer: string) => {
    const reached = reachingAssignments(name).get(consumer);
    const sources = [...(reached ?? [])]
      .filter(Boolean)
      .map((id) => nodes.get(id)!);
    const elsewhere = [...nodes.values()].some(
      (node) => variableName(node) === name,
    );
    let warning: string | undefined;
    if (!sources.length)
      warning = elsewhere
        ? `Variable “${name}” does not have an assignment that runs before ${consumerLabel(consumer)}.`
        : `No Set variable node defines “${name}”.`;
    else if (reached?.has("")) {
      const failed = [...nodes.values()].some(
        (node) =>
          variableName(node) === name &&
          before(node.id, consumer) &&
          outgoing
            .get(node.id)!
            .some(
              (edge) =>
                edge.port === "error" &&
                (edge.target === consumer || before(edge.target, consumer)),
            ),
      );
      warning = `Variable “${name}” may be unset on some paths${failed ? ", including an error path" : ""} to ${consumerLabel(consumer)}.`;
    }
    return { sources, warning };
  };

  const ownValue = (
    value: Json | undefined,
    path: readonly string[],
  ): Json | undefined => {
    let current: Json | undefined = value;
    for (const part of path) {
      if (
        !current ||
        typeof current !== "object" ||
        !Object.hasOwn(current, part)
      )
        return undefined;
      current = (current as Record<string, Json>)[part];
    }
    return current;
  };
  const staticValue = (
    value: Json | undefined,
    consumer: string,
    seen = new Set<string>(),
  ): Json | undefined => {
    const parts = exactPath(value);
    if (!parts) return value;
    const key = `${consumer}:${parts.join(".")}`;
    if (seen.has(key)) return undefined;
    seen.add(key);
    if (parts[0] === "inputs") return ownValue(flow.inputs, parts.slice(1));
    if (parts[0] === "nodes" && parts[1]) {
      const source = nodes.get(parts[1]);
      if (source?.kind === "set")
        return ownValue(
          staticValue(assignedValue(source), source.id, seen),
          parts.slice(2),
        );
    }
    if (parts[0] === "vars" && parts[1]) {
      const sources = variableInfo(parts[1], consumer).sources;
      if (sources.length === 1)
        return ownValue(
          staticValue(assignedValue(sources[0]), sources[0].id, seen),
          parts.slice(2),
        );
    }
    return undefined;
  };
  const typeOfValue = (
    value: Json | undefined,
    consumer: string,
    seen = new Set<string>(),
  ): OutputSpec["type"] => {
    const parts = exactPath(value);
    if (!parts) return value === undefined ? "json" : jsonType(value);
    const key = `${consumer}:${parts.join(".")}`;
    if (seen.has(key)) return "json";
    seen.add(key);
    return describe(parts, consumer, {}, seen)?.type ?? "json";
  };
  const nestedSpecs = (
    value: Json | undefined,
    consumer: string,
  ): OutputSpec[] => {
    const specs: OutputSpec[] = [];
    const walk = (current: Json | undefined, path: string[], depth: number) => {
      if (specs.length >= 1000 || depth > 12) return;
      specs.push({
        path: path.join("."),
        type: typeOfValue(current, consumer),
        description: path.length ? path.join(" → ") : "Assigned value",
      });
      const literal = staticValue(current, consumer);
      if (literal && typeof literal === "object")
        for (const [key, child] of Object.entries(literal))
          if (safeSegment(key)) walk(child, [...path, key], depth + 1);
    };
    walk(value, [], 0);
    return specs;
  };
  const outputCache = new Map<string, OutputSpec[]>();
  const outputs = (node: FlowNode): OutputSpec[] => {
    const cached = outputCache.get(node.id);
    if (cached) return cached;
    // Reserve before inference so malformed cyclic references cannot recurse indefinitely.
    outputCache.set(node.id, []);
    let result: OutputSpec[];
    const config = nodeConfig(node);
    if (!config)
      result = [
        {
          path: "",
          type: "json",
          description:
            "Result is unknown until the node configuration is valid",
        },
      ];
    else if (node.kind === "set")
      result = nestedSpecs(assignedValue(node), node.id);
    else if (node.kind === "ai" && config.schema !== undefined)
      result = schemaOutputs(config.schema);
    else if (node.kind === "wait")
      result = config.detector
        ? exactPath(config.detector)
          ? [
              {
                path: "",
                type: "json",
                description: "Result depends on the selected wait mode",
              },
            ]
          : nodeDefinitions.detect.outputs
        : [
            {
              path: "",
              type: "null",
              description: "Duration waits have no result value",
            },
          ];
    else if (Object.hasOwn(nodeDefinitions, node.kind))
      result = nodeDefinitions[node.kind].outputs;
    else result = [];
    outputCache.set(node.id, result);
    return result;
  };
  const nodeOption = (
    producer: FlowNode,
    path: string[],
    consumer: string,
  ): ReferenceOption => {
    const spec = outputs(producer).find(
      (output) => output.path === path.join("."),
    );
    return {
      reference: reference(["nodes", producer.id, ...path]),
      label: `${producer.label || nodeDefinitions[producer.kind]?.label || producer.id}${path.length ? ` → ${path.join(" → ")}` : " → Result"}`,
      group: "Node outputs",
      type:
        spec?.type ??
        (!path.length && ["start", "end"].includes(producer.kind)
          ? "null"
          : "json"),
      nodeId: producer.id,
      description:
        spec?.description ??
        "Custom output path; its shape is checked when the workflow runs.",
      warning: warningText(
        availability(producer, consumer),
        spec?.optional
          ? "This field is optional and may be absent from the result."
          : undefined,
      ),
    };
  };
  const loopValues = (consumer: string, options: ReferenceOptions) => {
    const node = nodes.get(consumer);
    if (!options.loopInputs || node?.kind !== "loop") return [];
    const config = nodeConfig(node);
    const items = staticValue(config?.items, consumer);
    const values =
      config?.items === undefined && config
        ? [0]
        : Array.isArray(items)
          ? items
          : [];
    const specs = new Map<string, OutputSpec[]>();
    for (const value of values)
      for (const spec of nestedSpecs(value, consumer))
        specs.set(spec.path, [...(specs.get(spec.path) ?? []), spec]);
    if (!specs.has(""))
      specs.set("", [
        { path: "", type: "json", description: "Current loop item" },
      ]);
    return [
      ...[...specs].map(([path, variants]): ReferenceOption => ({
        reference: reference(["item", ...(path ? path.split(".") : [])]),
        label: `Current item${path ? ` → ${path.split(".").join(" → ")}` : ""}`,
        group: "Loop values",
        type: mergeTypes(variants.map((spec) => spec.type)),
        description: "The item supplied to this iteration's child inputs.",
        warning:
          path && variants.length < values.length
            ? "This item field is absent from some default loop items."
            : undefined,
      })),
      {
        reference: "${index}",
        label: "Iteration index",
        group: "Loop values" as const,
        type: "number" as const,
        description: "Zero-based index of the current loop iteration.",
      },
    ];
  };

  function describe(
    parts: string[],
    consumer: string,
    options: ReferenceOptions,
    seen = new Set<string>(),
  ): ReferenceOption {
    const [root, name, ...path] = parts;
    const ref = reference(parts);
    if (root === "inputs") {
      const value = ownValue(flow.inputs, parts.slice(1));
      return {
        reference: ref,
        label:
          parts.length === 1 ? "All flow inputs" : parts.slice(1).join(" → "),
        group: "Flow inputs",
        type: value === undefined ? "json" : jsonType(value),
        description:
          value === undefined
            ? "Not in the flow defaults; supply this input when running the workflow."
            : "Type inferred from the flow input default; run inputs can override it.",
      };
    }
    if (root === "nodes") {
      if (!name)
        return {
          reference: ref,
          label: "All completed node outputs",
          group: "Node outputs",
          type: "object",
          description: "Results of nodes that have already run.",
        };
      const producer = nodes.get(name);
      if (!producer)
        return {
          reference: ref,
          label: `Missing node: ${name}`,
          group: "Node outputs",
          type: "json",
          nodeId: name,
          warning: "The referenced node no longer exists.",
        };
      return nodeOption(producer, path, consumer);
    }
    if (root === "vars") {
      if (!name)
        return {
          reference: ref,
          label: "All current variables",
          group: "Variables",
          type: "object",
        };
      const { sources, warning } = variableInfo(name, consumer);
      const values = sources.map((source) => {
        if (!path.length)
          return typeOfValue(assignedValue(source), source.id, seen);
        const value = ownValue(
          staticValue(assignedValue(source), source.id),
          path,
        );
        return value === undefined
          ? ("json" as const)
          : typeOfValue(value, source.id, seen);
      });
      return {
        reference: ref,
        label: [name, ...path].join(" → "),
        group: "Variables",
        type: mergeTypes(values),
        warning,
        ...(sources.length === 1 ? { nodeId: sources[0].id } : {}),
        description: sources.length
          ? `Set by ${sources.map((source) => `“${source.label}”`).join(", ")}.`
          : "A variable must be assigned before it is read.",
      };
    }
    if (root === "item" || root === "index") {
      const allowed =
        nodes.get(consumer)?.kind === "loop" && options.loopInputs;
      return (
        loopValues(consumer, options).find(
          (option) => option.reference === ref,
        ) ?? {
          reference: ref,
          label:
            root === "index"
              ? "Iteration index"
              : `Current item${parts.length > 1 ? ` → ${parts.slice(1).join(" → ")}` : ""}`,
          group: "Loop values",
          type: root === "index" && parts.length === 1 ? "number" : "json",
          warning: !allowed
            ? "Loop values are only available inside a Loop node's child inputs."
            : root === "index" && parts.length > 1
              ? "The iteration index is a number and has no nested fields."
              : undefined,
        }
      );
    }
    return {
      reference: ref,
      label: `Unknown reference: ${parts.join(".")}`,
      group: "Flow inputs",
      type: "json",
      warning: `Unknown reference root: ${root}.`,
    };
  }

  const optionsCache = new Map<string, ReferenceOption[]>();
  return {
    describeReference(value, consumerNodeId, options = {}) {
      const parts = exactPath(value);
      return parts
        ? describe(parts, consumerNodeId ?? completion, options)
        : null;
    },
    referenceOptions(consumer = completion, options = {}) {
      const key = JSON.stringify([consumer, Boolean(options.loopInputs)]);
      const cached = optionsCache.get(key);
      if (cached) return cached;
      const result: ReferenceOption[] = [];
      // Defaults are literal inputs, even when a string happens to look like a reference.
      const inputWalk = (value: Json, path: string[], depth: number) => {
        if (result.length >= 1000 || depth > 12) return;
        if (path.length)
          result.push(describe(["inputs", ...path], consumer, options));
        if (value && typeof value === "object")
          for (const [key, child] of Object.entries(value))
            if (safeSegment(key)) inputWalk(child, [...path, key], depth + 1);
      };
      inputWalk(flow.inputs, [], 0);
      const prior = [...nodes.values()].filter(
        (node) =>
          node.id !== consumer &&
          reachable.has(node.id) &&
          before(node.id, consumer),
      );
      const names = [
        ...new Set(
          prior
            .map(variableName)
            .filter((name): name is string => Boolean(name)),
        ),
      ];
      for (const name of names) {
        result.push(describe(["vars", name], consumer, options));
        const paths = new Set<string>();
        for (const source of variableInfo(name, consumer).sources)
          for (const output of outputs(source))
            if (output.path) paths.add(output.path);
        for (const path of paths)
          result.push(
            describe(["vars", name, ...path.split(".")], consumer, options),
          );
      }
      for (const node of prior)
        if (safeSegment(node.id))
          for (const output of outputs(node)) {
            const path = output.path ? output.path.split(".") : [];
            if (path.every(safeSegment))
              result.push(nodeOption(node, path, consumer));
          }
      result.push(...loopValues(consumer, options));
      optionsCache.set(key, result);
      return result;
    },
  };
}

export function referenceOptions(
  flow: FlowDefinition,
  consumerNodeId?: string,
  options?: ReferenceOptions,
): ReferenceOption[] {
  return createReferenceInspector(flow).referenceOptions(
    consumerNodeId,
    options,
  );
}
export function describeReference(
  value: unknown,
  flow: FlowDefinition,
  consumerNodeId?: string,
  options?: ReferenceOptions,
): ReferenceOption | null {
  return createReferenceInspector(flow).describeReference(
    value,
    consumerNodeId,
    options,
  );
}
