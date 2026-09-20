import {
  AssetSchema, ConversionOverlaySchema, ReviewOverlaySchema, SourceOccurrenceSchema,
} from "../../src/domain/index.js";
import { approvedAdministrativeAccount, inspectFirebaseControls } from "../firebase/preflight.js";
import { digest, errorMessage, occurrenceId, workspacePath } from "../ingest/normalize-shared.js";
import { readdir } from "node:fs/promises";
import { buildPreparedSnapshot } from "../review/prepare.js";
import { isMain, readData, readOptionalData, writeData } from "../review/data.js";
import { sourceReviewSchema } from "../review/source-review.js";
import { executeUploadPlan } from "./execute.js";
import { createFirestoreDocumentAdapter } from "./firebase-adapter.js";
import { buildUploadPlan, uploadPlanInternals } from "./plan.js";
import { acquireUploadLock, FileWriteBudget } from "./quota.js";
import {
  DEFAULT_DAILY_WRITE_BUDGET, UPLOAD_PROJECT_ID, UPLOAD_PROJECT_NUMBER,
  type UploadAdapter, type UploadPlan, type WriteBudget,
} from "./types.js";
import { parseUploadArgs, type UploadCliOptions } from "./upload.js";

type Controls = Awaited<ReturnType<typeof inspectFirebaseControls>>;

export function assertFreeFirestoreStaging(controls: Controls): void {
  if (controls.projectId !== UPLOAD_PROJECT_ID || controls.projectNumber !== UPLOAD_PROJECT_NUMBER ||
      controls.administrativeAccount !== approvedAdministrativeAccount()) {
    throw new Error("Private Firestore staging requires the approved project and study account.");
  }
  if (controls.billing.enabled || controls.billing.accountName !== null) {
    throw new Error("Billing is enabled; use the normal uploader with Storage and budget safeguards instead.");
  }
  if (controls.firestore.name !== `projects/${UPLOAD_PROJECT_ID}/databases/(default)` ||
      controls.firestore.type !== "FIRESTORE_NATIVE" || controls.firestore.freeTier !== true ||
      !controls.firestore.rules.deployed || !controls.firestore.rules.matchesLocal) {
    throw new Error("The free default Firestore database or its deployed private-staging rules are not ready.");
  }
}

export function assertPrivateDocumentPlan(plan: UploadPlan): void {
  if (plan.projectId !== UPLOAD_PROJECT_ID || plan.mode !== "stage" || plan.objects.length !== 0 ||
      !/^import_[a-f0-9]{64}$/.test(plan.importId)) {
    throw new Error("Firestore-only staging cannot upload objects or publish content.");
  }
  const root = `importRuns/${plan.importId}`;
  if (plan.documents.some((operation) =>
    operation.phase !== "stage" || (operation.path !== root && !operation.path.startsWith(`${root}/`)))) {
    throw new Error("Firestore-only staging can write only beneath its private import record.");
  }
}

export function firestoreOnlyAdapter(
  documents: Pick<UploadAdapter, "getDocument" | "getDocuments" | "createDocuments">,
): UploadAdapter {
  return {
    ...documents,
    async getObject() { throw new Error("Storage reads are disabled in Firestore-only staging."); },
    async createObject() { throw new Error("Storage writes are disabled in Firestore-only staging."); },
  };
}

export async function buildFirestoreStagingPlan(workspace = process.cwd()): Promise<UploadPlan> {
  const base = await buildUploadPlan("stage", { workspace });
  const prepared = await buildPreparedSnapshot(workspace);
  const plan: UploadPlan = {
    ...base,
    releaseId: prepared.catalog.releaseId,
    objects: [],
    documents: [],
    counts: { ...base.counts, ...prepared.catalog.records, objects: 0, objectBytes: 0 },
    warnings: [
      ...base.warnings,
      "Firestore-only staging: all documents remain private; no public questions or catalog are written.",
      `The ${base.objects.length} Storage objects, including original images and raw capture archives, remain local.`,
      "The complete Firebase import is not finished until Storage is enabled and the normal publication upload completes.",
    ],
  };
  const root = `importRuns/${base.importId}/firestoreOnly/${prepared.catalog.releaseId}`;
  plan.documents.push(uploadPlanInternals.documentOperation("stage", root, {
    schemaVersion: 1,
    releaseId: prepared.catalog.releaseId,
    sourceRevision: prepared.catalog.sourceRevision,
    records: prepared.catalog.records,
    sourceRecords: prepared.catalog.sourceRecords,
    commentFilter: prepared.catalog.commentFilter,
    reviewCounts: prepared.catalog.reviewCounts,
    gradingCounts: prepared.catalog.gradingCounts,
    published: false,
    purpose: "private-filtered-study-data-without-storage",
    mediaUploaded: false,
  }));
  plan.documents.push(uploadPlanInternals.documentOperation(
    "stage", `${root}/catalogs/az104`, { ...prepared.catalog, published: false },
  ));
  for (const question of prepared.questions) {
    plan.documents.push(uploadPlanInternals.documentOperation(
      "stage", `${root}/questions/${question.id}`, { ...question, published: false },
    ));
  }
  for (const answer of prepared.answers) {
    plan.documents.push(uploadPlanInternals.documentOperation(
      "stage", `${root}/answers/${answer.id}`, { ...answer, published: false },
    ));
  }
  for (const comment of prepared.comments) {
    plan.documents.push(uploadPlanInternals.documentOperation(
      "stage", `${root}/comments/${comment.id}`, comment,
    ));
  }
  for (const filename of (await readdir(workspacePath(workspace, ".data/normalized/assets"))).sort()) {
    if (!filename.endsWith(".json")) continue;
    const path = `.data/normalized/assets/${filename}`;
    const asset = await readData(path, AssetSchema, workspace);
    plan.documents.push(uploadPlanInternals.documentOperation(
      "stage", `${root}/assets/${asset.id}`, asset, { sourcePath: path },
    ));
  }
  for (const entry of prepared.catalog.entries) {
    const reviewPath = `.data/reviews/${entry.id}.json`;
    const review = await readData(reviewPath, ReviewOverlaySchema, workspace);
    plan.documents.push(uploadPlanInternals.documentOperation(
      "stage", `${root}/reviews/${entry.id}`, review, { sourcePath: reviewPath },
    ));
    const conversionPath = `.data/conversions/${entry.id}.json`;
    const conversion = await readOptionalData(conversionPath, ConversionOverlaySchema, workspace);
    if (conversion) {
      plan.documents.push(uploadPlanInternals.documentOperation(
        "stage", `${root}/conversions/${entry.id}`, conversion, { sourcePath: conversionPath },
      ));
    }
    for (const number of entry.sourceQuestionNumbers) {
      const occurrencePath = `.data/normalized/occurrences/${occurrenceId(number)}.json`;
      const occurrence = await readData(occurrencePath, SourceOccurrenceSchema, workspace);
      plan.documents.push(uploadPlanInternals.documentOperation(
        "stage", `${root}/occurrences/${occurrence.id}`, occurrence, { sourcePath: occurrencePath },
      ));
      const sourcePath = `.data/curation/source-reviews/q-${String(number).padStart(4, "0")}.json`;
      const source = await readData(sourcePath, sourceReviewSchema, workspace);
      plan.documents.push(uploadPlanInternals.documentOperation(
        "stage", `${root}/sourceReviews/${occurrenceId(number)}`, source,
      ));
    }
  }
  const priority = (path: string) => path.includes("/comments/") ? 1 : 0;
  plan.documents.sort((left, right) =>
    priority(left.path) - priority(right.path) || left.path.localeCompare(right.path));
  plan.counts.documents = plan.documents.length;
  assertPrivateDocumentPlan(plan);
  return plan;
}

export function parseFirestoreStagingArgs(args: string[], workspace = process.cwd()): UploadCliOptions | { help: true } {
  if (args.includes("--publish")) throw new Error("Firestore-only staging never publishes content.");
  const options = parseUploadArgs(args, workspace);
  if ("help" in options) return options;
  if (options.dailyWriteBudget > DEFAULT_DAILY_WRITE_BUDGET || options.maxWrites > DEFAULT_DAILY_WRITE_BUDGET) {
    throw new Error("Free-plan staging is capped at 18,000 writes per run and Pacific quota day.");
  }
  return options;
}

export async function runFirestoreStaging(
  options: UploadCliOptions,
  dependencies: {
    buildPlan?: (workspace: string) => Promise<UploadPlan>;
    inspectControls?: () => Promise<Controls>;
    createDocuments?: () => Pick<UploadAdapter, "getDocument" | "getDocuments" | "createDocuments">;
    budget?: WriteBudget;
  } = {},
) {
  if (options.mode !== "stage" || options.dailyWriteBudget > DEFAULT_DAILY_WRITE_BUDGET ||
      options.maxWrites > DEFAULT_DAILY_WRITE_BUDGET) {
    throw new Error("Only quota-limited private staging is supported by this command.");
  }
  const plan = await (dependencies.buildPlan ?? buildFirestoreStagingPlan)(options.workspace);
  assertPrivateDocumentPlan(plan);
  if (!options.apply) {
    return {
      execution: "dry-run" as const, status: "planned" as const,
      projectId: UPLOAD_PROJECT_ID, importId: plan.importId, releaseId: plan.releaseId,
      counts: plan.counts, warnings: plan.warnings,
      firestoreRoot: `importRuns/${plan.importId}/firestoreOnly/${plan.releaseId}`,
      sourceDataWritesPerformed: 0, storageBytesUploaded: 0, published: false,
    };
  }
  const releaseLock = await acquireUploadLock(options.workspace);
  try {
    const budget = dependencies.budget ?? await FileWriteBudget.open(
      options.workspace, options.dailyWriteBudget, options.maxWrites,
    );
    if (budget.remaining() === 0) {
      throw new Error(
        `The private upload's ${budget.day} write allowance is exhausted (${budget.pauseReason}). ` +
        "No remote documents were scanned. Resume after the Pacific quota reset.",
      );
    }
    const controls = await (dependencies.inspectControls ?? inspectFirebaseControls)();
    assertFreeFirestoreStaging(controls);
    const documents = (dependencies.createDocuments ?? createFirestoreDocumentAdapter)();
    const adapter = firestoreOnlyAdapter(documents);
    const create = adapter.createDocuments.bind(adapter);
    let created = 0;
    let lastProgress = 0;
    adapter.createDocuments = async (operations) => {
      const count = await create(operations);
      created += count;
      if (created - lastProgress >= 1000) {
        console.error(`Private Firestore staging: ${created} documents created in this run.`);
        lastProgress = created;
      }
      return count;
    };
    const execution = await executeUploadPlan(plan, { adapter, budget, workspace: options.workspace });
    const report = {
      ...execution, execution: "applied" as const, completedAt: new Date().toISOString(),
      firestoreOnly: true, published: false, fullDatasetUploaded: false,
      firestoreRoot: `importRuns/${plan.importId}/firestoreOnly/${plan.releaseId}`,
      planDigest: digest(plan.documents.map(({ path, contentHash }) => ({ path, contentHash }))),
      deferredStorage: true, warnings: plan.warnings,
    };
    await writeData(".data/firestore-staging-report.json", report, options.workspace);
    return report;
  } finally {
    await releaseLock();
  }
}

if (isMain(import.meta.url)) {
  try {
    const options = parseFirestoreStagingArgs(process.argv.slice(2));
    if ("help" in options) {
      console.log("Private Firestore staging on the unbilled free plan.\n" +
        "Usage: npm run data:upload-firestore -- [--dry-run | --apply] [--max-writes N]\n" +
        "Only private documents are uploaded. Storage, public release, and billing changes are prohibited.\n" +
        "Default run/day limit: 18000 writes; exceeding this limit is not supported.");
    } else {
      const report = await runFirestoreStaging(options);
      console.log(JSON.stringify(report, null, 2));
      if (report.status === "paused") process.exitCode = 3;
    }
  } catch (error) {
    console.error(errorMessage(error));
    process.exitCode = 1;
  }
}
