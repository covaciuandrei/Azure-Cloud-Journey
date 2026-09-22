import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { decodeSc900CloudEnvelope } from "../src/domain/sc900Cloud.js";
import { Sc900DocumentSchema } from "../src/domain/sc900Bank.js";
import {
  buildSc900CloudPlan, validateSc900CloudPlan, validateCloudApplyApproval, METADATA_PATHS, SourceScopeReceiptSchema,
  type CloudDocument, type Sc900CloudPlan,
} from "../tools/sc900/cloud-plan.js";
import { CloudQuotaPause, executeSc900CloudPlan, sc900CloudStageRoot, type Sc900CloudQuotas } from "../tools/sc900/cloud-executor.js";
import { boundedResponse, createSc900RestAdapter, emulatorOrigin, type RemoteDocument, type RemoteObject, type Sc900CloudAdapter } from "../tools/sc900/cloud-adapter.js";
import { canonicalJson, byteSha256, sc900Hash } from "../tools/sc900/canonical.js";
import { MemoryWriteBudget, pacificQuotaDay } from "../tools/publish/quota.js";
import { StorageReservations, type StorageUsage } from "../tools/publish/storage-clean.js";
import { openSc900FirestoreBudgets, assertSc900StorageUsage, parseSc900UploadArgs } from "../tools/sc900/upload.js";
import { sc900CloudFixture } from "./sc900-cloud-fixture.js";

function memoryCloud(plan: Sc900CloudPlan) {
  const documents = new Map<string, RemoteDocument>();
  const objects = new Map<string, RemoteObject>();
  const calls: string[] = [];
  let revision = 0;
  const put = (operation: CloudDocument) => documents.set(operation.path, {
    data: structuredClone(operation.data), updateTime: `2026-09-22T00:00:00.${String(++revision).padStart(9, "0")}Z`,
  });
  const adapter: Sc900CloudAdapter = {
    target: "emulator", projectId: plan.projectId, bucket: plan.bucket,
    async getDocument(path) { calls.push(`read:${path}`); return structuredClone(documents.get(path) ?? null); },
    async createDocument(operation) {
      calls.push(`create:${operation.path}`);
      if (documents.has(operation.path)) throw new Error("HTTP 409 create-only conflict");
      put(operation);
    },
    async switchMetadata(operations, previous) {
      calls.push("metadata-commit");
      if (operations.some((operation, index) => {
        const actual = documents.get(operation.path);
        return previous[index] ? actual?.updateTime !== previous[index]!.updateTime : actual !== undefined;
      })) throw new Error("Metadata CAS precondition conflict");
      operations.forEach(put);
    },
    async getObject(operation) { calls.push(`object-read:${operation.name}`); return structuredClone(objects.get(operation.name) ?? null); },
    async createObject(operation, bytes) {
      calls.push(`object-create:${operation.name}`);
      if (objects.has(operation.name)) throw new Error("HTTP 412 object conflict");
      objects.set(operation.name, { name: operation.name, generation: "1", size: String(bytes.length),
        contentType: operation.contentType, cacheControl: "private,no-store",
        metadata: { sha256: operation.sha256 }, contentSha256: byteSha256(bytes) });
    },
  };
  return { adapter, documents, objects, calls, put };
}
function quotas(bucket: string, writes = 18000): Sc900CloudQuotas {
  let reads = 45000;
  return {
    reads: { remaining: () => reads, async reserve(n) { if (n > reads) throw new Error("read budget"); reads -= n; } },
    writes: new MemoryWriteBudget(pacificQuotaDay(new Date()), writes, writes),
    deletes: { remaining: () => 18000 }, storage: { async reserve() {} },
    privacy: { bucketName: bucket, safeForPrivateUploads: true, uniformBucketLevelAccess: true,
      publicAccessPrevention: null, anonymousIamBindings: [], anonymousDefaultObjectAcls: [] },
  };
}
async function workspace(run: (root: string) => Promise<void>) {
  const root = resolve(`.data/sc900-cloud-tests/${randomUUID()}`);
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test("cloud planning verifies raw source-scope evidence and preserves nested rich content without cloud calls", async () => workspace(async (root) => {
  const fixture = await sc900CloudFixture(root);
  assert.equal(fixture.plan.objects[0]!.name,
    fixture.publication.documents[0]!.question.media[0]!.objectPath);
  const stored = fixture.plan.documents.find((item) => item.path.includes("/questions/"))!;
  const decoded = Sc900DocumentSchema.parse(await decodeSc900CloudEnvelope(stored.data));
  assert.ok(decoded.question.prompt.some((block) => block.type === "list" && Array.isArray(block.items[0])));
  assert.deepEqual(decoded, fixture.publication.documents.find((item) => item.question.id === decoded.question.id));
  await assert.rejects(decodeSc900CloudEnvelope({ ...stored.data, payload: "{}" }), /integrity/);
  await assert.rejects(buildSc900CloudPlan(root, {
    target: "production", approvalPath: fixture.approvalPath, sourceScopePath: fixture.sourceScopePath,
  }), /Synthetic fixtures/);
  await writeFile(resolve(root, fixture.sourceScopePath), `${JSON.stringify(fixture.receipt)}\n`);
  await assert.rejects(fixture.revalidate(), /actual source-scope receipt/);
  for (const changed of [
    { ...fixture.receipt, examId: 45 }, { ...fixture.receipt, observedSourceQuestionCount: 219 },
    { ...fixture.receipt, nextVisible: 1 }, { ...fixture.receipt, headings: [" Question 2", " Question 1"] },
    { ...fixture.receipt, url: "https://www.examprepper.co/exam/45/1" },
  ]) assert.equal(SourceScopeReceiptSchema.safeParse(changed).success, false);
}));

test("cloud plans and apply approval reject tampering, mixed targets and foreign paths", async () => workspace(async (root) => {
  const { plan, approval } = await sc900CloudFixture(root);
  assert.throws(() => validateCloudApplyApproval({ ...approval, sourceScopeSha256: "0".repeat(64) }, plan));
  assert.throws(() => validateSc900CloudPlan({ ...plan, target: "production" }));
  const changed = structuredClone(plan);
  changed.documents[0]!.path = "users/foreign/state/active";
  const { planDigest: _digest, ...data } = changed;
  changed.planDigest = sc900Hash("cloud-plan", data);
  assert.throws(() => validateSc900CloudPlan(changed), /foreign/);
  const partial = structuredClone(plan);
  partial.baseline[0]!.snapshot = { sha256: "a".repeat(64), updateTime: "2026-09-22T00:00:00Z" };
  const { planDigest: _partialDigest, ...partialData } = partial;
  partial.planDigest = sc900Hash("cloud-plan", partialData);
  assert.throws(() => validateSc900CloudPlan(partial), /metadata boundary/);
  const cloud = memoryCloud(plan);
  await assert.rejects(executeSc900CloudPlan(plan, approval, {
    workspace: root, adapter: { ...cloud.adapter, projectId: "study-az104" },
    refresh: async () => quotas(plan.bucket), revalidate: async () => plan,
  }), /approved target/);
  assert.equal(cloud.calls.length, 0);
  for (const host of ["evil.test:8080", "127.0.0.1.evil:8080", "127.0.0.1:99999", "http://127.0.0.1:8080"]) {
    assert.throws(() => emulatorOrigin(host));
  }
  assert.equal(parseSc900UploadArgs(["--dry-run", "--approval", ".data/a.json", "--scope", ".data/s.json"]).mode, "plan");
  for (const args of [["--apply", ".data/p.json"], ["--apply", ".data/p.json", "--cloud-approval", ".data/a.json", "--dry-run"],
    ["--emulator", "--emulator"], ["--delete"], ["--scope"]]) assert.throws(() => parseSc900UploadArgs(args));
}));

test("interrupted creates and lost metadata acknowledgements resume idempotently without duplicate writes", async () => workspace(async (root) => {
  const fixture = await sc900CloudFixture(root);
  const cloud = memoryCloud(fixture.plan);
  const budget = quotas(fixture.plan.bucket);
  let interrupted = false;
  const create = cloud.adapter.createDocument.bind(cloud.adapter);
  cloud.adapter.createDocument = async (operation) => {
    await create(operation);
    if (!interrupted && operation.path.startsWith("studyBanks/")) { interrupted = true; throw new Error("Synthetic lost create response"); }
  };
  const deps = { workspace: root, adapter: cloud.adapter, refresh: async () => budget, revalidate: fixture.revalidate };
  await assert.rejects(executeSc900CloudPlan(fixture.plan, fixture.approval, deps), /lost create response/);
  assert.ok(METADATA_PATHS.every((path) => !cloud.documents.has(path)));
  const commit = cloud.adapter.switchMetadata.bind(cloud.adapter);
  let lost = false;
  cloud.adapter.switchMetadata = async (operations, previous) => {
    await commit(operations, previous);
    if (!lost) { lost = true; throw new Error("Synthetic lost commit response"); }
  };
  await assert.rejects(executeSc900CloudPlan(fixture.plan, fixture.approval, deps), /lost commit response/);
  assert.ok(METADATA_PATHS.every((path) => cloud.documents.has(path)));
  const result = await executeSc900CloudPlan(fixture.plan, fixture.approval, deps);
  assert.equal(result.status, "verified");
  if (result.status === "verified") assert.equal(result.metadataUpdated, false);
  assert.equal(cloud.calls.filter((call) => call === "metadata-commit").length, 1);
  const before = cloud.calls.filter((call) => call.startsWith("create:") || call.startsWith("object-create:")).length;
  assert.equal((await executeSc900CloudPlan(fixture.plan, fixture.approval, deps)).status, "verified");
  assert.equal(cloud.calls.filter((call) => call.startsWith("create:") || call.startsWith("object-create:")).length, before);
  assert.ok(cloud.calls.every((call) => !call.includes("/az104") && !call.includes("users/")));
}));

test("collisions, tampering, metadata races and unsafe Storage never advance pointers", async () => {
  for (const mode of ["stage", "metadata", "media", "late-source", "metadata-race"] as const) await workspace(async (root) => {
    const fixture = await sc900CloudFixture(root);
    const cloud = memoryCloud(fixture.plan);
    const budget = quotas(fixture.plan.bucket);
    if (mode === "stage") cloud.put({ ...fixture.plan.documents[0]!,
      path: fixture.plan.documents[0]!.path.replace(`studyBanks/sc900/releases/${fixture.plan.releaseId}`, sc900CloudStageRoot(fixture.plan)),
      data: { conflict: true } });
    if (mode === "metadata") cloud.put({ ...fixture.plan.metadata[0]!, data: { foreign: true } });
    if (mode === "media") {
      const object = fixture.plan.objects[0]!;
      cloud.objects.set(object.name, { name: object.name, generation: "9", size: String(object.byteLength), contentType: object.contentType,
        cacheControl: "private,no-store", contentSha256: object.sha256, metadata: { sha256: object.sha256, firebaseStorageDownloadTokens: "synthetic-unsafe-token" } });
    }
    if (mode === "metadata-race") {
      const commit = cloud.adapter.switchMetadata.bind(cloud.adapter);
      cloud.adapter.switchMetadata = async (operations, previous) => {
        cloud.put({ ...operations[0]!, data: { concurrent: true } });
        await commit(operations, previous);
      };
    }
    let validations = 0;
    await assert.rejects(executeSc900CloudPlan(fixture.plan, fixture.approval, {
      workspace: root, adapter: cloud.adapter, refresh: async () => budget,
      revalidate: async () => {
        if (++validations === 2 && mode === "late-source") throw new Error("Synthetic source changed before commit");
        return fixture.revalidate();
      },
    }));
    assert.ok(METADATA_PATHS.slice(1).every((path) => !cloud.documents.has(path)));
    if (mode === "stage") assert.equal(cloud.documents.get(fixture.plan.documents[0]!.path)?.data, undefined);
  });
});

test("shared quotas pause before requests, retain reservations and never gain a per-exam allowance", async () => workspace(async (root) => {
  const fixture = await sc900CloudFixture(root);
  const cloud = memoryCloud(fixture.plan);
  const noWrites = quotas(fixture.plan.bucket, 0);
  const result = await executeSc900CloudPlan(fixture.plan, fixture.approval, {
    workspace: root, adapter: cloud.adapter, refresh: async () => noWrites, revalidate: fixture.revalidate,
  });
  assert.equal(result.status, "paused");
  assert.equal(cloud.calls.length, 0);
  const checkedAt = new Date().toISOString();
  const usage = { checkedAt, pacificDay: pacificQuotaDay(new Date()), periodStart: checkedAt, reads: 0, writes: 17_999, deletes: 0 };
  const first = await openSc900FirestoreBudgets(usage, root);
  assert.equal(first.writes.remaining(), 1);
  assert.equal(await first.writes.reserve(1), true);
  assert.equal((await openSc900FirestoreBudgets({ ...usage, writes: 0 }, root)).writes.remaining(), 0);
  for (const [key, value] of [["reads", 45000], ["writes", 18000], ["deletes", 18000]] as const) {
    await assert.rejects(openSc900FirestoreBudgets({ ...usage, writes: 0, [key]: value }, root), CloudQuotaPause);
  }
  const storageUsage: StorageUsage = { checkedAt, month: usage.pacificDay.slice(0, 7), periodStart: checkedAt,
    requests: 0, storedBytes: 0, transferBytes: 0, peakStoredBytes: 0, hostingStoredBytes: 0, hostingTransferBytes: 0, samples: {} };
  const storage = await StorageReservations.open(storageUsage, root);
  await storage.reserve({ requests: 4499 });
  const next = await StorageReservations.open(storageUsage, root);
  await assert.rejects(next.reserve({ requests: 2 }), /quota pause/i);
  const journal = JSON.parse(await readFile(resolve(root, ".data/rollout/storage-journal.json"), "utf8"));
  assert.equal(journal.months[storageUsage.month].requests, 4499);
  assert.throws(() => assertSc900StorageUsage({ ...storageUsage, hostingTransferBytes: 9_000_000_000 }), CloudQuotaPause);
  const disk = await executeSc900CloudPlan(fixture.plan, fixture.approval, {
    workspace: root, adapter: cloud.adapter, refresh: async () => quotas(fixture.plan.bucket), revalidate: fixture.revalidate,
    checkDisk: async () => { throw new CloudQuotaPause("Synthetic disk floor"); },
  });
  assert.equal(disk.status, "paused");
}));

test("cloud transport refuses foreign paths, redirects, oversized responses and automatic retries", async () => {
  assert.throws(() => Reflect.apply(createSc900RestAdapter, undefined, [{ target: "typo", firestoreHost: "localhost:18180", storageHost: "localhost:19199" }]));
  let calls = 0;
  const adapter = createSc900RestAdapter({ target: "emulator", firestoreHost: "127.0.0.1:18180", storageHost: "localhost:19199",
    fetcher: async (_input, init) => {
      calls++;
      assert.equal(init?.redirect, "error");
      return new Response("synthetic server error without credentials", { status: 503 });
    } });
  await assert.rejects(adapter.getDocument("users/foreign/state/active"), /Out-of-scope/);
  assert.equal(calls, 0);
  await assert.rejects(adapter.getDocument(METADATA_PATHS[0]), /HTTP 503/);
  assert.equal(calls, 1);
  await assert.rejects(boundedResponse(new Response("oversized", { headers: { "content-length": "100" } }), 5), /byte limit/);
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(100)); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(boundedResponse(new Response(stream), 5), /byte limit/);
  assert.equal(cancelled, true);
});

test("the explicit dry-run CLI writes only a local plan and refuses production synthetic inputs before ADC", async () => workspace(async (root) => {
  const fixture = await sc900CloudFixture(root);
  const command = resolve("tools/sc900/upload.ts");
  const environment = { ...process.env, GOOGLE_APPLICATION_CREDENTIALS: resolve(root, "must-not-open-adc.json") };
  const args = ["--import", "tsx", command, "--dry-run", "--approval", fixture.approvalPath, "--scope", fixture.sourceScopePath];
  const result = await promisify(execFile)(process.execPath, [...args, "--emulator"], { cwd: root, env: environment });
  const report = JSON.parse(result.stdout) as { status: string; remoteRequests: number; approvalRequired: boolean; planPath: string };
  assert.equal(report.status, "planned");
  assert.equal(report.remoteRequests, 0);
  assert.equal(report.approvalRequired, true);
  assert.equal(validateSc900CloudPlan(JSON.parse(await readFile(resolve(root, report.planPath), "utf8"))).target, "emulator");
  await assert.rejects(promisify(execFile)(process.execPath, args, { cwd: root, env: environment }), /Synthetic fixtures/);
}));

test("an abort checkpoints uncertain writes and a resumed apply verifies rather than duplicating them", async () => workspace(async (root) => {
  const fixture = await sc900CloudFixture(root);
  const cloud = memoryCloud(fixture.plan);
  const budget = quotas(fixture.plan.bucket);
  const controller = new AbortController();
  const create = cloud.adapter.createObject.bind(cloud.adapter);
  cloud.adapter.createObject = async (...args) => {
    await create(...args);
    controller.abort();
    throw new DOMException("Synthetic interrupted upload", "AbortError");
  };
  const deps = { workspace: root, adapter: cloud.adapter, refresh: async () => budget, revalidate: fixture.revalidate };
  const result = await executeSc900CloudPlan(fixture.plan, fixture.approval, { ...deps, signal: controller.signal });
  assert.equal(result.status, "paused");
  assert.ok(METADATA_PATHS.every((path) => !cloud.documents.has(path)));
  cloud.adapter.createObject = create;
  assert.equal((await executeSc900CloudPlan(fixture.plan, fixture.approval, deps)).status, "verified");
  assert.equal(cloud.calls.filter((call) => call.startsWith("object-create:")).length, 1);
}));

test("caller mutation during the final await cannot replace approved nested metadata", async () => workspace(async (root) => {
  const fixture = await sc900CloudFixture(root);
  const cloud = memoryCloud(fixture.plan);
  const budget = quotas(fixture.plan.bucket);
  const original = structuredClone(fixture.plan.metadata[1]!.data);
  const commit = cloud.adapter.switchMetadata.bind(cloud.adapter);
  cloud.adapter.switchMetadata = async (operations, previous) => {
    const assignments = fixture.plan.metadata[1]!.data.assignments;
    assert.ok(assignments && typeof assignments === "object");
    Reflect.set(assignments, fixture.publication.documents[0]!.question.id, ["sc-entra-types"]);
    await commit(operations, previous);
  };
  const result = await executeSc900CloudPlan(fixture.plan, fixture.approval, {
    workspace: root, adapter: cloud.adapter, refresh: async () => budget, revalidate: fixture.revalidate,
  });
  assert.equal(result.status, "verified");
  assert.deepEqual(cloud.documents.get(METADATA_PATHS[1])?.data, original);
}));

test("cloud apply requires explicit acknowledgement of owner-authorized omission and never plans comment writes", async () => workspace(async (root) => {
  const fixture = await sc900CloudFixture(root, true);
  assert.equal(fixture.plan.discussionScope?.sourceCommentCount, null);
  assert.ok(fixture.plan.documents.every((item) => !item.path.includes("/comments/")));
  assert.equal(fixture.plan.objects.length, fixture.publication.assets.size);
  const { discussionScope: _scope, ...unacknowledged } = fixture.approval;
  assert.throws(() => validateCloudApplyApproval(unacknowledged, fixture.plan), /exact source/);
  const cloud = memoryCloud(fixture.plan);
  assert.equal((await executeSc900CloudPlan(fixture.plan, fixture.approval, {
    workspace: root, adapter: cloud.adapter, refresh: async () => quotas(fixture.plan.bucket), revalidate: fixture.revalidate,
  })).status, "verified");
  assert.deepEqual(cloud.documents.get(METADATA_PATHS[0])?.data.discussionScope, fixture.plan.discussionScope);
}));
