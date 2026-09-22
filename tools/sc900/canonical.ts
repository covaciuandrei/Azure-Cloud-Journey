import { createHash } from "node:crypto";
import { SC900_EXAM_ID, Sc900CaptureLedgerSchema, type Sc900CaptureLedger } from "../../src/domain/sc900Capture.js";
import type { Sc900Question } from "../../src/domain/sc900Bank.js";

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (Array.from({ length: value.length }, (_, index) => index).some((index) => !(index in value))) {
      throw new Error("Cannot canonicalize sparse arrays");
    }
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error("SC900 canonical hashes require plain finite JSON values");
  }
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

export function byteSha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function sc900Hash(scope: string, value: unknown): string {
  if (!/^[a-z][a-z0-9-]*$/.test(scope)) throw new Error("Invalid SC900 canonical hash scope");
  return byteSha256(canonicalJson({ schemaVersion: 1, examId: SC900_EXAM_ID, scope, value }));
}

export function sc900QuestionIdentity(question: Pick<Sc900Question, "kind" | "prompt" | "options">): unknown {
  return { kind: question.kind, prompt: question.prompt, options: question.options };
}

export function sc900QuestionId(question: Pick<Sc900Question, "kind" | "prompt" | "options">): string {
  return `q_${sc900Hash("question", sc900QuestionIdentity(question))}`;
}

export function sc900SourceRevision(ledger: Sc900CaptureLedger): string {
  return sc900Hash("source", Sc900CaptureLedgerSchema.parse(ledger));
}

export function sc900OptionId(content: unknown): string {
  return `opt_${sc900Hash("option", content)}`;
}
