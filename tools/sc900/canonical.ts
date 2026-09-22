import { createHash } from "node:crypto";
import { SC900_EXAM_ID, type Sc900CaptureLedger } from "../../src/domain/sc900Capture.js";
import {
  Sc900PublicationCaptureLedgerSchema, Sc900QuestionsOnlyAuthorizationSchema, Sc900ScopedCaptureLedgerSchema,
  type Sc900PublicationCaptureLedger, type Sc900QuestionsOnlyAuthorization, type Sc900ScopedCaptureLedger,
} from "../../src/domain/sc900Scope.js";
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

export function sc900SourceRevision(ledger: Sc900PublicationCaptureLedger): string {
  return sc900Hash("source", Sc900PublicationCaptureLedgerSchema.parse(ledger));
}

export function sc900OptionId(content: unknown): string {
  return `opt_${sc900Hash("option", content)}`;
}

export function sc900RawPageInventoryDigest(pages: Sc900CaptureLedger["pages"]): string {
  return sc900Hash("raw-page-inventory", [...pages].sort((a, b) => a.pageNumber - b.pageNumber));
}
export function sc900AssetInventoryDigest(assets: Sc900CaptureLedger["assets"]): string {
  return sc900Hash("capture-asset-inventory", [...assets].sort((a, b) => a.id.localeCompare(b.id)));
}
export function sc900AuthorizationDigest(receipt: Sc900QuestionsOnlyAuthorization): string {
  return sc900Hash("questions-only-authorization", Sc900QuestionsOnlyAuthorizationSchema.parse(receipt));
}
export function assertSc900ScopedAuthorization(
  input: Sc900ScopedCaptureLedger, receiptInput: Sc900QuestionsOnlyAuthorization,
): void {
  const ledger = Sc900ScopedCaptureLedgerSchema.parse(input);
  const receipt = Sc900QuestionsOnlyAuthorizationSchema.parse(receiptInput);
  if (ledger.authorizationDigest !== sc900AuthorizationDigest(receipt) ||
      ledger.sourceScopeReceiptSha256 !== receipt.sourceScopeReceiptSha256 ||
      ledger.rawPageInventoryDigest !== receipt.rawPageInventoryDigest ||
      ledger.assetInventoryDigest !== receipt.assetInventoryDigest ||
      ledger.rawPageInventoryDigest !== sc900RawPageInventoryDigest(ledger.pages) ||
      ledger.assetInventoryDigest !== sc900AssetInventoryDigest(ledger.assets) ||
      ledger.reported.questions !== receipt.questions || ledger.reported.pages !== receipt.pages ||
      ledger.assets.length !== receipt.images) {
    throw new Error("Owner authorization does not bind the exact SC900 questions, source scope, raw pages and original assets.");
  }
}
