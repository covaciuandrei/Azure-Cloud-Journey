import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  OfflineFileSchema, OfflineManifestSchema, selectOfflineFiles, type OfflineManifest,
} from "../src/domain/offline.js";
import { CleanDocumentSchema } from "../src/domain/cleanBank.js";
import { createOfflineAwareRepository } from "../src/web/offline-repository.js";
import type { StudyDocument, StudyRepository } from "../src/web/types.js";

const release = `r_${"a".repeat(64)}`;
const legacy = `r_${"b".repeat(64)}`;
const hex = (number: number) => number.toString(16).padStart(64, "0");
function manifestFixture(): OfflineManifest {
  return OfflineManifestSchema.parse({
    schemaVersion: 1, buildId: hex(99999), releaseId: release, counts: { questions: 604, comments: 7994, images: 784 },
    files: [
      ...["/index.html", "/favicon.svg", "/offline-worker.js", "/assets/index-abcdef.js"].map((url) =>
        ({ kind: "shell", url, sha256: hex(1), bytes: 10 })),
      { kind: "data", url: "/data/manifest.json", sha256: hex(1), bytes: 10 },
      { kind: "data", url: "/data/topics.json", sha256: hex(2), bytes: 10 },
      { kind: "data", url: "/data/learning.json", sha256: hex(3), bytes: 10 },
      { kind: "data", url: "/data/course.json", sha256: hex(5), bytes: 10 },
      { kind: "data", url: `/courses/c_${hex(6)}/networking.json`, sha256: hex(7), bytes: 10 },
      ...Array.from({ length: 606 }, (_, i) => ({
        kind: "data", url: `/teaching/${release}/questions/q_${hex(i)}.json`,
        sha256: hex(4), bytes: 10, releaseId: release, part: "explanation", questionId: `q_${hex(i)}`,
      })),
      ...[release, legacy].map((releaseId) => ({
        kind: "data", url: `/content/${releaseId}/catalog.json`, sha256: hex(1), bytes: 10, releaseId, part: "catalog",
      })),
      ...Array.from({ length: 604 }, (_, i) => ({
        kind: "data", url: `/content/${release}/questions/q_${hex(i)}.json`,
        sha256: hex(1), bytes: 10, releaseId: release, part: "question", questionId: `q_${hex(i)}`,
      })),
      { kind: "data", url: `/content/${release}/discussions/q_${hex(0)}.json`,
        sha256: hex(1), bytes: 10, releaseId: release, part: "discussion", questionId: `q_${hex(0)}`, commentCount: 7994 },
      ...[0, 1].map((i) => ({
        kind: "data", url: `/content/${legacy}/questions/q_${hex(i)}.json`,
        sha256: hex(1), bytes: 10, releaseId: legacy, part: "question", questionId: `q_${hex(i)}`,
      })),
      ...Array.from({ length: 784 }, (_, i) => ({
        kind: "image", url: `/content/${release}/media/${hex(i + 1000)}.png`,
        sha256: hex(i + 1000), bytes: 10, releaseId: release,
      })),
    ],
  });
}

test("offline file allowlist excludes private, auth, API and traversal paths", () => {
  for (const url of ["/data/approved-comments.json", "/__/firebase/init.json", "/api/session", "/users/alice",
    "https://example.test/index.html", "/assets/../secret.js", "/index.html?token=secret", "/%2e%2e/index.html"]) {
    assert.equal(OfflineFileSchema.safeParse({ kind: "shell", url, sha256: hex(1), bytes: 1 }).success, false);
  }
});

test("offline selection downloads the current bank, shared media once, and only requested legacy data", () => {
  const manifest = manifestFixture();
  const current = selectOfflineFiles(manifest);
  assert.equal(current.filter((file) => file.kind === "image").length, 784);
  assert.equal(current.filter((file) => file.part === "question").length, 604);
  assert.equal(current.some((file) => file.releaseId === legacy), false);
  assert.ok(current.some((file) => file.url === "/data/topics.json"));
  assert.ok(current.some((file) => file.url === "/data/learning.json"));
  assert.ok(current.some((file) => file.url === "/data/course.json"));
  assert.ok(current.some((file) => file.url === `/courses/c_${hex(6)}/networking.json`));
  assert.equal(current.filter((file) => file.part === "explanation").length, 606);
  const selected = selectOfflineFiles(manifest, [{ releaseId: legacy, questionIds: [`q_${hex(0)}`] }]);
  assert.equal(selected.filter((file) => file.releaseId === legacy).length, 2);
  assert.equal(selected.filter((file) => file.kind === "image").length, 784);
  assert.throws(() => selectOfflineFiles(manifest, [{ releaseId: legacy, questionIds: [`q_${hex(999)}`] }]), /unavailable/);
  assert.equal(OfflineManifestSchema.safeParse({ ...manifest, files: manifest.files.slice(1) }).success, false);
});

test("a reduced bank downloads retired explanations and exclusive images only for referenced old sessions", () => {
  const fixture = manifestFixture();
  const retiredId = `q_${hex(603)}`;
  const removed = fixture.files.find((file) => file.part === "question" && file.questionId === retiredId)!;
  const files = fixture.files.filter((file) => file !== removed);
  files.push({ ...removed, releaseId: legacy, url: `/content/${legacy}/questions/${retiredId}.json` });
  const images = files.filter((file) => file.kind === "image");
  images.forEach((file, index) => { file.questionIds = [index === 0 ? retiredId : `q_${hex(0)}`]; });
  const manifest = OfflineManifestSchema.parse({
    ...fixture, learningReleaseId: release, counts: { ...fixture.counts, questions: 603 }, files,
  });
  const current = selectOfflineFiles(manifest);
  assert.equal(current.filter((file) => file.part === "question").length, 603);
  assert.equal(current.filter((file) => file.part === "explanation").length, 603);
  assert.equal(current.filter((file) => file.kind === "image").length, 783);
  assert.ok(!current.some((file) => file.questionId === retiredId));
  const saved = selectOfflineFiles(manifest, [{ releaseId: legacy, questionIds: [retiredId] }]);
  assert.ok(saved.some((file) => file.part === "explanation" && file.questionId === retiredId));
  assert.ok(saved.some((file) => file.part === "question" && file.questionId === retiredId && file.releaseId === legacy));
  assert.equal(saved.filter((file) => file.kind === "image").length, 784);
  assert.equal(OfflineManifestSchema.safeParse({ ...manifest, counts: { ...manifest.counts, questions: 602 } }).success, false);
});

async function documentFixture() {
  const current = "r_b7f94b0d9dd9319c1d661c638cd9786be97dc83cb204871357c79639bb9fb5f2";
  const catalog = JSON.parse(await readFile(`.data/clean-bank/content/${current}/catalog.json`, "utf8")) as {
    questions: Array<{ number: number; id: string }>;
  };
  const id = catalog.questions.find((item) => item.number === 157)!.id;
  return CleanDocumentSchema.parse(JSON.parse(await readFile(`.data/clean-bank/content/${current}/questions/${id}.json`, "utf8")));
}

function stubRepository(document: StudyDocument, origin: string, onRead: () => void): StudyRepository {
  return {
    async loadCatalog() { onRead(); throw new Error("Not needed by this fixture"); },
    async loadQuestion() { onRead(); return document; },
    async loadQuestions() { onRead(); return [document]; },
    async loadDiscussion() { onRead(); return { schemaVersion: 1, releaseId: document.releaseId, questionId: document.question.id, comments: [] }; },
    mediaUrl(question, assetId) { return `${origin}/content/${document.releaseId}/media/${assetId}.png`; },
  };
}

test("switching offline preserves the owner of loaded questions and rewrites media to the cache origin", async () => {
  const document = await documentFixture();
  let offline = false;
  let primaryReads = 0;
  let downloadedReads = 0;
  const primary = stubRepository(document, "https://study-az104.web.app", () => primaryReads++);
  const downloaded = stubRepository(document, "http://127.0.0.1:4185", () => downloadedReads++);
  const repository = createOfflineAwareRepository(primary, downloaded, () => offline, "http://127.0.0.1:4185");
  const loaded = await repository.loadQuestion(document.question.id);
  offline = true;
  assert.ok(repository.mediaUrl(loaded.question, loaded.question.media[0]!.id, loaded.releaseId).startsWith("http://127.0.0.1:4185/content/"));
  assert.equal(downloadedReads, 0);
  await repository.loadQuestions([document.question.id], document.releaseId);
  assert.equal(primaryReads, 1);
  assert.equal(downloadedReads, 1);
});

test("online database errors never silently fall back to the downloaded copy", async () => {
  const document = await documentFixture();
  let downloadedReads = 0;
  const downloaded = stubRepository(document, "https://example.test", () => downloadedReads++);
  const primary = { ...downloaded, async loadQuestion() { throw new Error("permission-denied"); } };
  const repository = createOfflineAwareRepository(primary, downloaded, () => false, "https://example.test");
  await assert.rejects(repository.loadQuestion(document.question.id), /permission-denied/);
  assert.equal(downloadedReads, 0);
});
