import { z } from "zod";
import type { AIConnection } from "./types";

export const aiCheckOperations = [
  "text",
  "decision",
  "structured",
  "image",
  "localization",
] as const;
export const aiCheckOperationSchema = z.enum(aiCheckOperations);
export type AICheckOperation = z.infer<typeof aiCheckOperationSchema>;
export const aiCheckSchema = z
  .object({
    operation: aiCheckOperationSchema,
    status: z.enum(["passed", "failed", "unsupported"]),
    message: z.string().max(800),
    at: z.string().datetime(),
    connectionRevision: z.number().int().nonnegative(),
    credentialRevision: z.number().int().nonnegative(),
  })
  .strict();
export type AIConnectionCheck = z.infer<typeof aiCheckSchema>;
export type AICheckResult = AIConnectionCheck & {
  ok: boolean;
  discarded?: boolean;
};
export const aiCheckLabels: Record<AICheckOperation, string> = {
  text: "Text",
  decision: "Decision",
  structured: "Structured",
  image: "Image",
  localization: "Localization",
};
export function unsupportedCheck(
  connection: AIConnection,
  operation: AICheckOperation,
): string | undefined {
  if (
    connection.provider === "jev" &&
    ["text", "structured"].includes(operation)
  )
    return "Jev supports decisions/detection, not arbitrary text or schema generation.";
  if (operation === "text" && !connection.capabilities.text)
    return "Enable text for this connection before testing it.";
  if (
    ["structured", "decision"].includes(operation) &&
    connection.provider !== "jev" &&
    !connection.capabilities.structured
  )
    return "Enable structured output for this operation before testing it.";
  if (["image", "localization"].includes(operation)) {
    if (!connection.capabilities.vision)
      return "Enable vision for this connection before testing images.";
    if (connection.provider === "jev" && !connection.experimentalVision)
      return "Enable experimental Jev vision before testing images.";
    if (
      operation === "localization" &&
      connection.provider !== "jev" &&
      !connection.capabilities.structured
    )
      return "Localization requires vision and structured output enabled.";
  }
}
export function connectionCheckState(
  connection: AIConnection,
  operation: AICheckOperation,
) {
  const unsupported = unsupportedCheck(connection, operation);
  if (unsupported)
    return { status: "unsupported" as const, message: unsupported };
  const result = connection.checks?.[operation];
  if (!result)
    return {
      status: "untested" as const,
      message: "This operation has not been tested.",
    };
  if (
    result.operation !== operation ||
    result.connectionRevision !== (connection.revision ?? 0) ||
    result.credentialRevision !== (connection.credentialRevision ?? 0)
  )
    return {
      status: "stale" as const,
      message:
        "Configuration or credentials changed. Test this operation again.",
    };
  return result;
}
function configuration(connection: AIConnection) {
  return JSON.stringify([
    connection.provider,
    connection.baseUrl,
    connection.model,
    connection.capabilities.text,
    connection.capabilities.vision,
    connection.capabilities.structured,
    Boolean(connection.experimentalVision),
  ]);
}
// Only the main process may own revisions or probe evidence. Draft fields cannot manufacture a pass.
export function prepareConnectionSave(
  previous: AIConnection | undefined,
  draft: AIConnection,
  credentialChanged: boolean,
): AIConnection {
  return {
    ...draft,
    revision: previous
      ? (previous.revision ?? 0) +
        Number(configuration(previous) !== configuration(draft))
      : 1,
    credentialRevision:
      (previous?.credentialRevision ?? 0) + Number(credentialChanged),
    checks: previous?.checks,
    lastTest: undefined,
  };
}
export function sameConnectionRevision(a: AIConnection, b: AIConnection) {
  return (
    a.id === b.id &&
    (a.revision ?? 0) === (b.revision ?? 0) &&
    (a.credentialRevision ?? 0) === (b.credentialRevision ?? 0) &&
    configuration(a) === configuration(b)
  );
}
