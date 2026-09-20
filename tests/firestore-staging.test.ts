import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { digest } from "../tools/ingest/normalize-shared.js";
import {
  assertFreeFirestoreStaging, assertPrivateDocumentPlan, firestoreOnlyAdapter,
  parseFirestoreStagingArgs, runFirestoreStaging,
} from "../tools/publish/stage-firestore.js";
import { MemoryWriteBudget } from "../tools/publish/quota.js";
import { type UploadAdapter, type UploadPlan } from "../tools/publish/types.js";

process.env.AZURE_CLOUD_JOURNEY_ADMIN_EMAIL = "study-admin@example.test";

function controls(): Parameters<typeof assertFreeFirestoreStaging>[0] {
  return {
    checkedAt: "2026-09-10T06:35:00Z",
    projectId: "study-az104", projectNumber: "237261733668",
    administrativeAccount: "study-admin@example.test",
    cloudControlsReady: false,
    blockers: ["Storage and billing are not configured."],
    billing: { enabled: false, accountName: null },
    firestore: {
      name: "projects/study-az104/databases/(default)", location: "us-central1",
      type: "FIRESTORE_NATIVE", edition: "STANDARD", freeTier: true,
      pointInTimeRecovery: "POINT_IN_TIME_RECOVERY_DISABLED",
      deleteProtection: "DELETE_PROTECTION_ENABLED",
      rules: { deployed: true, matchesLocal: true },
    },
    storage: { bucketName: null, location: null, rules: { deployed: false, matchesLocal: false } },
    budget: { name: null, verified: false, isHardSpendingCap: false },
  };
}

function plan(): UploadPlan {
  const importId = `import_${"a".repeat(64)}`;
  const data = { fixture: true, published: false };
  return {
    schemaVersion: 1, projectId: "study-az104", mode: "stage", status: "planned",
    importId, releaseId: null, sourceRevision: "a".repeat(64),
    createdAt: "2026-09-10T06:35:00Z", blockers: [], warnings: [],
    documents: [{
      kind: "document", phase: "stage", path: `importRuns/${importId}/questions/fixture`,
      data, contentHash: digest(data), byteLength: Buffer.byteLength(JSON.stringify(data)),
    }],
    objects: [],
    counts: { documents: 1, objects: 0, objectBytes: 0, questions: 1, answers: 0, comments: 0, occurrences: 0, assets: 0 },
  };
}

test("free-plan staging requires verified unbilled identity, free database and private rules", () => {
  assert.doesNotThrow(() => assertFreeFirestoreStaging(controls()));
  const enabledBilling = controls();
  enabledBilling.billing = { enabled: true, accountName: "billingAccounts/example" };
  assert.throws(() => assertFreeFirestoreStaging(enabledBilling), /normal uploader/);
  const wrongDatabase = controls();
  wrongDatabase.firestore.freeTier = false;
  assert.throws(() => assertFreeFirestoreStaging(wrongDatabase), /free default Firestore/);
  const changedRules = controls();
  changedRules.firestore.rules.matchesLocal = false;
  assert.throws(() => assertFreeFirestoreStaging(changedRules), /private-staging rules/);
});

test("Firestore-only CLI rejects publication, conflicting flags and unlimited writes", () => {
  assert.throws(() => parseFirestoreStagingArgs(["--publish"]), /never publishes/);
  assert.throws(() => parseFirestoreStagingArgs(["--apply", "--dry-run"]), /not both/);
  assert.throws(() => parseFirestoreStagingArgs(["--daily-write-budget", "20000"]), /capped/);
  assert.throws(() => parseFirestoreStagingArgs(["--max-writes", "20000"]), /capped/);
  const options = parseFirestoreStagingArgs([]);
  assert.ok(!("help" in options));
  assert.equal(options.apply, false);
  assert.equal(options.dailyWriteBudget, 18000);
});

test("document-only staging cannot target public collections or Storage", () => {
  assert.doesNotThrow(() => assertPrivateDocumentPlan(plan()));
  const publicPlan = plan();
  publicPlan.documents[0]!.path = "questions/fixture";
  assert.throws(() => assertPrivateDocumentPlan(publicPlan), /private import/);
  const objectPlan = plan();
  objectPlan.objects.push({
    kind: "object", phase: "archive", path: "private/example", sourcePath: ".data/example",
    sha256: "a".repeat(64), byteLength: 1, contentType: "text/plain", questionIds: [],
  });
  assert.throws(() => assertPrivateDocumentPlan(objectPlan), /cannot upload objects/);
});

test("document-only adapter always rejects Storage access", async () => {
  const adapter = firestoreOnlyAdapter({
    async getDocument() { return { exists: false }; },
    async createDocuments() { return 0; },
  });
  await assert.rejects(adapter.getObject("any"), /Storage reads are disabled/);
});

test("Firestore staging dry-run never inspects credentials or initializes cloud clients", async () => {
  const options = parseFirestoreStagingArgs([]);
  assert.ok(!("help" in options));
  const report = await runFirestoreStaging(options, {
    buildPlan: async () => plan(),
    inspectControls: async () => { throw new Error("Must not inspect cloud during dry-run."); },
    createDocuments: () => { throw new Error("Must not initialize cloud during dry-run."); },
  });
  assert.equal(report.execution, "dry-run");
  assert.equal(report.published, false);
});

test("explicit private staging persists, pauses and resumes without a Storage client", async () => {
  const workspace = resolve(`.data/firestore-staging-tests/${randomUUID()}`);
  await mkdir(workspace, { recursive: true });
  const store = new Map<string, unknown>();
  const documents: Pick<UploadAdapter, "getDocument" | "createDocuments"> = {
    async getDocument(path) {
      return store.has(path) ? { exists: true, data: store.get(path) } : { exists: false };
    },
    async createDocuments(operations) {
      for (const operation of operations) {
        assert.match(operation.path, /^importRuns\//);
        store.set(operation.path, operation.data);
      }
      return operations.length;
    },
  };
  try {
    const options = parseFirestoreStagingArgs(["--apply", "--max-writes", "1"], workspace);
    assert.ok(!("help" in options));
    const report = await runFirestoreStaging(options, {
      buildPlan: async () => plan(), inspectControls: async () => controls(),
      createDocuments: () => documents, budget: new MemoryWriteBudget("2026-09-09", 1, 1),
    });
    assert.equal(report.status, "staged");
    assert.equal(report.execution, "applied");
    assert.equal(report.published, false);
    const repeated = await runFirestoreStaging(options, {
      buildPlan: async () => plan(), inspectControls: async () => controls(),
      createDocuments: () => documents, budget: new MemoryWriteBudget("2026-09-10", 1, 1),
    });
    assert.equal(repeated.status, "staged");
    if (repeated.execution !== "applied") throw new Error("Expected applied report.");
    assert.equal(repeated.documents.created, 0);
    assert.equal(repeated.documents.unchanged, 1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("an exhausted daily allowance stops before any cloud preflight or document scan", async () => {
  const workspace = resolve(`.data/firestore-staging-tests/${randomUUID()}`);
  await mkdir(workspace, { recursive: true });
  try {
    const options = parseFirestoreStagingArgs(["--apply"], workspace);
    assert.ok(!("help" in options));
    await assert.rejects(runFirestoreStaging(options, {
      buildPlan: async () => plan(),
      inspectControls: async () => { throw new Error("Must not call cloud when the daily allowance is exhausted."); },
      createDocuments: () => { throw new Error("Must not scan already-uploaded data."); },
      budget: new MemoryWriteBudget("2026-09-10", 18000, 18000, 18000),
    }), /No remote documents were scanned/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
