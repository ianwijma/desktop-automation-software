import { z } from "zod";

export const nativeControlTypes = [
  "button",
  "edit",
  "text",
  "checkbox",
  "combobox",
  "list",
  "listitem",
  "menuitem",
  "tab",
  "tabitem",
  "tree",
  "treeitem",
  "window",
  "pane",
  "custom",
] as const;
export const nativeSelectorSchema = z
  .object({
    automationId: z.string().min(1).max(512).optional(),
    name: z.string().max(512).optional(),
    controlType: z.enum(nativeControlTypes).optional(),
    className: z.string().min(1).max(512).optional(),
  })
  .strict()
  .refine((s) => Object.keys(s).length > 0, "Choose a semantic property");
export const nativeLocatorSchema = z
  .object({
    version: z.literal(1),
    backend: z.enum(["uia", "ax"]),
    selector: nativeSelectorSchema,
    ancestors: z.array(nativeSelectorSchema).max(8).optional(),
  })
  .strict();
export type NativeLocator = z.infer<typeof nativeLocatorSchema>;
export const nativeInspectionQuerySchema = z.union([
  z.object({ locator: nativeLocatorSchema }).strict(),
  z
    .object({
      point: z
        .object({
          x: z.number().finite().nonnegative(),
          y: z.number().finite().nonnegative(),
          frameId: z.string().min(1).max(200),
        })
        .strict(),
    })
    .strict(),
]);
export type NativeInspectionQuery = z.infer<typeof nativeInspectionQuerySchema>;
export const nativeInspectionSchema = z.object({
  status: z.enum(["unique", "missing", "ambiguous"]),
  count: z.number().int().nonnegative(),
  element: z
    .object({
      locator: nativeLocatorSchema,
      name: z.string().max(512),
      controlType: z.string().max(100),
      automationId: z.string().max(512),
      className: z.string().max(512),
      enabled: z.boolean(),
      offscreen: z.boolean(),
      secure: z.boolean(),
      virtualized: z.boolean(),
      actions: z.array(z.enum(["read", "invoke", "setValue", "select"])),
      bounds: z.object({
        x: z.number().finite(),
        y: z.number().finite(),
        width: z.number().finite().nonnegative(),
        height: z.number().finite().nonnegative(),
      }),
    })
    .optional(),
});
export type NativeLocatorInspection = z.infer<typeof nativeInspectionSchema>;
