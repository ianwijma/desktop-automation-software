import sharp from "sharp";
import { AttachmentError, attachmentLimits } from "../shared/chat-attachments";

function stillFormat(bytes: Buffer): "png" | "jpeg" | "webp" {
  if (
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    let ended = false;
    for (let offset = 8; offset < bytes.length;) {
      if (offset + 12 > bytes.length)
        throw new AttachmentError("invalid-image");
      const length = bytes.readUInt32BE(offset),
        type = bytes.toString("ascii", offset + 4, offset + 8);
      if (length > bytes.length - offset - 12)
        throw new AttachmentError("invalid-image");
      if (type === "acTL" || type === "fcTL" || type === "fdAT")
        throw new AttachmentError("animated-image");
      offset += length + 12;
      if (type === "IEND") {
        if (length || offset !== bytes.length)
          throw new AttachmentError("invalid-image");
        ended = true;
      }
    }
    if (!ended) throw new AttachmentError("invalid-image");
    return "png";
  }
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "jpeg";
  if (
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    if (bytes.readUInt32LE(4) + 8 !== bytes.length)
      throw new AttachmentError("invalid-image");
    for (let offset = 12; offset < bytes.length;) {
      if (offset + 8 > bytes.length) throw new AttachmentError("invalid-image");
      const length = bytes.readUInt32LE(offset + 4),
        type = bytes.toString("ascii", offset, offset + 4);
      if (length > bytes.length - offset - 8)
        throw new AttachmentError("invalid-image");
      if (
        type === "ANIM" ||
        type === "ANMF" ||
        (type === "VP8X" && bytes[offset + 8]! & 2)
      )
        throw new AttachmentError("animated-image");
      offset += 8 + length + (length % 2);
      if (offset > bytes.length) throw new AttachmentError("invalid-image");
    }
    return "webp";
  }
  throw new AttachmentError("invalid-image");
}
/** Decode only bounded static rasters; no original bytes/EXIF are retained. */
export async function prepareAuthoringImage(input: Uint8Array) {
  if (
    !(input instanceof Uint8Array) ||
    !input.byteLength ||
    input.byteLength > attachmentLimits.sourceBytes
  )
    throw new AttachmentError("source-limit");
  const bytes = Buffer.from(input),
    format = stillFormat(bytes);
  try {
    const image = sharp(bytes, {
      limitInputPixels: attachmentLimits.sourcePixels,
      failOn: "warning",
      pages: 1,
    });
    const metadata = await image.metadata();
    if (metadata.format !== format || !metadata.width || !metadata.height)
      throw new AttachmentError("invalid-image");
    if (metadata.width * metadata.height > attachmentLimits.sourcePixels)
      throw new AttachmentError("source-limit");
    if ((metadata.pages ?? 1) !== 1)
      throw new AttachmentError("animated-image");
    // Sharp strips metadata by default. autoOrient applies EXIF, then removes it.
    for (const side of [2048, 1536, 1024, 768, 512]) {
      const output = await image
        .clone()
        .autoOrient()
        .resize({
          width: side,
          height: side,
          fit: "inside",
          withoutEnlargement: true,
        })
        .toColourspace("srgb")
        .png({ compressionLevel: 9 })
        .timeout({ seconds: 10 })
        .toBuffer({ resolveWithObject: true });
      if (output.data.byteLength <= attachmentLimits.preparedBytes)
        return {
          bytes: output.data,
          width: output.info.width,
          height: output.info.height,
        };
    }
    throw new AttachmentError("source-limit");
  } catch (error) {
    if (error instanceof AttachmentError) throw error;
    // Never expose decoder messages, file paths or embedded image text.
    if (error instanceof Error && /pixel limit/i.test(error.message))
      throw new AttachmentError("source-limit");
    throw new AttachmentError("invalid-image");
  }
}
