import { readFile } from "node:fs/promises";
import { applicationDefault, getApps, initializeApp } from "firebase-admin/app";
import { FieldPath, FieldValue, getFirestore, Timestamp } from "firebase-admin/firestore";
import { inspectFirebaseControls } from "../firebase/preflight.js";
import { digest } from "../ingest/normalize-shared.js";
import { isMain, writeData } from "../review/data.js";
import { buildFirestoreStagingPlan } from "./stage-firestore.js";
import { acquireUploadLock } from "./quota.js";
import { assertPlannedHeadroom, OperationBudget, writeBudgetForUsage } from "./operation-budget.js";
import { inspectFirestoreUsage } from "./usage.js";
import { loadCleanBank } from "../web/bank.js";
import { mediaExtension, type CleanDocument } from "../../src/domain/cleanBank.js";
import { uploadPlanInternals } from "./plan.js";

export const CLEANUP_ROOT = "importRuns/import_96c1ceb6c7e36dce153640fa9604a6761e0ad7bae0f8012bf00ef49198c81001/firestoreOnly/r_61ae993f4534c2d7b370d43a31ccc51c025bac080f0459df307f4d3ecaa7f296";
const receiptPath = ".data/rollout/legacy-document-hashes.json";
const inventoryPath = ".data/rollout/cloud-inventory.json";
const collections = ["questions", "answers", "comments", "assets", "occurrences", "reviews", "sourceReviews", "conversions", "catalogs"] as const;

export interface RemoteReceipt {
  path: string;
  hash: string;
  fields: string[];
  seconds: number;
  nanoseconds: number;
}
export interface Inventory {
  checkedAt: string;
  documents: RemoteReceipt[];
  root: string;
}

async function json<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function firestore() {
  const app = getApps().find((item) => item.name === "az104-clean-sync") ??
    initializeApp({ credential: applicationDefault(), projectId: "study-az104" }, "az104-clean-sync");
  if (app.options.projectId !== "study-az104") throw new Error("Unexpected Firebase project.");
  return getFirestore(app);
}

export async function freezeLegacyHashes() {
  const plan = await buildFirestoreStagingPlan();
  const documents = plan.documents.map(({ path, contentHash }) => ({ path, hash: contentHash }));
  if (documents.length !== 26850 || documents.some(({ path }) => path !== CLEANUP_ROOT && !path.startsWith(`${CLEANUP_ROOT}/`))) {
    throw new Error("Unexpected legacy private import plan; refusing to establish deletion scope.");
  }
  await writeData(receiptPath, { root: CLEANUP_ROOT, documents });
  return { documents: documents.length, contentIncluded: false };
}

async function controlsAndUsage() {
  const controls = await inspectFirebaseControls();
  if (!controls.cloudControlsReady || controls.firestore.freeTier !== true) {
    throw new Error(`Cloud safeguards are not ready: ${controls.blockers.join("; ")}`);
  }
  const usage = await inspectFirestoreUsage();
  await writeData(".data/rollout/usage-current.json", usage);
  return usage;
}

export async function inventoryCloud() {
  const unlock = await acquireUploadLock(process.cwd());
  try {
    const usage = await controlsAndUsage();
    const reads = await OperationBudget.open("reads", usage.reads);
    // A capped scan includes empty pages; reserve before issuing any reads.
    const maximum = 27_000;
    if (reads.remaining() < maximum) throw new Error("Quota pause: a full bounded inventory will not fit.");
    const expected = await json<{ root: string; documents: Array<{ path: string; hash: string }> }>(receiptPath);
    if (expected.root !== CLEANUP_ROOT) throw new Error("Unexpected cleanup receipt root.");
    const hashes = new Map(expected.documents.map((item) => [item.path, item.hash]));
    const db = firestore();
    const documents: RemoteReceipt[] = [];
    const add = (snapshot: FirebaseFirestore.DocumentSnapshot) => {
      if (!snapshot.exists || !snapshot.updateTime) return;
      const data = snapshot.data()!;
      const hash = digest(data);
      if (hashes.get(snapshot.ref.path) !== hash) {
        throw new Error(`${snapshot.ref.path}: remote content differs from the original upload; refusing cleanup.`);
      }
      documents.push({
        path: snapshot.ref.path, hash, fields: Object.keys(data).sort(),
        seconds: snapshot.updateTime.seconds, nanoseconds: snapshot.updateTime.nanoseconds,
      });
    };
    await reads.reserve(1);
    add(await db.doc(CLEANUP_ROOT).get());
    for (const collection of collections) {
      let after: string | undefined;
      while (true) {
        const query = db.collection(`${CLEANUP_ROOT}/${collection}`).orderBy(FieldPath.documentId()).limit(500);
        await reads.reserve(500);
        const result = await (after ? query.startAfter(after) : query).get();
        result.docs.forEach(add);
        if (documents.length > maximum) throw new Error("Unexpected import size; stopped the bounded inventory.");
        if (result.size < 500) break;
        after = result.docs.at(-1)!.id;
      }
    }
    const inventory: Inventory = { root: CLEANUP_ROOT, checkedAt: new Date().toISOString(), documents };
    await writeData(inventoryPath, inventory);
    return { documents: documents.length, reservedReads: reads.reservedThisRun, contentIncluded: false };
  } finally {
    await unlock();
  }
}

export function replacementFields(previous: string[], next: Record<string, unknown>) {
  return {
    ...Object.fromEntries(previous.filter((key) => !(key in next)).map((key) => [key, FieldValue.delete()])),
    ...next,
  };
}

export interface CleanOperation {
  kind: "create" | "replace" | "delete";
  path: string;
  nextHash?: string;
  previous?: RemoteReceipt;
}

export async function loadCleanTarget(): Promise<Map<string, Record<string, unknown>>> {
  const bank = await loadCleanBank();
  const current = bank.releases.find((item) => item.catalog.releaseId === bank.manifest.releaseId);
  if (!current) throw new Error("The current clean release is missing.");
  const target = new Map<string, Record<string, unknown>>();
  const put = (path: string, value: Record<string, unknown>) => {
    if (target.has(path)) throw new Error(`Duplicate clean document: ${path}`);
    uploadPlanInternals.documentOperation("stage", path, value);
    target.set(path, value);
  };
  const questions = new Set<string>();
  const putQuestion = (document: CleanDocument, compatibilityOnly: boolean) => {
    const extra = { published: false, compatibilityOnly, releaseId: document.releaseId };
    put(`${CLEANUP_ROOT}/questions/${document.question.id}`, { ...document.question, ...extra });
    put(`${CLEANUP_ROOT}/answers/${document.answers.id}`, { ...document.answers, ...extra });
    questions.add(document.question.id);
  };
  for (const document of current.documents) putQuestion(document, false);
  for (const release of bank.releases) {
    for (const document of release.documents) {
      if (!questions.has(document.question.id)) putQuestion(document, true);
    }
  }
  if (questions.size !== 606) throw new Error("All 606 source question identities must survive privately.");
  for (const discussion of current.discussions) {
    for (const comment of discussion.comments) put(`${CLEANUP_ROOT}/comments/${comment.id}`, comment);
  }
  const media = new Map(current.documents.flatMap((document) => document.question.media).map((asset) => [asset.id, asset]));
  if (media.size !== 784) throw new Error("The complete original image set is required.");
  for (const asset of media.values()) {
    put(`${CLEANUP_ROOT}/assets/${asset.id}`, {
      id: asset.id, sha256: asset.id, contentType: asset.contentType,
      width: asset.width, height: asset.height, byteLength: asset.byteLength,
      sourceUrls: asset.sourceUrls,
      storageObjectPath: `private/az104/assets/${asset.id}.${mediaExtension(asset.contentType)}`,
    });
  }
  put(`${CLEANUP_ROOT}/catalogs/az104`, { ...current.catalog, published: false });
  put(CLEANUP_ROOT, {
    schemaVersion: 1, bankVersion: bank.manifest.bankVersion, releaseId: bank.manifest.releaseId,
    sourceRevision: bank.manifest.sourceRevision, counts: bank.manifest.counts,
    compatibilityQuestions: 2, published: false, purpose: "private-minimal-approved-study-bank",
    storageMediaPrefix: "private/az104/assets",
  });
  if (target.size !== 9992) throw new Error("Unexpected clean cloud document count.");
  return target;
}
interface CleanPlan {
  root: string;
  digest: string;
  operations: CleanOperation[];
  targetDocuments: number;
  counts: { reads: number; writes: number; deletes: number };
}
interface Progress {
  planDigest: string;
  completed: string[];
  pending: string[];
}

export function planCleanOperations(target: Map<string, Record<string, unknown>>, inventory: Inventory): CleanPlan {
  if (inventory.root !== CLEANUP_ROOT || !target.has(CLEANUP_ROOT)) throw new Error("Invalid cleanup root.");
  const previous = new Map(inventory.documents.map((item) => [item.path, item]));
  if (previous.size !== inventory.documents.length) throw new Error("Duplicate inventory paths.");
  const operations: CleanOperation[] = [];
  for (const [path, data] of target) {
    if (path !== CLEANUP_ROOT && !path.startsWith(`${CLEANUP_ROOT}/`)) throw new Error("Out-of-scope target.");
    const receipt = previous.get(path);
    const nextHash = digest(data);
    if (receipt?.hash === nextHash) continue;
    operations.push({ kind: receipt ? "replace" : "create", path, nextHash, ...(receipt ? { previous: receipt } : {}) });
  }
  for (const receipt of inventory.documents) {
    if (receipt.path !== CLEANUP_ROOT && !receipt.path.startsWith(`${CLEANUP_ROOT}/`)) throw new Error("Out-of-scope deletion.");
    if (!target.has(receipt.path)) operations.push({ kind: "delete", path: receipt.path, previous: receipt });
  }
  // Replace the catalog/descriptor last; all keys and comments are persisted first.
  operations.sort((a, b) => {
    const priority = (operation: CleanOperation) => operation.path === CLEANUP_ROOT || operation.path.endsWith("/catalogs/az104") ? 2
      : operation.kind === "delete" ? 1 : 0;
    return priority(a) - priority(b) || a.path.localeCompare(b.path);
  });
  return {
    root: CLEANUP_ROOT, digest: digest(operations), operations, targetDocuments: target.size,
    counts: {
      reads: target.size + collections.length * 500 + 1,
      writes: operations.filter((item) => item.kind !== "delete").length,
      deletes: operations.filter((item) => item.kind === "delete").length,
    },
  };
}

async function optionalProgress(): Promise<Progress | null> {
  try { return await json<Progress>(".data/rollout/cloud-clean-progress.json"); }
  catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

export async function applyCleanPlan(plan: CleanPlan, target: Map<string, Record<string, unknown>>) {
  const unlock = await acquireUploadLock(process.cwd());
  try {
    const usage = await controlsAndUsage();
    let reads = await OperationBudget.open("reads", usage.reads);
    let writes = await writeBudgetForUsage(usage);
    let deletes = await OperationBudget.open("deletes", usage.deletes);
    const saved = await optionalProgress();
    if (saved && saved.planDigest !== plan.digest) throw new Error("Cleanup target changed during an unfinished migration.");
    const progress = saved ?? { planDigest: plan.digest, completed: [], pending: [] };
    const completed = new Set(progress.completed);
    const remaining = plan.operations.filter((item) => !completed.has(item.path));
    assertPlannedHeadroom({
      reads: plan.counts.reads + progress.pending.length,
      writes: remaining.filter((item) => item.kind !== "delete").length,
      deletes: remaining.filter((item) => item.kind === "delete").length,
    }, { reads: reads.remaining(), writes: writes.remaining(), deletes: deletes.remaining() });
    const db = firestore();
    if (progress.pending.length) {
      await reads.reserve(progress.pending.length);
      const snapshots = await db.getAll(...progress.pending.map((path) => db.doc(path)));
      for (const snapshot of snapshots) {
        const operation = remaining.find((item) => item.path === snapshot.ref.path);
        if (!operation) throw new Error("Invalid pending cleanup receipt.");
        const actual = snapshot.exists ? digest(snapshot.data()) : null;
        if (operation.kind === "delete" ? actual === null : actual === operation.nextHash) {
          completed.add(operation.path);
        } else if (operation.previous ? actual !== operation.previous.hash ||
          !snapshot.updateTime?.isEqual(new Timestamp(operation.previous.seconds, operation.previous.nanoseconds)) : actual !== null) {
          throw new Error(`${operation.path}: concurrent modification; stopped without overwriting.`);
        }
      }
      progress.completed = [...completed];
      progress.pending = [];
      await writeData(".data/rollout/cloud-clean-progress.json", progress);
    }
    let lastUsageCheck = Date.now();
    for (let offset = 0; offset < plan.operations.length; offset += 100) {
      const group = plan.operations.slice(offset, offset + 100).filter((item) => !completed.has(item.path));
      if (!group.length) continue;
      if (Date.now() - lastUsageCheck > 60_000) {
        const current = await controlsAndUsage();
        reads = await OperationBudget.open("reads", current.reads);
        writes = await writeBudgetForUsage(current);
        deletes = await OperationBudget.open("deletes", current.deletes);
        lastUsageCheck = Date.now();
      }
      const writeCount = group.filter((item) => item.kind !== "delete").length;
      const deleteCount = group.length - writeCount;
      if (writeCount > writes.remaining() || deleteCount > deletes.remaining()) {
        throw new Error("Quota pause: the remaining cleanup requires another Pacific day.");
      }
      if (!(await writes.reserve(writeCount))) throw new Error("Quota pause: write allowance exhausted.");
      await deletes.reserve(deleteCount);
      progress.pending = group.map((item) => item.path);
      await writeData(".data/rollout/cloud-clean-progress.json", progress);
      const batch = db.batch();
      for (const operation of group) {
        const ref = db.doc(operation.path);
        const old = operation.previous;
        const condition = old ? { lastUpdateTime: new Timestamp(old.seconds, old.nanoseconds) } : undefined;
        if (operation.kind === "delete") {
          if (!condition) throw new Error("Deletes require a validated update-time precondition.");
          batch.delete(ref, condition);
        } else {
          const data = target.get(operation.path);
          if (!data || digest(data) !== operation.nextHash) throw new Error("Clean content changed after planning.");
          if (operation.kind === "create") batch.create(ref, data);
          else {
            if (!old || !condition) throw new Error("Replacements require a validated precondition.");
            batch.update(ref, replacementFields(old.fields, data), condition);
          }
        }
      }
      await batch.commit();
      group.forEach((item) => completed.add(item.path));
      progress.completed = [...completed];
      progress.pending = [];
      await writeData(".data/rollout/cloud-clean-progress.json", progress);
    }
    return { completed: completed.size, writes: plan.counts.writes, deletes: plan.counts.deletes };
  } finally {
    await unlock();
  }
}

export async function verifyCleanCloud(target: Map<string, Record<string, unknown>>) {
  const unlock = await acquireUploadLock(process.cwd());
  try {
    const usage = await controlsAndUsage();
    const reads = await OperationBudget.open("reads", usage.reads);
    const maximum = target.size + collections.length * 500 + 1;
    if (reads.remaining() < maximum) throw new Error("Quota pause: full verification will not fit.");
    const db = firestore();
    const verified = new Set<string>();
    const check = (snapshot: FirebaseFirestore.DocumentSnapshot) => {
      const expected = target.get(snapshot.ref.path);
      if (!snapshot.exists || !expected || digest(snapshot.data()) !== digest(expected)) {
        throw new Error(`${snapshot.ref.path}: unexpected, missing, or mismatched remote content.`);
      }
      verified.add(snapshot.ref.path);
    };
    await reads.reserve(1);
    check(await db.doc(CLEANUP_ROOT).get());
    const counts: Record<string, number> = {};
    for (const collection of collections) {
      let after: string | undefined;
      counts[collection] = 0;
      while (true) {
        await reads.reserve(500);
        const query = db.collection(`${CLEANUP_ROOT}/${collection}`).orderBy(FieldPath.documentId()).limit(500);
        const result = await (after ? query.startAfter(after) : query).get();
        result.docs.forEach(check);
        counts[collection] += result.size;
        if (result.size < 500) break;
        after = result.docs.at(-1)!.id;
      }
    }
    if (verified.size !== target.size) throw new Error("The remote clean bank is incomplete.");
    const report = {
      verifiedAt: new Date().toISOString(), root: CLEANUP_ROOT, counts,
      documents: verified.size, exactContentHashesMatch: true, private: true,
      generatedReviewCollections: 0, originalLetterMappings: 0,
    };
    await writeData(".data/rollout/cloud-clean-verification.json", report);
    return report;
  } finally {
    await unlock();
  }
}

if (isMain(import.meta.url)) {
  const command = process.argv[2];
  let result: unknown;
  if (command === "freeze-hashes") result = await freezeLegacyHashes();
  else if (command === "inventory") result = await inventoryCloud();
  else if (command === "plan" || command === "apply" || command === "verify") {
    const target = await loadCleanTarget();
    if (command === "verify") result = await verifyCleanCloud(target);
    else {
      const plan = planCleanOperations(target, await json<Inventory>(inventoryPath));
      await writeData(".data/rollout/cloud-clean-plan.json", plan);
      result = command === "apply" ? await applyCleanPlan(plan, target)
        : { digest: plan.digest, targetDocuments: plan.targetDocuments, counts: plan.counts };
    }
  } else throw new Error("Usage: clean-sync.ts plan | apply | verify (one-time preparation: freeze-hashes | inventory)");
  console.log(JSON.stringify(result, null, 2));
}
