import { z } from "zod";
export const attachmentLimits = Object.freeze({
  sourceBytes: 8 * 1024 * 1024,
  sourcePixels: 40_000_000,
  preparedBytes: 2 * 1024 * 1024,
  preparedSide: 2048,
  perTurn: 4,
  storageBytes: 256 * 1024 * 1024,
  records: 512,
  sessions: 256,
  preparing: 2,
  unsentAgeMs: 24 * 60 * 60 * 1000,
});
export const attachmentSessionSchema = z.string().uuid();
export const attachmentRefSchema = z
  .object({
    sessionId: attachmentSessionSchema,
    attachmentId: z.string().uuid(),
  })
  .strict();
export const attachmentUploadSchema = z
  .object({
    sessionId: attachmentSessionSchema,
    name: z.string().min(1).max(160),
    source: z.enum(["file", "paste", "drop"]),
    bytes: z
      .instanceof(Uint8Array)
      .refine(
        (b) => b.byteLength > 0 && b.byteLength <= attachmentLimits.sourceBytes,
        "Use an image of at most 8 MiB.",
      ),
  })
  .strict();
export type AttachmentUpload = z.infer<typeof attachmentUploadSchema>;
export const attachmentCaptureSchema = z
  .object({
    sessionId: attachmentSessionSchema,
    targetId: z.string().min(1).max(200),
  })
  .strict();
export interface AuthoringAttachment {
  id: string;
  sessionId: string;
  name: string;
  source: "file" | "paste" | "drop" | "capture" | "reuse";
  state: "draft" | "sent";
  width: number;
  height: number;
  byteLength: number;
  createdAt: number;
}
export interface AttachmentPreview {
  attachment: AuthoringAttachment;
  mimeType: "image/png";
  bytes: Uint8Array;
}
export type AttachmentErrorCode =
  | "invalid-image"
  | "source-limit"
  | "animated-image"
  | "capacity"
  | "missing"
  | "closed-session"
  | "capture-unavailable"
  | "stale-capture"
  | "busy"
  | "storage";
export const attachmentMessages: Record<AttachmentErrorCode, string> = {
  "invalid-image":
    "This image is corrupt or unsupported. Choose a static PNG, JPEG or WebP.",
  "source-limit": "Images must be at most 8 MiB and 40 megapixels.",
  "animated-image":
    "Animated images are not supported. Choose a static PNG, JPEG or WebP.",
  capacity:
    "Image storage or this turn is full. Remove images or clear the session; a turn allows four images.",
  missing:
    "This image was deleted, expired, already sent or belongs to another session. Add it again or choose Reuse.",
  "closed-session": "This authoring session has closed. Start a new session.",
  "capture-unavailable":
    "The chosen window could not be captured. Check its target and capture permissions, then try again.",
  "stale-capture":
    "The chosen target changed during capture. Choose it again and take a new capture.",
  busy: "Image preparation is busy. Wait for the current import or capture to finish.",
  storage:
    "The prepared image could not be stored or read. Remove it and add it again.",
};
export class AttachmentError extends Error {
  constructor(public readonly code: AttachmentErrorCode) {
    super(attachmentMessages[code]);
    this.name = "AttachmentError";
  }
}
