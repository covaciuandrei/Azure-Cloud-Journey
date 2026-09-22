import { lstat, mkdir, open, rename, rm, statfs } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { z } from "zod";
import { Sc900ReleasePointerSchema } from "../../src/domain/sc900Bank.js";
import { Sc900TopicMapSchema } from "../../src/domain/sc900Topics.js";
import { Sc900LearningManifestSchema } from "../../src/domain/sc900Learning.js";
import type { WriteBudget } from "../publish/types.js";
import type { BucketPrivacyReport } from "../publish/bucket-privacy.js";
import type { Amounts } from "../publish/storage-clean.js";
import { assertSafeDirectory, childPath } from "../web/bank.js";
import { byteSha256, canonicalJson, sc900Hash } from "./canonical.js";
import {
  CloudCurrentReceiptSchema, METADATA_PATHS, readCloudFile, validateCloudApplyApproval, validateSc900CloudPlan,
  type CloudApplyApproval, type CloudDocument, type CloudObject, type Sc900CloudPlan,
} from "./cloud-plan.js";
import type { RemoteDocument, RemoteObject, Sc900CloudAdapter } from "./cloud-adapter.js";

export const MINIMUM_EXECUTOR_FREE_BYTES = 2_500_000_000;
export class CloudQuotaPause extends Error {}
export interface Sc900CloudQuotas {
  reads: { reserve(count: number): Promise<void>; remaining(): number };
  writes: WriteBudget;
  deletes: { remaining(): number };
  storage: { reserve(amount: Partial<Amounts>): Promise<void> };
  privacy: BucketPrivacyReport;
}
const ProgressSchema = z.object({
  schemaVersion: z.literal(1), planDigest: z.string().regex(/^[a-f0-9]{64}$/),
  approvalDigest: z.string().regex(/^[a-f0-9]{64}$/),
  phase: z.enum(["objects", "stage", "promote", "verify", "publish", "complete"]),
  next: z.number().int().nonnegative(), status: z.enum(["running", "paused", "verified"]),
}).strict();

export async function writeCloudFile(workspace: string, path: string, value: unknown) {
  if (!/^\.data\/sc900-cloud\/[a-zA-Z0-9_./-]+\.json$/.test(path) ||
      path.split("/").some((part) => part === "." || part === "..")) throw new Error("Unsafe cloud receipt path.");
  await assertSafeDirectory(workspace, dirname(path));
  await mkdir(childPath(workspace, dirname(path)), { recursive: true, mode: 0o700 });
  const target = childPath(workspace, path);
  try {
    const stat = await lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("Unsafe existing cloud receipt.");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const pending = `${target}.${randomUUID()}.pending`;
  try {
    const handle = await open(pending, "wx", 0o600);
    try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); }
    finally { await handle.close(); }
    await rename(pending, target);
  } finally { await rm(pending, { force: true }); }
}

export async function assertExecutorDisk(workspace: string) {
  const disk = await statfs(workspace);
  if (disk.bavail * disk.bsize <= MINIMUM_EXECUTOR_FREE_BYTES) {
    throw new CloudQuotaPause("SC900 upload paused: free disk space is at or below 2,500,000,000 bytes.");
  }
}

function checkPrivateObject(actual: RemoteObject | null, expected: CloudObject, privacy: BucketPrivacyReport) {
  if (!actual || actual.name !== expected.name || actual.timeDeleted || actual.softDeleteTime ||
      Number(actual.size) !== expected.byteLength || actual.contentType !== expected.contentType ||
      actual.contentSha256 !== expected.sha256 || actual.metadata?.sha256 !== expected.sha256 ||
      Object.keys(actual.metadata ?? {}).some((key) => key !== "sha256") ||
      actual.cacheControl !== "private,no-store" ||
      (!privacy.uniformBucketLevelAccess && !Array.isArray(actual.acl)) ||
      actual.acl?.some((acl) => ["allUsers", "allAuthenticatedUsers"].includes(acl.entity ?? ""))) {
    throw new Error("SC900 Storage object has conflicting bytes, metadata or private-access settings; preserved without overwrite.");
  }
}
const hashDocument = (value: RemoteDocument | null) => value ? byteSha256(canonicalJson(value.data)) : null;
export function sc900CloudStageRoot(plan: Sc900CloudPlan) {
  return `sc900ImportRuns/${sc900Hash("cloud-stage", {
    target: plan.target, releaseId: plan.releaseId, staticPlanDigest: plan.staticPlanDigest,
    sourceScopeSha256: plan.sourceScopeSha256,
  })}`;
}

/** Caller owns both shared locks; no operation is retried or refunded after a failure. */
export async function executeSc900CloudPlan(rawPlan: unknown, rawApproval: unknown, dependencies: {
  workspace: string; adapter: Sc900CloudAdapter;
  refresh: () => Promise<Sc900CloudQuotas>;
  revalidate: () => Promise<Sc900CloudPlan>;
  checkDisk?: () => Promise<void>;
  signal?: AbortSignal;
}) {
  const plan = validateSc900CloudPlan(rawPlan);
  const approval = validateCloudApplyApproval(rawApproval, plan);
  const { adapter, workspace } = dependencies;
  if (adapter.target !== plan.target || adapter.projectId !== plan.projectId || adapter.bucket !== plan.bucket) {
    throw new Error("Cloud adapter does not match the approved target; no requests were made.");
  }
  const progressPath = `.data/sc900-cloud/progress/${plan.target}/${plan.planDigest}.json`;
  const approvalDigest = byteSha256(canonicalJson(approval));
  let progress: z.infer<typeof ProgressSchema> = {
    schemaVersion: 1, planDigest: plan.planDigest, approvalDigest, phase: "objects", next: 0, status: "running",
  };
  try { progress = ProgressSchema.parse(JSON.parse((await readCloudFile(workspace, progressPath, 8000)).toString("utf8"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (progress.planDigest !== plan.planDigest || progress.approvalDigest !== approvalDigest ||
      progress.next > (progress.phase === "objects" ? plan.objects.length : plan.documents.length)) {
    throw new Error("The upload checkpoint does not match this exact approved plan.");
  }
  let quotas: Sc900CloudQuotas;
  let refreshedAt = 0;
  let diskCheckedAt = 0;
  const checkpoint = async (phase = progress.phase, next = progress.next, status: typeof progress.status = "running") => {
    progress = { ...progress, phase, next, status };
    await writeCloudFile(workspace, progressPath, progress);
  };
  const before = async (force = false) => {
    if (dependencies.signal?.aborted) throw new CloudQuotaPause("SC900 apply interrupted; resume the same approved plan to verify any uncertain request.");
    if (Date.now() - diskCheckedAt >= 120_000 || force) {
      await (dependencies.checkDisk ?? (() => assertExecutorDisk(workspace)))();
      diskCheckedAt = Date.now();
    }
    if (Date.now() - refreshedAt >= 60_000 || force) {
      try { quotas = await dependencies.refresh(); }
      catch (error) {
        if (error instanceof Error && /quota pause|month changed/i.test(error.message)) throw new CloudQuotaPause(error.message);
        throw error;
      }
      if (!quotas.privacy.safeForPrivateUploads || quotas.privacy.bucketName !== plan.bucket ||
          quotas.privacy.anonymousIamBindings.length || quotas.privacy.anonymousDefaultObjectAcls.length) {
        throw new Error("Fresh verified private bucket controls are required.");
      }
      if (!quotas.reads.remaining() || !quotas.writes.remaining() || !quotas.deletes.remaining()) {
        throw new CloudQuotaPause("SC900 upload paused at a shared Firestore read/write/delete safety threshold.");
      }
      refreshedAt = Date.now();
    }
  };
  const read = async (path: string) => {
    await before();
    if (quotas.reads.remaining() < 1) throw new CloudQuotaPause("SC900 upload paused before an unbudgeted Firestore read.");
    await quotas.reads.reserve(1);
    return adapter.getDocument(path);
  };
  const create = async (operation: CloudDocument) => {
    const previous = await read(operation.path);
    if (previous) {
      if (hashDocument(previous) !== operation.sha256) throw new Error("Immutable SC900 Firestore document conflict; existing data preserved.");
      return;
    }
    await before();
    if (!(await quotas.writes.reserve(1))) throw new CloudQuotaPause("SC900 upload paused before an unbudgeted write.");
    await adapter.createDocument(operation);
    if (hashDocument(await read(operation.path)) !== operation.sha256) throw new Error("SC900 create-only document verification failed.");
  };
  const storageBudget = async (amount: Partial<Amounts>) => {
    await before();
    try { await quotas.storage.reserve(amount); }
    catch (error) {
      if (error instanceof Error && /quota pause|month changed/i.test(error.message)) throw new CloudQuotaPause("SC900 upload paused at the shared Storage safety threshold.");
      throw error;
    }
  };
  const getObject = async (object: CloudObject) => {
    await storageBudget({ classBRequests: 2, transferBytes: object.byteLength + 2 * 1024 * 1024 });
    return adapter.getObject(object);
  };
  const stageRoot = sc900CloudStageRoot(plan);
  const stagePath = (path: string) => path.replace(`studyBanks/sc900/releases/${plan.releaseId}`, stageRoot);
  const readPointers = async () => {
    const snapshots: Array<RemoteDocument | null> = [];
    for (const path of METADATA_PATHS) snapshots.push(await read(path));
    return snapshots;
  };
  const checkPointers = (snapshots: Array<RemoteDocument | null>) => {
    const existing = snapshots.filter((value) => value !== null).length;
    if (existing !== 0 && existing !== 3) throw new Error("SC900 metadata is partial; it will not be repaired implicitly.");
    if (existing === 3) {
      const current = [Sc900ReleasePointerSchema.parse(snapshots[0]!.data),
        Sc900TopicMapSchema.parse(snapshots[1]!.data), Sc900LearningManifestSchema.parse(snapshots[2]!.data)];
      if (current.some((value) => value.releaseId !== current[0]!.releaseId || value.sourceRevision !== current[0]!.sourceRevision)) {
        throw new Error("SC900 metadata contains mixed releases; no pointers were overwritten.");
      }
    }
    if (snapshots.every((value, index) => hashDocument(value) === plan.metadata[index]!.sha256)) return true;
    if (snapshots.some((value, index) => {
      const baseline = plan.baseline[index]!.snapshot;
      return baseline ? !value || hashDocument(value) !== baseline.sha256 || value.updateTime !== baseline.updateTime : value !== null;
    })) throw new Error("SC900 metadata changed outside the approved baseline; no pointers were overwritten.");
    return false;
  };
  const validateAgain = async () => {
    const current = validateSc900CloudPlan(await dependencies.revalidate());
    if (canonicalJson(current) !== canonicalJson(plan)) throw new Error("SC900 source, approvals, assets or cloud plan changed during upload.");
  };
  try {
    await validateAgain();
    await before(true);
    checkPointers(await readPointers());
    const stageData = { schemaVersion: 1, examId: "sc900", purpose: "private-sc900-upload-stage",
      stageDigest: stageRoot.split("/")[1], releaseId: plan.releaseId, staticPlanDigest: plan.staticPlanDigest,
      sourceScopeSha256: plan.sourceScopeSha256 };
    await create({ path: stageRoot, data: stageData, sha256: byteSha256(canonicalJson(stageData)) });
    if (progress.phase === "objects") {
      for (let index = progress.next; index < plan.objects.length; index++) {
        const object = plan.objects[index]!;
        const previous = await getObject(object);
        if (previous) checkPrivateObject(previous, object, quotas!.privacy);
        else {
          const bytes = await readCloudFile(workspace, object.source, object.byteLength);
          if (byteSha256(bytes) !== object.sha256 || bytes.length !== object.byteLength) throw new Error("Original image changed after cloud planning.");
          await storageBudget({ classARequests: 1, transferBytes: bytes.length + 65536, storedBytes: bytes.length });
          await adapter.createObject(object, bytes, quotas!.privacy.uniformBucketLevelAccess);
          checkPrivateObject(await getObject(object), object, quotas!.privacy);
        }
        await checkpoint("objects", index + 1);
      }
      await checkpoint("stage", 0);
    }
    if (progress.phase === "stage") {
      for (let index = progress.next; index < plan.documents.length; index++) {
        const document = plan.documents[index]!;
        await create({ ...document, path: stagePath(document.path) });
        await checkpoint("stage", index + 1);
      }
      await checkpoint("promote", 0);
    }
    if (progress.phase === "promote") {
      for (let index = progress.next; index < plan.documents.length; index++) {
        const document = plan.documents[index]!;
        if (hashDocument(await read(stagePath(document.path))) !== document.sha256) throw new Error("Private SC900 stage was modified before promotion.");
        await create(document);
        await checkpoint("promote", index + 1);
      }
      await checkpoint("verify", 0);
    }
    // Completed checkpoints are hints only. Every invocation rechecks remote content before reporting success.
    if (quotas!.reads.remaining() < plan.documents.length * 2 + 6) {
      throw new CloudQuotaPause("SC900 upload paused: the complete verification pass needs a fresh shared read allowance.");
    }
    for (const object of plan.objects) checkPrivateObject(await getObject(object), object, quotas!.privacy);
    for (const document of plan.documents) {
      if (hashDocument(await read(document.path)) !== document.sha256 ||
          hashDocument(await read(stagePath(document.path))) !== document.sha256) {
        throw new Error("SC900 immutable content changed or is incomplete; metadata was not published.");
      }
    }
    await checkpoint("publish", 0);
    await validateAgain();
    await before(true);
    const previous = await readPointers();
    const alreadyCurrent = checkPointers(previous);
    if (!alreadyCurrent) {
      if (quotas!.reads.remaining() < 3 || !(await quotas!.writes.reserve(3))) {
        throw new CloudQuotaPause("SC900 upload paused before the atomic metadata publication.");
      }
      await adapter.switchMetadata(plan.metadata, previous);
    }
    const verified = await readPointers();
    if (!verified.every((value, index) => value && hashDocument(value) === plan.metadata[index]!.sha256)) {
      throw new Error("The atomic SC900 metadata switch could not be verified.");
    }
    const receipt = CloudCurrentReceiptSchema.parse({
      schemaVersion: 1, examId: "sc900", target: plan.target, planDigest: plan.planDigest, releaseId: plan.releaseId,
      records: verified.map((value, index) => ({ path: METADATA_PATHS[index],
        snapshot: { sha256: hashDocument(value), updateTime: value!.updateTime } })),
    });
    await writeCloudFile(workspace, `.data/sc900-cloud/current-${plan.target}.json`, receipt);
    await checkpoint("complete", 0, "verified");
    return { status: "verified" as const, target: plan.target, planDigest: plan.planDigest,
      releaseId: plan.releaseId, metadataUpdated: !alreadyCurrent, applicationActivated: false as const, receipt };
  } catch (error) {
    const pause = error instanceof CloudQuotaPause ? error :
      dependencies.signal?.aborted && error instanceof Error && error.name === "AbortError"
        ? new CloudQuotaPause("SC900 apply interrupted; resume the same approved plan to verify any uncertain request.") : null;
    if (!pause) throw error;
    await checkpoint(progress.phase, progress.next, "paused");
    return { status: "paused" as const, target: plan.target, planDigest: plan.planDigest,
      phase: progress.phase, reason: pause.message, applicationActivated: false as const };
  }
}
