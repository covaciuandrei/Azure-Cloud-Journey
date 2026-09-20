import { Timestamp } from "firebase/firestore";
import { z } from "zod";
import { PracticeAttemptSchema, type PracticeAttempt } from "../engine.js";

const uuid = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
);
const timestamp = z.custom<Timestamp>((value) =>
  value instanceof Timestamp &&
  Number.isSafeInteger(value.seconds) &&
  value.seconds >= -62_135_596_800 && value.seconds <= 253_402_300_799 &&
  Number.isInteger(value.nanoseconds) &&
  value.nanoseconds >= 0 && value.nanoseconds < 1_000_000_000,
);
const ActiveDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  revision: uuid,
  attempt: PracticeAttemptSchema.nullable(),
  updatedAt: timestamp,
}).strict();
const HistoryDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  attempt: PracticeAttemptSchema,
  finishedAt: z.number().int().nonnegative().finite(),
  updatedAt: timestamp,
}).strict();

export const MAX_PROGRESS_DOCUMENT_BYTES = 800_000;
export const RECENT_HISTORY_LIMIT = 20;

export class ProgressConflictError extends Error {
  readonly code = "account/progress-conflict";

  constructor(
    readonly expectedRevision: string | null,
    readonly actualRevision: string | null,
  ) {
    super("Your account progress changed on another device. Reload cloud progress before saving again.");
    this.name = "ProgressConflictError";
  }
}

export class ProgressIdentityError extends Error {
  readonly code = "account/identity-mismatch";

  constructor() {
    super("The signed-in account changed. Sign in to the correct account before accessing progress.");
    this.name = "ProgressIdentityError";
  }
}

export class ProgressValidationError extends Error {
  readonly code = "account/invalid-progress";

  constructor(message = "Account progress is invalid and could not be loaded or saved.") {
    super(message);
    this.name = "ProgressValidationError";
  }
}

export interface AccountProgress {
  revision: string | null;
  activeAttempt: PracticeAttempt | null;
  history: PracticeAttempt[];
}

export interface ProgressDocument {
  id: string;
  data: unknown;
}

export interface ProgressTransaction {
  get: (path: string) => Promise<ProgressDocument | null>;
  set: (path: string, data: Record<string, unknown>) => void;
}

export interface ProgressAdapter {
  currentUser: () => { readonly uid: string } | null;
  readDocument: (path: string) => Promise<ProgressDocument | null>;
  readHistory: (path: string, count: number) => Promise<ProgressDocument[]>;
  transaction: <T>(operation: (transaction: ProgressTransaction) => Promise<T>) => Promise<T>;
  newRevision: () => string;
  serverTimestamp: () => unknown;
}

export function validateAccountUid(uid: string): void {
  if (typeof uid !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(uid)) {
    throw new ProgressValidationError("The account identity is not a valid progress path.");
  }
}

function parseAttempt(input: unknown): PracticeAttempt {
  const parsed = PracticeAttemptSchema.safeParse(input);
  if (!parsed.success || !uuid.safeParse(parsed.data.id).success) {
    throw new ProgressValidationError();
  }
  const attempt = parsed.data;
  if (attempt.dataSource === undefined) delete attempt.dataSource;
  return attempt;
}

function parseActive(document: ProgressDocument | null): {
  revision: string | null;
  attempt: PracticeAttempt | null;
} {
  if (document === null) return { revision: null, attempt: null };
  const parsed = ActiveDocumentSchema.safeParse(document.data);
  if (document.id !== "active" || !parsed.success) throw new ProgressValidationError();
  const attempt = parsed.data.attempt === null ? null : parseAttempt(parsed.data.attempt);
  if (attempt && attempt.status !== "active") throw new ProgressValidationError();
  return { revision: parsed.data.revision, attempt };
}

function parseHistory(document: ProgressDocument): PracticeAttempt {
  const parsed = HistoryDocumentSchema.safeParse(document.data);
  if (!parsed.success) throw new ProgressValidationError();
  const attempt = parseAttempt(parsed.data.attempt);
  if (attempt.id !== document.id || attempt.status !== "completed" ||
      attempt.finishedAt !== parsed.data.finishedAt) {
    throw new ProgressValidationError();
  }
  return attempt;
}

const bytes = (value: string): number => new TextEncoder().encode(value).length + 1;

function valueBytes(value: unknown): number {
  if (typeof value === "string") return bytes(value);
  if (typeof value === "number" || value instanceof Timestamp) return 8;
  if (typeof value === "boolean" || value === null) return 1;
  if (Array.isArray(value)) return value.reduce<number>((total, item) => total + valueBytes(item), 0);
  if (value !== null && typeof value === "object") {
    return 32 + Object.entries(value).reduce((total, [key, item]) => {
      if (bytes(key) > 1_501 || /^__.*__$/.test(key)) throw new ProgressValidationError();
      return total + bytes(key) + valueBytes(item);
    }, 0);
  }
  throw new ProgressValidationError();
}

function assertDocumentSize(path: string, document: Record<string, unknown>): void {
  // Firestore counts UTF-8 strings, field names, map overhead, and the document name.
  const documentNameBytes = path.split("/").reduce((total, segment) => total + bytes(segment), 16);
  if (documentNameBytes + valueBytes({ ...document, updatedAt: new Timestamp(0, 0) }) >
      MAX_PROGRESS_DOCUMENT_BYTES) {
    throw new ProgressValidationError("This practice session exceeds the 800 KB cloud progress limit.");
  }
}

export function createAccountProgressService(adapter: ProgressAdapter): {
  loadAccountProgress: (uid: string) => Promise<AccountProgress>;
  saveAccountAttempt: (
    uid: string, attempt: PracticeAttempt, expectedRevision: string | null,
  ) => Promise<{ revision: string }>;
} {
  function bindIdentity(uid: string): () => void {
    validateAccountUid(uid);
    const account = adapter.currentUser();
    if (!account || account.uid !== uid) throw new ProgressIdentityError();
    return () => {
      if (adapter.currentUser() !== account || account.uid !== uid) throw new ProgressIdentityError();
    };
  }

  return {
    async loadAccountProgress(uid) {
      const assertIdentity = bindIdentity(uid);
      const [activeDocument, historyDocuments] = await Promise.all([
        adapter.readDocument(`users/${uid}/state/active`),
        adapter.readHistory(`users/${uid}/history`, RECENT_HISTORY_LIMIT),
      ]);
      assertIdentity();
      const active = parseActive(activeDocument);
      const history = historyDocuments.map(parseHistory);
      const seenIds = new Set<string>();
      if (history.length > RECENT_HISTORY_LIMIT) throw new ProgressValidationError();
      for (const attempt of history) {
        if (seenIds.has(attempt.id) || active.attempt?.id === attempt.id) {
          throw new ProgressValidationError();
        }
        seenIds.add(attempt.id);
      }
      return { revision: active.revision, activeAttempt: active.attempt, history };
    },

    async saveAccountAttempt(uid, input, expectedRevision) {
      const assertIdentity = bindIdentity(uid);
      const attempt = parseAttempt(input);
      if (expectedRevision !== null && !uuid.safeParse(expectedRevision).success) {
        throw new ProgressValidationError("The cloud progress revision is invalid.");
      }
      const revision = adapter.newRevision();
      if (!uuid.safeParse(revision).success) throw new ProgressValidationError();
      const activePath = `users/${uid}/state/active`;
      const historyPath = `users/${uid}/history/${attempt.id}`;
      const payload = attempt.status === "completed"
        ? { schemaVersion: 1, attempt, finishedAt: attempt.finishedAt, updatedAt: null }
        : { schemaVersion: 1, attempt, revision, updatedAt: null };
      assertDocumentSize(attempt.status === "completed" ? historyPath : activePath, payload);

      const result = await adapter.transaction(async (transaction) => {
        assertIdentity();
        const current = parseActive(await transaction.get(activePath));
        assertIdentity();
        if (current.revision !== expectedRevision) {
          throw new ProgressConflictError(expectedRevision, current.revision);
        }
        const activeAttempt = attempt.status === "active"
          ? attempt
          : current.attempt?.id === attempt.id ? null : current.attempt;
        const state = {
          schemaVersion: 1,
          revision,
          attempt: activeAttempt,
          updatedAt: adapter.serverTimestamp(),
        };
        assertDocumentSize(activePath, state);
        assertIdentity();
        if (attempt.status === "completed") {
          transaction.set(historyPath, {
            schemaVersion: 1,
            attempt,
            finishedAt: attempt.finishedAt,
            updatedAt: adapter.serverTimestamp(),
          });
        }
        transaction.set(activePath, state);
        return { revision };
      });
      assertIdentity();
      return result;
    },
  };
}
