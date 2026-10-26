import { z } from "zod";
import { aiCheckOperationSchema, aiCheckSchema } from "./ai-connections";
import type { Json } from "./types";
import { nativeLocatorSchema } from "./native-locators";
import { nodeKinds, hasReference } from "./node-definitions";
import { recordableKinds } from "./recording";

export const jsonSchema: z.ZodType<Json> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string().max(8_000_000),
    z.array(jsonSchema).max(10000),
    z.record(
      z
        .string()
        .refine(
          (k) => !["__proto__", "prototype", "constructor"].includes(k),
          "Unsafe property",
        ),
      jsonSchema,
    ),
  ]),
);
const configSchema = z.record(z.string(), jsonSchema);
const nodeConfigSchema = configSchema.superRefine((config, ctx) => {
  if (
    config.nativeLocator !== undefined &&
    !(
      typeof config.nativeLocator === "string" &&
      hasReference(config.nativeLocator)
    ) &&
    !nativeLocatorSchema.safeParse(config.nativeLocator).success
  )
    ctx.addIssue({
      code: "custom",
      path: ["nativeLocator"],
      message:
        "Native locators must contain valid semantic properties, never object pointers or runtime identities",
    });
});
const id = z.string().min(1).max(200);
const nodeKind = z.enum(nodeKinds);
export const flowSchema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2)]),
  id,
  name: z.string().min(1).max(160),
  description: z.string().max(4000),
  folder: z.string().max(160),
  revision: z.number().int().positive(),
  nodes: z
    .array(
      z.object({
        id,
        kind: nodeKind,
        label: z.string().max(200),
        position: z.object({ x: z.number().finite(), y: z.number().finite() }),
        config: nodeConfigSchema,
        breakpoint: z.boolean().optional(),
      }),
    )
    .max(2000),
  edges: z
    .array(
      z.object({
        id,
        source: id,
        target: id,
        port: z.string().max(80).optional(),
      }),
    )
    .max(4000),
  inputs: configSchema,
  outputs: configSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  hotkey: z.string().max(100).optional(),
});
export const flowSaveOptionsSchema = z.object({
  expectedRevision: z.number().int().positive().nullable(),
});
export const connectionSchema = z.object({
  id,
  name: z.string().min(1).max(160),
  provider: z.enum([
    "openai",
    "openrouter",
    "anthropic",
    "gemini",
    "ollama",
    "lmstudio",
    "jev",
  ]),
  baseUrl: z
    .string()
    .url()
    .refine((s) => ["http:", "https:"].includes(new URL(s).protocol)),
  model: z.string().min(1).max(200),
  capabilities: z.object({
    text: z.boolean(),
    vision: z.boolean(),
    structured: z.boolean(),
  }),
  hasKey: z.boolean(),
  experimentalVision: z.boolean().optional(),
  revision: z.number().int().nonnegative().optional(),
  credentialRevision: z.number().int().nonnegative().optional(),
  checks: z.partialRecord(aiCheckOperationSchema, aiCheckSchema).optional(),
  lastTest: z
    .object({ ok: z.boolean(), message: z.string(), at: z.string() })
    .optional(),
});
export const targetSchema = z
  .object({
    id,
    name: z.string().min(1).max(160),
    kind: z.enum(["desktop", "browser"]),
    browserMode: z.enum(["managed", "extension"]).optional(),
    profile: z.string().max(120).optional(),
    url: z.string().optional(),
    application: z.string().optional(),
    windowTitle: z.string().optional(),
    windowsCaptureBackend: z.enum(["wgc", "printwindow"]).optional(),
    launch: z
      .object({
        linux: z
          .object({ command: z.string(), args: z.array(z.string()) })
          .optional(),
        win32: z
          .object({ command: z.string(), args: z.array(z.string()) })
          .optional(),
        darwin: z
          .object({ command: z.string(), args: z.array(z.string()) })
          .optional(),
      })
      .optional(),
  })
  .superRefine((target, context) => {
    if (target.kind !== "desktop" && target.windowsCaptureBackend)
      context.addIssue({
        code: "custom",
        path: ["windowsCaptureBackend"],
        message: "Windows capture methods require a desktop target",
      });
  });
export const settingsSchema = z.object({
  theme: z.enum(["dark", "light", "system"]),
  accent: z.string().max(40),
  defaultTextConnection: z.string().optional(),
  defaultVisionConnection: z.string().optional(),
  launchAtLogin: z.boolean(),
  minimizeToTray: z.boolean(),
  stopHotkey: z.string().max(100),
  pauseHotkey: z.string().max(100),
  historyRetentionDays: z.number().int().min(1).max(3650),
});
export const scheduleSchema = z.object({
  id,
  flowId: id,
  name: z.string().min(1).max(160),
  enabled: z.boolean(),
  kind: z.enum(["once", "interval", "daily", "weekly"]),
  time: z.string(),
  timezone: z.string().refine((v) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: v });
      return true;
    } catch {
      return false;
    }
  }, "Unknown timezone"),
  intervalMinutes: z.number().int().min(1).max(525600),
  weekdays: z.array(z.number().int().min(0).max(6)).max(7),
  inputs: configSchema,
  lastRunAt: z.string().optional(),
  nextRunAt: z.string().optional(),
});
export const actionSchema = z.object({
  kind: z.enum(recordableKinds),
  label: z.string().max(200),
  config: nodeConfigSchema,
});
export const recordedActionSchema = actionSchema.extend({
  id,
  at: z.number().finite().nonnegative(),
});
export const recordedActionsSchema = z
  .array(recordedActionSchema)
  .max(2000)
  .refine(
    (actions) =>
      new Set(actions.map((action) => action.id)).size === actions.length,
    "Recorded step IDs must be unique.",
  );
export const recordingInsertionAnchorSchema = z
  .object({
    sourceNodeId: id,
    port: z.string().min(1).max(80),
    edgeId: id.optional(),
    successorNodeId: id.optional(),
  })
  .refine(
    (anchor) => Boolean(anchor.edgeId) === Boolean(anchor.successorNodeId),
    "An occupied output requires both its edge and successor.",
  );
export const recordingStartSchema = z.object({
  targetId: id,
  mode: z.enum(["guided", "direct"]),
  flowId: id,
  flowRevision: z.number().int().positive(),
  anchorNodeId: id.optional(),
  anchor: recordingInsertionAnchorSchema.optional(),
});
export const recordingInsertSchema = z.object({
  destination: z.enum(["new", "bound"]),
  name: z.string().trim().min(1).max(160).optional(),
  anchor: recordingInsertionAnchorSchema.optional(),
});
export const recordingStateSchema = z
  .object({
    phase: z.enum(["idle", "capturing", "paused", "review"]),
    sessionId: id.optional(),
    revision: z.number().int().nonnegative(),
    active: z.boolean(),
    mode: z.enum(["guided", "direct"]),
    targetId: id.optional(),
    destination: z
      .object({
        flowId: id,
        flowRevision: z.number().int().positive(),
        flowName: z.string().max(160),
        anchorNodeId: id.optional(),
        anchor: recordingInsertionAnchorSchema.optional(),
      })
      .optional(),
    actions: recordedActionsSchema,
    recovered: z.boolean().optional(),
    error: z.string().max(4000).optional(),
  })
  .superRefine((state, ctx) => {
    if (state.active !== (state.phase === "capturing"))
      ctx.addIssue({
        code: "custom",
        message: "Recording activity does not match its phase.",
      });
    if (
      state.phase !== "idle" &&
      (!state.sessionId ||
        !state.destination ||
        !state.targetId ||
        state.revision < 1)
    )
      ctx.addIssue({
        code: "custom",
        message:
          "A recording draft requires a session, target, destination, and revision.",
      });
    if (
      state.phase === "idle" &&
      (state.sessionId || state.destination || state.actions.length)
    )
      ctx.addIssue({
        code: "custom",
        message: "An idle recorder cannot contain a draft.",
      });
  });
export function boundedJson(value: unknown): void {
  if (JSON.stringify(value).length > 12_000_000)
    throw new Error("This request exceeds the 12 MB limit.");
}
