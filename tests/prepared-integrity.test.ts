import assert from "node:assert/strict";
import { test } from "node:test";
import { uploadPlanInternals } from "../tools/publish/plan.js";

test("prepared data must match fresh review materialization, not just its source revision", () => {
  const current = {
    sourceRevision: "unchanged-source",
    review: { status: "completed", basedOnSourceRevision: "unchanged-source" },
    effectiveAnswer: { optionIds: ["reviewed-option"] },
    originalAnswers: [{ sourceLabels: ["B"] }],
  };
  assert.doesNotThrow(() =>
    uploadPlanInternals.assertPreparedMatches(current, structuredClone(current), "answers/example"));
  assert.throws(() => uploadPlanInternals.assertPreparedMatches(current, {
    ...current, effectiveAnswer: { optionIds: ["old-or-hand-edited-option"] },
  }, "answers/example"), /stale or edited/);
  assert.throws(() => uploadPlanInternals.assertPreparedMatches(current, {
    ...current, originalAnswers: [{ sourceLabels: ["A"] }],
  }, "answers/example"), /stale or edited/);
});

test("prepared catalog and report comparison is deterministic and detects a changed release", () => {
  assert.doesNotThrow(() => uploadPlanInternals.assertPreparedMatches(
    { releaseId: "release-one", counts: { questions: 1, comments: 2 } },
    { counts: { comments: 2, questions: 1 }, releaseId: "release-one" },
    "catalog",
  ));
  assert.throws(() => uploadPlanInternals.assertPreparedMatches(
    { releaseId: "release-two", recordDigests: { answers: "new-digest" } },
    { releaseId: "release-one", recordDigests: { answers: "old-digest" } },
    "report",
  ), /rerun review:prepare/);
});
