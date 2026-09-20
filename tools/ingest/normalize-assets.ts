import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { inflateSync } from "node:zlib";
import { AssetSchema, type Asset, type AssetUse } from "../../src/domain/index.js";
import {
  fail, sha256, workspacePath, relativeWorkspacePath, type RawAsset,
} from "./normalize-shared.js";

type ImageInfo = Pick<Asset, "contentType" | "extension" | "width" | "height">;
export interface CapturedAsset {
  metadata: Asset;
  bytes: Buffer;
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngInfo(bytes: Buffer, context: string): ImageInfo {
  if (bytes.length < 45 || bytes.toString("hex", 0, 8) !== "89504e470d0a1a0a") {
    fail(context, "invalid PNG signature or truncated PNG");
  }
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let ended = false;
  let ihdrSeen = false;
  const compressed: Buffer[] = [];
  for (let offset = 8; offset < bytes.length;) {
    if (offset + 12 > bytes.length) fail(context, "truncated PNG chunk");
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) fail(context, "PNG chunk length exceeds captured bytes");
    const kind = bytes.toString("ascii", offset + 4, offset + 8);
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) {
      fail(context, `PNG ${kind} CRC mismatch`);
    }
    if (offset === 8 && kind !== "IHDR") fail(context, "PNG does not start with IHDR");
    if (kind === "IHDR") {
      if (length !== 13 || ihdrSeen) fail(context, "invalid or repeated PNG IHDR");
      ihdrSeen = true;
      width = bytes.readUInt32BE(offset + 8);
      height = bytes.readUInt32BE(offset + 12);
      bitDepth = bytes[offset + 16]!;
      colorType = bytes[offset + 17]!;
      interlace = bytes[offset + 20]!;
      if (bytes[offset + 18] !== 0 || bytes[offset + 19] !== 0 || interlace > 1) {
        fail(context, "unsupported PNG compression/filter/interlace method");
      }
    }
    if (kind === "IDAT") compressed.push(bytes.subarray(offset + 8, end - 4));
    if (kind === "IEND") {
      if (length !== 0 || end !== bytes.length) fail(context, "invalid PNG end or trailing bytes");
      ended = true;
    }
    offset = end;
  }
  if (!width || !height || !ended || !compressed.length) fail(context, "PNG is missing dimensions/image data/end");
  const depths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
  if (!depths[colorType]?.includes(bitDepth)) fail(context, "invalid PNG color type/bit depth");
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colorType]!;
  const passes = interlace === 0 ? [[0, 0, 1, 1]] :
    [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];
  const rows: { count: number; bytes: number }[] = [];
  for (const [x, y, dx, dy] of passes as [number, number, number, number][]) {
    const passWidth = Math.max(0, Math.ceil((width - x) / dx));
    const passHeight = Math.max(0, Math.ceil((height - y) / dy));
    if (passWidth && passHeight) rows.push({
      count: passHeight, bytes: 1 + Math.ceil(passWidth * channels * bitDepth / 8),
    });
  }
  const decodedLength = rows.reduce((sum, row) => sum + row.count * row.bytes, 0);
  if (decodedLength > 128 * 1024 * 1024) fail(context, "PNG exceeds the 128 MiB decoded-image safety limit");
  let decoded: Buffer;
  try {
    decoded = inflateSync(Buffer.concat(compressed), { maxOutputLength: decodedLength + 1 });
  } catch (error) {
    fail(context, `unreadable PNG compressed data: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (decoded.length !== decodedLength) fail(context, "PNG decoded scanline length does not match dimensions");
  let offset = 0;
  for (const row of rows) {
    for (let index = 0; index < row.count; index++) {
      if (decoded[offset]! > 4) fail(context, "invalid PNG scanline filter");
      offset += row.bytes;
    }
  }
  return { contentType: "image/png", extension: "png", width, height };
}

function jpegInfo(bytes: Buffer, context: string): ImageInfo {
  if (bytes.length < 12 || bytes[0] !== 0xff || bytes[1] !== 0xd8 ||
      bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) {
    fail(context, "invalid/truncated JPEG signature");
  }
  let width = 0;
  let height = 0;
  let scan = false;
  for (let offset = 2; offset < bytes.length - 2;) {
    if (bytes[offset++] !== 0xff) fail(context, "invalid JPEG marker");
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === undefined) fail(context, "truncated JPEG marker");
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) fail(context, "truncated JPEG segment");
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) fail(context, "invalid JPEG segment length");
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (length < 8) fail(context, "truncated JPEG frame dimensions");
      height = bytes.readUInt16BE(offset + 3);
      width = bytes.readUInt16BE(offset + 5);
    }
    if (marker === 0xda) { scan = true; break; }
    offset += length;
  }
  if (!width || !height || !scan) fail(context, "JPEG is missing frame dimensions or image scan");
  return { contentType: "image/jpeg", extension: "jpg", width, height };
}

function gifInfo(bytes: Buffer, context: string): ImageInfo {
  if (bytes.length < 14 || !["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6)) ||
      bytes[bytes.length - 1] !== 0x3b || !bytes.subarray(13).includes(0x2c)) {
    fail(context, "invalid/truncated GIF signature, image descriptor or trailer");
  }
  const width = bytes.readUInt16LE(6);
  const height = bytes.readUInt16LE(8);
  if (!width || !height) fail(context, "GIF dimensions must be positive");
  return { contentType: "image/gif", extension: "gif", width, height };
}

function webpInfo(bytes: Buffer, context: string): ImageInfo {
  if (bytes.length < 30 || bytes.toString("ascii", 0, 4) !== "RIFF" ||
      bytes.toString("ascii", 8, 12) !== "WEBP" || bytes.readUInt32LE(4) + 8 !== bytes.length) {
    fail(context, "invalid/truncated WebP RIFF signature or length");
  }
  let width = 0;
  let height = 0;
  let imageSeen = false;
  for (let offset = 12; offset < bytes.length;) {
    if (offset + 8 > bytes.length) fail(context, "truncated WebP chunk header");
    const kind = bytes.toString("ascii", offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + length;
    if (end > bytes.length) fail(context, "WebP chunk exceeds captured bytes");
    if (kind === "VP8X") {
      if (length !== 10) fail(context, "invalid WebP extended header");
      width = bytes.readUIntLE(start + 4, 3) + 1;
      height = bytes.readUIntLE(start + 7, 3) + 1;
    }
    if (kind === "VP8 ") {
      if (length < 10 || bytes.toString("hex", start + 3, start + 6) !== "9d012a") fail(context, "invalid WebP VP8 frame");
      width ||= bytes.readUInt16LE(start + 6) & 0x3fff;
      height ||= bytes.readUInt16LE(start + 8) & 0x3fff;
      imageSeen = true;
    }
    if (kind === "VP8L") {
      if (length < 5 || bytes[start] !== 0x2f) fail(context, "invalid WebP lossless frame");
      const bits = bytes.readUInt32LE(start + 1);
      width ||= (bits & 0x3fff) + 1;
      height ||= ((bits >>> 14) & 0x3fff) + 1;
      imageSeen = true;
    }
    if (kind === "ANMF") {
      if (length < 24) fail(context, "truncated animated WebP frame");
      imageSeen = true;
    }
    offset = end + (length % 2);
  }
  if (!width || !height || !imageSeen) fail(context, "WebP is missing readable dimensions or image chunks");
  return { contentType: "image/webp", extension: "webp", width, height };
}

export function inspectImage(bytes: Buffer, mimeType: string, context: string): ImageInfo {
  const mime = mimeType.split(";")[0]!.trim().toLowerCase();
  switch (mime) {
    case "image/png": return pngInfo(bytes, context);
    case "image/jpeg": return jpegInfo(bytes, context);
    case "image/gif": return gifInfo(bytes, context);
    case "image/webp": return webpInfo(bytes, context);
    default: return fail(context, `unsupported/unsafe image MIME type ${mimeType}; retain raw bytes for explicit conversion`);
  }
}

function signatureMime(bytes: Buffer, context: string): Asset["contentType"] {
  if (bytes.toString("hex", 0, 8) === "89504e470d0a1a0a") return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))) return "image/gif";
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return fail(context, "captured bytes have no supported inert raster image signature");
}

export function decodeCapturedAsset(
  raw: RawAsset, assetDirectory: string, context: string,
): CapturedAsset {
  if (raw.base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(raw.base64)) {
    fail(context, "invalid canonical base64 image data");
  }
  const bytes = Buffer.from(raw.base64, "base64");
  if (bytes.toString("base64") !== raw.base64 || bytes.length !== raw.byteLength) {
    fail(context, `base64/byteLength mismatch: declared ${raw.byteLength}, decoded ${bytes.length}`);
  }
  const declaredMime = raw.contentType.split(";")[0]!.trim().toLowerCase();
  if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(declaredMime)) {
    fail(context, `unsupported/unsafe captured image MIME type ${raw.contentType}`);
  }
  const info = inspectImage(bytes, signatureMime(bytes, context), context);
  const hash = sha256(bytes);
  return {
    bytes,
    metadata: AssetSchema.parse({
      schemaVersion: 1, id: hash, sha256: hash, ...info, byteLength: bytes.length,
      filePath: `${assetDirectory}/${hash}.${info.extension}`,
      sourceUrls: [raw.url], sourceResponses: [{ url: raw.url, declaredContentType: raw.contentType }], uses: [],
      validation: {
        signature: "verified", dimensions: "verified",
        mime: info.contentType === declaredMime ? "matched" : "corrected-from-signature",
      },
    }),
  };
}

export class AssetRegistry {
  readonly assets = new Map<string, CapturedAsset>();

  add(raw: RawAsset, assetDirectory: string, context: string): CapturedAsset {
    const decoded = decodeCapturedAsset(raw, assetDirectory, context);
    const existing = this.assets.get(decoded.metadata.id);
    if (existing) {
      if (!existing.bytes.equals(decoded.bytes) || existing.metadata.contentType !== decoded.metadata.contentType) {
        fail(context, `conflicting content for asset ${decoded.metadata.id}`);
      }
      existing.metadata.sourceUrls = [...new Set([...existing.metadata.sourceUrls, raw.url])].sort();
      if (!existing.metadata.sourceResponses.some((response) => response.url === raw.url && response.declaredContentType === raw.contentType)) {
        existing.metadata.sourceResponses.push({ url: raw.url, declaredContentType: raw.contentType });
      }
      if (decoded.metadata.validation.mime === "corrected-from-signature") existing.metadata.validation.mime = "corrected-from-signature";
      return existing;
    }
    this.assets.set(decoded.metadata.id, decoded);
    return decoded;
  }

  use(assetId: string, use: AssetUse): void {
    const asset = this.assets.get(assetId);
    if (!asset) throw new Error(`Cannot reference unknown captured asset ${assetId}`);
    asset.metadata.uses.push(use);
  }

  records(): Asset[] {
    return [...this.assets.values()].map(({ metadata }) => AssetSchema.parse({
      ...metadata,
      sourceUrls: [...metadata.sourceUrls].sort(),
      sourceResponses: [...metadata.sourceResponses].sort((a, b) =>
        a.url.localeCompare(b.url) || a.declaredContentType.localeCompare(b.declaredContentType)),
      uses: [...metadata.uses].sort((a, b) =>
        a.sourceOccurrenceId.localeCompare(b.sourceOccurrenceId) || a.presentationIndex - b.presentationIndex),
    })).sort((a, b) => a.id.localeCompare(b.id));
  }

  async unpack(workspace: string, assetDirectory: string): Promise<void> {
    const localDirectory = relativeWorkspacePath(workspace, assetDirectory);
    for (const { metadata, bytes } of this.assets.values()) {
      if (!metadata.filePath.startsWith(`${localDirectory}/`)) {
        throw new Error(`Asset path is outside the requested asset directory: ${metadata.filePath}`);
      }
      const path = workspacePath(workspace, metadata.filePath);
      await mkdir(dirname(path), { recursive: true });
      try {
        await writeFile(path, bytes, { flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const stat = await lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Refusing non-regular existing asset ${metadata.filePath}`);
        const existing = await readFile(path);
        if (sha256(existing) !== metadata.sha256 || !existing.equals(bytes)) {
          throw new Error(`Conflicting existing asset ${metadata.filePath}; left untouched`);
        }
      }
    }
  }
}
