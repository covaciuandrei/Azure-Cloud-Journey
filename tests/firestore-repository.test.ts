import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { CleanCatalogSchema, CleanDocumentSchema, CleanDiscussionSchema } from "../src/domain/cleanBank.js";
import { STUDY_CURRENT_BANK_PATH } from "../src/domain/cloud.js";
import { createStudyRepository } from "../src/web/data.js";
import { createFirestoreStudyRepository } from "../src/web/firestore-repository.js";
import type { StudyRepository } from "../src/web/types.js";

const release = "r_b7f94b0d9dd9319c1d661c638cd9786be97dc83cb204871357c79639bb9fb5f2";
const directory = `.data/clean-bank/content/${release}`;
const read = async (path: string) => JSON.parse(await readFile(path, "utf8")) as unknown;
const fixture = (async () => {
  const catalog = CleanCatalogSchema.parse(await read(`${directory}/catalog.json`));
  const summary = catalog.questions.find((item) => item.number === 2)!;
  const document = CleanDocumentSchema.parse(await read(`${directory}/questions/${summary.id}.json`));
  const discussion = CleanDiscussionSchema.parse(await read(`${directory}/discussions/${summary.id}.json`));
  return { catalog, document, discussion };
})();

test("Firestore mode really reads Firestore records, caches them, and loads comments only on request", async () => {
  const { catalog, document, discussion } = await fixture;
  const calls: string[] = [];
  let commentQueries = 0;
  const archive = createStudyRepository("https://example.test/", async () => { throw new Error("Unexpected snapshot fetch"); });
  const repository = createFirestoreStudyRepository({
    async document(path) {
      calls.push(path);
      if (path === STUDY_CURRENT_BANK_PATH) return { schemaVersion: 1, releaseId: release, sourceRevision: catalog.sourceRevision };
      if (path.endsWith("/catalogs/az104")) return catalog;
      if (path.endsWith(`/questions/${document.question.id}`)) return document;
      throw new Error("Unexpected document");
    },
    async comments(id, count) {
      commentQueries++;
      assert.equal(id, document.question.id);
      assert.equal(count, discussion.comments.length);
      return discussion.comments;
    },
  }, archive, "https://study-az104.web.app/");
  assert.deepEqual(await repository.loadCatalog(), catalog);
  assert.deepEqual(await repository.loadQuestion(document.question.id), document);
  assert.deepEqual(await repository.loadQuestion(document.question.id), document);
  assert.equal(commentQueries, 0);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((path) => path === STUDY_CURRENT_BANK_PATH || path.startsWith(`studyReleases/${release}/`)));
  await repository.loadDiscussion(document.question.id);
  await repository.loadDiscussion(document.question.id);
  assert.equal(commentQueries, 1);
});

test("Firestore failures do not masquerade as local snapshot success", async () => {
  let snapshotReads = 0;
  const archive = createStudyRepository("https://example.test/", async () => {
    snapshotReads++;
    throw new Error("Unexpected snapshot request");
  });
  const repository = createFirestoreStudyRepository({
    async document() { throw new Error("permission-denied"); },
    async comments() { throw new Error("Unexpected comments"); },
  }, archive, "https://study-az104.web.app/");
  await assert.rejects(repository.loadCatalog(), /permission-denied/);
  assert.equal(snapshotReads, 0);
});

test("legacy releases deliberately use their pinned archive without changing session identities", async () => {
  const { catalog, document } = await fixture;
  const older = `r_${"1".repeat(64)}`;
  let requested: string | undefined;
  const archive: StudyRepository = {
    async loadCatalog(id) { requested = id; return { ...catalog, releaseId: older }; },
    async loadQuestion(id, version) { assert.equal(id, document.question.id); assert.equal(version, older); return { ...document, releaseId: older }; },
    async loadQuestions() { throw new Error("Unused"); },
    async loadDiscussion() { throw new Error("Unused"); },
    mediaUrl() { throw new Error("Unused"); },
  };
  const repository = createFirestoreStudyRepository({
    async document(path) {
      return path === STUDY_CURRENT_BANK_PATH
        ? { schemaVersion: 1, releaseId: release, sourceRevision: catalog.sourceRevision } : catalog;
    },
    async comments() { throw new Error("Unused"); },
  }, archive, "https://study-az104.web.app/");
  assert.equal((await repository.loadQuestion(document.question.id, older)).releaseId, older);
  assert.equal(requested, older);
});
