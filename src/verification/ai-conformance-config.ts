import { z } from "zod";
import { createHash } from "node:crypto";
import {
  aiCheckOperationSchema,
  aiCheckOperations,
  unsupportedCheck,
  type AICheckOperation,
} from "../shared/ai-connections";
import { safeModelIdentity } from "../shared/ai-diagnostics";
import type { AIConnection } from "../shared/types";
const identity = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:+/@-]*$/);
export const visualCases = [
  "light-1x",
  "dark-1x",
  "light-2x",
  "dark-2x",
  "absent",
  "duplicate",
  "obscured",
] as const;
export type VisualCase = (typeof visualCases)[number];
const unique = <T>(values: T[]) => new Set(values).size === values.length;
const profileSchema = z
  .object({
    id: identity,
    provider: z.enum([
      "openai",
      "openrouter",
      "anthropic",
      "gemini",
      "ollama",
      "lmstudio",
      "jev",
    ]),
    model: z
      .string()
      .min(1)
      .max(200)
      .refine(
        (v) => Boolean(safeModelIdentity(v)) && !/^(YOUR_|CHANGE_ME)/.test(v),
        "Supply an exact model identifier.",
      ),
    baseUrl: z
      .string()
      .max(2000)
      .refine((v) => {
        try {
          const url = new URL(v);
          return (
            !url.username &&
            !url.password &&
            !url.search &&
            !url.hash &&
            (url.protocol === "https:" ||
              (url.protocol === "http:" &&
                ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
          );
        } catch {
          return false;
        }
      }, "Use HTTPS or loopback HTTP, without credentials, query or fragment."),
    keyEnv: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{2,80}$/)
      .optional(),
    capabilities: z
      .object({
        text: z.boolean(),
        vision: z.boolean(),
        structured: z.boolean(),
      })
      .strict(),
    experimentalVision: z.boolean().optional(),
    runtime: z
      .object({ name: identity, version: identity, modelRevision: identity })
      .strict()
      .optional(),
    operations: z.array(aiCheckOperationSchema).min(1).max(5).refine(unique),
    coldStartExpected: z.boolean().optional(),
    cancellation: z
      .object({
        operation: aiCheckOperationSchema,
        afterMs: z.number().int().min(10).max(19000),
      })
      .strict()
      .optional(),
    visualCases: z.array(z.enum(visualCases)).max(7).refine(unique).default([]),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (p.visualCases.length && p.provider !== "jev")
      ctx.addIssue({
        code: "custom",
        message: "Visual evaluation cases require Jev.",
      });
  });
export const conformanceConfigSchema = z
  .object({
    version: z.literal(1),
    maxRequests: z.number().int().min(1).max(100),
    requestTimeoutMs: z.number().int().min(100).max(20000),
    totalTimeoutMs: z.number().int().min(100).max(900000),
    profiles: z
      .array(profileSchema)
      .min(1)
      .max(14)
      .refine((p) => unique(p.map((v) => v.id))),
  })
  .strict();
export type ConformanceConfig = z.infer<typeof conformanceConfigSchema>;
export type ConformanceProfile = ConformanceConfig["profiles"][number];
export type ConformanceCase = {
  id: string;
  operation: AICheckOperation;
  kind: "probe" | "cancellation" | "visual";
  visual?: VisualCase;
  afterMs?: number;
  firstRequest?: "operator-expects-cold-start";
};
export function connectionFor(profile: ConformanceProfile): AIConnection {
  return {
    id: profile.id,
    name: "Conformance synthetic fixture",
    provider: profile.provider,
    model: profile.model,
    baseUrl: profile.baseUrl,
    capabilities: profile.capabilities,
    experimentalVision: profile.experimentalVision,
    hasKey: false,
    revision: 1,
    credentialRevision: 0,
  };
}
export function casesFor(profile: ConformanceProfile): ConformanceCase[] {
  const cases: ConformanceCase[] = profile.operations.map((operation) => ({
    id: operation,
    operation,
    kind: "probe",
  }));
  if (profile.cancellation)
    cases.push({
      id: `cancel-${profile.cancellation.operation}`,
      kind: "cancellation",
      ...profile.cancellation,
    });
  for (const visual of profile.visualCases)
    cases.push({
      id: `jev-${visual}`,
      operation: "localization",
      kind: "visual",
      visual,
    });
  if (profile.coldStartExpected && cases[0])
    cases[0].firstRequest = "operator-expects-cold-start";
  return cases;
}
export function configurationIdentity(profile: ConformanceProfile) {
  return createHash("sha256").update(JSON.stringify(profile)).digest("hex");
}
export function notSelected(profile: ConformanceProfile) {
  return aiCheckOperations.filter((op) => !profile.operations.includes(op));
}
export function unsupportedCase(
  profile: ConformanceProfile,
  scenario: ConformanceCase,
) {
  return unsupportedCheck(connectionFor(profile), scenario.operation);
}
export function exactLocalRuntime(profile: ConformanceProfile) {
  return (
    !["ollama", "lmstudio"].includes(profile.provider) ||
    Boolean(
      profile.runtime &&
      !Object.values(profile.runtime).some((v) =>
        /^(?:YOUR_|CHANGE_ME)|^(unknown|latest|unrecorded|not-recorded)$/i.test(
          v,
        ),
      ),
    )
  );
}
