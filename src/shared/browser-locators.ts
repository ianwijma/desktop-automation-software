import { z } from "zod";

const text = z.string().min(1).max(4000);
export const browserSelectorSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("testId"),
    attribute: z
      .string()
      .regex(/^data-[a-z0-9_-]+$/)
      .max(100),
    value: text,
  }),
  z.object({
    kind: z.literal("role"),
    role: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-z]+$/),
    name: z.string().max(4000).optional(),
  }),
  z.object({ kind: z.literal("label"), value: text }),
  z.object({ kind: z.literal("id"), value: text }),
  z.object({ kind: z.literal("css"), value: text }),
]);
export const browserLocatorSchema = z.object({
  version: z.literal(1),
  selector: browserSelectorSchema,
  path: z
    .array(
      z.object({
        kind: z.enum(["frame", "shadow"]),
        selector: browserSelectorSchema,
      }),
    )
    .max(12)
    .optional(),
});
