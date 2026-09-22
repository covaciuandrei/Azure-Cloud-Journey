import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { decodeSc900CloudEnvelope } from "../src/domain/sc900Cloud.js";
import { Sc900DocumentSchema } from "../src/domain/sc900Bank.js";
import { createSc900RestAdapter, emulatorOrigin } from "../tools/sc900/cloud-adapter.js";
import { executeSc900CloudPlan, writeCloudFile, type Sc900CloudQuotas } from "../tools/sc900/cloud-executor.js";
import { METADATA_PATHS, EMULATOR_PROJECT, EMULATOR_BUCKET, type Sc900CloudPlan } from "../tools/sc900/cloud-plan.js";
import { openSc900FirestoreBudgets, runSc900CloudApply } from "../tools/sc900/upload.js";
import { StorageReservations, type StorageUsage } from "../tools/publish/storage-clean.js";
import { MemoryWriteBudget, pacificQuotaDay } from "../tools/publish/quota.js";
import { sc900CloudFixture } from "./sc900-cloud-fixture.js";

const configured = Boolean(process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_STORAGE_EMULATOR_HOST);
function local() {
  const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST!;
  const storageHost = process.env.FIREBASE_STORAGE_EMULATOR_HOST!;
  const firestore = emulatorOrigin(firestoreHost);
  const storage = emulatorOrigin(storageHost);
  assert.equal(process.env.GCLOUD_PROJECT, EMULATOR_PROJECT);
  const requests: Array<{ url: string; method: string }> = [];
  const original = globalThis.fetch;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    assert.ok([firestore, storage].includes(url.origin), "Emulator tests must never contact production");
    requests.push({ url: url.href, method: init?.method ?? "GET" });
    return original(input, init);
  };
  const adapter = createSc900RestAdapter({ target: "emulator", firestoreHost, storageHost, fetcher });
  return { adapter, requests, firestore, storage, fetcher };
}
async function clearOwnPointers(plan: Sc900CloudPlan, firestore: string) {
  for (const path of METADATA_PATHS) {
    const url = `${firestore}/v1/projects/${EMULATOR_PROJECT}/databases/(default)/documents/${path}`;
    const response = await fetch(url, { headers: { Authorization: "Bearer owner" } });
    if (response.status === 404) continue;
    assert.equal(response.status, 200);
    const body = await response.json() as { fields: { releaseId: { stringValue: string } } };
    assert.equal(body.fields.releaseId.stringValue, plan.releaseId, "Only this synthetic release's pointers may be cleaned");
    assert.ok((await fetch(url, { method: "DELETE", headers: { Authorization: "Bearer owner" } })).ok);
  }
}

test("real REST executor verifies original private bytes, nested documents and idempotent atomic pointers in demo emulators", {
  skip: !configured,
}, async () => {
  const root = resolve(`.data/sc900-cloud-emulator/${randomUUID()}`);
  const context = local();
  const previousFetch = globalThis.fetch;
  let fixture: Awaited<ReturnType<typeof sc900CloudFixture>> | undefined;
  try {
    globalThis.fetch = context.fetcher;
    fixture = await sc900CloudFixture(root);
    const { plan, approval } = fixture;
    const planPath = `.data/sc900-cloud/plans/${plan.planDigest}.json`;
    const approvalPath = `.data/sc900-cloud/approvals/${plan.planDigest}.json`;
    await writeCloudFile(root, planPath, plan);
    await writeCloudFile(root, approvalPath, approval);
    const result = await runSc900CloudApply({ workspace: root, planPath, cloudApprovalPath: approvalPath, emulator: true });
    assert.equal(result.status, "verified");
    const creates = context.requests.filter((request) => request.method === "POST").length;
    assert.equal((await runSc900CloudApply({ workspace: root, planPath, cloudApprovalPath: approvalPath, emulator: true })).status, "verified");
    assert.equal(context.requests.filter((request) => request.method === "POST").length, creates);
    const operation = plan.documents.find((item) => item.path.includes("/questions/"))!;
    const remote = await context.adapter.getDocument(operation.path);
    assert.ok(remote);
    const question = Sc900DocumentSchema.parse(await decodeSc900CloudEnvelope(remote.data));
    assert.deepEqual(question, fixture.publication.documents.find((item) => item.question.id === question.question.id));
    assert.ok(question.question.prompt.some((block) => block.type === "list" && Array.isArray(block.items[0])));
    const object = await context.adapter.getObject(plan.objects[0]!);
    assert.equal(object?.contentSha256, plan.objects[0]!.sha256);
    assert.equal(object?.cacheControl, "private,no-store");
    assert.deepEqual(Object.keys(object?.metadata ?? {}), ["sha256"]);
    assert.equal(plan.objects[0]!.name, question.question.media[0]!.objectPath);
    const discussed = fixture.publication.documents.find((item) => item.question.commentCount > 0)!;
    const query = await fetch(`${context.firestore}/v1/projects/${EMULATOR_PROJECT}/databases/(default)/documents/studyBanks/sc900/releases/${plan.releaseId}:runQuery`, {
      method: "POST", headers: { Authorization: "Bearer owner", "Content-Type": "application/json" },
      body: JSON.stringify({ structuredQuery: { from: [{ collectionId: "comments" }],
        where: { fieldFilter: { field: { fieldPath: "questionId" }, op: "EQUAL", value: { stringValue: discussed.question.id } } }, limit: 100 } }),
    });
    assert.equal(query.status, 200);
    const matches = await query.json() as Array<{ document?: unknown }>;
    assert.equal(matches.filter((entry) => entry.document).length, discussed.question.commentCount);
    assert.ok(context.requests.every((request) => !request.url.includes("/studyMetadata/az104") && !request.url.includes("/users/")));
    assert.ok(context.requests.every((request) => request.method !== "DELETE"));
    assert.equal(result.applicationActivated, false);
  } finally {
    globalThis.fetch = previousFetch;
    if (fixture) await clearOwnPointers(fixture.plan, context.firestore);
    await rm(root, { recursive: true, force: true });
  }
});

test("real emulator partial Storage/document/commit failures recover without overwrites or premature pointers", {
  skip: !configured,
}, async () => {
  const root = resolve(`.data/sc900-cloud-emulator/${randomUUID()}`);
  const context = local();
  let fixture: Awaited<ReturnType<typeof sc900CloudFixture>> | undefined;
  try {
    fixture = await sc900CloudFixture(root);
    const { plan, approval } = fixture;
    let reads = 45000;
    const budget: Sc900CloudQuotas = {
      reads: { remaining: () => reads, async reserve(n) { assert.ok(n <= reads); reads -= n; } },
      writes: new MemoryWriteBudget(pacificQuotaDay(new Date()), 18000, 18000), deletes: { remaining: () => 18000 },
      storage: { async reserve() {} },
      privacy: { bucketName: EMULATOR_BUCKET, safeForPrivateUploads: true, uniformBucketLevelAccess: true,
        publicAccessPrevention: null, anonymousIamBindings: [], anonymousDefaultObjectAcls: [] },
    };
    let objectInterrupted = false;
    let documentInterrupted = false;
    let commitInterrupted = false;
    const adapter = {
      ...context.adapter,
      async createObject(...args: Parameters<typeof context.adapter.createObject>) {
        await context.adapter.createObject(...args);
        if (!objectInterrupted) { objectInterrupted = true; throw new Error("Synthetic lost Storage acknowledgement"); }
      },
      async createDocument(...args: Parameters<typeof context.adapter.createDocument>) {
        await context.adapter.createDocument(...args);
        if (!documentInterrupted && args[0].path.startsWith("studyBanks/")) {
          documentInterrupted = true; throw new Error("Synthetic lost document acknowledgement");
        }
      },
      async switchMetadata(...args: Parameters<typeof context.adapter.switchMetadata>) {
        await context.adapter.switchMetadata(...args);
        if (!commitInterrupted) { commitInterrupted = true; throw new Error("Synthetic lost metadata acknowledgement"); }
      },
    };
    const run = () => executeSc900CloudPlan(plan, approval, {
      workspace: root, adapter, refresh: async () => budget, revalidate: fixture!.revalidate,
    });

    await assert.rejects(run(), /lost Storage/);
    for (const path of METADATA_PATHS) assert.equal(await context.adapter.getDocument(path), null);
    await assert.rejects(run(), /lost document/);
    for (const path of METADATA_PATHS) assert.equal(await context.adapter.getDocument(path), null);
    await assert.rejects(run(), /lost metadata/);
    for (const path of METADATA_PATHS) assert.ok(await context.adapter.getDocument(path));
    const result = await run();
    assert.equal(result.status, "verified");
    if (result.status === "verified") assert.equal(result.metadataUpdated, false);
    assert.equal(budget.writes.reservedThisRun, plan.documents.length * 2 + 4);
    const wrong = { ...plan.documents[0]!, data: { unsafe: true } };
    await assert.rejects(context.adapter.createDocument(wrong), /HTTP 409/);
    const stale = plan.metadata.map(() => null);
    await assert.rejects(context.adapter.switchMetadata(plan.metadata, stale), /HTTP 409/);
    assert.equal((await context.adapter.getDocument(plan.documents[0]!.path))?.data.encoding, "sc900-json-v1");
  } finally {
    if (fixture) await clearOwnPointers(fixture.plan, context.firestore);
    await rm(root, { recursive: true, force: true });
  }
});

test("real emulator quota pauses preserve shared read/write/delete caps and never publish a partial bank", {
  skip: !configured,
}, async () => {
  for (const mode of ["reads", "writes", "deletes"] as const) {
    const root = resolve(`.data/sc900-cloud-emulator/${randomUUID()}`);
    const context = local();
    try {
      const fixture = await sc900CloudFixture(root);
      const checkedAt = new Date().toISOString();
      const usage = { checkedAt, pacificDay: pacificQuotaDay(new Date()), periodStart: checkedAt,
        reads: mode === "reads" ? 45000 : 0, writes: mode === "writes" ? 17999 : 0, deletes: mode === "deletes" ? 18000 : 0 };
      const storageUsage: StorageUsage = { checkedAt, month: usage.pacificDay.slice(0, 7), periodStart: checkedAt,
        requests: 0, storedBytes: 0, transferBytes: 0, peakStoredBytes: 0,
        hostingStoredBytes: 0, hostingTransferBytes: 0, samples: {} };
      const refresh = async (): Promise<Sc900CloudQuotas> => ({
        ...await openSc900FirestoreBudgets(usage, root), storage: await StorageReservations.open(storageUsage, root),
        privacy: { bucketName: EMULATOR_BUCKET, safeForPrivateUploads: true, uniformBucketLevelAccess: true,
          publicAccessPrevention: null, anonymousIamBindings: [], anonymousDefaultObjectAcls: [] },
      });
      const result = await executeSc900CloudPlan(fixture.plan, fixture.approval, {
        workspace: root, adapter: context.adapter, refresh, revalidate: fixture.revalidate,
      });
      assert.equal(result.status, "paused");
      const writes = context.requests.filter((request) => request.method === "POST" && request.url.includes("documents:commit"));
      assert.equal(writes.length, mode === "writes" ? 1 : 0);
      for (const path of METADATA_PATHS) assert.equal(await context.adapter.getDocument(path), null);
      if (mode === "writes") {
        const current = await openSc900FirestoreBudgets({ ...usage, writes: 0 }, root);
        assert.equal(current.writes.remaining(), 0, "Reopening must not replenish the used global write allowance");
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test("real emulator download-token metadata is refused without automatic repair", {
  skip: !configured,
}, async () => {
  const root = resolve(`.data/sc900-cloud-emulator/${randomUUID()}`);
  const context = local();
  let fixture: Awaited<ReturnType<typeof sc900CloudFixture>> | undefined;
  try {
    fixture = await sc900CloudFixture(root);
    const { plan } = fixture;
    const planPath = `.data/sc900-cloud/plans/${plan.planDigest}.json`;
    const approvalPath = `.data/sc900-cloud/approvals/${plan.planDigest}.json`;
    await writeCloudFile(root, planPath, plan);
    await writeCloudFile(root, approvalPath, fixture.approval);
    const run = () => runSc900CloudApply({ workspace: root, planPath, cloudApprovalPath: approvalPath, emulator: true });
    assert.equal((await run()).status, "verified");
    const before = await Promise.all(METADATA_PATHS.map((path) => context.adapter.getDocument(path)));
    const object = plan.objects[0]!;
    const objectUrl = `${context.storage}/v0/b/${EMULATOR_BUCKET}/o/${encodeURIComponent(object.name)}`;
    const setMetadata = (metadata: object) => fetch(objectUrl, {
      method: "PATCH", headers: { Authorization: "Bearer owner", "Content-Type": "application/json" },
      body: JSON.stringify({ metadata }),
    });
    assert.equal((await setMetadata({ sha256: object.sha256, firebaseStorageDownloadTokens: "synthetic-emulator-only-token" })).status, 200);
    await assert.rejects(run(), /private-access settings/);
    assert.deepEqual(await Promise.all(METADATA_PATHS.map((path) => context.adapter.getDocument(path))), before);
  } finally {
    if (fixture) await clearOwnPointers(fixture.plan, context.firestore);
    await rm(root, { recursive: true, force: true });
  }
});

test("real emulator immutable-document tampering cannot be hidden by a completed checkpoint", {
  skip: !configured,
}, async () => {
  const root = resolve(`.data/sc900-cloud-emulator/${randomUUID()}`);
  const context = local();
  let fixture: Awaited<ReturnType<typeof sc900CloudFixture>> | undefined;
  try {
    fixture = await sc900CloudFixture(root);
    const { plan } = fixture;
    const planPath = `.data/sc900-cloud/plans/${plan.planDigest}.json`;
    const approvalPath = `.data/sc900-cloud/approvals/${plan.planDigest}.json`;
    await writeCloudFile(root, planPath, plan);
    await writeCloudFile(root, approvalPath, fixture.approval);
    const run = () => runSc900CloudApply({ workspace: root, planPath, cloudApprovalPath: approvalPath, emulator: true });
    assert.equal((await run()).status, "verified");
    const before = await Promise.all(METADATA_PATHS.map((path) => context.adapter.getDocument(path)));
    const path = plan.documents.find((item) => item.path.includes("/questions/"))!.path;
    const tamper = await fetch(`${context.firestore}/v1/projects/${EMULATOR_PROJECT}/databases/(default)/documents/${path}`, {
      method: "PATCH", headers: { Authorization: "Bearer owner", "Content-Type": "application/json" },
      body: JSON.stringify({ fields: { payload: { stringValue: "synthetic deliberate corruption" } } }),
    });
    assert.ok(tamper.ok);
    await assert.rejects(run(), /immutable content changed/);
    assert.deepEqual(await Promise.all(METADATA_PATHS.map((pointer) => context.adapter.getDocument(pointer))), before);
  } finally {
    if (fixture) await clearOwnPointers(fixture.plan, context.firestore);
    await rm(root, { recursive: true, force: true });
  }
});
