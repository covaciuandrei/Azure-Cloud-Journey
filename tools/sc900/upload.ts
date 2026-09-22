import { applicationDefault } from "firebase-admin/app";
import { z } from "zod";
import { isMain } from "../review/data.js";
import { inspectFirebaseControls, approvedAdministrativeAccount } from "../firebase/preflight.js";
import { inspectFirestoreUsage, type FirestoreUsage } from "../publish/usage.js";
import { OperationBudget, writeBudgetForUsage, SAFE_READ_LIMIT, SAFE_WRITE_LIMIT, SAFE_DELETE_LIMIT } from "../publish/operation-budget.js";
import { acquireUploadLock, FileWriteBudget, pacificQuotaDay } from "../publish/quota.js";
import {
  acquireStorageHostingLock, prepareStorageCloud, StorageReservations, type StorageUsage,
} from "../publish/storage-clean.js";
import { canonicalJson } from "./canonical.js";
import {
  CLOUD_BUCKET, CLOUD_PROJECT, CloudCurrentReceiptSchema, buildSc900CloudPlan, readCloudFile,
  validateCloudApplyApproval, validateSc900CloudPlan, type Sc900CloudPlan,
} from "./cloud-plan.js";
import { createSc900RestAdapter, emulatorOrigin } from "./cloud-adapter.js";
import { CloudQuotaPause, assertExecutorDisk, executeSc900CloudPlan, sc900CloudStageRoot, writeCloudFile, type Sc900CloudQuotas } from "./cloud-executor.js";

function assertFresh(checkedAt: string) {
  const time = Date.parse(checkedAt);
  if (!Number.isFinite(time) || time > Date.now() || Date.now() - time > 5 * 60_000) {
    throw new Error("Cloud controls and quota evidence must be fresh and not future-dated.");
  }
}
export async function openSc900FirestoreBudgets(usage: FirestoreUsage, workspace: string) {
  assertFresh(usage.checkedAt);
  if (usage.pacificDay !== pacificQuotaDay(new Date()) ||
      [usage.reads, usage.writes, usage.deletes].some((count) => !Number.isSafeInteger(count) || count < 0)) {
    throw new Error("Invalid project-wide Firestore quota evidence.");
  }
  // Preserve observed project usage in the existing journals before reserving new work.
  // Delayed telemetry or a restart must not restore already consumed headroom.
  const observedReads = await OperationBudget.open("reads", 0, workspace);
  const observedDeletes = await OperationBudget.open("deletes", 0, workspace);
  const observedWrites = await FileWriteBudget.open(workspace, SAFE_WRITE_LIMIT, SAFE_WRITE_LIMIT);
  await observedReads.reserve(Math.max(0, Math.min(usage.reads, SAFE_READ_LIMIT) - (SAFE_READ_LIMIT - observedReads.remaining())));
  await observedDeletes.reserve(Math.max(0, Math.min(usage.deletes, SAFE_DELETE_LIMIT) - (SAFE_DELETE_LIMIT - observedDeletes.remaining())));
  const extraWrites = Math.max(0, Math.min(usage.writes, SAFE_WRITE_LIMIT) - (SAFE_WRITE_LIMIT - observedWrites.remaining()));
  if (!(await observedWrites.reserve(extraWrites))) throw new CloudQuotaPause("Shared write headroom changed before reservation.");
  if (usage.reads >= SAFE_READ_LIMIT || usage.writes >= SAFE_WRITE_LIMIT || usage.deletes >= SAFE_DELETE_LIMIT) {
    throw new CloudQuotaPause("SC900 upload paused at a project-wide Firestore safety threshold.");
  }
  return {
    reads: await OperationBudget.open("reads", usage.reads, workspace),
    writes: await writeBudgetForUsage(usage, workspace),
    deletes: await OperationBudget.open("deletes", usage.deletes, workspace),
  };
}
export function assertSc900StorageUsage(usage: StorageUsage,
  reserved = { storedBytes: 0, transferBytes: 0 }, inventoryBytes = 0) {
  assertFresh(usage.checkedAt);
  if (usage.month !== pacificQuotaDay(new Date()).slice(0, 7) ||
      [usage.hostingStoredBytes, usage.hostingTransferBytes, reserved.storedBytes, reserved.transferBytes, inventoryBytes]
        .some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error("Invalid project-wide Storage/Hosting usage evidence.");
  }
  if (Math.max(usage.hostingStoredBytes, inventoryBytes) + reserved.storedBytes >= 9_000_000_000 ||
      usage.hostingTransferBytes + reserved.transferBytes >= 9_000_000_000) {
    throw new CloudQuotaPause("SC900 upload paused to preserve shared monthly Hosting headroom.");
  }
}

export async function runSc900CloudApply(options: {
  workspace: string; planPath: string; cloudApprovalPath: string; emulator: boolean;
  signal?: AbortSignal;
}) {
  const plan = validateSc900CloudPlan(JSON.parse((await readCloudFile(options.workspace, options.planPath)).toString("utf8")));
  const approval = validateCloudApplyApproval(
    JSON.parse((await readCloudFile(options.workspace, options.cloudApprovalPath, 64 * 1024)).toString("utf8")), plan);
  if ((plan.target === "emulator") !== options.emulator) throw new Error("The explicit emulator flag does not match the approved plan target.");
  const rebuild = async () => {
    const currentPlan = validateSc900CloudPlan(JSON.parse((await readCloudFile(options.workspace, options.planPath)).toString("utf8")));
    const currentApproval = validateCloudApplyApproval(
      JSON.parse((await readCloudFile(options.workspace, options.cloudApprovalPath, 64 * 1024)).toString("utf8")), currentPlan);
    if (canonicalJson(currentPlan) !== canonicalJson(plan) || canonicalJson(currentApproval) !== canonicalJson(approval)) {
      throw new Error("Cloud plan or apply approval changed while execution was in progress.");
    }
    return buildSc900CloudPlan(options.workspace, {
      target: plan.target, approvalPath: plan.approvalPath, sourceScopePath: plan.sourceScopePath, baseline: plan.baseline,
    });
  };
  if (canonicalJson(await rebuild()) !== canonicalJson(plan)) throw new Error("Cloud plan no longer matches its approved source publication.");
  options.signal?.throwIfAborted();
  let firestoreHost = "";
  let storageHost = "";
  if (options.emulator) {
    firestoreHost = process.env.FIRESTORE_EMULATOR_HOST ?? "";
    storageHost = process.env.FIREBASE_STORAGE_EMULATOR_HOST ?? "";
    emulatorOrigin(firestoreHost); emulatorOrigin(storageHost);
    if (process.env.GCLOUD_PROJECT && process.env.GCLOUD_PROJECT !== "demo-az104-study") {
      throw new Error("Emulator apply is restricted to demo-az104-study.");
    }
  } else {
    if (process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_STORAGE_EMULATOR_HOST ||
        process.env.STORAGE_EMULATOR_HOST || process.env.FIREBASE_AUTH_EMULATOR_HOST) {
      throw new Error("Production apply refuses emulator environment variables.");
    }
    if (options.workspace !== process.cwd()) throw new Error("Production apply must run in the approved workspace containing the shared journals.");
    if (approval.reviewer.toLowerCase() !== approvedAdministrativeAccount()) {
      throw new Error("The approved administrator must approve the exact cloud plan before apply.");
    }
    for (const path of [".data/upload-journal.json", ".data/operation-journal.json",
      ".data/rollout/storage-journal.json", ".data/rollout/hosting-journal.json"]) {
      await readCloudFile(options.workspace, path, 4 * 1024 * 1024);
    }
  }
  await assertExecutorDisk(options.workspace);
  const unlockFirestore = await acquireUploadLock(options.workspace);
  try {
    const unlockStorage = await acquireStorageHostingLock(options.workspace);
    try {
      const signal = options.signal ? { signal: options.signal } : {};
      const adapter = options.emulator ? createSc900RestAdapter({ target: "emulator", firestoreHost, storageHost, ...signal })
        : createSc900RestAdapter({ target: "production", getAccessToken: async () => (await applicationDefault().getAccessToken()).access_token, ...signal });
      const refresh = async (): Promise<Sc900CloudQuotas> => {
        if (options.emulator) {
          const checkedAt = new Date().toISOString();
          const firestore = await openSc900FirestoreBudgets({
            checkedAt, pacificDay: pacificQuotaDay(new Date()), periodStart: checkedAt, reads: 0, writes: 0, deletes: 0,
          }, options.workspace);
          const usage: StorageUsage = { checkedAt, month: pacificQuotaDay(new Date()).slice(0, 7), periodStart: checkedAt,
            requests: 0, transferBytes: 0, storedBytes: 0, peakStoredBytes: 0,
            hostingStoredBytes: 0, hostingTransferBytes: 0, samples: {} };
          return { ...firestore, storage: await StorageReservations.open(usage, options.workspace), privacy: {
            bucketName: adapter.bucket, safeForPrivateUploads: true, uniformBucketLevelAccess: true,
            publicAccessPrevention: null, anonymousIamBindings: [], anonymousDefaultObjectAcls: [],
          } };
        }
        const controls = await inspectFirebaseControls();
        assertFresh(controls.checkedAt);
        if (!controls.cloudControlsReady || controls.projectId !== CLOUD_PROJECT ||
            controls.administrativeAccount !== approvedAdministrativeAccount() ||
            controls.storage.bucketName !== CLOUD_BUCKET || controls.storage.location !== "US-EAST1" ||
            controls.firestore.freeTier !== true || !controls.budget.verified) {
          throw new Error("Fresh project, administrator, rules, billing and budget verification blocks SC900 apply.");
        }
        const firestore = await openSc900FirestoreBudgets(await inspectFirestoreUsage(), options.workspace);
        const storage = await prepareStorageCloud();
        const journal = z.object({ months: z.record(z.string(), z.object({
          storedBytes: z.number().int().nonnegative(), transferBytes: z.number().int().nonnegative(),
        }).strict()) }).strict().parse(JSON.parse(
          (await readCloudFile(options.workspace, ".data/rollout/hosting-journal.json", 4 * 1024 * 1024)).toString("utf8")));
        const inventoryBytes = storage.cloud.hosting.flatMap((site) => site.versions).reduce<number>((total, raw) => {
          const version = z.object({ versionBytes: z.string().optional(), status: z.string().optional() }).passthrough().parse(raw);
          const bytes = version.status === "DELETED" && version.versionBytes === undefined ? 0 : Number(version.versionBytes);
          if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("Hosting inventory has unknown stored bytes.");
          return total + bytes;
        }, 0);
        assertSc900StorageUsage(storage.usage, journal.months[storage.usage.month], inventoryBytes);
        return { ...firestore, storage: storage.reservations, privacy: storage.privacy };
      };
      return await executeSc900CloudPlan(plan, approval, { workspace: options.workspace, adapter, refresh, revalidate: rebuild, ...signal });
    } finally { await unlockStorage(); }
  } finally { await unlockFirestore(); }
}

export function parseSc900UploadArgs(args: string[]) {
  let emulator = false;
  let mode: "plan" | "apply" = "plan";
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!;
    if (flags.has(flag)) throw new Error("Duplicate SC900 upload argument.");
    flags.add(flag);
    if (flag === "--emulator") { emulator = true; continue; }
    if (flag === "--dry-run" || flag === "--plan") continue;
    if (!["--apply", "--approval", "--scope", "--cloud-approval", "--baseline"].includes(flag) ||
        !args[index + 1] || args[index + 1]!.startsWith("--")) throw new Error("Invalid SC900 upload arguments.");
    values.set(flag, args[++index]!);
    if (flag === "--apply") mode = "apply";
  }
  if (flags.has("--dry-run") && (flags.has("--plan") || flags.has("--apply")) ||
      flags.has("--plan") && flags.has("--apply")) throw new Error("Choose exactly one plan/dry-run or apply mode.");
  if (mode === "apply") {
    if (!values.has("--cloud-approval") || ["--approval", "--scope", "--baseline"].some((flag) => values.has(flag))) {
      throw new Error("Apply requires the saved cloud plan and exact cloud approval only.");
    }
  } else if (!values.has("--approval") || !values.has("--scope") || values.has("--cloud-approval")) {
    throw new Error("Planning requires the independently approved static bank and original source-scope receipt.");
  }
  return { mode, emulator, values };
}

if (isMain(import.meta.url)) {
  try {
    const options = parseSc900UploadArgs(process.argv.slice(2));
    const workspace = process.cwd();
    if (options.mode === "apply") {
      const controller = new AbortController();
      const interrupt = () => { process.exitCode = 130; controller.abort(); };
      const terminate = () => { process.exitCode = 143; controller.abort(); };
      process.once("SIGINT", interrupt); process.once("SIGTERM", terminate);
      try {
        const report = await runSc900CloudApply({ workspace, emulator: options.emulator, signal: controller.signal,
          planPath: options.values.get("--apply")!, cloudApprovalPath: options.values.get("--cloud-approval")! });
        console.log(JSON.stringify(report, null, 2));
        if (report.status === "paused" && !controller.signal.aborted) process.exitCode = 3;
      } finally { process.off("SIGINT", interrupt); process.off("SIGTERM", terminate); }
    } else {
      await assertExecutorDisk(workspace);
      const target: Sc900CloudPlan["target"] = options.emulator ? "emulator" : "production";
      let baseline: Sc900CloudPlan["baseline"] | undefined;
      if (options.values.has("--baseline")) {
        const previous = CloudCurrentReceiptSchema.parse(JSON.parse(
          (await readCloudFile(workspace, options.values.get("--baseline")!, 64 * 1024)).toString("utf8")));
        if (previous.target !== target) throw new Error("Metadata baseline belongs to a different cloud target.");
        baseline = previous.records;
      }
      const plan = await buildSc900CloudPlan(workspace, {
        target, approvalPath: options.values.get("--approval")!, sourceScopePath: options.values.get("--scope")!,
        ...(baseline ? { baseline } : {}),
      });
      const path = `.data/sc900-cloud/plans/${plan.planDigest}.json`;
      await writeCloudFile(workspace, path, plan);
      console.log(JSON.stringify({ status: "planned", target, planPath: path, planDigest: plan.planDigest,
        staticPlanDigest: plan.staticPlanDigest, sourceScopeSha256: plan.sourceScopeSha256,
        privateStageRoot: sc900CloudStageRoot(plan), immutableDocuments: plan.documents.length,
        objects: plan.objects.length, metadataWrites: 3, deletes: 0, remoteRequests: 0,
        applicationActivated: false, approvalRequired: true }, null, 2));
    }
  } catch (error) {
    console.error(error instanceof z.ZodError ? "SC900 cloud input failed strict schema validation." :
      error instanceof Error ? error.message : "SC900 cloud execution failed.");
    if (process.exitCode !== 130 && process.exitCode !== 143) process.exitCode = 1;
  }
}
