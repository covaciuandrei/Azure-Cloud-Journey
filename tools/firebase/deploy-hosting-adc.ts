import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { gzipSync } from "node:zlib";
import { applicationDefault } from "firebase-admin/app";
import { z } from "zod";
import { CoursePointerSchema } from "../../src/domain/course.js";
import { OFFLINE_COURSE_MAX_BYTES } from "../../src/domain/offline.js";
import { loadCoursePublication } from "../course/publication.js";
import { isMain, writeData } from "../review/data.js";
import { assertSafeDirectory, childPath, json, regularFiles } from "../web/bank.js";
import { inspectAuthentication } from "./auth-setup.js";
import { projectId } from "./preflight.js";
import {
  buildCleanStoragePlan, checkHostingDeployment, hostingBuildIdentity, validateHostingTree,
} from "../publish/storage-clean.js";
import { acquireUploadLock } from "../publish/quota.js";
import { loadSc900HostingPublication } from "../web/sc900-publication.js";
import {
  boundedHostingValidationResponse, loadApprovedHostingValidation, measureHostingValidationEnvelope,
  reserveHostingValidationRequests,
} from "../publish/hosting-validation-budget.js";

const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const HostingSchema = z.object({
  hosting: z.object({
    site: z.literal("study-az104"), public: z.literal("dist"),
    headers: z.array(z.object({
      source: z.string(), headers: z.array(z.object({ key: z.string(), value: z.string() }).strict()),
    }).strict()),
    rewrites: z.array(z.object({ source: z.string(), destination: z.literal("/index.html") }).strict()),
  }).passthrough(),
}).passthrough();

export async function validateHostingCourse(workspace = process.cwd(), outputDir = "dist") {
  const publication = await loadCoursePublication(workspace);
  await assertSafeDirectory(workspace, outputDir);
  const root = childPath(workspace, outputDir);
  const readBounded = async (path: string, limit: number) => {
    await assertSafeDirectory(root, dirname(path));
    const absolute = childPath(root, path);
    const info = await lstat(absolute);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Unsafe Hosting course file: ${path}`);
    if (info.size > limit) throw new Error(`Hosting course file exceeds its size limit: ${path}`);
    const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const bytes = Buffer.alloc(limit + 1);
      let length = 0;
      while (length < bytes.length) {
        const result = await file.read(bytes, length, bytes.length - length, null);
        if (!result.bytesRead) break;
        length += result.bytesRead;
      }
      if (length > limit) throw new Error(`Hosting course file exceeds its size limit: ${path}`);
      return bytes.subarray(0, length);
    } finally { await file.close(); }
  };
  const pointerBytes = await readBounded("data/course.json", 8000);
  const pointer = CoursePointerSchema.parse(JSON.parse(pointerBytes.toString("utf8")));
  if (!pointerBytes.equals(Buffer.from(json(publication.pointer)))) {
    throw new Error("Hosting course pointer differs from the active approved publication.");
  }
  const courseBytes = await readBounded(pointer.url, OFFLINE_COURSE_MAX_BYTES);
  if (hash(courseBytes) !== pointer.sha256 || !courseBytes.equals(Buffer.from(json(publication.course)))) {
    throw new Error("Hosting course content differs from the active approved publication.");
  }
  return { id: publication.course.id, pointer, digest: hash(Buffer.concat([pointerBytes, courseBytes])) };
}

export type HostingFeature = "accounts" | "offline" | "topics" | "learning" | "eligibility" | "course" | "design" | "journey" | "az104" | "sc900";
export function hostingFeatureDetails(feature: HostingFeature, courseId = "az104") {
  const reportDirectory = feature === "sc900" ? ".data/sc900/rollout" : feature === "az104" ? ".data/full-course/rollout" :
    feature === "journey" ? ".data/journey/rollout" : feature === "design" ? ".data/coursebook/rollout" : feature === "course" ? ".data/course/rollout" :
    feature === "eligibility" ? ".data/eligibility/rollout" : feature === "learning" ? ".data/learning/rollout" :
    feature === "topics" ? ".data/topics" : feature === "offline" ? ".data/offline-rollout" : ".data/auth-rollout";
  const label = feature === "sc900" ? "approved-sc900-exam" : feature === "az104" ? "complete-az104-course" :
    feature === "journey" ? "azure-cloud-journey" : feature === "design" ? "blue-coursebook" : feature === "course" ? `${courseId}-course` : feature === "eligibility" ? "current-question-bank" : feature === "learning" ? "learning-explanations" :
    feature === "topics" ? "topic-filters" : feature === "offline" ? "offline-download" : "accounts-and-firestore";
  const message = feature === "sc900" ? "Approved SC-900 course and scoped question publication with isolated accounts and offline support; all AZ-104 content and saved-session archives retained" :
    feature === "az104" ? "Complete AZ-104 authored course across all five exam domains and 21 modules with offline support; question bank, accounts and grading preserved" :
    feature === "journey" ? "Azure Cloud Journey branding and AZ-104 exam selection; content and progress preserved" :
    feature === "design" ? "Blue Coursebook interface for learning, practice and exams; study content and progress preserved" :
    feature === "course" ? "Authored course with worked examples, interactive tools, checkpoints and offline support" :
    feature === "eligibility" ? "Current-only question bank with historical session compatibility" :
    feature === "learning" ? "Student explanations, documentation-backed answer guidance and versioned grading" :
    feature === "topics" ? "Classified AZ-104 topics and topic-filtered practice, exams and library" :
    feature === "offline" ? "Verified offline download, cached study sessions and reconnect sync" :
    "Google sign-in, personal progress, and selectable Firestore data";
  return { reportDirectory, label, message };
}

export async function deployHostingWithAdc(apply: boolean, feature: HostingFeature = "accounts",
  options: { contentAddressedApprovalPath?: string; measureContentAddressed?: boolean } = {}) {
  const course = await validateHostingCourse();
  const { reportDirectory, label, message } = hostingFeatureDetails(feature, course.id);
  if (feature === "az104" && course.id !== "az104") {
    throw new Error("The --az104 Hosting feature requires the active approved AZ-104 course package (id: az104).");
  }
  if (feature === "sc900" && !(await loadSc900HostingPublication()).active) {
    throw new Error("The --sc900 Hosting feature requires an explicitly approved active SC900 publication.");
  }
  const plan = await buildCleanStoragePlan();
  const local = await validateHostingTree(plan);
  const identity = await hostingBuildIdentity();
  if (apply && options.measureContentAddressed) throw new Error("Measurement alone cannot authorize a content-addressed deployment.");
  const transferEnvelope = options.contentAddressedApprovalPath
    ? (await loadApprovedHostingValidation(options.contentAddressedApprovalPath, identity)).envelope
    : options.measureContentAddressed ? await measureHostingValidationEnvelope(identity) : undefined;
  const configBytes = await readFile("firebase.json");
  const configDigest = hash(configBytes);
  const config = HostingSchema.parse(JSON.parse(configBytes.toString("utf8"))).hosting;
  const entries: Array<{ path: string; hash: string; rawHash: string; compressedBytes: number }> = [];
  const compressed = new Map<string, { hash: string; bytes: number }>();
  for (const path of await regularFiles("dist")) {
    const bytes = await readFile(`dist/${path}`);
    const rawHash = hash(bytes);
    let value = compressed.get(rawHash);
    if (!value) {
      const gzip = gzipSync(bytes, { level: 9 });
      value = { hash: hash(gzip), bytes: gzip.length };
      compressed.set(rawHash, value);
    }
    entries.push({ path: `/${path}`, hash: value.hash, rawHash, compressedBytes: value.bytes });
  }
  const summary = {
    projectId, ...identity, configDigest, files: entries.length, bytes: local.bytes, planDigest: plan.digest,
    courseId: course.id, courseReleaseId: course.pointer.releaseId, courseDigest: course.digest,
    ...(transferEnvelope ? { transferEnvelope: {
      mode: transferEnvelope.mode, envelopeDigest: transferEnvelope.envelopeDigest,
      pathBytes: transferEnvelope.pathBytes, uniqueRawBytes: transferEnvelope.uniqueRawBytes,
      uniqueContents: transferEnvelope.uniqueContents, metadataMarginBytes: transferEnvelope.metadataMarginBytes,
      transferBytes: transferEnvelope.transferBytes,
    } } : {}),
  };
  if (!apply) return { status: "planned", ...summary };
  const unlock = await acquireUploadLock(process.cwd());
  try {
    const auth = await inspectAuthentication();
    if (!auth.google.enabled || !auth.config.authorizedDomains?.includes("study-az104.web.app")) {
      throw new Error("Google sign-in and the Hosting domain must be configured before release.");
    }
    if (auth.firestoreUsage.reads >= 45_000 || auth.firestoreUsage.writes >= 18_000 || auth.firestoreUsage.deletes >= 18_000) {
      throw new Error("Quota pause: the project has reached a conservative daily threshold.");
    }
    await writeData(".data/rollout/hosting-ready.json", {
      schemaVersion: 1, approvedBy: "parent", scope: "hosting", planDigest: plan.digest, ...identity,
    });
    const preflight = await checkHostingDeployment(options.contentAddressedApprovalPath
      ? { contentAddressedApprovalPath: options.contentAddressedApprovalPath } : {});
    const validationGrantId = "validationBudget" in preflight
      ? z.object({ grantId: z.string().regex(/^\d{4}-\d{2}-[a-f0-9]{64}$/) }).parse(preflight.validationBudget).grantId : undefined;
    if (options.contentAddressedApprovalPath && !validationGrantId) throw new Error("Content-addressed validation allocation was not persisted.");
    const assertUnchanged = async () => {
      const current = await hostingBuildIdentity();
      const currentCourse = await validateHostingCourse();
      await loadSc900HostingPublication();
      if (current.distDigest !== identity.distDigest || current.sourceDigest !== identity.sourceDigest ||
          currentCourse.digest !== course.digest ||
          hash(await readFile("firebase.json")) !== configDigest) {
        throw new Error("Build inputs changed during deployment; refusing to release a mixed build.");
      }
    };
    await assertUnchanged();
    const maximumMetadataRequests = 8 + Math.ceil(entries.length / 1000) + Math.ceil((entries.length + 2) / 1000);
    let metadataRequests = 0;
    if (validationGrantId) await reserveHostingValidationRequests(validationGrantId,
      Array.from({ length: maximumMetadataRequests }, () => ({
        kind: "metadata" as const, purpose: "hosting-api" as const, maximumResponseBytes: 1024 * 1024,
      })));
    async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
      if (!path.startsWith(`sites/${projectId}/`)) throw new Error("Unexpected Hosting project path.");
      const maximumResponseBytes = 1024 * 1024;
      if (validationGrantId && ++metadataRequests > maximumMetadataRequests) {
        throw new Error("Hosting metadata validation exceeded its pre-reserved request batch.");
      }
      const { access_token } = await applicationDefault().getAccessToken();
      const response = await fetch(`https://firebasehosting.googleapis.com/v1beta1/${path}`, {
        method, headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json", "x-goog-user-project": projectId },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(60_000), ...(validationGrantId ? { redirect: "error" as const } : {}),
      });
      const result = (validationGrantId ? JSON.parse((await boundedHostingValidationResponse(response, maximumResponseBytes)).toString("utf8"))
        : await response.json()) as T & { error?: { message?: string } };
      if (!response.ok) throw new Error(`Hosting API ${response.status}: ${result.error?.message ?? response.statusText}`);
      return result;
    }
    const baseline = await request<{ releases?: Array<{ name: string }> }>(`sites/${projectId}/releases?pageSize=1`);
    const baselineRelease = baseline.releases?.[0]?.name ?? null;
    const version = await request<{ name: string }>(`sites/${projectId}/versions`, "POST", {
      config: {
        headers: config.headers.map((item) => ({ glob: item.source, headers: Object.fromEntries(item.headers.map(({ key, value }) => [key, value])) })),
        rewrites: config.rewrites.map((item) => ({ glob: item.source, path: item.destination })),
      },
      labels: { feature: label },
    });
    if (!version.name.startsWith(`sites/${projectId}/versions/`)) throw new Error("Unexpected Hosting version identity.");
    await writeData(`${reportDirectory}/hosting-pending.json`, { ...summary, version: version.name, status: "created" });
    const required = new Set<string>();
    let uploadUrl: string | undefined;
    for (let offset = 0; offset < entries.length; offset += 1000) {
      const result = await request<{ uploadRequiredHashes?: string[]; uploadUrl?: string }>(
        `${version.name}:populateFiles`, "POST",
        { files: Object.fromEntries(entries.slice(offset, offset + 1000).map((file) => [file.path, file.hash])) },
      );
      for (const value of result.uploadRequiredHashes ?? []) required.add(value);
      if (result.uploadUrl) {
        const expected = `https://upload-firebasehosting.googleapis.com/upload/${version.name}/files`;
        if (result.uploadUrl !== expected) throw new Error("Unexpected Hosting content-upload destination.");
        uploadUrl = result.uploadUrl;
      }
    }
    const byHash = new Map(entries.map((entry) => [entry.hash, entry]));
    if ([...required].some((value) => !byHash.has(value))) throw new Error("Hosting requested unknown content.");
    if (validationGrantId && required.size) await reserveHostingValidationRequests(validationGrantId,
      Array.from({ length: required.size }, () => ({
        kind: "metadata" as const, purpose: "hosting-api" as const, maximumResponseBytes: 65536,
      })));
    let uploadedBytes = 0;
    for (const value of required) {
      const file = byHash.get(value);
      if (!file || !uploadUrl) throw new Error("Hosting requested unknown content.");
      const bytes = await readFile(`dist${file.path}`);
      const gzip = gzipSync(bytes, { level: 9 });
      if (hash(bytes) !== file.rawHash || hash(gzip) !== value) throw new Error("A file changed after planning.");
      const { access_token } = await applicationDefault().getAccessToken();
      const response = await fetch(`${uploadUrl}/${value}`, {
        method: "POST", headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/octet-stream" },
        body: gzip, signal: AbortSignal.timeout(60_000), ...(validationGrantId ? { redirect: "error" as const } : {}),
      });
      if (validationGrantId) await boundedHostingValidationResponse(response, 65536);
      if (!response.ok) throw new Error(`Hosting content upload failed: HTTP ${response.status}`);
      uploadedBytes += gzip.length;
    }
    await assertUnchanged();
    await request(`${version.name}?updateMask=status`, "PATCH", { status: "FINALIZED" });
    const remote = new Map<string, string>();
    let pageToken = "";
    do {
      const files = await request<{ files?: Array<{ path: string; hash: string }>; nextPageToken?: string }>(
        `${version.name}/files?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`,
      );
      for (const file of files.files ?? []) remote.set(file.path, file.hash);
      pageToken = files.nextPageToken ?? "";
    } while (pageToken);
    for (const file of entries) {
      if (remote.get(file.path) !== file.hash) throw new Error(`Server content hash differs for ${file.path}.`);
      remote.delete(file.path);
    }
    if ([...remote.keys()].some((path) => !["/__/firebase/init.js", "/__/firebase/init.json"].includes(path))) {
      throw new Error("Hosting version contains unexpected files.");
    }
    await assertUnchanged();
    const current = await request<{ releases?: Array<{ name: string }> }>(`sites/${projectId}/releases?pageSize=1`);
    if ((current.releases?.[0]?.name ?? null) !== baselineRelease) throw new Error("Another Hosting release appeared concurrently; it was not overwritten.");
    const release = await request<{ name: string }>(
      `sites/${projectId}/releases?versionName=${encodeURIComponent(version.name)}`, "POST",
      { message },
    );
    const report = {
      status: "released", ...summary, version: version.name, release: release.name,
      url: "https://study-az104.web.app", changedFilesUploaded: required.size, uploadedBytes,
      serverFileHashesMatched: entries.length, authentication: "isolated ADC; no Firebase CLI account-token diagnostics",
      completedAt: new Date().toISOString(),
      ...(validationGrantId ? { validationGrantId } : {}),
    };
    await writeData(`${reportDirectory}/hosting-deployment.json`, report);
    return report;
  } finally { await unlock(); }
}

export function parseHostingDeployArgs(args: string[]) {
  const features: HostingFeature[] = ["accounts", "offline", "topics", "learning", "eligibility", "course", "design", "journey", "az104", "sc900"];
  let feature: HostingFeature = "accounts";
  let selected = false;
  let apply = false;
  const options: { contentAddressedApprovalPath?: string; measureContentAddressed?: boolean } = {};
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!;
    if (seen.has(flag)) throw new Error("Duplicate Hosting deploy flag.");
    seen.add(flag);
    if (flag === "--apply") apply = true;
    else if (flag === "--measure-content-addressed") options.measureContentAddressed = true;
    else if (flag === "--content-addressed-validation") {
      const path = args[++index];
      if (!path || path.startsWith("--")) throw new Error("Explicit parent approval path is required.");
      options.contentAddressedApprovalPath = path;
    } else {
      const match = features.find((item) => flag === `--${item}`);
      if (!match || selected) throw new Error("Choose a single deployment feature.");
      feature = match; selected = true;
    }
  }
  if (options.measureContentAddressed && (apply || options.contentAddressedApprovalPath)) {
    throw new Error("Use measurement only for planning; apply requires a separate exact parent approval.");
  }
  return { apply, feature, options };
}

if (isMain(import.meta.url)) {
  const { apply, feature, options } = parseHostingDeployArgs(process.argv.slice(2));
  console.log(JSON.stringify(await deployHostingWithAdc(apply, feature, options), null, 2));
}
