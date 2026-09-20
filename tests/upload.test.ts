import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { test } from "node:test";
import { digest } from "../tools/ingest/normalize-shared.js";
import { inspectBucketPrivacy } from "../tools/publish/bucket-privacy.js";
import { executeUploadPlan } from "../tools/publish/execute.js";
import { uploadPlanInternals } from "../tools/publish/plan.js";
import { FileWriteBudget, MemoryWriteBudget, pacificQuotaDay } from "../tools/publish/quota.js";
import {
  UPLOAD_PROJECT_ID,
  type DocumentOperation,
  type ObjectOperation,
  type RemoteDocument,
  type RemoteObject,
  type UploadAdapter,
  type UploadPlan,
} from "../tools/publish/types.js";
import { parseUploadArgs, runUpload, type UploadCliOptions } from "../tools/publish/upload.js";

function document(
  phase: DocumentOperation["phase"],
  path: string,
  data: unknown,
  questionId?: string,
): DocumentOperation {
  return {
    kind: "document",
    phase,
    path,
    data,
    contentHash: digest(data),
    byteLength: Buffer.byteLength(JSON.stringify(data)),
    ...(questionId ? { questionId } : {}),
  };
}

function plan(
  mode: UploadPlan["mode"],
  documents: DocumentOperation[] = [],
  objects: ObjectOperation[] = [],
): UploadPlan {
  return {
    schemaVersion: 1,
    projectId: UPLOAD_PROJECT_ID,
    mode,
    status: "planned",
    importId: `import_${"a".repeat(64)}`,
    releaseId: mode === "publish" ? `r_${"b".repeat(64)}` : null,
    sourceRevision: "c".repeat(64),
    createdAt: "2026-09-10T00:00:00.000Z",
    blockers: [],
    warnings: [],
    documents,
    objects,
    counts: {
      documents: documents.length,
      objects: objects.length,
      objectBytes: objects.reduce((sum, item) => sum + item.byteLength, 0),
      questions: 0,
      answers: 0,
      comments: 0,
      occurrences: 0,
      assets: 0,
    },
  };
}

class MemoryAdapter implements UploadAdapter {
  public readonly documents = new Map<string, unknown>();
  public readonly objects = new Map<string, {
    bytes: Uint8Array;
    sha256: string;
    contentType: string;
    hasDownloadTokens?: boolean;
    anonymousAcl?: boolean;
  }>();
  public readonly calls: string[][] = [];
  public batchReads = 0;
  public individualReads = 0;

  public async getDocument(path: string): Promise<RemoteDocument> {
    this.individualReads++;
    return this.documents.has(path)
      ? { exists: true, data: structuredClone(this.documents.get(path)) }
      : { exists: false };
  }

  public async getDocuments(paths: string[]): Promise<RemoteDocument[]> {
    this.batchReads++;
    return paths.map((path) => this.documents.has(path)
      ? { exists: true, data: structuredClone(this.documents.get(path)) }
      : { exists: false });
  }

  public async createDocuments(operations: DocumentOperation[]): Promise<number> {
    this.calls.push(operations.map((operation) => operation.path));
    for (const operation of operations) {
      if (this.documents.has(operation.path) &&
          digest(this.documents.get(operation.path)) !== operation.contentHash) {
        throw new Error(`${operation.path}: conflict`);
      }
    }
    let created = 0;
    for (const operation of operations) {
      if (!this.documents.has(operation.path)) {
        this.documents.set(operation.path, structuredClone(operation.data));
        created++;
      }
    }
    return created;
  }

  public async getObject(path: string): Promise<RemoteObject> {
    const value = this.objects.get(path);
    return value
      ? {
          exists: true,
          sha256: value.sha256,
          byteLength: value.bytes.byteLength,
          contentType: value.contentType,
          hasDownloadTokens: value.hasDownloadTokens ?? false,
          anonymousAcl: value.anonymousAcl ?? false,
        }
      : { exists: false };
  }

  public async createObject(operation: ObjectOperation, bytes: Uint8Array): Promise<boolean> {
    if (this.objects.has(operation.path)) return false;
    this.objects.set(operation.path, {
      bytes: Uint8Array.from(bytes),
      sha256: operation.sha256,
      contentType: operation.contentType,
      hasDownloadTokens: false,
      anonymousAcl: false,
    });
    return true;
  }
}

const dryRunOptions: UploadCliOptions = {
  mode: "stage",
  apply: false,
  maxWrites: 18_000,
  dailyWriteBudget: 18_000,
  workspace: process.cwd(),
};

test("default dry-run never invokes cloud preflight or creates an adapter", async () => {
  let cloudCalls = 0;
  const result = await runUpload(dryRunOptions, {
    buildPlan: async () => plan("stage"),
    inspectControls: async () => {
      cloudCalls++;
      throw new Error("must not run");
    },
    createAdapter: () => {
      cloudCalls++;
      throw new Error("must not run");
    },
  });
  assert.equal(result.dryRun, true);
  assert.equal(cloudCalls, 0);
});

test("--apply and --dry-run are rejected together in either order", () => {
  assert.throws(
    () => parseUploadArgs(["--apply", "--dry-run"]),
    /either --apply or --dry-run/,
  );
  assert.throws(
    () => parseUploadArgs(["--dry-run", "--apply"]),
    /either --apply or --dry-run/,
  );
});

test("apply refuses failed preflight and never initializes Firebase", async () => {
  let adapterCreated = false;
  await assert.rejects(() => runUpload({ ...dryRunOptions, apply: true }, {
    buildPlan: async () => plan("stage"),
    inspectControls: async () => ({
      projectId: UPLOAD_PROJECT_ID,
      cloudControlsReady: false,
      blockers: ["billing is not linked"],
      storage: { bucketName: null },
    }),
    createAdapter: () => {
      adapterCreated = true;
      return new MemoryAdapter();
    },
  }), /Fresh cloud preflight refused writes: billing is not linked/);
  assert.equal(adapterCreated, false);
});

test("apply rejects a preflight result for any other project", async () => {
  await assert.rejects(() => runUpload({ ...dryRunOptions, apply: true }, {
    buildPlan: async () => plan("stage"),
    inspectControls: async () => ({
      projectId: "other-project",
      cloudControlsReady: true,
      blockers: [],
      storage: { bucketName: "other.invalid" },
    }),
  }), /unapproved Firebase project/);
});

test("apply refuses a verified bucket with anonymous IAM before adapter initialization", async () => {
  let adapterCreated = false;
  await assert.rejects(() => runUpload({ ...dryRunOptions, apply: true }, {
    buildPlan: async () => plan("stage"),
    inspectControls: async () => ({
      projectId: UPLOAD_PROJECT_ID,
      cloudControlsReady: true,
      blockers: [],
      storage: { bucketName: "study-az104.firebasestorage.app" },
    }),
    inspectPrivacy: async (bucketName) => ({
      bucketName,
      safeForPrivateUploads: false,
      uniformBucketLevelAccess: true,
      publicAccessPrevention: "inherited",
      anonymousIamBindings: [{ role: "roles/storage.objectViewer", member: "allUsers" }],
      anonymousDefaultObjectAcls: [],
    }),
    createAdapter: () => {
      adapterCreated = true;
      return new MemoryAdapter();
    },
  }), /unsafe for private uploads.*allUsers/);
  assert.equal(adapterCreated, false);
});

test("bucket privacy inspection rejects anonymous default ACLs without cloud access", async () => {
  const responses: unknown[] = [
    {
      name: "study-az104.firebasestorage.app",
      projectNumber: "237261733668",
      iamConfiguration: {
        uniformBucketLevelAccess: { enabled: false },
        publicAccessPrevention: "inherited",
      },
    },
    { bindings: [] },
    { items: [{ entity: "allAuthenticatedUsers", role: "READER" }] },
  ];
  const report = await inspectBucketPrivacy("study-az104.firebasestorage.app", {
    getAccessToken: async () => "synthetic-token",
    fetch: async () => {
      const body = responses.shift();
      if (body === undefined) throw new Error("Unexpected synthetic request.");
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => body,
      };
    },
  });
  assert.equal(report.safeForPrivateUploads, false);
  assert.deepEqual(report.anonymousDefaultObjectAcls, [
    { entity: "allAuthenticatedUsers", role: "READER" },
  ]);
  assert.equal(responses.length, 0);
});

test("uniform private bucket inspection checks IAM and does not query legacy ACLs", async () => {
  const requested: string[] = [];
  const report = await inspectBucketPrivacy("study-az104.firebasestorage.app", {
    getAccessToken: async () => "synthetic-token",
    fetch: async (url) => {
      requested.push(url);
      const body = requested.length === 1
        ? {
            name: "study-az104.firebasestorage.app",
            projectNumber: "237261733668",
            iamConfiguration: {
              uniformBucketLevelAccess: { enabled: true },
              publicAccessPrevention: "enforced",
            },
          }
        : { bindings: [{ role: "roles/storage.objectViewer", members: ["projectViewer:study-az104"] }] };
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => body,
      };
    },
  });
  assert.equal(report.safeForPrivateUploads, true);
  assert.equal(report.uniformBucketLevelAccess, true);
  assert.equal(requested.length, 2);
  assert.equal(requested.some((url) => url.includes("defaultObjectAcl")), false);
});

test("Firestore validation rejects nested arrays and unsupported values", () => {
  assert.throws(
    () => uploadPlanInternals.assertFirestoreValue({ nested: [["not", "supported"]] }, "fixture"),
    /nested arrays/,
  );
  assert.throws(
    () => uploadPlanInternals.assertFirestoreValue({ missing: undefined }, "fixture"),
    /undefined/,
  );
  assert.throws(
    () => uploadPlanInternals.documentOperation("stage", "unsafe/../document", {}, {}),
    /safe Firestore document path/,
  );
});

test("object planning rejects unsafe paths and mismatched source hashes", async () => {
  await assert.rejects(
    () => uploadPlanInternals.objectOperation(
      process.cwd(), "archive", "private/az104/../escape", "package.json",
      "0".repeat(64), "application/json",
    ),
    /approved, safe Storage object path/,
  );
  await assert.rejects(
    () => uploadPlanInternals.objectOperation(
      process.cwd(), "archive", "private/az104/import_fixture/package.json", "package.json",
      "0".repeat(64), "application/json",
    ),
    /byte hash .* does not match expected/,
  );
});

test("execution is resumable and idempotent while preserving conflicts", async () => {
  const adapter = new MemoryAdapter();
  const operations = [
    document("stage", "importRuns/import_x/questions/q_1", { id: "q_1", published: false }),
    document("stage", "importRuns/import_x/answers/q_1", { id: "q_1", published: false }),
  ];
  const first = await executeUploadPlan(plan("stage", operations), {
    adapter,
    budget: new MemoryWriteBudget("2026-09-09", 10, 10),
  });
  assert.deepEqual(first.documents, { created: 2, unchanged: 0, remaining: 0 });
  assert.equal(adapter.batchReads, 2);
  assert.equal(adapter.individualReads, 0);

  const second = await executeUploadPlan(plan("stage", operations), {
    adapter,
    budget: new MemoryWriteBudget("2026-09-09", 10, 10),
  });
  assert.deepEqual(second.documents, { created: 0, unchanged: 2, remaining: 0 });

  adapter.documents.set(operations[0]?.path ?? "", { id: "accepted-different-data" });
  await assert.rejects(() => executeUploadPlan(plan("stage", operations), {
    adapter,
    budget: new MemoryWriteBudget("2026-09-09", 10, 10),
  }), /remote document conflict; existing data was preserved/);
  assert.deepEqual(adapter.documents.get(operations[0]?.path ?? ""), { id: "accepted-different-data" });
});

test("quota day uses Pacific time and reservations honor daily and run caps", async () => {
  assert.equal(pacificQuotaDay(new Date("2026-09-10T06:59:59Z")), "2026-09-09");
  assert.equal(pacificQuotaDay(new Date("2026-09-10T07:00:00Z")), "2026-09-10");
  const budget = new MemoryWriteBudget("2026-09-10", 18_000, 500, 17_750);
  assert.equal(budget.remaining(), 250);
  assert.equal(await budget.reserve(250), true);
  assert.equal(await budget.reserve(1), false);
});

test("one FileWriteBudget run pauses before reserving across Pacific midnight", async () => {
  const directory = `.data/upload-budget-test-${process.pid}`;
  const journal = `${directory}/journal.json`;
  let now = new Date("2026-09-10T06:59:59Z");
  try {
    const budget = await FileWriteBudget.open(
      process.cwd(),
      10,
      10,
      () => now,
      journal,
    );
    assert.equal(await budget.reserve(1), true);
    now = new Date("2026-09-10T07:00:00Z");
    assert.equal(budget.remaining(), 0);
    assert.equal(await budget.reserve(1), false);
    assert.equal(budget.reservedThisRun, 1);
    assert.equal(budget.pauseReason, "day-rollover");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("publication creates all comments before the question-answer pair and catalog last", async () => {
  const adapter = new MemoryAdapter();
  const qid = "q_fixture";
  const operations = [
    document("catalog", "catalogs/az104", { published: true }),
    document("publication", `questions/${qid}`, { id: qid, published: true }, qid),
    document("comments", `questions/${qid}/comments/c_1`, { id: "c_1" }, qid),
    document("publication", `answerKeys/${qid}`, { id: qid, published: true }, qid),
  ];
  const result = await executeUploadPlan(plan("publish", operations), {
    adapter,
    budget: new MemoryWriteBudget("2026-09-10", 10, 10),
  });
  assert.equal(result.status, "published");
  assert.deepEqual(adapter.calls, [
    [`questions/${qid}/comments/c_1`],
    [`questions/${qid}`, `answerKeys/${qid}`],
    ["catalogs/az104"],
  ]);
});

test("publication pauses before exposure when the remaining budget cannot create the pair", async () => {
  const adapter = new MemoryAdapter();
  const qid = "q_fixture";
  const operations = [
    document("comments", `questions/${qid}/comments/c_1`, { id: "c_1" }, qid),
    document("publication", `questions/${qid}`, { id: qid, published: true }, qid),
    document("publication", `answerKeys/${qid}`, { id: qid, published: true }, qid),
    document("catalog", "catalogs/az104", { published: true }),
  ];
  const result = await executeUploadPlan(plan("publish", operations), {
    adapter,
    budget: new MemoryWriteBudget("2026-09-10", 1, 1),
  });
  assert.equal(result.status, "paused");
  assert.equal(adapter.documents.has(`questions/${qid}/comments/c_1`), true);
  assert.equal(adapter.documents.has(`questions/${qid}`), false);
  assert.equal(adapter.documents.has(`answerKeys/${qid}`), false);
  assert.equal(adapter.documents.has("catalogs/az104"), false);
});

test("600 comments progress with run limits 1 and 5, then resume idempotently", async () => {
  const adapter = new MemoryAdapter();
  const qid = "q_large_discussion";
  const comments = Array.from({ length: 600 }, (_, index) =>
    document(
      "comments",
      `questions/${qid}/comments/c_${String(index).padStart(3, "0")}`,
      { id: `c_${index}` },
      qid,
    ));
  const operations = [
    ...comments,
    document("publication", `questions/${qid}`, { id: qid, published: true }, qid),
    document("publication", `answerKeys/${qid}`, { id: qid, published: true }, qid),
    document("catalog", "catalogs/az104", { published: true }),
  ];

  const first = await executeUploadPlan(plan("publish", operations), {
    adapter,
    budget: new MemoryWriteBudget("2026-09-10", 1_000, 1),
  });
  assert.equal(first.status, "paused");
  assert.equal(first.documents.created, 1);
  assert.match(first.resume ?? "", /run write limit.*remaining daily allowance/i);

  const second = await executeUploadPlan(plan("publish", operations), {
    adapter,
    budget: new MemoryWriteBudget("2026-09-10", 1_000, 5),
  });
  assert.equal(second.status, "paused");
  assert.equal(second.documents.created, 5);
  assert.equal(second.documents.unchanged, 1);
  assert.equal(adapter.documents.has(`questions/${qid}`), false);

  const completed = await executeUploadPlan(plan("publish", operations), {
    adapter,
    budget: new MemoryWriteBudget("2026-09-10", 1_000, 700),
  });
  assert.equal(completed.status, "published");
  assert.equal(adapter.documents.size, 603);
  assert.equal(Math.max(...adapter.calls.map((call) => call.length)), 100);
  const publicationCall = adapter.calls.findIndex((call) =>
    call.includes(`questions/${qid}`));
  const lastCommentCall = adapter.calls.reduce((last, call, index) =>
    call.some((path) => path.includes("/comments/")) ? index : last, -1);
  assert.ok(publicationCall > lastCommentCall);
  assert.deepEqual(adapter.calls.at(-1), ["catalogs/az104"]);

  const unchanged = await executeUploadPlan(plan("publish", operations), {
    adapter,
    budget: new MemoryWriteBudget("2026-09-10", 1_000, 1),
  });
  assert.equal(unchanged.status, "published");
  assert.deepEqual(unchanged.documents, { created: 0, unchanged: 603, remaining: 0 });
});

test("existing objects with download tokens or anonymous ACLs fail closed", async () => {
  for (const unsafe of [
    { hasDownloadTokens: true, anonymousAcl: false },
    { hasDownloadTokens: false, anonymousAcl: true },
  ]) {
    const adapter = new MemoryAdapter();
    const operation: ObjectOperation = {
      kind: "object",
      phase: "archive",
      path: "private/az104/import_fixture/archive.json",
      sourcePath: "package.json",
      sha256: "a".repeat(64),
      byteLength: 1,
      contentType: "application/json",
      questionIds: [],
    };
    adapter.objects.set(operation.path, {
      bytes: new Uint8Array(1),
      sha256: operation.sha256,
      contentType: operation.contentType,
      ...unsafe,
    });
    await assert.rejects(() => executeUploadPlan(plan("stage", [], [operation]), {
      adapter,
      budget: new MemoryWriteBudget("2026-09-10", 10, 10),
    }), /object privacy could not be verified or unsafe access metadata exists/);
  }
});
