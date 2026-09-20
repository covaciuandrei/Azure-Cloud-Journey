import { z } from "zod";
import { PracticeAttemptSchema, type PracticeAttempt } from "./engine.js";
import { SavedPracticeSchema, STORAGE_KEY, emptyPractice, storeAttempt, type SavedPractice } from "./storage.js";

export const DataSourceSchema = z.enum(["firebase", "snapshot"]);
export type DataSource = z.infer<typeof DataSourceSchema>;
export const AccountCacheSchema = z.object({
  schemaVersion: z.literal(1),
  saved: SavedPracticeSchema,
  revision: z.string().min(1).nullable(),
  pending: z.array(PracticeAttemptSchema).max(100),
  dataSource: DataSourceSchema,
}).strict().refine((value) => new Set(value.pending.map((item) => item.id)).size === value.pending.length,
  "Pending session IDs must be unique");
export type AccountCache = z.infer<typeof AccountCacheSchema>;

export function accountStorageKey(uid: string): string {
  if (!uid || uid.length > 128 || /[/\\\u0000-\u001f]/.test(uid)) throw new Error("Invalid account identity.");
  return `${STORAGE_KEY}:account:${encodeURIComponent(uid)}`;
}

export function emptyAccountCache(): AccountCache {
  return { schemaVersion: 1, saved: emptyPractice(), revision: null, pending: [], dataSource: "firebase" };
}

export function queueAttempt(cache: AccountCache, attempt: PracticeAttempt): AccountCache {
  PracticeAttemptSchema.parse(attempt);
  const pending = [...cache.pending];
  const index = pending.findIndex((item) => item.id === attempt.id);
  if (index < 0) pending.push(attempt);
  else pending[index] = attempt;
  return AccountCacheSchema.parse({ ...cache, saved: storeAttempt(cache.saved, attempt), pending });
}

export function acknowledgeAttempt(cache: AccountCache, uploaded: PracticeAttempt, revision: string): AccountCache {
  return {
    ...cache, revision,
    pending: cache.pending.filter((item) => item.id !== uploaded.id || JSON.stringify(item) !== JSON.stringify(uploaded)),
  };
}

export function accountCloudState(activeAttempt: PracticeAttempt | null, history: PracticeAttempt[]): SavedPractice {
  return SavedPracticeSchema.parse({ schemaVersion: 1, activeAttempt, history });
}
