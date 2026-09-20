import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { CleanCatalogSchema, CleanDocumentSchema } from "../src/domain/cleanBank.js";
import { createAttempt, reduceAttempt, PracticeAttemptSchema } from "../src/web/engine.js";
import { accountStorageKey, emptyAccountCache, queueAttempt, acknowledgeAttempt } from "../src/web/profile-storage.js";
import { recentStatistics } from "../src/web/statistics.js";
import { STORAGE_KEY } from "../src/web/storage.js";

const fixtures = (async () => {
  const root = ".data/clean-bank/content/r_b7f94b0d9dd9319c1d661c638cd9786be97dc83cb204871357c79639bb9fb5f2";
  const catalog = CleanCatalogSchema.parse(JSON.parse(await readFile(`${root}/catalog.json`, "utf8")));
  const documents = [];
  for (const summary of catalog.questions.filter((item) => item.grading === "automatic").slice(0, 10)) {
    documents.push(CleanDocumentSchema.parse(JSON.parse(await readFile(`${root}/questions/${summary.id}.json`, "utf8"))));
  }
  return documents;
})();

test("guest and account storage keys cannot collide", () => {
  assert.notEqual(accountStorageKey("alice"), accountStorageKey("bob"));
  assert.notEqual(accountStorageKey("alice"), STORAGE_KEY);
  for (const id of ["", "../alice", "a/b", "a\\b"]) assert.throws(() => accountStorageKey(id), /identity/);
});

test("pending saves coalesce and an older acknowledgement cannot discard newer answers", async () => {
  const documents = await fixtures;
  const first = createAttempt({ mode: "free", documents, id: "pending-session", now: 1000, dataSource: "firebase" });
  const next = reduceAttempt(first, { type: "navigate", index: 1 }, documents, 2000);
  let cache = queueAttempt(emptyAccountCache(), first);
  cache = queueAttempt(cache, next);
  assert.equal(cache.pending.length, 1);
  cache = acknowledgeAttempt(cache, first, "revision-1");
  assert.equal(cache.pending.length, 1);
  assert.equal(cache.saved.activeAttempt?.currentIndex, 1);
  cache = acknowledgeAttempt(cache, next, "revision-2");
  assert.equal(cache.pending.length, 0);
  assert.equal(cache.revision, "revision-2");
});

test("source choice survives storage while old attempts remain valid snapshot sessions", async () => {
  const documents = await fixtures;
  const legacy = createAttempt({ mode: "free", documents, now: 1000 });
  assert.equal(legacy.dataSource, undefined);
  assert.equal(PracticeAttemptSchema.parse(JSON.parse(JSON.stringify(legacy))).dataSource ?? "snapshot", "snapshot");
  const online = createAttempt({ mode: "free", documents, now: 1000, dataSource: "firebase" });
  assert.equal(PracticeAttemptSchema.parse(JSON.parse(JSON.stringify(online))).dataSource, "firebase");
  assert.equal(PracticeAttemptSchema.safeParse({ ...online, dataSource: "invented" }).success, false);
});

test("statistics ignore active attempts and separate unanswered/provisional/manual outcomes", async () => {
  const documents = await fixtures;
  const active = createAttempt({ mode: "free", documents, now: 1000 });
  const finished = reduceAttempt(active, { type: "finish" }, documents, 2000);
  const stats = recentStatistics([active, finished]);
  assert.equal(stats.sessions, 1);
  assert.equal(stats.practice, 1);
  assert.equal(stats.exams, 0);
  assert.equal(stats.accuracy, null);
  assert.equal(stats.unanswered + stats.provisional + stats.manual, 10);
});
