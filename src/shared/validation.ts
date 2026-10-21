import { z } from "zod";
import type { Json } from "./types";

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
const id = z.string().min(1).max(200);
const nodeKind = z.enum([
  "start",
  "end",
  "launch",
  "attach",
  "focus",
  "close",
  "click",
  "move",
  "drag",
  "scroll",
  "type",
  "key",
  "navigate",
  "read",
  "select",
  "tab",
  "screenshot",
  "detect",
  "wait",
  "condition",
  "set",
  "loop",
  "ai",
  "call",
  "group",
]);
export const flowSchema = z.object({
  schemaVersion: z.literal(1),
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
        config: configSchema,
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
export const connectionSchema = z.object({
  id,
  name: z.string().min(1).max(160),
  provider: z.enum([
    "openai",
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
  lastTest: z
    .object({ ok: z.boolean(), message: z.string(), at: z.string() })
    .optional(),
});
export const targetSchema = z.object({
  id,
  name: z.string().min(1).max(160),
  kind: z.enum(["desktop", "browser"]),
  browserMode: z.enum(["managed", "extension"]).optional(),
  profile: z.string().max(120).optional(),
  url: z.string().optional(),
  application: z.string().optional(),
  windowTitle: z.string().optional(),
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
  kind: nodeKind,
  label: z.string().max(200),
  config: configSchema,
});
export function boundedJson(value: unknown): void {
  if (JSON.stringify(value).length > 12_000_000)
    throw new Error("This request exceeds the 12 MB limit.");
}
