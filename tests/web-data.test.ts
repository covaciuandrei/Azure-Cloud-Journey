import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import test, { after } from "node:test";
import { CleanDocumentSchema, CleanManifestSchema, mediaExtension } from "../src/domain/cleanBank.js";
import { createStudyRepository } from "../src/web/data.js";
import { createAttempt, validateAttemptDocuments } from "../src/web/engine.js";
import { STORAGE_KEY } from "../src/web/storage.js";
import type { StudyCatalog, StudyDiscussion, StudyDocument, StudyManifest } from "../src/web/types.js";
import { hash, loadCleanBank, regularFiles } from "../tools/web/bank.js";
import { exportSnapshot } from "../tools/web/export.js";
import { readTopicMap } from "../tools/topics/data.js";
import { loadStudyPublication, publicationFileBytes } from "../tools/learning/publication.js";
import { loadCoursePublication } from "../tools/course/publication.js";

const root = resolve(import.meta.dirname, "..");
const scratch = resolve(root, ".data", "web-data-tests", String(process.pid));
const isolated = resolve(scratch, "isolated");
const exportRoot = resolve(scratch, "export");
const isolatedBank = resolve(isolated, ".data/clean-bank");
const bankPromise = loadCleanBank(root);
after(async () => { await rm(scratch, { recursive: true, force: true }); });

test("frozen bank is strict, complete, and preserves every legacy release and saved attempt", async () => {
  const bank = await bankPromise;
  assert.equal(bank.releases.length, 4);
  assert.equal(bank.manifest.counts.questions, 604);
  assert.equal(bank.manifest.counts.comments, 7994);
  assert.equal(bank.manifest.counts.images, 784);
  assert.equal(bank.manifest.counts.automatic, 396);
  assert.equal(bank.manifest.counts.manual, 208);
  assert.equal(STORAGE_KEY, "az104-study-room:v1");
  for (const release of bank.releases) {
    assert.equal(release.discussions.flatMap((discussion) => discussion.comments).length, 7994);
    const documents = release.documents.slice(0, 10);
    const active = createAttempt({ mode: "free", documents, now: 1000, id: "saved-session" });
    assert.doesNotThrow(() => validateAttemptDocuments(JSON.parse(JSON.stringify(active)), documents));
    for (const document of release.documents) {
      const serialized = JSON.stringify(document);
      assert.doesNotMatch(serialized,
        /"(?:assessment|review|reviewer|reviewedAt|citations|supportingExamples|sourcePresentation|sourceLabels|sourceOptionOrder|sourceLabelToOptionId|originalImageAnswers|effectiveImageAnswerSummary|conversion|published|contentHash)"\s*:/);
      assert.deepEqual([...document.question.fixedOptionOrder].sort(), document.question.options.map(({ id }) => id).sort());
    }
  }
  const current = bank.releases.find((release) => release.catalog.releaseId === bank.manifest.releaseId)!;
  assert.deepEqual(current.catalog.questions.find((summary) => summary.number === 48)?.sourceNumbers, [48, 54]);
  assert.deepEqual(current.catalog.questions.find((summary) => summary.number === 152)?.sourceNumbers, [152, 165]);
});

test("export uses the validated study publication, stays idempotent, and removes stray output data", async () => {
  const bank = await bankPromise;
  const publication = await loadStudyPublication(root);
  const course = await loadCoursePublication(root);
  for (const [path, value] of course.files) publication.files.set(path, { kind: "json", value });
  const before = hash(await readFile(resolve(bank.directory, "data/manifest.json")));
  const publicBefore = hash(await readFile(resolve(root, "public/data/manifest.json")));
  await mkdir(resolve(exportRoot, "content"), { recursive: true });
  await writeFile(resolve(exportRoot, "content", "obsolete-review.json"), "{}");
  const result = await exportSnapshot({ workspaceRoot: root, outputDir: relative(root, exportRoot) });
  assert.deepEqual(result.manifest, publication.manifest);
  const publicFiles = [...publication.files.keys(), "data/topics.json"].sort();
  assert.equal(result.files, publicFiles.length);
  const paths = await regularFiles(exportRoot);
  assert.deepEqual(paths, publicFiles);
  await assert.rejects(readFile(resolve(exportRoot, "data/approved-comments.json")), /ENOENT/,
    "The private frozen identity ledger must not be hosted");
  for (const path of paths) {
    const expected = path === "data/topics.json" ? Buffer.from(`${JSON.stringify(await readTopicMap(root), null, 2)}\n`) :
      await publicationFileBytes(publication.files.get(path)!);
    assert.equal(hash(await readFile(resolve(exportRoot, path))), hash(expected));
  }
  const again = await exportSnapshot({ workspaceRoot: root, outputDir: relative(root, exportRoot) });
  assert.equal(again.bytes, result.bytes);
  assert.equal(hash(await readFile(resolve(bank.directory, "data/manifest.json"))), before);
  assert.equal(hash(await readFile(resolve(root, "public/data/manifest.json"))), publicBefore);
  for (const path of bank.files) {
    await mkdir(resolve(isolatedBank, path, ".."), { recursive: true });
    await writeFile(resolve(isolatedBank, path), await readFile(resolve(bank.directory, path)));
  }
  const image = bank.files.find((path) => path.includes("/media/"))!;
  const originalImage = await readFile(resolve(isolatedBank, image));
  await writeFile(resolve(isolatedBank, image), "corrupted");
  await assert.rejects(exportSnapshot({ workspaceRoot: isolated }), /hash\/length verification/);
  await assert.rejects(readFile(resolve(isolated, "public/data/manifest.json")), /ENOENT/);
  await writeFile(resolve(isolatedBank, image), originalImage);
  const questionPath = bank.files.find((path) => path.includes("/questions/"))!;
  const originalDocument = await readFile(resolve(isolatedBank, questionPath), "utf8");
  const contaminated = JSON.parse(originalDocument) as StudyDocument & { review?: unknown };
  contaminated.review = { summary: "must not be exported" };
  await writeFile(resolve(isolatedBank, questionPath), JSON.stringify(contaminated));
  await assert.rejects(exportSnapshot({ workspaceRoot: isolated }), /Unrecognized key/);
  await assert.rejects(readFile(resolve(isolated, "public/data/manifest.json")), /ENOENT/);
  await writeFile(resolve(isolatedBank, questionPath), originalDocument);
  await mkdir(resolve(scratch, "empty"), { recursive: true });
  await assert.rejects(exportSnapshot({ workspaceRoot: resolve(scratch, "empty") }), /ENOENT/);
  await assert.rejects(readFile(resolve(scratch, "empty/public/data/manifest.json")), /ENOENT/);
});

test("strict bank validation rejects injected review material and unknown files", async () => {
  const bank = await bankPromise;
  const document = bank.releases[0]!.documents[0]!;
  assert.throws(() => CleanDocumentSchema.parse({
    ...document, question: { ...document.question, sourcePresentation: {} },
  }), /Unrecognized key/);
  assert.throws(() => CleanDocumentSchema.parse({
    ...document, answers: { ...document.answers, assessment: { summary: "generated" } },
  }), /Unrecognized key/);
  assert.throws(() => CleanDocumentSchema.parse({
    ...document, question: { ...document.question, fixedOptionOrder: [] },
  }), /Fixed option order/);
  assert.throws(() => CleanManifestSchema.parse({
    ...bank.manifest, discussionQuestionNumbers: [],
  }), /Unrecognized key/);
});

type MockOptions = {
  failOnce?: string;
  mutate?: (url: string, value: unknown) => unknown;
  delayQuestions?: boolean;
};
async function publicFixture(options: MockOptions = {}) {
  const bank = await bankPromise;
  const manifest = bank.manifest;
  const current = bank.releases.find((release) => release.catalog.releaseId === manifest.releaseId)!;
  const catalog = current.catalog;
  const documents = new Map(current.documents.map((document) => [document.question.id, document]));
  const discussions = new Map(current.discussions.map((discussion) => [discussion.questionId, discussion]));
  const base = "https://study.example/app/";
  const calls: string[] = [];
  let failed = false;
  let active = 0;
  let maxActive = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    assert.ok(url.startsWith(base), `unexpected non-local URL ${url}`);
    assert.equal(init?.cache, "no-store", "Reused legacy URLs must not reload unsanitized HTTP cache entries");
    if (options.failOnce === url && !failed) {
      failed = true;
      return new Response("retry", { status: 503 });
    }
    let value: unknown;
    if (url === `${base}data/manifest.json`) value = manifest;
    else {
      const release = bank.releases.find((candidate) => url.startsWith(`${base}content/${candidate.catalog.releaseId}/`));
      if (release && url.endsWith("/catalog.json")) value = release.catalog;
      else if (release) {
        const match = /\/(questions|discussions)\/(q_[a-f0-9]{64})\.json$/.exec(url);
        value = match?.[1] === "questions"
          ? release.documents.find((document) => document.question.id === match[2])
          : match?.[1] === "discussions"
            ? release.discussions.find((discussion) => discussion.questionId === match[2]) : undefined;
      }
    }
    if (value === undefined) return new Response("missing", { status: 404 });
    if (options.delayQuestions && url.includes("/questions/")) {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((done) => setTimeout(done, 5));
      active--;
    }
    value = options.mutate?.(url, structuredClone(value)) ?? value;
    return Response.json(value);
  };
  return { base, calls, catalog, documents, discussions, fetcher, manifest, bank, getMaxActive: () => maxActive };
}

test("browser repository is same-origin, cached, retryable, bounded, and order preserving", async () => {
  const fixture = await publicFixture({ delayQuestions: true });
  const repository = createStudyRepository(fixture.base, fixture.fetcher);
  const [firstCatalog, secondCatalog] = await Promise.all([repository.loadCatalog(), repository.loadCatalog()]);
  assert.strictEqual(firstCatalog, secondCatalog);
  assert.equal(fixture.calls.filter((url) => url.endsWith("data/manifest.json")).length, 1);
  assert.equal(fixture.calls.filter((url) => url.endsWith("/catalog.json")).length, 1);
  const ids = fixture.catalog.questions.slice(0, 6).map((question) => question.id).reverse();
  const loaded = await repository.loadQuestions(ids);
  assert.deepEqual(loaded.map((document) => document.question.id), ids);
  assert.ok(fixture.getMaxActive() <= 4 && fixture.getMaxActive() > 1);
  assert.strictEqual(await repository.loadQuestion(ids[0]!), loaded[0]);
  const discussion = await repository.loadDiscussion(ids[0]!);
  assert.equal(discussion.questionId, ids[0]);
  const imageId = fixture.catalog.questions.find((summary) => summary.hasImages)!.id;
  const mediaDocument = await repository.loadQuestion(imageId);
  const media = mediaDocument.question.media[0]!;
  assert.equal(repository.mediaUrl(mediaDocument.question, media.id),
    `${fixture.base}${fixture.manifest.mediaBaseUrl}${media.id}.${mediaExtension(media.contentType)}`);
  const retryId = fixture.catalog.questions[0]!.id;
  const retry = await publicFixture({
    failOnce: `${fixture.base}${fixture.manifest.questionBaseUrl}${retryId}.json`,
  });
  const retryRepository = createStudyRepository(retry.base, retry.fetcher);
  await assert.rejects(retryRepository.loadQuestion(retryId), /HTTP 503/);
  assert.equal((await retryRepository.loadQuestion(retryId)).question.id, retryId);
});

test("browser repository rejects missing IDs, release/path attacks, and broken threads", async () => {
  const fixture = await publicFixture();
  const repository = createStudyRepository(fixture.base, fixture.fetcher);
  await repository.loadCatalog();
  const id = fixture.catalog.questions[0]!.id;
  await assert.rejects(repository.loadQuestion(`q_${"f".repeat(64)}`), /Unknown question ID/);
  await assert.rejects(repository.loadQuestions([id, id]), /Duplicate question IDs/);
  assert.throws(() => repository.mediaUrl(fixture.documents.get(id)!.question, "f".repeat(64)), /no media asset/);
  const malicious = await publicFixture({
    mutate(url, value) {
      return url.endsWith("data/manifest.json")
        ? { ...(value as StudyManifest), catalogUrl: "https://evil.example/catalog.json" } : value;
    },
  });
  await assert.rejects(createStudyRepository(malicious.base, malicious.fetcher).loadCatalog(), /Unsafe|Manifest paths/);
  const mismatch = await publicFixture({
    mutate(url, value) {
      return url.endsWith("/catalog.json") ? { ...(value as StudyCatalog), releaseId: `r_${"f".repeat(64)}` } : value;
    },
  });
  await assert.rejects(createStudyRepository(mismatch.base, mismatch.fetcher).loadCatalog(), /does not match/);
  const broken = await publicFixture({
    mutate(url, value) {
      if (url.includes("/discussions/")) {
        const discussion = value as StudyDiscussion;
        if (discussion.comments[0]) discussion.comments[0].rootId = `c_${"f".repeat(64)}`;
      }
      return value;
    },
  });
  const brokenId = broken.catalog.questions.find((summary) => summary.commentCount > 0)!.id;
  await assert.rejects(createStudyRepository(broken.base, broken.fetcher).loadDiscussion(brokenId), /comment root/);
});

test("frozen discussions load without review context or reclassification and empty ones do not fetch", async () => {
  const fixture = await publicFixture();
  const repository = createStudyRepository(fixture.base, fixture.fetcher);
  const empty = fixture.catalog.questions.find((summary) => summary.commentCount === 0)!;
  assert.deepEqual((await repository.loadDiscussion(empty.id)).comments, []);
  assert.ok(!fixture.calls.some((url) => url.includes("/discussions/")));
  const populated = fixture.catalog.questions.find((summary) => summary.commentCount > 0)!;
  const discussion = await repository.loadDiscussion(populated.id);
  assert.deepEqual(discussion.comments, fixture.discussions.get(populated.id)!.comments);
  assert.ok(!fixture.calls.some((url) => url.includes("/questions/")), "No review/question context is needed to retain frozen comments");
});

test("legacy question IDs, grading keys, media and frozen comments load against a newer manifest", async () => {
  const fixture = await publicFixture();
  const repository = createStudyRepository(fixture.base, fixture.fetcher);
  const legacy = fixture.bank.releases.find((release) => release.catalog.counts.questions === 606)!;
  assert.ok(legacy);
  const summary = legacy.catalog.questions.find((question) => question.number === 54)!;
  const document = await repository.loadQuestion(summary.id, legacy.catalog.releaseId);
  assert.equal(document.releaseId, legacy.catalog.releaseId);
  assert.deepEqual(document.answers, legacy.documents.find((item) => item.question.id === summary.id)!.answers);
  assert.equal((await repository.loadDiscussion(summary.id, legacy.catalog.releaseId)).comments.length, summary.commentCount);
  const imageDocument = legacy.documents.find((item) => item.question.media.length > 0)!;
  const restored = await repository.loadQuestion(imageDocument.question.id, legacy.catalog.releaseId);
  const media = restored.question.media[0]!;
  assert.match(repository.mediaUrl(restored.question, media.id), new RegExp(`/content/${legacy.catalog.releaseId}/media/`));
  assert.throws(() => repository.mediaUrl(restored.question, media.id, fixture.manifest.releaseId), /Unknown question|another loaded snapshot/);
  const before = fixture.calls.length;
  await assert.rejects(repository.loadCatalog("../../private"), /Invalid saved study snapshot/);
  assert.equal(fixture.calls.length, before);
});
