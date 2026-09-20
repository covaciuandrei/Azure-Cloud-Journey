import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { inspectFirebaseControls } from "../firebase/preflight.js";
import { errorMessage } from "../ingest/normalize-shared.js";
import { inspectBucketPrivacy, type BucketPrivacyReport } from "./bucket-privacy.js";
import { executeUploadPlan } from "./execute.js";
import { createFirebaseUploadAdapter } from "./firebase-adapter.js";
import { buildUploadPlan } from "./plan.js";
import { acquireUploadLock, FileWriteBudget } from "./quota.js";
import {
  DEFAULT_DAILY_WRITE_BUDGET,
  DEFAULT_RUN_WRITE_LIMIT,
  UPLOAD_PROJECT_ID,
  type ExecutionReport,
  type UploadAdapter,
  type UploadMode,
  type UploadPlan,
} from "./types.js";

export interface UploadCliOptions {
  mode: UploadMode;
  apply: boolean;
  maxWrites: number;
  dailyWriteBudget: number;
  workspace: string;
}

export interface CloudControls {
  projectId: string;
  cloudControlsReady: boolean;
  blockers: string[];
  storage: { bucketName: string | null };
}

export function helpText(): string {
  return `AZ-104 data uploader (dry-run by default)

Usage:
  npm run data:upload -- [--stage|--publish] [--dry-run]
  npm run data:upload -- [--stage|--publish] --apply [--max-writes N]

Options:
  --stage                    Plan/upload private staging data (default).
  --publish                  Plan/upload reviewed prepared public data.
  --dry-run                  Validate and print a local plan; never contact cloud (default).
  --apply                    Permit writes after a fresh successful cloud preflight.
  --max-writes N             Maximum Firestore writes in this run (default 18000);
                             this local safeguard does not cap billed document reads.
  --daily-write-budget N     Pacific-day budget shared through the local journal (default 18000).
                             Values above 18000 are an explicit cost-risk override.
  --help                     Show this help.
`;
}

function positiveInteger(value: string | undefined, flag: string): number {
  if (!value || !/^[1-9]\d*$/.test(value)) throw new Error(`${flag} requires a positive integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${flag} is too large.`);
  return parsed;
}

export function parseUploadArgs(
  args: string[],
  workspace = process.cwd(),
): UploadCliOptions | { help: true } {
  let mode: UploadMode = "stage";
  let explicitMode: UploadMode | undefined;
  let apply = false;
  let sawApply = false;
  let sawDryRun = false;
  let showHelp = false;
  let maxWrites = DEFAULT_RUN_WRITE_LIMIT;
  let dailyWriteBudget = DEFAULT_DAILY_WRITE_BUDGET;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === undefined) throw new Error("Invalid empty argument.");
    if (argument === "--help" || argument === "-h") {
      showHelp = true;
      continue;
    }
    if (argument === "--stage" || argument === "--publish") {
      const candidate = argument === "--stage" ? "stage" : "publish";
      if (explicitMode && explicitMode !== candidate) throw new Error("Choose either --stage or --publish.");
      explicitMode = candidate;
      mode = candidate;
    } else if (argument === "--apply") {
      sawApply = true;
      apply = true;
    } else if (argument === "--dry-run") {
      sawDryRun = true;
      apply = false;
    } else if (argument === "--max-writes") {
      maxWrites = positiveInteger(args[++index], argument);
    } else if (argument.startsWith("--max-writes=")) {
      maxWrites = positiveInteger(argument.split("=", 2)[1], "--max-writes");
    } else if (argument === "--daily-write-budget") {
      dailyWriteBudget = positiveInteger(args[++index], argument);
    } else if (argument.startsWith("--daily-write-budget=")) {
      dailyWriteBudget = positiveInteger(argument.split("=", 2)[1], "--daily-write-budget");
    } else {
      throw new Error(`Unknown argument: ${argument ?? ""}`);
    }
  }
  if (sawApply && sawDryRun) throw new Error("Choose either --apply or --dry-run, not both.");
  if (showHelp) return { help: true };
  return { mode, apply, maxWrites, dailyWriteBudget, workspace: resolve(workspace) };
}

export function summarizeUploadPlan(plan: UploadPlan) {
  return {
    projectId: plan.projectId,
    mode: plan.mode,
    status: plan.status,
    execution: "dry-run" as const,
    writesPerformed: 0,
    bytesUploaded: 0,
    importId: plan.importId,
    releaseId: plan.releaseId,
    sourceRevision: plan.sourceRevision,
    counts: plan.counts,
    plannedPhases: {
      mediaFirst: plan.objects.filter((operation) => operation.phase === "media").length,
      privateArchives: plan.objects.filter((operation) => operation.phase === "archive").length,
      stagedDocuments: plan.documents.filter((operation) => operation.phase === "stage").length,
      publicComments: plan.documents.filter((operation) => operation.phase === "comments").length,
      publicQuestionAnswerDocuments: plan.documents.filter(
        (operation) => operation.phase === "publication",
      ).length,
      catalogLast: plan.documents.filter((operation) => operation.phase === "catalog").length,
    },
    blockers: plan.blockers,
    warnings: [
      ...plan.warnings,
      "Dry-run did not read credentials, call cloud APIs, reserve quota, or write source data.",
    ],
    applyRequired: true,
  };
}

export async function runUpload(
  options: UploadCliOptions,
  dependencies: {
    buildPlan?: (mode: UploadMode, options: { workspace: string }) => Promise<UploadPlan>;
    inspectControls?: () => Promise<CloudControls>;
    inspectPrivacy?: (bucketName: string) => Promise<BucketPrivacyReport>;
    createAdapter?: (bucketName: string, privacy: BucketPrivacyReport) => UploadAdapter;
    execute?: typeof executeUploadPlan;
    now?: Date;
    clock?: () => Date;
  } = {},
): Promise<{ dryRun: true; plan: UploadPlan } | { dryRun: false; plan: UploadPlan; report: ExecutionReport }> {
  const plan = await (dependencies.buildPlan ?? buildUploadPlan)(
    options.mode,
    { workspace: options.workspace },
  );
  if (!options.apply) return { dryRun: true, plan };
  if (plan.blockers.length) {
    throw new Error(`Upload is blocked:\n${plan.blockers.join("\n")}`);
  }
  const releaseLock = await acquireUploadLock(options.workspace);
  try {
    const controls = await (dependencies.inspectControls ?? inspectFirebaseControls)();
    if (controls.projectId !== UPLOAD_PROJECT_ID) {
      throw new Error("Cloud preflight returned an unapproved Firebase project.");
    }
    if (!controls.cloudControlsReady || !controls.storage.bucketName) {
      throw new Error(`Fresh cloud preflight refused writes: ${controls.blockers.join("; ")}`);
    }
    const privacy = await (dependencies.inspectPrivacy ?? inspectBucketPrivacy)(
      controls.storage.bucketName,
    );
    if (privacy.bucketName !== controls.storage.bucketName ||
        !privacy.safeForPrivateUploads ||
        privacy.anonymousIamBindings.length > 0 ||
        privacy.anonymousDefaultObjectAcls.length > 0) {
      const iam = privacy.anonymousIamBindings
        .map((binding) => `${binding.role}:${binding.member}`);
      const acl = privacy.anonymousDefaultObjectAcls
        .map((entry) => `${entry.role}:${entry.entity}`);
      throw new Error(
        "Verified default bucket is unsafe for private uploads; anonymous access is configured" +
        `${[...iam, ...acl].length ? ` (${[...iam, ...acl].join(", ")})` : ""}.`,
      );
    }
    const adapterFactory = dependencies.createAdapter ?? createFirebaseUploadAdapter;
    const budget = await FileWriteBudget.open(
      options.workspace,
      options.dailyWriteBudget,
      options.maxWrites,
      dependencies.clock ?? dependencies.now,
    );
    const report = await (dependencies.execute ?? executeUploadPlan)(plan, {
      adapter: adapterFactory(controls.storage.bucketName, privacy),
      budget,
      workspace: options.workspace,
    });
    return { dryRun: false, plan, report };
  } finally {
    await releaseLock();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parseUploadArgs(process.argv.slice(2));
    if ("help" in options) {
      console.log(helpText());
    } else {
      if (options.dailyWriteBudget > DEFAULT_DAILY_WRITE_BUDGET) {
        console.error(
          `COST WARNING: explicit daily write budget ${options.dailyWriteBudget} exceeds the conservative ` +
          `${DEFAULT_DAILY_WRITE_BUDGET}-write default and is not a guaranteed spending cap.`,
        );
      }
      const result = await runUpload(options);
      console.log(JSON.stringify(result.dryRun ? summarizeUploadPlan(result.plan) : result.report, null, 2));
      if (result.dryRun && result.plan.status === "blocked") process.exitCode = 2;
      if (!result.dryRun && result.report.status === "paused") process.exitCode = 3;
    }
  } catch (error) {
    console.error(errorMessage(error));
    process.exitCode = 1;
  }
}
