import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { LearningDatasetSchema, LearningManifestSchema } from "../src/domain/learning.js";
import { TopicMapSchema } from "../src/domain/topics.js";
import { DEMO_QUESTION_COUNT } from "../src/domain/demo.js";
import { createDemoRepository } from "../src/web/demo-repository.js";
import { createAttempt, reduceAttempt, scoreAttempt } from "../src/web/engine.js";
import { loadCoursePublication } from "../tools/course/publication.js";
import { createDemoBank } from "../tools/demo/fixtures.js";
import { DEMO_PUBLIC_DIRECTORY, exportDemo } from "../tools/demo/export.js";
import { validateExplanation } from "../tools/learning/validate.js";
import { hash, json, loadCleanBank, regularFiles } from "../tools/web/bank.js";

test("demo fixtures are deterministic, original, strict-schema records with no imported media or discussion", () => {
  const bank = createDemoBank();
  assert.equal(bank.manifest.counts.questions, DEMO_QUESTION_COUNT);
  assert.equal(bank.manifest.counts.comments, 0);
  assert.equal(bank.manifest.counts.images, 0);
  assert.equal(bank.manifest.releaseId, createDemoBank().manifest.releaseId);
  for (const document of bank.release.documents) {
    assert.deepEqual(document.question.media, []);
    assert.deepEqual(document.question.assetIds, []);
    assert.equal(document.discussionEnabled, false);
    assert.ok(document.question.sources.every((source) => new URL(source.url).hostname === "example.invalid"));
    const explanation = bank.dataset.explanations.find((item) => item.questionId === document.question.id)!;
    validateExplanation(explanation, document);
    assert.equal(bank.learning.records[document.question.id]!.sha256, hash(json(explanation)));
  }
  assert.equal(TopicMapSchema.safeParse(bank.topics).success, false, "production still requires every real source identity");
  assert.equal(LearningManifestSchema.safeParse(bank.learning).success, false);
  assert.equal(LearningDatasetSchema.safeParse(bank.dataset).success, false);
});

test("demo repository supports a complete local practice session and rejects a non-demo marker", async () => {
  const bank = createDemoBank();
  const requested: string[] = [];
  const fetcher = (async (input) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://demo.example");
    requested.push(url.pathname);
    const value = bank.files.get(url.pathname.slice(1));
    return value === undefined ? new Response("missing", { status: 404 }) : Response.json(value);
  }) as typeof fetch;
  const repository = createDemoRepository("https://demo.example/", fetcher);
  const catalog = await repository.loadCatalog();
  const documents = await repository.loadQuestions(catalog.questions.map((question) => question.id));
  let attempt = createAttempt({ documents, mode: "free", id: "demo-session", now: 1 });
  for (const document of documents) {
    const key = document.answers.effectiveAnswer.value;
    assert.equal(key.kind, "option-selection");
    if (key.kind !== "option-selection") throw new Error("Expected demo choice key.");
    attempt = reduceAttempt(attempt, { type: "select", questionId: document.question.id, optionId: key.optionIds[0]! }, documents, 2);
    attempt = reduceAttempt(attempt, { type: "submit", questionId: document.question.id }, documents, 3);
    const explanation = await repository.loadExplanation!(document);
    assert.equal(explanation.explanation.questionId, document.question.id);
    assert.equal((await repository.loadDiscussion(document.question.id)).comments.length, 0);
  }
  attempt = reduceAttempt(attempt, { type: "finish" }, documents, 4);
  assert.equal(scoreAttempt(attempt, documents).automatic.correct, DEMO_QUESTION_COUNT);
  assert.ok(requested.every((path) => !path.includes("eligibility")));
  bank.files.set("data/demo.json", { ...bank.metadata, kind: "production" });
  await assert.rejects(createDemoRepository("https://demo.example/", fetcher).loadCatalog());
});

test("public authoring reproduces the identical reviewed course release and served bytes", async () => {
  const course = await loadCoursePublication();
  assert.equal(course.pointer.releaseId, "c_0888a1dd6a7bbc057b0d968e73168763e890ec3738a65a80db61baf9863b3e00");
  assert.equal(course.pointer.sha256, "d88357128e65dabc3a49249a9ad6106159f8356e34fac5d1e913acc1760430f6");
  assert.equal(course.pointer.modules, 8);
  assert.equal(course.pointer.lessons, 21);
  assert.equal(course.pointer.checkpoints, 86);
});

test("demo export needs only public source files, preserves private outputs, and rejects symlink output", async () => {
  const root = resolve(`.data/demo-test-${randomUUID()}`);
  try {
    await mkdir(resolve(root, "public/data"), { recursive: true });
    await mkdir(resolve(root, "dist"), { recursive: true });
    await mkdir(resolve(root, ".data/clean-bank"), { recursive: true });
    await cp("content/networking", resolve(root, "content/networking"), { recursive: true });
    await cp("content/course.json", resolve(root, "content/course.json"));
    await cp("public/favicon.svg", resolve(root, "public/favicon.svg"));
    const sentinels = ["public/data/sentinel.json", "dist/sentinel.txt", ".data/clean-bank/sentinel.txt"];
    for (const path of sentinels) await writeFile(resolve(root, path), "leave unchanged");
    const first = await exportDemo(root);
    assert.equal(first.questions, DEMO_QUESTION_COUNT);
    assert.equal(first.lessons, 21);
    assert.deepEqual(await exportDemo(root), first);
    for (const path of sentinels) assert.equal(await readFile(resolve(root, path), "utf8"), "leave unchanged");
    await assert.rejects(loadCleanBank(root), /ENOENT/, "demo must not become a production-bank fallback");
    const output = resolve(root, DEMO_PUBLIC_DIRECTORY);
    const files = await regularFiles(output);
    assert.equal(files.filter((path) => /^content\/[^/]+\/questions\//.test(path)).length, DEMO_QUESTION_COUNT);
    assert.ok(!files.some((path) => path.endsWith("offline-worker.js") || path.includes("/media/")));
    await rm(output, { recursive: true });
    await symlink(resolve(root, "public"), output, "dir");
    await assert.rejects(exportDemo(root), /Unsafe directory/);
    const approvals = resolve(root, "content/networking/review-approvals.json");
    const changed = JSON.parse(await readFile(approvals, "utf8")) as Array<{ digest: string }>;
    changed[0]!.digest = "0".repeat(64);
    await writeFile(approvals, json(changed));
    await assert.rejects(loadCoursePublication(root), /approve this exact module/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
