import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { OperationBudget, assertPlannedHeadroom } from "../tools/publish/operation-budget.js";
import { pacificDayStart } from "../tools/publish/usage.js";
import { CLEANUP_ROOT, planCleanOperations, replacementFields } from "../tools/publish/clean-sync.js";
import { digest } from "../tools/ingest/normalize-shared.js";
import { FieldValue } from "firebase-admin/firestore";

test("Pacific quota midnight follows daylight saving transitions", () => {
  for (const [now, expected] of [
    ["2026-09-11T14:00:00Z", "2026-09-11T07:00:00.000Z"],
    ["2026-01-11T14:00:00Z", "2026-01-11T08:00:00.000Z"],
    ["2026-03-08T20:00:00Z", "2026-03-08T08:00:00.000Z"],
    ["2026-11-01T20:00:00Z", "2026-11-01T07:00:00.000Z"],
  ]) assert.equal(pacificDayStart(new Date(now!)).toISOString(), expected);
});

test("operation reservations survive lagging metrics, reject conflicts and stop at rollover", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "az104-operation-budget-"));
  let now = new Date("2026-09-11T14:00:00Z");
  try {
    const reads = await OperationBudget.open("reads", 100, workspace, () => now);
    const competing = await OperationBudget.open("reads", 100, workspace, () => now);
    assert.equal(reads.remaining(), 44900);
    await reads.reserve(500);
    await assert.rejects(competing.reserve(1), /concurrently/);
    const reopened = await OperationBudget.open("reads", 0, workspace, () => now);
    assert.equal(reopened.remaining(), 44400);
    await reopened.reserve(100);
    const deletes = await OperationBudget.open("deletes", 17999, workspace, () => now);
    await deletes.reserve(1);
    await assert.rejects(deletes.reserve(1), /Quota pause/);
    await assert.rejects(reads.reserve(-1), /Invalid/);
    now = new Date("2026-09-12T07:00:00Z");
    assert.equal(reopened.remaining(), 0);
    await assert.rejects(reopened.reserve(1), /Quota pause/);
  } finally {
    await rm(workspace, { recursive: true });
  }
});

test("headroom rejects unsafe and invalid plans", () => {
  const available = { reads: 45000, writes: 18000, deletes: 18000 };
  assert.doesNotThrow(() => assertPlannedHeadroom({ reads: 15000, writes: 9000, deletes: 13000 }, available));
  assert.throws(() => assertPlannedHeadroom({ reads: 45001, writes: 1, deletes: 1 }, available), /Quota pause/);
  assert.throws(() => assertPlannedHeadroom({ reads: -1, writes: 1, deletes: 1 }, available), /nonnegative/);
});

test("conditional replacement removes obsolete fields instead of merging them", () => {
  const next = { id: "retained", prompt: [], flags: { provisional: false } };
  const fields = replacementFields(["id", "prompt", "review", "sourcePresentation"], next);
  assert.deepEqual(fields.id, "retained");
  assert.deepEqual(fields.review, FieldValue.delete());
  assert.deepEqual(fields.sourcePresentation, FieldValue.delete());
  assert.equal("sourcePresentation" in next, false);
});

test("cleanup plans replace retained records, create missing records and delete only known obsolete paths", () => {
  const keep = `${CLEANUP_ROOT}/comments/keep`;
  const remove = `${CLEANUP_ROOT}/comments/remove`;
  const create = `${CLEANUP_ROOT}/comments/new`;
  const target = new Map([
    [CLEANUP_ROOT, { status: "clean" }],
    [keep, { status: "repaired" }],
    [create, { status: "retained" }],
  ]);
  const inventory = {
    root: CLEANUP_ROOT, checkedAt: "2026-09-11T14:00:00Z",
    documents: [CLEANUP_ROOT, keep, remove].map((path) => ({
      path, hash: digest({ status: "old" }), fields: ["status", "review"],
      seconds: 123, nanoseconds: 456,
    })),
  };
  const plan = planCleanOperations(target, inventory);
  assert.equal(plan.operations.find((item) => item.path === keep)?.kind, "replace");
  assert.equal(plan.operations.find((item) => item.path === remove)?.kind, "delete");
  assert.equal(plan.operations.find((item) => item.path === create)?.kind, "create");
  assert.equal(plan.operations.at(-1)?.path, CLEANUP_ROOT);
  assert.equal(plan.counts.writes, 3);
  assert.equal(plan.counts.deletes, 1);
  assert.equal(JSON.stringify(plan).includes('"old"'), false);
  assert.throws(() => planCleanOperations(target, {
    ...inventory, documents: [...inventory.documents, { ...inventory.documents[0]!, path: "users/progress" }],
  }), /Out-of-scope/);
});
