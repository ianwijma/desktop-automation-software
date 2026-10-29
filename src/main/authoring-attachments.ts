import { randomUUID, createHash } from "node:crypto";
import { mkdir, open, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  AttachmentError,
  attachmentLimits,
  attachmentUploadSchema,
  attachmentSessionSchema,
  attachmentRefSchema,
  type AuthoringAttachment,
  type AttachmentPreview,
} from "../shared/chat-attachments";
import type { PreparedAuthoringImage } from "../shared/chat-authoring";
import { prepareAuthoringImage } from "./authoring-images";

interface StoredImage {
  info: AuthoringAttachment;
  digest: string;
}
interface Session {
  closed: boolean;
  generation: number;
  pending: number;
}
interface Lease {
  sessionId: string;
  ids: string[];
  invalidated: boolean;
  cancel(): void;
}
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

/** Scratch attachments only. C04 owns durable history and restart retention. */
export class AuthoringAttachments {
  private images = new Map<string, StoredImage>();
  private sessions = new Map<string, Session>();
  private leases = new Set<Lease>();
  private preparing = 0;
  private importing = 0;
  private reservedBytes = 0;
  private usedBytes = 0;
  private disposed = false;
  private ready?: Promise<void>;
  constructor(
    private directory: string,
    private now = Date.now,
  ) {}
  private session(id: string) {
    attachmentSessionSchema.parse(id);
    if (this.disposed) throw new AttachmentError("closed-session");
    let session = this.sessions.get(id);
    if (!session) {
      if (this.sessions.size >= attachmentLimits.sessions)
        throw new AttachmentError("capacity");
      session = { closed: false, generation: 0, pending: 0 };
      this.sessions.set(id, session);
    }
    if (session.closed) throw new AttachmentError("closed-session");
    return session;
  }
  private path(id: string) {
    return join(this.directory, id + ".png");
  }
  private invalidate(id: string) {
    for (const lease of this.leases)
      if (lease.ids.includes(id) && !lease.invalidated) {
        lease.invalidated = true;
        lease.cancel();
      }
  }
  private async removeStored(image: StoredImage) {
    if (this.images.get(image.info.id) !== image) return;
    this.images.delete(image.info.id);
    this.invalidate(image.info.id);
    try {
      await rm(this.path(image.info.id), { force: true });
      this.usedBytes -= image.info.byteLength;
    } catch {
      // Failed deletion must not free quota or strand an unaccounted file.
      this.images.set(image.info.id, image);
      throw new AttachmentError("storage");
    }
  }
  private async expire() {
    for (const image of [...this.images.values()])
      if (
        image.info.state === "draft" &&
        this.now() - image.info.createdAt >= attachmentLimits.unsentAgeMs
      )
        await this.removeStored(image);
  }
  private async initialize() {
    if (!this.ready)
      this.ready = rm(this.directory, { recursive: true, force: true })
        .then(() => mkdir(this.directory, { recursive: true, mode: 0o700 }))
        .then(() => undefined);
    try {
      await this.ready;
    } catch {
      throw new AttachmentError("storage");
    }
    if (this.disposed) throw new AttachmentError("closed-session");
  }
  private record(sessionId: string, id: string, draftOnly = false) {
    this.session(sessionId);
    const image = this.images.get(id);
    if (
      !image ||
      image.info.sessionId !== sessionId ||
      (draftOnly && image.info.state !== "draft")
    )
      throw new AttachmentError("missing");
    return image;
  }
  private async bytes(image: StoredImage) {
    try {
      const file = await open(this.path(image.info.id), "r");
      try {
        const stat = await file.stat();
        if (
          !stat.isFile() ||
          stat.size !== image.info.byteLength ||
          stat.size > attachmentLimits.preparedBytes
        )
          throw new Error("changed");
        const buffer = Buffer.alloc(image.info.byteLength + 1);
        let offset = 0;
        while (offset < buffer.length) {
          const { bytesRead } = await file.read(
            buffer,
            offset,
            buffer.length - offset,
            offset,
          );
          if (!bytesRead) break;
          offset += bytesRead;
        }
        const bytes = buffer.subarray(0, offset);
        if (offset !== image.info.byteLength || digest(bytes) !== image.digest)
          throw new Error("changed");
        return bytes;
      } finally {
        await file.close();
      }
    } catch {
      throw new AttachmentError("storage");
    }
  }
  private async prepare(
    sessionId: string,
    name: string,
    source: AuthoringAttachment["source"],
    input: () => Promise<Uint8Array>,
  ): Promise<AuthoringAttachment> {
    await this.initialize();
    await this.expire();
    const session = this.session(sessionId),
      generation = session.generation;
    const draftCount = [...this.images.values()].filter(
      (i) => i.info.sessionId === sessionId && i.info.state === "draft",
    ).length;
    if (
      draftCount + session.pending >= attachmentLimits.perTurn ||
      this.images.size + this.preparing >= attachmentLimits.records ||
      this.usedBytes + this.reservedBytes + attachmentLimits.preparedBytes >
        attachmentLimits.storageBytes
    )
      throw new AttachmentError("capacity");
    if (this.preparing >= attachmentLimits.preparing)
      throw new AttachmentError("busy");
    this.preparing++;
    session.pending++;
    this.reservedBytes += attachmentLimits.preparedBytes;
    const id = randomUUID();
    let stored = false;
    try {
      const prepared = await prepareAuthoringImage(await input());
      if (session.closed || session.generation !== generation || this.disposed)
        throw new AttachmentError("closed-session");
      const info: AuthoringAttachment = {
        id,
        sessionId,
        name:
          name.replace(/[\u0000-\u001f\u007f/\\]/g, "").slice(0, 160) ||
          "Image",
        source,
        state: "draft",
        width: prepared.width,
        height: prepared.height,
        byteLength: prepared.bytes.byteLength,
        createdAt: this.now(),
      };
      await writeFile(this.path(id), prepared.bytes, {
        flag: "wx",
        mode: 0o600,
      });
      if (session.closed || session.generation !== generation || this.disposed)
        throw new AttachmentError("closed-session");
      this.images.set(id, { info, digest: digest(prepared.bytes) });
      this.usedBytes += info.byteLength;
      stored = true;
      return structuredClone(info);
    } catch (error) {
      if (error instanceof AttachmentError) throw error;
      throw new AttachmentError("storage");
    } finally {
      if (!stored) await rm(this.path(id), { force: true }).catch(() => {});
      this.preparing--;
      session.pending--;
      this.reservedBytes -= attachmentLimits.preparedBytes;
    }
  }
  import(input: unknown) {
    const upload = attachmentUploadSchema.parse(input);
    // Bound admission before the first await/copy, including initialization/pruning.
    if (
      this.importing >= attachmentLimits.preparing ||
      this.preparing >= attachmentLimits.preparing
    )
      return Promise.reject(new AttachmentError("busy"));
    this.importing++;
    const bytes = new Uint8Array(upload.bytes);
    return this.prepare(
      upload.sessionId,
      upload.name,
      upload.source,
      async () => bytes,
    ).finally(() => {
      this.importing--;
    });
  }
  capture(sessionId: string, name: string, capture: () => Promise<Uint8Array>) {
    return this.prepare(sessionId, name, "capture", capture);
  }
  async list(sessionId: string): Promise<AuthoringAttachment[]> {
    await this.initialize();
    await this.expire();
    this.session(sessionId);
    return [...this.images.values()]
      .filter((i) => i.info.sessionId === sessionId)
      .map((i) => structuredClone(i.info));
  }
  async preview(input: unknown): Promise<AttachmentPreview> {
    const ref = attachmentRefSchema.parse(input);
    await this.initialize();
    await this.expire();
    const image = this.record(ref.sessionId, ref.attachmentId),
      bytes = await this.bytes(image);
    if (this.images.get(image.info.id) !== image)
      throw new AttachmentError("missing");
    this.session(ref.sessionId);
    return {
      attachment: structuredClone(image.info),
      mimeType: "image/png",
      bytes: new Uint8Array(bytes),
    };
  }
  async reuse(input: unknown): Promise<AuthoringAttachment> {
    const ref = attachmentRefSchema.parse(input);
    await this.initialize();
    await this.expire();
    const image = this.record(ref.sessionId, ref.attachmentId);
    return this.prepare(ref.sessionId, image.info.name, "reuse", () =>
      this.bytes(image),
    );
  }
  async delete(input: unknown) {
    const ref = attachmentRefSchema.parse(input);
    await this.initialize();
    await this.expire();
    const image = this.record(ref.sessionId, ref.attachmentId);
    await this.removeStored(image);
  }
  async close(sessionId: string) {
    await this.initialize();
    const session = this.session(sessionId);
    session.closed = true;
    session.generation++;
    for (const image of [...this.images.values()])
      if (image.info.sessionId === sessionId) await this.removeStored(image);
  }
  async lease(sessionId: string, ids: string[], cancel: () => void) {
    await this.initialize();
    await this.expire();
    this.session(sessionId);
    if (
      ids.length > attachmentLimits.perTurn ||
      new Set(ids).size !== ids.length
    )
      throw new AttachmentError("capacity");
    const selected = ids.map((id) => this.record(sessionId, id, true));
    const lease: Lease = { sessionId, ids, invalidated: false, cancel };
    this.leases.add(lease);
    try {
      const images: PreparedAuthoringImage[] = [];
      for (const image of selected) {
        const bytes = await this.bytes(image);
        if (this.images.get(image.info.id) !== image)
          throw new AttachmentError("missing");
        images.push({
          width: image.info.width,
          height: image.info.height,
          dataUrl: "data:image/png;base64," + bytes.toString("base64"),
        });
      }
      this.session(sessionId);
      if (lease.invalidated || selected.some((i) => i.info.state !== "draft"))
        throw new AttachmentError("missing");
      // A prior turn's images never become context implicitly. Reuse allocates a new draft ID.
      selected.forEach((i) => {
        i.info.state = "sent";
      });
      return {
        images,
        current: () =>
          !this.disposed &&
          !this.sessions.get(sessionId)?.closed &&
          !lease.invalidated,
        release: () => {
          this.leases.delete(lease);
        },
      };
    } catch (error) {
      this.leases.delete(lease);
      throw error;
    }
  }
  async closeAll() {
    await this.initialize();
    for (const session of this.sessions.values()) {
      session.closed = true;
      session.generation++;
    }
    for (const image of [...this.images.values()])
      await this.removeStored(image);
  }
  dispose() {
    this.disposed = true;
    for (const lease of this.leases) {
      lease.invalidated = true;
      lease.cancel();
    }
    this.leases.clear();
    for (const session of this.sessions.values()) {
      session.closed = true;
      session.generation++;
    }
  }
}

/** Main-only bridge: no arbitrary screen/window/frame ID is accepted from the renderer. */
export async function captureChosenAuthoringWindow(
  attachments: AuthoringAttachments,
  request: { sessionId: string; targetId: string },
  options: {
    target(id: string): import("../shared/types").TargetDescriptor | undefined;
    capture(
      target: import("../shared/types").TargetDescriptor,
    ): Promise<{ dataUrl: string }>;
  },
) {
  const target = options.target(request.targetId);
  if (!target || target.kind !== "desktop")
    throw new AttachmentError("capture-unavailable");
  const snapshot = structuredClone(target),
    stamp = JSON.stringify(snapshot);
  const current = () =>
    stamp === JSON.stringify(options.target(request.targetId));
  const attachment = await attachments.capture(
    request.sessionId,
    snapshot.name + " capture",
    async () => {
      let frame: { dataUrl: string };
      try {
        frame = await options.capture(snapshot);
      } catch {
        throw new AttachmentError("capture-unavailable");
      }
      if (!current()) throw new AttachmentError("stale-capture");
      const match =
        /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(
          frame.dataUrl,
        );
      if (
        !match ||
        match[1].length > Math.ceil(attachmentLimits.sourceBytes / 3) * 4
      )
        throw new AttachmentError("source-limit");
      const bytes = Buffer.from(match[1], "base64");
      if (bytes.toString("base64") !== match[1])
        throw new AttachmentError("invalid-image");
      return bytes;
    },
  );
  if (!current()) {
    await attachments.delete({
      sessionId: request.sessionId,
      attachmentId: attachment.id,
    });
    throw new AttachmentError("stale-capture");
  }
  return attachment;
}
