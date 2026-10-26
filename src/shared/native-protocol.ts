import { z } from "zod";

export const NATIVE_PROTOCOL_VERSION = 2;
export const nativeErrorSchema = z.object({
  code: z.enum([
    "PROTOCOL_MISMATCH",
    "INVALID_REQUEST",
    "UNSUPPORTED_OPERATION",
    "PERMISSION_DENIED",
    "TARGET_UNAVAILABLE",
    "DEPENDENCY_UNAVAILABLE",
    "BACKEND_FAILURE",
    "HELPER_EXITED",
    "TIMEOUT",
    "CANCELLED",
    "AMBIGUOUS_TARGET",
    "STALE_CAPTURE",
    "CAPTURE_UNAVAILABLE",
    "CAPTURE_LOST",
    "INPUT_REJECTED",
    "FOCUS_FAILED",
  ]),
  message: z.string(),
  operation: z.string(),
  backend: z.string(),
  permission: z.enum([
    "granted",
    "denied",
    "required",
    "unknown",
    "not-required",
  ]),
  retryable: z.boolean(),
});
export type NativeErrorDetails = z.infer<typeof nativeErrorSchema>;
export class NativeServiceError extends Error {
  readonly details: NativeErrorDetails;
  constructor(details: NativeErrorDetails) {
    super(details.message);
    this.name = "NativeServiceError";
    this.details = details;
  }
}
export const nativeHandshakeSchema = z.object({
  protocolVersion: z.literal(NATIVE_PROTOCOL_VERSION),
  helperVersion: z.string().min(1),
  instanceId: z.string().min(1),
  platform: z.string().min(1),
  backend: z.string().min(1),
  coordinateSpace: z.enum([
    "physical-pixels",
    "logical-points",
    "portal-source",
  ]),
});
export type NativeHandshake = z.infer<typeof nativeHandshakeSchema>;
const boundsSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().positive(),
  height: z.number().positive(),
});
export const nativeWindowSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  application: z.string().optional(),
  dpi: z.number().int().positive().optional(),
  displayScale: z.number().positive().optional(),
  bounds: boundsSchema,
  applicationIdentity: z
    .object({
      id: z.string().min(1),
      kind: z.enum([
        "wm-class",
        "process-name",
        "owner-name",
        "pid-only",
        "bundle-id",
      ]),
      pid: z.number().int().positive().optional(),
    })
    .optional(),
});
export const nativeCapabilitiesSchema = z.object({
  platform: z.string(),
  session: z.string(),
  capture: z.boolean(),
  input: z.boolean(),
  accessibility: z.boolean(),
  directRecording: z.boolean(),
  globalShortcuts: z.boolean(),
  reasons: z.array(z.string()),
  windows: z.array(nativeWindowSchema),
  native: z
    .object({
      helper: nativeHandshakeSchema,
      windows: z
        .object({
          graphicsCaptureSupported: z.boolean(),
          interactiveDesktop: z.boolean(),
          perMonitorV2: z.boolean(),
          captureLibraryVersion: z.string().optional(),
        })
        .optional(),
      macos: z
        .object({
          screenRecording: nativeErrorSchema.shape.permission,
          accessibility: nativeErrorSchema.shape.permission,
          interactiveSession: z.boolean(),
          framework: z.literal("ScreenCaptureKit"),
          minimumOS: z.string(),
          processPath: z.string(),
          bundleId: z.string(),
          focusIdentification: z.literal("public-ax-owner-geometry"),
        })
        .optional(),
      permissions: z.record(z.string(), nativeErrorSchema.shape.permission),
      operations: z.record(
        z.string(),
        z.object({
          availability: z.enum(["available", "unavailable", "unsupported"]),
          verification: z.literal("untested"),
          backend: z.string(),
        }),
      ),
    })
    .optional(),
});
export const nativeCaptureSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  capturedAt: z.number().finite(),
  dataUrl: z.string().startsWith("data:image/png;base64,"),
  bounds: boundsSchema,
  native: z.object({
    helperInstanceId: z.string(),
    backend: z.string(),
    windowId: z.string(),
    geometry: z.object({
      inputSpace: nativeHandshakeSchema.shape.coordinateSpace,
      captureSpace: z.literal("pixels"),
      boundsKind: z.enum(["window", "portal-source"]),
      captureBounds: boundsSchema.optional(),
      dpi: z.number().int().positive().optional(),
      displayScale: z.number().positive().optional(),
      pixelToInput: z.object({
        scaleX: z.number().positive(),
        scaleY: z.number().positive(),
        offsetX: z.number().finite().optional(),
        offsetY: z.number().finite().optional(),
      }),
    }),
  }),
});
export interface NativeApplicationIdentity {
  id: string;
  kind: "wm-class" | "process-name" | "owner-name" | "pid-only" | "bundle-id";
  pid?: number;
}
export interface NativeDiagnostics {
  helper?: NativeHandshake;
  windows?: {
    graphicsCaptureSupported: boolean;
    interactiveDesktop: boolean;
    perMonitorV2: boolean;
    captureLibraryVersion?: string;
  };
  macos?: {
    screenRecording: NativeErrorDetails["permission"];
    accessibility: NativeErrorDetails["permission"];
    interactiveSession: boolean;
    framework: "ScreenCaptureKit";
    minimumOS: string;
    processPath: string;
    bundleId: string;
    focusIdentification: "public-ax-owner-geometry";
  };
  permissions?: Record<string, NativeErrorDetails["permission"]>;
  operations?: Record<
    string,
    {
      availability: "available" | "unavailable" | "unsupported";
      verification: "untested";
      backend: string;
    }
  >;
  lastError?: NativeErrorDetails;
}
export interface NativeCaptureMetadata {
  helperInstanceId: string;
  backend: string;
  windowId: string;
  application?: NativeApplicationIdentity;
  geometry: {
    inputSpace: NativeHandshake["coordinateSpace"];
    captureSpace: "pixels";
    boundsKind: "window" | "portal-source";
    captureBounds?: { x: number; y: number; width: number; height: number };
    dpi?: number;
    displayScale?: number;
    pixelToInput: {
      scaleX: number;
      scaleY: number;
      offsetX?: number;
      offsetY?: number;
    };
  };
}
