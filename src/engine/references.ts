import type { Json } from "../shared/types";

const forbidden = new Set(["__proto__", "prototype", "constructor"]);
export interface ReferenceScope {
  inputs: Record<string, Json>;
  vars: Record<string, Json>;
  nodes: Record<string, Json>;
  item?: Json;
  index?: number;
}

export function lookup(path: string, scope: ReferenceScope): Json {
  const parts = path.trim().split(".");
  let value: unknown = scope;
  for (const part of parts) {
    if (
      !part ||
      forbidden.has(part) ||
      typeof value !== "object" ||
      value === null ||
      !Object.prototype.hasOwnProperty.call(value, part)
    ) {
      throw new Error(`Unknown or unsafe reference: ${path}`);
    }
    value = (value as Record<string, unknown>)[part];
  }
  if (value === undefined) throw new Error(`Reference is undefined: ${path}`);
  return structuredClone(value) as Json;
}

/** Exact references preserve JSON types; interpolation is text only. No JavaScript is evaluated. */
export function resolve<T extends Json>(value: T, scope: ReferenceScope): T {
  if (typeof value === "string") {
    const exact = /^\$\{([^{}]+)\}$/.exec(value);
    if (exact) return lookup(exact[1], scope) as T;
    return value.replace(/\$\{([^{}]+)\}/g, (_, path: string) => {
      const result = lookup(path, scope);
      return typeof result === "string" ? result : JSON.stringify(result);
    }) as T;
  }
  if (Array.isArray(value))
    return value.map((item) => resolve(item, scope)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => {
        if (forbidden.has(key)) throw new Error(`Unsafe property: ${key}`);
        return [key, resolve(item, scope)];
      }),
    ) as T;
  }
  return value;
}

export function safeVariable(name: unknown): string {
  if (
    typeof name !== "string" ||
    !/^[a-zA-Z_][\w-]*$/.test(name) ||
    forbidden.has(name)
  )
    throw new Error("Variable must have a safe, non-empty identifier");
  return name;
}

const secretKey =
  /password|passwd|secret|api.?key|authorization|access.?token|refresh.?token|credential/i;
export function secretValues(value: Json): string[] {
  const result: string[] = [];
  const visit = (item: Json) => {
    if (!item || typeof item !== "object") return;
    for (const [key, child] of Object.entries(item)) {
      if (secretKey.test(key) && typeof child === "string" && child.length)
        result.push(child);
      else visit(child);
    }
  };
  visit(value);
  return result;
}

export function redact<T>(value: T, secrets: readonly string[] = []): T {
  if (typeof value === "string") {
    let text: string = value;
    for (const secret of secrets)
      if (secret) text = text.split(secret).join("[redacted]");
    return text as T;
  }
  if (Array.isArray(value))
    return value.map((item) => redact(item, secrets)) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        secretKey.test(key) ? "[redacted]" : redact(child, secrets),
      ]),
    ) as T;
  return value;
}
