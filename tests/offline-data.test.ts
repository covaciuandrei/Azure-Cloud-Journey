import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  OFFLINE_COURSE_MAX_BYTES, OfflineFileSchema, OfflineManifestSchema, selectOfflineFiles, type OfflineManifest,
} from "../src/domain/offline.js";
import { CleanDocumentSchema } from "../src/domain/cleanBank.js";
import { createOfflineAwareRepository } from "../src/web/offline-repository.js";
import type { StudyDocument, StudyRepository } from "../src/web/types.js";
import { loadCoursePublication } from "../tools/course/publication.js";
import { createDemoBank } from "../tools/demo/fixtures.js";
import { validateHostingCourse } from "../tools/firebase/deploy-hosting-adc.js";
import { hash, json } from "../tools/web/bank.js";

const release = `r_${"a".repeat(64)}`;
const legacy = `r_${"b".repeat(64)}`;
const hex = (number: number) => number.toString(16).padStart(64, "0");
function manifestFixture(courseId: "networking" | "az104" = "networking"): OfflineManifest {
  return OfflineManifestSchema.parse({
    schemaVersion: 1, buildId: hex(99999), releaseId: release, counts: { questions: 604, comments: 7994, images: 784 },
    files: [
      ...["/index.html", "/favicon.svg", "/offline-worker.js", "/assets/index-abcdef.js"].map((url) =>
        ({ kind: "shell", url, sha256: hex(1), bytes: 10 })),
      { kind: "data", url: "/data/manifest.json", sha256: hex(1), bytes: 10 },
      { kind: "data", url: "/data/topics.json", sha256: hex(2), bytes: 10 },
      { kind: "data", url: "/data/learning.json", sha256: hex(3), bytes: 10 },
      { kind: "data", url: "/data/course.json", sha256: hex(5), bytes: 10 },
      { kind: "data", url: `/courses/c_${hex(6)}/${courseId}.json`, sha256: hex(7), bytes: 10 },
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

test("offline course allowlist accepts only bounded networking and AZ-104 release files", () => {
  const root = `/courses/c_${hex(6)}`;
  for (const name of ["networking", "az104"]) {
    const file = { kind: "data", url: `${root}/${name}.json`, sha256: hex(7), bytes: OFFLINE_COURSE_MAX_BYTES };
    assert.equal(OfflineFileSchema.safeParse(file).success, true);
    assert.equal(OfflineFileSchema.safeParse({ ...file, bytes: OFFLINE_COURSE_MAX_BYTES + 1 }).success, false);
    assert.equal(OfflineFileSchema.safeParse({ ...file, releaseId: release }).success, false);
  }
  for (const url of [
    `${root}/foreign.json`, `${root}/az104.json.bak`, `${root}/../az104.json`,
    `${root}/nested/az104.json`, `${root}/./az104.json`, `${root}/%2e%2e/az104.json`,
    `${root}\\az104.json`, `${root}/az104.json?download=1`, `${root}/az104.json#course`,
    "https://example.test" + root + "/az104.json", "//example.test" + root + "/az104.json",
    "/courses/c_bad/az104.json",
  ]) {
    assert.equal(OfflineFileSchema.safeParse({ kind: "data", url, sha256: hex(7), bytes: 10 }).success, false, url);
  }
  assert.ok(selectOfflineFiles(manifestFixture("az104")).some((file) => file.url === `${root}/az104.json`));
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

function documentFixture() {
  const document = createDemoBank().release.documents[0]!;
  const id = hex(123);
  return CleanDocumentSchema.parse({
    ...document,
    question: {
      ...document.question, assetIds: [id],
      media: [{
        id, objectPath: `published/az104/${document.releaseId}/assets/${id}.png`,
        contentType: "image/png", width: 1, height: 1, byteLength: 1,
        sourceUrls: ["https://example.invalid/original-offline-fixture.png"],
      }],
    },
  });
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

test("Hosting course validation uses the active publication and rejects changed, oversized and symlink files without deployment", async () => {
  const workspace = resolve(`.offline-course-test-${randomUUID()}`);
  try {
    await mkdir(resolve(workspace, "content"), { recursive: true });
    await cp("content/networking", resolve(workspace, "content/networking"), { recursive: true });
    await writeFile(resolve(workspace, "content/course.json"), json({ schemaVersion: 1, activeCourse: "networking" }));
    const publication = await loadCoursePublication(workspace);
    for (const [path, value] of publication.files) {
      await mkdir(dirname(resolve(workspace, "dist", path)), { recursive: true });
      await writeFile(resolve(workspace, "dist", path), json(value));
    }
    const validated = await validateHostingCourse(workspace);
    assert.equal(validated.id, "networking");
    assert.deepEqual(validated.pointer, publication.pointer);
    const cli = fileURLToPath(new URL("../tools/firebase/deploy-hosting-adc.ts", import.meta.url));
    const az104 = spawnSync(process.execPath, ["--import", "tsx", cli, "--az104"], {
      cwd: workspace, encoding: "utf8", timeout: 30_000,
    });
    assert.equal(az104.status, 1);
    assert.match(az104.stderr, /--az104 Hosting feature requires the active approved AZ-104 course package/);
    const conflicting = spawnSync(process.execPath, ["--import", "tsx", cli, "--az104", "--course"], {
      cwd: workspace, encoding: "utf8", timeout: 30_000,
    });
    assert.equal(conflicting.status, 1);
    assert.match(conflicting.stderr, /Choose a single deployment feature/);
    const pointerPath = resolve(workspace, "dist/data/course.json");
    const coursePath = resolve(workspace, "dist", publication.pointer.url);
    const modified = json(publication.course) + " ";
    await writeFile(coursePath, modified);
    await assert.rejects(validateHostingCourse(workspace), /content differs/);
    await writeFile(pointerPath, json({ ...publication.pointer, sha256: hash(modified) }));
    await assert.rejects(validateHostingCourse(workspace), /pointer differs/);
    await writeFile(pointerPath, json(publication.pointer));
    await writeFile(coursePath, Buffer.alloc(OFFLINE_COURSE_MAX_BYTES + 1));
    await assert.rejects(validateHostingCourse(workspace), /size limit/);
    await rm(coursePath);
    const original = resolve(workspace, "original-course.json");
    await writeFile(original, json(publication.course));
    await symlink(original, coursePath);
    await assert.rejects(validateHostingCourse(workspace), /Unsafe Hosting course file/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
