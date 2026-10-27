import type { Json } from "../shared/types";
import { hasReference } from "../shared/node-definitions";
export const privateAuthoringValue = "__RELAY_USER_OWNED_SECRET__";
const secretKey =
  /password|passwd|secret|api.?key|authorization|access.?token|refresh.?token|credential/i;
function privateLiteral(key: string, value: Json) {
  return (
    secretKey.test(key) &&
    typeof value === "string" &&
    Boolean(value.trim()) &&
    !hasReference(value)
  );
}
export function projectAuthoringValue(value: Json, key = ""): Json {
  if (privateLiteral(key, value)) return privateAuthoringValue;
  if (Array.isArray(value))
    return value.map((item) => projectAuthoringValue(item));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, item]) => [
        k,
        projectAuthoringValue(item, k),
      ]),
    );
  return value;
}
function hasPrivateLiteral(value: Json, key = ""): boolean {
  return (
    privateLiteral(key, value) ||
    Boolean(
      value &&
      typeof value === "object" &&
      Object.entries(value).some(([k, item]) => hasPrivateLiteral(item, k)),
    )
  );
}
/** Preserve owned secrets without accepting edits to them from a provider. Arrays
 * with private entries are preserved as a whole, so reordering cannot rebind keys. */
export function restoreAuthoringPrivateValues(
  proposed: Json,
  previous: Json,
  key = "",
): Json {
  if (privateLiteral(key, previous)) return structuredClone(previous);
  if (!hasPrivateLiteral(previous, key)) return proposed;
  if (Array.isArray(previous)) return structuredClone(previous);
  if (!previous || typeof previous !== "object") return proposed;
  const next: Record<string, Json> =
    proposed && typeof proposed === "object" && !Array.isArray(proposed)
      ? { ...proposed }
      : structuredClone(previous);
  for (const [k, item] of Object.entries(previous))
    if (hasPrivateLiteral(item, k))
      next[k] = restoreAuthoringPrivateValues(next[k] ?? null, item, k);
  return next;
}
export function containsPrivatePlaceholder(value: Json): boolean {
  return typeof value === "string"
    ? value.includes(privateAuthoringValue)
    : Boolean(
        value &&
        typeof value === "object" &&
        Object.values(value).some(containsPrivatePlaceholder),
      );
}
