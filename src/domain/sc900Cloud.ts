import { z } from "zod";
import { QuestionIdSchema, Sha256Schema } from "./schemas.js";

export const Sc900CloudEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  examId: z.literal("sc900"),
  encoding: z.literal("sc900-json-v1"),
  sha256: Sha256Schema,
  payload: z.string().min(2).max(800_000),
  questionId: QuestionIdSchema.optional(),
}).strict();
export type Sc900CloudEnvelope = z.infer<typeof Sc900CloudEnvelopeSchema>;

export async function decodeSc900CloudEnvelope(raw: unknown): Promise<unknown> {
  const envelope = Sc900CloudEnvelopeSchema.parse(raw);
  const bytes = new TextEncoder().encode(envelope.payload);
  if (bytes.length > 800_000) throw new Error("SC-900 cloud content exceeds its byte limit.");
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  if (hash !== envelope.sha256) throw new Error("SC-900 cloud content failed its integrity check.");
  const value: unknown = JSON.parse(envelope.payload);
  if (!value || typeof value !== "object" || !("examId" in value) || value.examId !== "sc900") {
    throw new Error("SC-900 cloud content belongs to a different exam.");
  }
  if (envelope.questionId && (!("questionId" in value) || value.questionId !== envelope.questionId)) {
    throw new Error("SC-900 cloud comment query identity does not match its content.");
  }
  return value;
}
