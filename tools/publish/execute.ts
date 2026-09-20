import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { canonicalJson, digest, sha256, workspacePath } from "../ingest/normalize-shared.js";
import type {
  DocumentOperation,
  ExecutionReport,
  ObjectOperation,
  UploadAdapter,
  UploadPlan,
  WriteBudget,
} from "./types.js";

function equalDocument(remote: unknown, operation: DocumentOperation): boolean {
  return digest(remote) === operation.contentHash;
}

async function operationData(workspace: string, operation: DocumentOperation): Promise<unknown> {
  if (operation.data !== undefined) {
    if (digest(operation.data) !== operation.contentHash) {
      throw new Error(`${operation.path}: in-memory plan data changed after planning.`);
    }
    return operation.data;
  }
  if (!operation.sourcePath) throw new Error(`${operation.path}: plan has no document source.`);
  const value = JSON.parse(await readFile(workspacePath(workspace, operation.sourcePath), "utf8")) as unknown;
  if (digest(value) !== operation.contentHash) {
    throw new Error(`${operation.sourcePath}: content changed after upload planning; build a fresh plan.`);
  }
  return value;
}

async function classifyDocuments(
  adapter: UploadAdapter,
  operations: DocumentOperation[],
): Promise<{
  states: Array<"missing" | "unchanged">;
  missing: DocumentOperation[];
  unchanged: number;
}> {
  const missing: DocumentOperation[] = [];
  const states: Array<"missing" | "unchanged"> = [];
  let unchanged = 0;
  const remotes = adapter.getDocuments
    ? await adapter.getDocuments(operations.map((operation) => operation.path))
    : await Promise.all(operations.map((operation) => adapter.getDocument(operation.path)));
  if (remotes.length !== operations.length) {
    throw new Error("Upload adapter returned an incomplete document batch.");
  }
  for (let index = 0; index < operations.length; index++) {
    const operation = operations[index];
    const remote = remotes[index];
    if (!operation || !remote) throw new Error("Invalid document classification batch.");
    if (!remote.exists) {
      missing.push(operation);
      states.push("missing");
    } else if (remote.data !== undefined && equalDocument(remote.data, operation)) {
      unchanged++;
      states.push("unchanged");
    } else {
      throw new Error(`${operation.path}: remote document conflict; existing data was preserved.`);
    }
  }
  return { states, missing, unchanged };
}

async function verifyDocuments(
  adapter: UploadAdapter,
  operations: DocumentOperation[],
): Promise<void> {
  const remotes = adapter.getDocuments
    ? await adapter.getDocuments(operations.map((operation) => operation.path))
    : await Promise.all(operations.map((operation) => adapter.getDocument(operation.path)));
  if (remotes.length !== operations.length) {
    throw new Error("Upload adapter returned an incomplete verification batch.");
  }
  for (let index = 0; index < operations.length; index++) {
    const operation = operations[index];
    const remote = remotes[index];
    if (!operation || !remote) throw new Error("Invalid document verification batch.");
    if (!remote.exists || remote.data === undefined || !equalDocument(remote.data, operation)) {
      throw new Error(`${operation.path}: post-write verification failed.`);
    }
  }
}

async function applyDocumentGroup(
  workspace: string,
  adapter: UploadAdapter,
  budget: WriteBudget,
  operations: DocumentOperation[],
  classified?: Awaited<ReturnType<typeof classifyDocuments>>,
): Promise<{ created: number; unchanged: number; paused: boolean }> {
  const state = classified ?? await classifyDocuments(adapter, operations);
  if (state.missing.length === 0) return { created: 0, unchanged: state.unchanged, paused: false };
  if (!(await budget.reserve(state.missing.length))) {
    return { created: 0, unchanged: state.unchanged, paused: true };
  }
  const materialized: DocumentOperation[] = [];
  for (const operation of state.missing) {
    materialized.push({ ...operation, data: await operationData(workspace, operation) });
  }
  const created = await adapter.createDocuments(materialized);
  if (created > state.missing.length) {
    throw new Error("Upload adapter reported more document writes than were reserved.");
  }
  await verifyDocuments(adapter, operations);
  return { created, unchanged: operations.length - created, paused: false };
}

async function applyChunkedDocuments(
  workspace: string,
  adapter: UploadAdapter,
  budget: WriteBudget,
  operations: DocumentOperation[],
): Promise<{ created: number; unchanged: number; processed: number; paused: boolean }> {
  let created = 0;
  let unchanged = 0;
  let processed = 0;
  while (processed < operations.length) {
    const candidate = operations.slice(processed, processed + 100);
    const classified = await classifyDocuments(adapter, candidate);
    const available = budget.remaining();
    let selectedCount = candidate.length;
    if (classified.missing.length > available) {
      if (available === 0) return { created, unchanged, processed, paused: true };
      let missingSeen = 0;
      selectedCount = 0;
      for (const state of classified.states) {
        if (state === "missing") {
          if (missingSeen === available) break;
          missingSeen++;
        }
        selectedCount++;
      }
    }
    const selected = candidate.slice(0, selectedCount);
    const selectedStates = classified.states.slice(0, selectedCount);
    const selectedMissing = selected.filter((_, index) => selectedStates[index] === "missing");
    const selectedClassification = {
      states: selectedStates,
      missing: selectedMissing,
      unchanged: selected.length - selectedMissing.length,
    };
    const result = await applyDocumentGroup(
      workspace,
      adapter,
      budget,
      selected,
      selectedClassification,
    );
    created += result.created;
    unchanged += result.unchanged;
    processed += result.created + result.unchanged;
    if (result.paused || selectedCount < candidate.length) {
      return { created, unchanged, processed, paused: true };
    }
  }
  return { created, unchanged, processed, paused: false };
}

async function applyObject(
  workspace: string,
  adapter: UploadAdapter,
  operation: ObjectOperation,
): Promise<"created" | "unchanged"> {
  const assertPrivateMetadata = (value: Awaited<ReturnType<UploadAdapter["getObject"]>>) => {
    if (value.exists && (value.hasDownloadTokens !== false || value.anonymousAcl !== false)) {
      throw new Error(
        `${operation.path}: object privacy could not be verified or unsafe access metadata exists; ` +
        "the existing object was preserved.",
      );
    }
  };
  const remote = await adapter.getObject(operation.path);
  assertPrivateMetadata(remote);
  if (remote.exists) {
    if (remote.sha256 === operation.sha256 &&
        remote.byteLength === operation.byteLength &&
        remote.contentType === operation.contentType) return "unchanged";
    throw new Error(`${operation.path}: remote object conflict; existing bytes were preserved.`);
  }
  const bytes = await readFile(workspacePath(workspace, operation.sourcePath));
  if (bytes.byteLength !== operation.byteLength || sha256(bytes) !== operation.sha256) {
    throw new Error(`${operation.sourcePath}: asset changed after upload planning; build a fresh plan.`);
  }
  const created = await adapter.createObject(operation, bytes);
  const verified = await adapter.getObject(operation.path);
  assertPrivateMetadata(verified);
  if (!verified.exists || verified.sha256 !== operation.sha256 ||
      verified.byteLength !== operation.byteLength ||
      verified.contentType !== operation.contentType) {
    throw new Error(`${operation.path}: post-upload object verification failed.`);
  }
  return created ? "created" : "unchanged";
}

function questionGroups(plan: UploadPlan): Array<{
  comments: DocumentOperation[];
  publication: DocumentOperation[];
}> {
  const ids = [...new Set(plan.documents.flatMap((operation) =>
    operation.questionId ? [operation.questionId] : []))].sort();
  return ids.map((questionId) => ({
    comments: plan.documents.filter((operation) =>
      operation.phase === "comments" && operation.questionId === questionId),
    publication: plan.documents.filter((operation) =>
      operation.phase === "publication" && operation.questionId === questionId),
  }));
}

export async function executeUploadPlan(
  plan: UploadPlan,
  dependencies: {
    adapter: UploadAdapter;
    budget: WriteBudget;
    workspace?: string;
  },
): Promise<ExecutionReport> {
  const workspace = resolve(dependencies.workspace ?? process.cwd());
  const { adapter, budget } = dependencies;
  if (plan.projectId !== "study-az104") throw new Error("Upload plan targets an unapproved Firebase project.");
  const result: ExecutionReport = {
    projectId: plan.projectId,
    mode: plan.mode,
    status: plan.blockers.length ? "blocked" : plan.mode === "stage" ? "staged" : "published",
    importId: plan.importId,
    releaseId: plan.releaseId,
    documents: { created: 0, unchanged: 0, remaining: plan.documents.length },
    objects: { created: 0, unchanged: 0, remaining: plan.objects.length, bytesCreated: 0 },
    writeBudget: {
      pacificDay: budget.day,
      dailyLimit: budget.dailyLimit,
      runLimit: budget.runLimit,
      usedBeforeRun: budget.usedBeforeRun,
      reservedThisRun: 0,
      remaining: budget.remaining(),
      pauseReason: budget.pauseReason,
    },
    blockers: [...plan.blockers],
    resume: null,
  };
  if (plan.blockers.length) return result;

  for (const operation of plan.objects) {
    const objectResult = await applyObject(workspace, adapter, operation);
    result.objects[objectResult]++;
    if (objectResult === "created") result.objects.bytesCreated += operation.byteLength;
    result.objects.remaining--;
  }

  let paused = false;
  if (plan.mode === "stage") {
    const applied = await applyChunkedDocuments(
      workspace,
      adapter,
      budget,
      plan.documents,
    );
    result.documents.created += applied.created;
    result.documents.unchanged += applied.unchanged;
    result.documents.remaining -= applied.processed;
    paused = applied.paused;
  } else {
    for (const group of questionGroups(plan)) {
      const comments = await applyChunkedDocuments(
        workspace,
        adapter,
        budget,
        group.comments,
      );
      result.documents.created += comments.created;
      result.documents.unchanged += comments.unchanged;
      result.documents.remaining -= comments.processed;
      if (comments.paused) { paused = true; break; }

      if (group.publication.length !== 2 ||
          group.publication[0]?.phase !== "publication" ||
          group.publication[1]?.phase !== "publication") {
        throw new Error("Each public question requires exactly one question and one answer operation.");
      }
      const publication = await applyDocumentGroup(workspace, adapter, budget, group.publication);
      result.documents.created += publication.created;
      result.documents.unchanged += publication.unchanged;
      result.documents.remaining -= publication.created + publication.unchanged;
      if (publication.paused) { paused = true; break; }
    }
    if (!paused) {
      const catalog = plan.documents.filter((operation) => operation.phase === "catalog");
      if (catalog.length !== 1) throw new Error("Publication requires exactly one final catalog operation.");
      const applied = await applyDocumentGroup(workspace, adapter, budget, catalog);
      result.documents.created += applied.created;
      result.documents.unchanged += applied.unchanged;
      result.documents.remaining -= applied.created + applied.unchanged;
      paused = applied.paused;
    }
  }

  result.writeBudget.reservedThisRun = budget.reservedThisRun;
  result.writeBudget.remaining = budget.remaining();
  result.writeBudget.pauseReason = budget.pauseReason;
  if (paused) {
    result.status = "paused";
    result.resume = budget.pauseReason === "run-limit"
      ? `The run write limit was reached. Re-run the same ${plan.mode} command to use any remaining daily allowance; unchanged records will be skipped.`
      : budget.pauseReason === "day-rollover"
        ? `The Pacific quota day changed during the run. Start a fresh ${plan.mode} run; unchanged records will be skipped.`
        : `The Pacific daily write allowance was reached. Resume ${plan.mode} after the quota day resets; unchanged records will be skipped.`;
  }
  if (!paused && (result.documents.remaining !== 0 || result.objects.remaining !== 0)) {
    throw new Error("Upload finished with unverified remaining work.");
  }
  return result;
}

export function plansEqual(left: UploadPlan, right: UploadPlan): boolean {
  const omitTime = (plan: UploadPlan) => ({ ...plan, createdAt: "" });
  return canonicalJson(omitTime(left)) === canonicalJson(omitTime(right));
}
