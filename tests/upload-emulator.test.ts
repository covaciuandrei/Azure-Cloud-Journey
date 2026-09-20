import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { deleteApp, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { digest, sha256 } from "../tools/ingest/normalize-shared.js";
import { createFirebaseUploadAdapter } from "../tools/publish/firebase-adapter.js";
import { executeUploadPlan } from "../tools/publish/execute.js";
import { MemoryWriteBudget } from "../tools/publish/quota.js";
import {
  UPLOAD_PROJECT_ID, type DocumentOperation, type ObjectOperation, type UploadPlan,
} from "../tools/publish/types.js";

const emulatorHosts = {
  firestore: process.env.FIRESTORE_EMULATOR_HOST,
  storage: process.env.FIREBASE_STORAGE_EMULATOR_HOST,
};
const configured = Boolean(emulatorHosts.firestore && emulatorHosts.storage);

test("an existing Admin app cannot redirect uploads to a different project", async () => {
  const app = initializeApp({ projectId: "unapproved-fixture-project" }, "az104-data-upload");
  try {
    assert.throws(() => createFirebaseUploadAdapter("demo-az104-study.appspot.com", {
      bucketName: "demo-az104-study.appspot.com", safeForPrivateUploads: true,
      uniformBucketLevelAccess: true, publicAccessPrevention: null,
      anonymousIamBindings: [], anonymousDefaultObjectAcls: [],
    }), /unapproved Firebase project/);
  } finally {
    await deleteApp(app);
  }
});

test("the production SDK adapter persists and resumes a synthetic release in local emulators", {
  skip: !configured,
}, async () => {
  assert.match(emulatorHosts.firestore ?? "", /^(127\.0\.0\.1|localhost):\d+$/);
  assert.match(emulatorHosts.storage ?? "", /^(127\.0\.0\.1|localhost):\d+$/);
  const runId = randomUUID();
  const hash = sha256(runId);
  const questionId = `q_${hash}`;
  const releaseId = `r_${hash}`;
  const directory = `.data/upload-emulator-tests/${runId}`;
  const bucketName = "demo-az104-study.appspot.com";
  const document = (
    phase: DocumentOperation["phase"], path: string, data: unknown, ownQuestion?: string,
  ): DocumentOperation => ({
    kind: "document", phase, path, data, contentHash: digest(data),
    byteLength: Buffer.byteLength(JSON.stringify(data)),
    ...(ownQuestion ? { questionId: ownQuestion } : {}),
  });
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
    "base64",
  );
  const archive = Buffer.from(JSON.stringify({ testRunId: runId, fixtureOnly: true }));
  await mkdir(directory, { recursive: true });
  await writeFile(`${directory}/pixel.png`, png);
  await writeFile(`${directory}/capture.json`, archive);
  const object = (
    phase: ObjectOperation["phase"], path: string, filename: string, bytes: Buffer, contentType: string,
  ): ObjectOperation => ({
    kind: "object", phase, path, sourcePath: `${directory}/${filename}`,
    sha256: sha256(bytes), byteLength: bytes.length, contentType, questionIds: [questionId],
  });
  const objects = [
    object("media", `published/az104/${releaseId}/assets/${sha256(png)}.png`, "pixel.png", png, "image/png"),
    object("archive", `private/az104/${releaseId}/capture.json`, "capture.json", archive, "application/json"),
  ];
  const documents = [
    document("comments", `questions/${questionId}/comments/c_fixture`, {
      testRunId: runId, body: [{ type: "text", spans: [{ text: "Synthetic comment" }] }],
    }, questionId),
    document("publication", `answerKeys/${questionId}`, {
      testRunId: runId, published: true, optionIds: ["fixture-option"],
    }, questionId),
    document("publication", `questions/${questionId}`, {
      testRunId: runId, published: true, title: "Synthetic emulator-only question",
    }, questionId),
    document("catalog", "catalogs/az104", { testRunId: runId, published: true, questionIds: [questionId] }),
  ];
  const plan: UploadPlan = {
    schemaVersion: 1, projectId: UPLOAD_PROJECT_ID, mode: "publish", status: "planned",
    importId: `import_${hash}`, releaseId, sourceRevision: hash, createdAt: new Date().toISOString(),
    blockers: [], warnings: [], documents, objects,
    counts: {
      documents: documents.length, objects: objects.length,
      objectBytes: png.length + archive.length,
      questions: 1, answers: 1, comments: 1, occurrences: 0, assets: 1,
    },
  };
  const adapter = createFirebaseUploadAdapter(bucketName, {
    bucketName, safeForPrivateUploads: true, uniformBucketLevelAccess: true,
    publicAccessPrevention: null, anonymousIamBindings: [], anonymousDefaultObjectAcls: [],
  });
  const app = getApps().find((candidate) => candidate.name === "az104-data-upload");
  assert.ok(app);
  const firestore = getFirestore(app);
  const bucket = getStorage(app).bucket(bucketName);
  try {
    assert.equal((await firestore.doc("catalogs/az104").get()).exists, false);
    const first = await executeUploadPlan(plan, {
      adapter, budget: new MemoryWriteBudget("2026-09-09", 100, 100),
    });
    assert.equal(first.status, "published");
    assert.equal(first.documents.created, 4);
    assert.equal(first.objects.created, 2);
    const resumed = await executeUploadPlan(plan, {
      adapter, budget: new MemoryWriteBudget("2026-09-09", 100, 100),
    });
    assert.equal(resumed.status, "published");
    assert.equal(resumed.documents.created, 0);
    assert.equal(resumed.objects.created, 0);
    const [stored] = await bucket.file(objects[1]!.path).download();
    assert.deepEqual(stored, archive);
  } finally {
    for (const operation of documents) {
      const reference = firestore.doc(operation.path);
      if ((await reference.get()).data()?.testRunId === runId) await reference.delete();
    }
    for (const operation of objects) {
      const file = bucket.file(operation.path);
      if ((await file.exists())[0]) await file.delete();
    }
    await deleteApp(app);
    await rm(directory, { recursive: true, force: true });
  }
});
