import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm, statfs, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { CoursePointerSchema, CourseSchema } from "../../src/domain/course.js";
import { MAX_COURSE_BYTES } from "../../src/domain/courseCatalog.js";
import { Sc900ApprovalReceiptSchema, type Sc900FinalReview } from "../../src/domain/sc900Publication.js";
import { SC900_INACTIVE, Sc900AvailabilitySchema } from "../../src/domain/examAvailability.js";
import { Sha256Schema } from "../../src/domain/schemas.js";
import { loadCoursePublication } from "../course/publication.js";
import type { PublicationFile } from "../learning/publication.js";
import { byteSha256, sc900Hash } from "../sc900/canonical.js";
import {
  loadSc900Publication, stageSc900Publication, writeSc900FinalApproval, SC900_EXPORT_LIMITS, type Sc900StaticPlan,
} from "../sc900/publication.js";
import { assertSafeDirectory, childPath, json } from "./bank.js";
import { acquireUploadLock } from "../publish/quota.js";

const selectionPath = ".data/sc900-publication/hosting.json";
const releaseBinding = z.object({
  releaseId: z.string().regex(/^r_[a-f0-9]{64}$/),
  receiptSha256: Sha256Schema, inventorySha256: Sha256Schema,
  finalApprovalPath: z.string().regex(/^\.data\/sc900-publication\/approvals\/r_[a-f0-9]{64}\/[a-f0-9]{64}-[a-f0-9]{64}\.json$/),
  finalApprovalSha256: Sha256Schema,
}).strict();
const courseBinding = z.object({
  releaseId: z.string().regex(/^c_[a-f0-9]{64}$/), sha256: Sha256Schema,
}).strict();
const selectionSchema = z.object({
  schemaVersion: z.literal(1), examId: z.literal("sc900"),
  activeReleaseId: releaseBinding.shape.releaseId,
  activeCourseReleaseId: courseBinding.shape.releaseId,
  releases: z.array(releaseBinding).min(1).max(100),
  courses: z.array(courseBinding).min(1).max(100),
}).strict().refine((value) =>
  new Set(value.releases.map((item) => item.releaseId)).size === value.releases.length &&
  new Set(value.courses.map((item) => item.releaseId)).size === value.courses.length &&
  value.releases.some((item) => item.releaseId === value.activeReleaseId) &&
  value.courses.some((item) => item.releaseId === value.activeCourseReleaseId),
"SC900 Hosting selection must name unique approved releases and its active course");
async function readBounded(workspace: string, path: string, maximum: number): Promise<Buffer> {
  await assertSafeDirectory(workspace, dirname(path));
  const absolute = childPath(workspace, path);
  const info = await lstat(absolute);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > maximum) {
    throw new Error(`Unsafe or oversized SC900 publication file: ${path}`);
  }
  const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const bytes = Buffer.alloc(maximum + 1);
    let count = 0;
    while (count < bytes.length) {
      const next = await file.read(bytes, count, bytes.length - count, null);
      if (!next.bytesRead) break;
      count += next.bytesRead;
    }
    if (count > maximum) throw new Error(`SC900 publication file grew beyond its bound: ${path}`);
    return bytes.subarray(0, count);
  } finally { await file.close(); }
}

async function readSelection(workspace: string) {
  try { return selectionSchema.parse(JSON.parse((await readBounded(workspace, selectionPath, MAX_COURSE_BYTES)).toString("utf8"))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Revalidates staged approved bytes, including archived releases. It never contacts cloud services. */
export async function loadSc900HostingPublication(workspace = process.cwd()) {
  const selection = await readSelection(workspace);
  return validateSelection(workspace, selection);
}

async function validateSelection(workspace: string, selection: z.infer<typeof selectionSchema> | null) {
  const files = new Map<string, PublicationFile>();
  if (!selection) {
    files.set("exams/sc900/availability.json", { kind: "json", value: SC900_INACTIVE });
    return { active: false as const, files, receipt: null };
  }
  let activeReceipt: z.infer<typeof Sc900ApprovalReceiptSchema> | null = null;
  for (const binding of selection.releases) {
    const root = `.data/sc900-publication/${binding.releaseId}`;
    const receiptBytes = await readBounded(workspace, `${root}/approval-receipt.json`, MAX_COURSE_BYTES);
    const inventoryBytes = await readBounded(workspace, `${root}/inventory.json`, MAX_COURSE_BYTES);
    const finalBytes = await readBounded(workspace, binding.finalApprovalPath, MAX_COURSE_BYTES);
    if (byteSha256(receiptBytes) !== binding.receiptSha256 || byteSha256(inventoryBytes) !== binding.inventorySha256 ||
        byteSha256(finalBytes) !== binding.finalApprovalSha256) {
      throw new Error("SC900 approved stage metadata changed after selection.");
    }
    const publication = await loadSc900Publication(workspace, { approvalPath: binding.finalApprovalPath });
    const receipt = publication.receipt;
    if (!receipt.activate || !receipt.finalReview || receipt.releaseId !== binding.releaseId ||
        binding.finalApprovalPath !== `.data/sc900-publication/approvals/${binding.releaseId}/${receipt.planDigest}-${sc900Hash("activation-receipt", receipt)}.json`) {
      throw new Error("SC900 Hosting requires an exact, complete, independently approved stage.");
    }
    for (const [path, file] of publication.files) {
      if (path === "exams/sc900/availability.json" ||
          path === "exams/sc900/manifest.json" && binding.releaseId !== selection.activeReleaseId) continue;
      files.set(path, file);
    }
    if (binding.releaseId === selection.activeReleaseId) {
      if (publication.eligibility.activeCounts.questions < 40) throw new Error("SC900 active bank cannot support its approved mock format.");
      activeReceipt = receipt;
    }
  }
  const currentCourse = await loadCoursePublication(workspace, "sc900", { activate: true });
  if (currentCourse.course.releaseId !== selection.activeCourseReleaseId) {
    throw new Error("SC900 authored course changed after Hosting selection.");
  }
  for (const binding of selection.courses) {
    const source = `.data/sc900-publication/courses/${binding.releaseId}.json`;
    const bytes = await readBounded(workspace, source, MAX_COURSE_BYTES);
    const course = CourseSchema.parse(JSON.parse(bytes.toString("utf8")));
    if (course.id !== "sc900" || course.releaseId !== binding.releaseId || byteSha256(bytes) !== binding.sha256) {
      throw new Error("Archived SC900 course hash or identity changed.");
    }
    if (binding.releaseId === selection.activeCourseReleaseId && binding.sha256 !== currentCourse.pointer.sha256) {
      throw new Error("SC900 course differs from its exact independent approval.");
    }
    files.set(`exams/sc900/course/releases/${binding.releaseId}/sc900.json`,
      { kind: "source", path: resolve(workspace, source) });
  }
  if (!activeReceipt?.finalReview) throw new Error("SC900 active bank approval is missing.");
  files.set("exams/sc900/course/current.json", { kind: "json", value: CoursePointerSchema.parse(currentCourse.pointer) });
  files.set("exams/sc900/availability.json", { kind: "json", value: Sc900AvailabilitySchema.parse({
    schemaVersion: 1, examId: "sc900", activated: true, kind: "approved-source",
    bankReleaseId: selection.activeReleaseId, courseReleaseId: selection.activeCourseReleaseId,
    sourceCaptureDigest: activeReceipt.captureLedgerDigest,
    approvedBy: activeReceipt.finalReview.reviewer, approvedAt: activeReceipt.finalReview.reviewedAt,
  }) });
  return { active: true as const, files, receipt: activeReceipt };
}

/** Parent-only local selection API. Stages first and atomically changes the selected bundle last. */
export async function selectSc900HostingPublication(
  plan: Sc900StaticPlan, finalReview: Sc900FinalReview, workspace = process.cwd(),
) {
  const unlock = await acquireUploadLock(workspace);
  try { return await selectPublicationLocked(plan, finalReview, workspace); }
  finally { await unlock(); }
}

async function selectPublicationLocked(plan: Sc900StaticPlan, finalReview: Sc900FinalReview, workspace: string) {
  if (plan.release.eligibility.activeCounts.questions < 40) {
    throw new Error("SC900 activation requires enough approved active questions for its 40-question mock.");
  }
  const disk = await statfs(workspace);
  if (disk.bavail * disk.bsize < SC900_EXPORT_LIMITS.minimumFreeBytes + plan.totalBytes + MAX_COURSE_BYTES) {
    throw new Error("SC900 selection stopped: preserve at least 2.5 GiB free.");
  }
  const previous = await readSelection(workspace);
  const stageReceipt = `.data/sc900-publication/${plan.release.manifest.releaseId}/approval-receipt.json`;
  try { await readBounded(workspace, stageReceipt, MAX_COURSE_BYTES); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await stageSc900Publication(plan, { workspaceRoot: workspace });
  }
  const final = await writeSc900FinalApproval(plan, finalReview, workspace);
  const course = await loadCoursePublication(workspace, "sc900", { activate: true });
  const coursePath = `.data/sc900-publication/courses/${course.course.releaseId}.json`;
  await assertSafeDirectory(workspace, dirname(coursePath));
  await mkdir(childPath(workspace, dirname(coursePath)), { recursive: true });
  const bytes = Buffer.from(json(course.course));
  try { await writeFile(childPath(workspace, coursePath), bytes, { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (!(await readBounded(workspace, coursePath, MAX_COURSE_BYTES)).equals(bytes)) throw new Error("Immutable SC900 course already has different bytes.");
  }
  const releaseId = plan.release.manifest.releaseId;
  const root = `.data/sc900-publication/${releaseId}`;
  const release = { releaseId,
    receiptSha256: byteSha256(await readBounded(workspace, `${root}/approval-receipt.json`, MAX_COURSE_BYTES)),
    inventorySha256: byteSha256(await readBounded(workspace, `${root}/inventory.json`, MAX_COURSE_BYTES)),
    finalApprovalPath: relative(resolve(workspace), final.path).split(sep).join("/"),
    finalApprovalSha256: byteSha256(await readBounded(workspace,
      relative(resolve(workspace), final.path).split(sep).join("/"), MAX_COURSE_BYTES)) };
  const selection = selectionSchema.parse({
    schemaVersion: 1, examId: "sc900", activeReleaseId: releaseId, activeCourseReleaseId: course.course.releaseId,
    releases: [...(previous?.releases ?? []).filter((item) => item.releaseId !== releaseId), release],
    courses: [...(previous?.courses ?? []).filter((item) => item.releaseId !== course.course.releaseId),
      { releaseId: course.course.releaseId, sha256: byteSha256(bytes) }],
  });
  const target = childPath(workspace, selectionPath);
  const temporary = `${target}.${randomUUID()}.pending`;
  const publication = await validateSelection(workspace, selection);
  try {
    await writeFile(temporary, json(selection), { flag: "wx", mode: 0o600 });
    await rename(temporary, target);
  } finally { await rm(temporary, { force: true }); }
  return publication;
}
