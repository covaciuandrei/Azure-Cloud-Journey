import assert from "node:assert/strict";
import { test } from "node:test";
import { getApps } from "firebase/app";
import { Timestamp } from "firebase/firestore";
import { PracticeAttemptSchema, type PracticeAttempt } from "../src/web/engine.js";
import {
  STORAGE_KEY, emptyPractice, practiceStorageKey, readPractice, storeAttempt, writePractice,
} from "../src/web/storage.js";
import {
  accountCacheSchema, accountCloudState, accountStorageKey, acknowledgeAttempt, emptyAccountCache, queueAttempt,
} from "../src/web/profile-storage.js";
import { accountErrorMessage } from "../src/web/account/auth-errors.js";
import {
  FirebaseConfigurationError,
  useFirebaseEmulators,
} from "../src/web/account/firebase-options.js";
import {
  createAccountProgressService,
  ProgressConflictError,
  ProgressIdentityError,
  ProgressValidationError,
  type ProgressAdapter,
  type ProgressDocument,
} from "../src/web/account/progress-service.js";

const UID = "alice";
const ACTIVE_PATH = `users/${UID}/state/active`;
const REVISION = "10000000-0000-4000-8000-000000000001";
const OTHER_REVISION = "10000000-0000-4000-8000-000000000002";
const updatedAt = new Timestamp(100, 123_000_000);
const attemptId = (index: number): string =>
  `20000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;

function attempt(index = 1, completed = false, exam = false): PracticeAttempt {
  const size = exam ? 40 : 10;
  const questionIds = Array.from({ length: size }, (_, number) => `question_${number}`);
  return {
    schemaVersion: 1,
    id: attemptId(index),
    releaseId: "synthetic-release",
    dataSource: "firebase",
    mode: exam ? "exam" : "free",
    size,
    questionIds,
    optionOrders: Object.fromEntries(questionIds.map((id) => [id, ["A", "B"]])),
    responses: Object.fromEntries(questionIds.map((id) => [id, {
      selectedIds: [],
      note: "",
      submitted: false,
      flagged: false,
      selfAssessment: null,
    }])),
    currentIndex: 0,
    startedAt: 1_000,
    deadline: exam ? 3_601_000 : null,
    finishedAt: completed ? 2_000 + index : null,
    status: completed ? "completed" : "active",
    score: completed ? {
      automatic: { correct: 3, incorrect: 5, unanswered: size - 8, total: size },
      provisional: { correct: 0, incorrect: 0, unanswered: 0, total: 0 },
      manual: { correct: 0, incorrect: 0, unanswered: 0, total: 0 },
      totalQuestions: size,
    } : null,
  };
}

function activeDocument(value: PracticeAttempt | null = attempt(), revision = REVISION) {
  return { schemaVersion: 1, revision, attempt: value, updatedAt };
}

function historyDocument(value: PracticeAttempt = attempt(1, true)) {
  return { schemaVersion: 1, attempt: value, finishedAt: value.finishedAt, updatedAt };
}

function sc900Attempt(index = 1, completed = false, exam = false): PracticeAttempt {
  const value = { ...attempt(index, completed, exam), examId: "sc900" as const };
  if (exam) value.deadline = value.startedAt + 45 * 60_000;
  return value;
}

function harness() {
  const documents = new Map<string, unknown>();
  const reads: string[] = [];
  const writes: Array<{ path: string; data: Record<string, unknown> }> = [];
  const state: {
    user: { uid: string } | null;
    transactions: number;
    beforeGet?: () => void;
    retry?: () => void;
    afterCommit?: () => void;
  } = { user: { uid: UID }, transactions: 0 };
  let revisionNumber = 2;
  const readDocument = async (path: string): Promise<ProgressDocument | null> => {
    reads.push(path);
    return documents.has(path) ? { id: path.split("/").at(-1)!, data: documents.get(path) } : null;
  };
  const adapter: ProgressAdapter = {
    currentUser: () => state.user,
    readDocument,
    async readHistory(path, count) {
      assert.equal(count, 20);
      reads.push(`${path}?orderBy=finishedAt:desc&limit=${count}`);
      return [...documents.entries()]
        .filter(([key]) => key.startsWith(`${path}/`))
        .map(([key, data]) => ({ id: key.split("/").at(-1)!, data }))
        .sort((left, right) =>
          (right.data as { finishedAt: number }).finishedAt -
          (left.data as { finishedAt: number }).finishedAt)
        .slice(0, count);
    },
    async transaction(operation) {
      state.transactions++;
      const staged: Array<{ path: string; data: Record<string, unknown> }> = [];
      const result = await operation({
        async get(path) {
          const document = await readDocument(path);
          state.beforeGet?.();
          return document;
        },
        set(path, data) { staged.push({ path, data }); },
      });
      if (state.retry) {
        const retry = state.retry;
        delete state.retry;
        retry();
        return adapter.transaction(operation);
      }
      for (const write of staged) {
        documents.set(write.path, write.data);
        writes.push(write);
      }
      state.afterCommit?.();
      return result;
    },
    newRevision: () => `10000000-0000-4000-8000-${(++revisionNumber).toString().padStart(12, "0")}`,
    serverTimestamp: () => updatedAt,
  };
  return { documents, reads, writes, state, adapter, service: createAccountProgressService(adapter) };
}

test("public module imports are lazy and invalid paths never initialize Firebase", async () => {
  assert.equal(getApps().length, 0);
  const client = await import("../src/web/firebase-client.js");
  const progress = await import("../src/web/account-progress.js");
  const account = await import("../src/web/account.js");
  assert.equal(typeof client.getFirebaseClients, "function");
  assert.equal(typeof account.useAccount, "function");
  assert.equal(progress.ProgressConflictError, ProgressConflictError);
  await assert.rejects(progress.loadAccountProgress("../bob"), ProgressValidationError);
  await assert.rejects(progress.saveAccountAttempt("../bob", attempt(), null), ProgressValidationError);
  assert.equal(getApps().length, 0);
});

test("empty account load uses only UID-scoped server reads and never writes", async () => {
  const mock = harness();
  mock.documents.set("users/bob/state/active", activeDocument());
  mock.documents.set(`users/bob/history/${attemptId(1)}`, historyDocument());
  assert.deepEqual(await mock.service.loadAccountProgress(UID), {
    revision: null, activeAttempt: null, history: [],
  });
  assert.deepEqual(mock.reads, [
    ACTIVE_PATH, `users/${UID}/history?orderBy=finishedAt:desc&limit=20`,
  ]);
  assert.equal(mock.state.transactions, 0);
  assert.equal(mock.writes.length, 0);
});

test("loads an active session and the 20 most recent completed sessions, without migrating them", async () => {
  const mock = harness();
  const legacy = attempt(30);
  delete legacy.dataSource;
  mock.documents.set(ACTIVE_PATH, activeDocument(legacy));
  for (let index = 1; index <= 25; index++) {
    mock.documents.set(`users/${UID}/history/${attemptId(index)}`, historyDocument(attempt(index, true)));
  }
  const result = await mock.service.loadAccountProgress(UID);
  assert.equal(result.revision, REVISION);
  assert.deepEqual(result.activeAttempt, legacy);
  assert.equal(result.history.length, 20);
  assert.equal(result.history[0]!.id, attemptId(25));
  assert.equal(result.history[19]!.id, attemptId(6));
  assert.equal(mock.writes.length, 0);
});

test("first save creates a revisioned active state and repeated saves require its new revision", async () => {
  const mock = harness();
  const value = attempt();
  value.dataSource = undefined;
  const first = await mock.service.saveAccountAttempt(UID, value, null);
  assert.equal(mock.writes.length, 1);
  assert.equal(mock.writes[0]!.path, ACTIVE_PATH);
  assert.equal(mock.writes[0]!.data.updatedAt, updatedAt);
  assert.equal("dataSource" in (mock.writes[0]!.data.attempt as object), false);
  const loaded = await mock.service.loadAccountProgress(UID);
  assert.equal(loaded.revision, first.revision);
  assert.equal(loaded.activeAttempt!.id, value.id);
  const next = await mock.service.saveAccountAttempt(UID, { ...value, currentIndex: 1 }, first.revision);
  assert.notEqual(next.revision, first.revision);
  assert.equal((await mock.service.loadAccountProgress(UID)).activeAttempt!.currentIndex, 1);
});

test("completion atomically archives its own session and clears a matching active session", async () => {
  const mock = harness();
  mock.documents.set(ACTIVE_PATH, activeDocument());
  const completed = attempt(1, true);
  const saved = await mock.service.saveAccountAttempt(UID, completed, REVISION);
  assert.deepEqual(mock.writes.map((write) => write.path), [
    `users/${UID}/history/${completed.id}`, ACTIVE_PATH,
  ]);
  assert.deepEqual(mock.documents.get(`users/${UID}/history/${completed.id}`), historyDocument(completed));
  assert.deepEqual(mock.documents.get(ACTIVE_PATH), activeDocument(null, saved.revision));
  assert.equal(mock.state.transactions, 1);
});

test("completion preserves unrelated active progress, advances revision, and updates only its own history", async () => {
  const mock = harness();
  const active = attempt(2);
  const otherHistory = historyDocument(attempt(3, true));
  mock.documents.set(ACTIVE_PATH, activeDocument(active));
  mock.documents.set(`users/${UID}/history/${attemptId(3)}`, otherHistory);
  const saved = await mock.service.saveAccountAttempt(UID, attempt(1, true), REVISION);
  assert.deepEqual(mock.documents.get(ACTIVE_PATH), activeDocument(active, saved.revision));
  assert.deepEqual(mock.documents.get(`users/${UID}/history/${attemptId(3)}`), otherHistory);
  await assert.rejects(
    mock.service.saveAccountAttempt(UID, active, REVISION),
    ProgressConflictError,
  );
  const completed = attempt(1, true);
  completed.responses.question_0!.note = "A revised private note";
  await mock.service.saveAccountAttempt(UID, completed, saved.revision);
  assert.equal((await mock.service.loadAccountProgress(UID)).history.length, 2);
  assert.deepEqual(mock.documents.get(`users/${UID}/history/${attemptId(1)}`), historyDocument(completed));
});

test("completion without existing active state still archives and advances the account revision", async () => {
  const mock = harness();
  const result = await mock.service.saveAccountAttempt(UID, attempt(1, true), null);
  const loaded = await mock.service.loadAccountProgress(UID);
  assert.equal(loaded.revision, result.revision);
  assert.equal(loaded.activeAttempt, null);
  assert.deepEqual(loaded.history, [attempt(1, true)]);
});

test("exam deadlines and separate automatic, provisional and manual score buckets survive round trips", async () => {
  const mock = harness();
  const active = attempt(1, false, true);
  const first = await mock.service.saveAccountAttempt(UID, active, null);
  assert.deepEqual((await mock.service.loadAccountProgress(UID)).activeAttempt, active);
  const completed = attempt(1, true, true);
  completed.finishedAt = completed.deadline;
  completed.score = {
    automatic: { correct: 10, incorrect: 10, unanswered: 10, total: 30 },
    provisional: { correct: 2, incorrect: 2, unanswered: 1, total: 5 },
    manual: { correct: 1, incorrect: 3, unanswered: 1, total: 5 },
    totalQuestions: 40,
  };
  await mock.service.saveAccountAttempt(UID, completed, first.revision);
  assert.deepEqual((await mock.service.loadAccountProgress(UID)).history, [completed]);
});

test("all revision mismatches reject with a stable conflict error, including missing documents", async () => {
  for (const [expected, actual] of [
    [null, REVISION],
    [REVISION, null],
    [REVISION, OTHER_REVISION],
  ] as const) {
    const mock = harness();
    if (actual) mock.documents.set(ACTIVE_PATH, activeDocument(attempt(), actual));
    await assert.rejects(
      mock.service.saveAccountAttempt(UID, attempt(), expected),
      (error: unknown) => {
        assert.ok(error instanceof ProgressConflictError);
        assert.ok(error instanceof Error);
        assert.equal(error.name, "ProgressConflictError");
        assert.equal(error.code, "account/progress-conflict");
        assert.equal(error.expectedRevision, expected);
        assert.equal(error.actualRevision, actual);
        assert.match(error.message, /another device/);
        return true;
      },
    );
    assert.equal(mock.writes.length, 0);
  }
});

test("transaction retries cannot silently overwrite a newly committed revision", async () => {
  const mock = harness();
  mock.documents.set(ACTIVE_PATH, activeDocument());
  mock.state.retry = () => {
    mock.documents.set(ACTIVE_PATH, activeDocument(attempt(2), OTHER_REVISION));
  };
  await assert.rejects(
    mock.service.saveAccountAttempt(UID, attempt(1, true), REVISION),
    ProgressConflictError,
  );
  assert.equal(mock.state.transactions, 2);
  assert.equal(mock.writes.length, 0);
  assert.deepEqual(mock.documents.get(ACTIVE_PATH), activeDocument(attempt(2), OTHER_REVISION));
  assert.equal(mock.documents.has(`users/${UID}/history/${attemptId(1)}`), false);
});

test("invalid account paths, session IDs, revisions and schemas fail before any I/O", async () => {
  const mock = harness();
  for (const uid of ["", ".", "..", "../alice", "a/b", "a\\b", "a b", "a\nb", "a".repeat(129)]) {
    await assert.rejects(mock.service.loadAccountProgress(uid), ProgressValidationError);
    await assert.rejects(mock.service.saveAccountAttempt(uid, attempt(), null), ProgressValidationError);
  }
  for (const value of [
    { ...attempt(), id: "../bob/state/active" },
    { ...attempt(), id: "not-a-uuid" },
    { ...attempt(), currentIndex: 10 },
    { ...attempt(), finishedAt: 5_000 },
    { ...attempt(), dataSource: "unknown" },
    { ...attempt(), extra: "not allowed" },
    { ...attempt(1, true), score: null },
    { ...attempt(), responses: {} },
  ]) {
    await assert.rejects(
      mock.service.saveAccountAttempt(UID, value as PracticeAttempt, null),
      ProgressValidationError,
    );
  }
  await assert.rejects(mock.service.saveAccountAttempt(UID, attempt(), "revision-1"), ProgressValidationError);
  assert.equal(mock.reads.length, 0);
  assert.equal(mock.state.transactions, 0);
  assert.equal(mock.writes.length, 0);
});

test("strict cloud parsing rejects malformed records rather than dropping history or resetting active state", async () => {
  const invalidActiveDocuments = [
    { ...activeDocument(), schemaVersion: 2 },
    { ...activeDocument(), revision: "invalid" },
    { ...activeDocument(), revision: null },
    { ...activeDocument(), updatedAt: null },
    { ...activeDocument(), updatedAt: { seconds: 100, nanoseconds: 0 } },
    { ...activeDocument(), updatedAt: { _methodName: "serverTimestamp" } },
    { ...activeDocument(), updatedAt: new Date() },
    { ...activeDocument(), updatedAt: undefined },
    { ...activeDocument(), attempt: attempt(1, true) },
    { ...activeDocument(), attempt: { ...attempt(), id: "invalid" } },
    { ...activeDocument(), extra: true },
  ];
  for (const document of invalidActiveDocuments) {
    const mock = harness();
    mock.documents.set(ACTIVE_PATH, document);
    await assert.rejects(mock.service.loadAccountProgress(UID), ProgressValidationError);
    await assert.rejects(
      mock.service.saveAccountAttempt(UID, attempt(), REVISION),
      ProgressValidationError,
    );
    assert.equal(mock.writes.length, 0);
  }
  for (const document of [
    { ...historyDocument(), attempt: attempt() },
    { ...historyDocument(), finishedAt: 12 },
    { ...historyDocument(), attempt: attempt(2, true) },
    { ...historyDocument(), updatedAt: null },
    { ...historyDocument(), schemaVersion: 2 },
    { ...historyDocument(), extra: true },
  ]) {
    const mock = harness();
    mock.documents.set(`users/${UID}/history/${attemptId(1)}`, document);
    await assert.rejects(mock.service.loadAccountProgress(UID), ProgressValidationError);
    assert.equal(mock.writes.length, 0);
  }
});

test("active/history overlap, duplicate history IDs, and unexpected record IDs are rejected", async () => {
  const mock = harness();
  mock.documents.set(ACTIVE_PATH, activeDocument());
  mock.documents.set(`users/${UID}/history/${attemptId(1)}`, historyDocument());
  await assert.rejects(mock.service.loadAccountProgress(UID), ProgressValidationError);
  mock.documents.delete(ACTIVE_PATH);
  mock.adapter.readHistory = async () => [
    { id: attemptId(1), data: historyDocument() },
    { id: attemptId(1), data: historyDocument() },
  ];
  await assert.rejects(mock.service.loadAccountProgress(UID), ProgressValidationError);
  mock.adapter.readHistory = async () => [];
  mock.adapter.readDocument = async () => ({ id: "wrong-active-path", data: activeDocument() });
  await assert.rejects(mock.service.loadAccountProgress(UID), ProgressValidationError);
});

test("signed-out and other-user requests perform no reads or writes", async () => {
  const mock = harness();
  for (const user of [null, { uid: "bob" }]) {
    mock.state.user = user;
    for (const operation of [
      () => mock.service.loadAccountProgress(UID),
      () => mock.service.saveAccountAttempt(UID, attempt(), null),
    ]) {
      await assert.rejects(operation(), (error: unknown) => {
        assert.ok(error instanceof ProgressIdentityError);
        assert.equal(error.name, "ProgressIdentityError");
        assert.equal(error.code, "account/identity-mismatch");
        return true;
      });
    }
  }
  assert.equal(mock.reads.length, 0);
  assert.equal(mock.state.transactions, 0);
});

test("auth changes during reads discard results, including a replacement session for the same UID", async () => {
  for (const user of [null, { uid: "bob" }, { uid: UID }]) {
    const mock = harness();
    mock.adapter.readDocument = async () => {
      mock.state.user = user;
      return { id: "active", data: activeDocument() };
    };
    await assert.rejects(mock.service.loadAccountProgress(UID), ProgressIdentityError);
    assert.equal(mock.writes.length, 0);
  }
});

test("auth changes while a transaction reads prevent staging writes", async () => {
  for (const user of [null, { uid: "bob" }, { uid: UID }]) {
    const mock = harness();
    mock.documents.set(ACTIVE_PATH, activeDocument());
    mock.state.beforeGet = () => { mock.state.user = user; };
    await assert.rejects(
      mock.service.saveAccountAttempt(UID, attempt(1, true), REVISION),
      ProgressIdentityError,
    );
    assert.equal(mock.writes.length, 0);
    assert.deepEqual(mock.documents.get(ACTIVE_PATH), activeDocument());
  }
});

test("an acknowledgement is not returned to another account after the original account's commit", async () => {
  const mock = harness();
  mock.state.afterCommit = () => { mock.state.user = { uid: "bob" }; };
  await assert.rejects(
    mock.service.saveAccountAttempt(UID, attempt(), null),
    ProgressIdentityError,
  );
  assert.equal(mock.writes.length, 1);
  assert.ok(mock.writes.every((write) => write.path.startsWith(`users/${UID}/`)));
  assert.equal(mock.documents.has("users/bob/state/active"), false);
});

test("load and transaction failures propagate unchanged without fallback writes", async () => {
  const mock = harness();
  const unavailable = Object.assign(new Error("Service unavailable"), { code: "unavailable" });
  mock.adapter.readDocument = async () => { throw unavailable; };
  await assert.rejects(mock.service.loadAccountProgress(UID), (error) => error === unavailable);
  mock.adapter.transaction = async () => { throw unavailable; };
  await assert.rejects(
    mock.service.saveAccountAttempt(UID, attempt(), null),
    (error) => error === unavailable,
  );
  assert.equal(mock.writes.length, 0);
});

test("history read failure cannot become an apparently empty successful account load", async () => {
  const mock = harness();
  const denied = Object.assign(new Error("Permission denied"), { code: "permission-denied" });
  mock.adapter.readHistory = async () => { throw denied; };
  await assert.rejects(mock.service.loadAccountProgress(UID), (error) => error === denied);
  assert.equal(mock.writes.length, 0);
});

test("attempt payloads are snapshotted before asynchronous work to prevent unvalidated caller mutation", async () => {
  const mock = harness();
  const value = attempt();
  mock.state.beforeGet = () => {
    value.responses.question_0!.note = "x".repeat(4_001);
    value.id = "unsafe/path";
  };
  await mock.service.saveAccountAttempt(UID, value, null);
  const saved = (mock.writes[0]!.data.attempt as PracticeAttempt);
  assert.equal(saved.id, attemptId(1));
  assert.equal(saved.responses.question_0!.note, "");
});

test("oversized Unicode payloads and reserved or oversized map keys are rejected before transactions", async () => {
  const mock = harness();
  const oversized = attempt();
  oversized.optionOrders.question_0 = ["界".repeat(270_000)];
  assert.equal(PracticeAttemptSchema.safeParse(oversized).success, true);
  await assert.rejects(mock.service.saveAccountAttempt(UID, oversized, null), (error: unknown) => {
    assert.ok(error instanceof ProgressValidationError);
    assert.equal(error.name, "ProgressValidationError");
    assert.equal(error.code, "account/invalid-progress");
    assert.match(error.message, /800 KB/);
    return true;
  });
  for (const key of ["__reserved__", "界".repeat(501)]) {
    const value = attempt();
    value.questionIds[0] = key;
    value.optionOrders[key] = value.optionOrders.question_0!;
    value.responses[key] = value.responses.question_0!;
    delete value.optionOrders.question_0;
    delete value.responses.question_0;
    assert.equal(PracticeAttemptSchema.safeParse(value).success, true);
    await assert.rejects(mock.service.saveAccountAttempt(UID, value, null), ProgressValidationError);
  }
  assert.equal(mock.state.transactions, 0);
  assert.equal(mock.writes.length, 0);
});

test("guest practice preserves legacy keys and isolates identical session/question IDs by exam", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
  const az104 = storeAttempt(emptyPractice(), attempt());
  const sc900 = storeAttempt(emptyPractice("sc900"), sc900Attempt(), "sc900");
  assert.equal(writePractice(storage, az104), null);
  assert.equal(writePractice(storage, sc900, undefined, "sc900"), null);
  assert.equal(practiceStorageKey(), STORAGE_KEY);
  assert.deepEqual([...values.keys()], [STORAGE_KEY, `${STORAGE_KEY}:exam:sc900`]);
  assert.deepEqual(readPractice(storage).state, az104);
  assert.deepEqual(readPractice(storage, undefined, "sc900").state, sc900);
  assert.equal(writePractice(storage, az104, "custom-key"), null);
  assert.ok(values.has("custom-key"));
  assert.equal(writePractice(storage, sc900, "custom-key", "sc900"), null);
  assert.ok(values.has("custom-key:exam:sc900"));
  assert.match(writePractice(storage, az104, undefined, "sc900")!, /invalid/);
  assert.match(writePractice(storage, sc900)!, /invalid/);
  assert.throws(() => storeAttempt(az104, sc900Attempt()), /another exam|different exam/);
  assert.throws(() => storeAttempt(sc900, attempt(), "sc900"), /another exam|different exam/);
  values.set(practiceStorageKey("sc900"), JSON.stringify(az104));
  const rejected = readPractice(storage, undefined, "sc900");
  assert.match(rejected.warning!, /invalid/);
  assert.deepEqual(rejected.state, emptyPractice("sc900"));
  assert.equal(values.get(practiceStorageKey("sc900")), JSON.stringify(az104));
  values.set(practiceStorageKey("sc900"), JSON.stringify({ ...sc900, admin: true }));
  assert.match(readPractice(storage, undefined, "sc900").warning!, /invalid/);
});

test("account caches reject foreign envelopes, attempts and acknowledgements before coalescing IDs", () => {
  const az104 = queueAttempt(emptyAccountCache(), attempt());
  const sc900 = queueAttempt(emptyAccountCache("sc900"), sc900Attempt(), "sc900");
  assert.equal(accountStorageKey(UID), `${STORAGE_KEY}:account:${UID}`);
  assert.notEqual(accountStorageKey(UID), accountStorageKey(UID, "sc900"));
  assert.notEqual(accountStorageKey(UID, "sc900"), accountStorageKey("bob", "sc900"));
  assert.notEqual(accountStorageKey(UID, "sc900"), practiceStorageKey("sc900"));
  assert.throws(() => queueAttempt(sc900, attempt(), "sc900"));
  assert.throws(() => queueAttempt(az104, sc900Attempt()));
  assert.throws(() => acknowledgeAttempt(sc900, attempt(), REVISION, "sc900"));
  assert.throws(() => acknowledgeAttempt(az104, sc900Attempt(), REVISION));
  assert.throws(() => accountCloudState(attempt(), [], "sc900"));
  assert.throws(() => accountCloudState(sc900Attempt(), []));
  for (const invalid of [
    { ...sc900, examId: undefined },
    { ...sc900, examId: "az104" },
    { ...sc900, saved: az104.saved },
    { ...sc900, pending: az104.pending },
    { ...sc900, extra: true },
    { ...sc900, saved: { ...sc900.saved, extra: true } },
  ]) {
    assert.equal(accountCacheSchema("sc900").safeParse(invalid).success, false);
  }
  const edited = { ...sc900Attempt(), currentIndex: 1 };
  const queued = queueAttempt(sc900, edited, "sc900");
  assert.equal(queued.pending.length, 1);
  const older = acknowledgeAttempt(queued, sc900Attempt(), REVISION, "sc900");
  assert.equal(older.pending.length, 1);
  const latest = acknowledgeAttempt(older, edited, OTHER_REVISION, "sc900");
  assert.equal(latest.pending.length, 0);
  assert.equal(az104.pending.length, 1);
  assert.equal(az104.revision, null);
});

test("per-exam history and pending queues retain their existing bounds", () => {
  let cache = emptyAccountCache("sc900");
  for (let index = 1; index <= 100; index++) cache = queueAttempt(cache, sc900Attempt(index), "sc900");
  assert.equal(cache.pending.length, 100);
  assert.throws(() => queueAttempt(cache, sc900Attempt(101), "sc900"));
  assert.equal(cache.pending.length, 100);
  let saved = emptyPractice("sc900");
  for (let index = 1; index <= 25; index++) saved = storeAttempt(saved, sc900Attempt(index, true), "sc900");
  assert.equal(saved.history.length, 20);
  assert.equal(saved.history[0]!.id, attemptId(25));
  assert.equal(saved.history[19]!.id, attemptId(6));
});

test("SC900 reads and revisioned saves never touch legacy AZ104 account paths", async () => {
  const mock = harness();
  const legacy = await mock.service.saveAccountAttempt(UID, attempt(), null);
  const az104Before = mock.documents.get(ACTIVE_PATH);
  const sc900 = await mock.service.saveAccountAttempt(UID, sc900Attempt(), null, "sc900");
  const scActive = `users/${UID}/exams/sc900/state/active`;
  assert.notEqual(legacy.revision, sc900.revision);
  assert.deepEqual(mock.documents.get(scActive), {
    ...activeDocument(sc900Attempt(), sc900.revision), examId: "sc900",
  });
  const scCompleted = await mock.service.saveAccountAttempt(UID, sc900Attempt(1, true), sc900.revision, "sc900");
  assert.deepEqual(await mock.service.loadAccountProgress(UID, "sc900"), {
    revision: scCompleted.revision, activeAttempt: null, history: [sc900Attempt(1, true)],
  });
  assert.deepEqual(mock.documents.get(ACTIVE_PATH), az104Before);
  assert.deepEqual(await mock.service.loadAccountProgress(UID), {
    revision: legacy.revision, activeAttempt: attempt(), history: [],
  });
  assert.deepEqual(mock.documents.get(`users/${UID}/exams/sc900/sessions/${attemptId(1)}`), {
    ...historyDocument(sc900Attempt(1, true)), examId: "sc900",
  });
  assert.ok(mock.reads.includes(`users/${UID}/exams/sc900/sessions?orderBy=finishedAt:desc&limit=20`));
  assert.equal(mock.documents.has(`users/${UID}/history/${attemptId(1)}`), false);
  await assert.rejects(mock.service.saveAccountAttempt(UID, attempt(), scCompleted.revision), ProgressConflictError);
});

test("SC900 requires explicit exam identities in active and history envelopes and attempts", async () => {
  const scActive = `users/${UID}/exams/sc900/state/active`;
  for (const document of [
    activeDocument(sc900Attempt()),
    { ...activeDocument(sc900Attempt()), examId: "az104" },
    { ...activeDocument(attempt()), examId: "sc900" },
    { ...activeDocument(null), examId: undefined },
    { ...activeDocument(sc900Attempt()), examId: "sc900", extra: true },
  ]) {
    const mock = harness();
    mock.documents.set(scActive, document);
    await assert.rejects(mock.service.loadAccountProgress(UID, "sc900"), ProgressValidationError);
    await assert.rejects(mock.service.saveAccountAttempt(UID, sc900Attempt(), REVISION, "sc900"), ProgressValidationError);
    assert.equal(mock.writes.length, 0);
  }
  for (const document of [
    historyDocument(sc900Attempt(1, true)),
    { ...historyDocument(sc900Attempt(1, true)), examId: "az104" },
    { ...historyDocument(attempt(1, true)), examId: "sc900" },
    { ...historyDocument(sc900Attempt(1, true)), examId: "sc900", extra: true },
  ]) {
    const mock = harness();
    mock.documents.set(`users/${UID}/exams/sc900/sessions/${attemptId(1)}`, document);
    await assert.rejects(mock.service.loadAccountProgress(UID, "sc900"), ProgressValidationError);
    assert.equal(mock.writes.length, 0);
  }
  const mock = harness();
  mock.documents.set(ACTIVE_PATH, { ...activeDocument(sc900Attempt()), examId: "sc900" });
  await assert.rejects(mock.service.loadAccountProgress(UID), ProgressValidationError);
  await assert.rejects(mock.service.saveAccountAttempt(UID, attempt(), REVISION), ProgressValidationError);
});

test("cross-exam saves, invalid exam paths, and foreign SC900 accounts fail before I/O", async () => {
  const mock = harness();
  await assert.rejects(mock.service.saveAccountAttempt(UID, attempt(), null, "sc900"), ProgressValidationError);
  await assert.rejects(mock.service.saveAccountAttempt(UID, sc900Attempt(), null), ProgressValidationError);
  const progress = await import("../src/web/account-progress.js");
  for (const invalid of ["", "../az104", "az500"]) {
    for (const api of [mock.service, progress]) {
      await assert.rejects(
        Reflect.apply(api.loadAccountProgress, api, [UID, invalid]), ProgressValidationError,
      );
      await assert.rejects(
        Reflect.apply(api.saveAccountAttempt, api, [UID, attempt(), null, invalid]), ProgressValidationError,
      );
    }
  }
  mock.state.user = { uid: "bob" };
  await assert.rejects(mock.service.loadAccountProgress(UID, "sc900"), ProgressIdentityError);
  await assert.rejects(mock.service.saveAccountAttempt(UID, sc900Attempt(), null, "sc900"), ProgressIdentityError);
  assert.equal(mock.reads.length, 0);
  assert.equal(mock.state.transactions, 0);
  assert.equal(getApps().length, 0);
});

test("SC900 timed sessions enforce their 45-minute deadline independently of AZ104", async () => {
  const mock = harness();
  const value = sc900Attempt(1, false, true);
  const saved = await mock.service.saveAccountAttempt(UID, value, null, "sc900");
  assert.deepEqual((await mock.service.loadAccountProgress(UID, "sc900")).activeAttempt, value);
  await assert.rejects(
    mock.service.saveAccountAttempt(UID, { ...value, deadline: value.startedAt + 60 * 60_000 }, saved.revision, "sc900"),
    ProgressValidationError,
  );
});

test("emulators require an explicit development flag and an exact permitted loopback hostname", () => {
  for (const hostname of ["localhost", "127.0.0.1"]) {
    assert.equal(useFirebaseEmulators({ DEV: true, VITE_FIREBASE_EMULATORS: "true" }, hostname), true);
    assert.throws(
      () => useFirebaseEmulators({ DEV: false, VITE_FIREBASE_EMULATORS: "true" }, hostname),
      /development build/,
    );
  }
  for (const hostname of ["study-az104.web.app", "localhost.example.com", "0.0.0.0", "::1", undefined]) {
    assert.throws(
      () => useFirebaseEmulators({ DEV: true, VITE_FIREBASE_EMULATORS: "true" }, hostname),
      /localhost or 127.0.0.1/,
    );
  }
  assert.equal(useFirebaseEmulators(undefined, undefined), false);
  assert.equal(useFirebaseEmulators({ DEV: false }, "study-az104.web.app"), false);
  assert.equal(useFirebaseEmulators({ DEV: true, VITE_FIREBASE_EMULATORS: "false" }, "localhost"), false);
});

test("auth errors are actionable and never expose credential-shaped error contents", () => {
  const credential = { accessToken: "sensitive-placeholder", email: "private@example.test" };
  for (const code of ["auth/popup-closed-by-user", "auth/cancelled-popup-request"]) {
    assert.match(accountErrorMessage({ code, credential }, "sign-in"), /cancelled/);
  }
  assert.match(accountErrorMessage({ code: "auth/popup-blocked" }, "sign-in"), /Allow pop-ups/);
  assert.match(accountErrorMessage({ code: "auth/network-request-failed" }, "observe"), /connection/);
  assert.match(accountErrorMessage({ code: "auth/unauthorized-domain" }, "sign-in"), /not configured/);
  assert.match(accountErrorMessage({ code: "auth/operation-not-allowed" }, "sign-in"), /not enabled/);
  assert.match(accountErrorMessage({ credential }, "sign-in"), /^Google sign-in failed/);
  assert.match(accountErrorMessage({ credential }, "sign-out"), /^Sign-out failed/);
  assert.match(accountErrorMessage(null, "observe"), /could not be loaded/);
  assert.doesNotMatch(accountErrorMessage({ credential }, "sign-in"), /sensitive-placeholder|private@/);
  assert.equal(
    accountErrorMessage(new FirebaseConfigurationError("An explicit configuration failure"), "observe"),
    "An explicit configuration failure",
  );
});
