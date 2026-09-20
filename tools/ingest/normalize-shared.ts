import { createHash } from "node:crypto";
import { resolve, relative, sep } from "node:path";
import { z } from "zod";
import {
  SafeUrlSchema, TimestampSchema, type RichContent, type Inline,
} from "../../src/domain/index.js";

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const json = JSON.stringify(value);
    if (json === undefined) throw new Error("Cannot canonicalize undefined values");
    return json;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

export function digest(value: unknown): string {
  return sha256(canonicalJson(value));
}

export function jsonFile(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function workspacePath(workspace: string, path: string): string {
  const absolute = resolve(workspace, path);
  const local = relative(resolve(workspace), absolute);
  if (!local || local === ".." || local.startsWith(`..${sep}`)) {
    throw new Error(`Path must be a child of the workspace: ${path}`);
  }
  return absolute;
}

export function relativeWorkspacePath(workspace: string, path: string): string {
  return relative(resolve(workspace), workspacePath(workspace, path)).split(sep).join("/");
}

export function fail(context: string, message: string): never {
  throw new Error(`${context}: ${message}`);
}

export const RawAssetSchema = z.object({
  url: SafeUrlSchema, contentType: z.string().min(1),
  byteLength: z.number().int().positive(), base64: z.string().min(1),
}).passthrough();
export type RawAsset = z.infer<typeof RawAssetSchema>;
export const RawImageSchema = z.object({
  src: z.string().nullable(), currentSrc: SafeUrlSchema, alt: z.string(),
  width: z.number().int().nonnegative(), height: z.number().int().nonnegative(), loaded: z.boolean(),
}).passthrough();
export type RawImage = z.infer<typeof RawImageSchema>;
export const RawQuestionSchema = z.object({
  heading: z.string().regex(/^Question \d+$/),
  html: z.string().min(1),
  renderedText: z.string().min(1),
  choiceStyles: z.array(z.object({
    label: z.string().regex(/^[A-Z]$/), text: z.string(),
    borderColor: z.string().min(1), borderWidth: z.string().min(1),
  }).passthrough()),
  commentCount: z.number().int().nonnegative(),
  remainingControls: z.array(z.string()),
  images: z.array(RawImageSchema),
  answerRevealed: z.boolean().optional(),
  loadingIndicators: z.number().int().nonnegative().optional(),
  discussionLoad: z.object({
    status: z.enum(["loaded", "rendered-only", "loading", "receiving", "failed"]),
    httpStatus: z.number().int().optional(), error: z.string().optional(),
  }).passthrough().optional(),
}).passthrough();
export type RawQuestion = z.infer<typeof RawQuestionSchema>;
export const RawCaptureSchema = z.object({
  captureVersion: z.literal(1),
  method: z.literal("rendered-browser-ui"),
  url: SafeUrlSchema,
  title: z.string().min(1),
  capturedAt: TimestampSchema,
  questions: z.array(RawQuestionSchema).min(1),
  assets: z.array(RawAssetSchema).default([]),
}).passthrough();
export type RawCapture = z.infer<typeof RawCaptureSchema>;

export function safeUrl(value: string, baseUrl: string): string | null {
  try {
    const url = new URL(value, baseUrl).href;
    return SafeUrlSchema.safeParse(url).success ? url : null;
  } catch {
    return null;
  }
}

export function plainText(content: RichContent): string {
  const spans = (values: Inline[]) => values.map((span) => span.text).join("");
  return content.map((block) => {
    switch (block.type) {
      case "text": case "heading": return spans(block.spans);
      case "code": return block.code;
      case "image": return block.alt;
      case "quote": return plainText(block.blocks);
      case "list": return block.items.map(plainText).join("\n");
      case "table": return [
        ...(block.caption.length ? [spans(block.caption)] : []),
        ...block.rows.map((row) => row.cells.map((cell) => plainText(cell.blocks)).join("\t")),
      ].join("\n");
      case "separator": return "";
    }
  }).join("\n");
}

export function occurrenceId(questionNumber: number): string {
  return `examprepper-45-q${String(questionNumber).padStart(6, "0")}`;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
