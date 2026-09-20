import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { applicationDefault } from "firebase-admin/app";
import { z } from "zod";
import { isMain, writeData } from "../review/data.js";
import { regularFiles } from "../web/bank.js";
import { inspectAuthentication } from "./auth-setup.js";
import { projectId } from "./preflight.js";
import {
  buildCleanStoragePlan, checkHostingDeployment, hostingBuildIdentity, validateHostingTree,
} from "../publish/storage-clean.js";
import { acquireUploadLock } from "../publish/quota.js";

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

export async function deployHostingWithAdc(apply: boolean, feature: "accounts" | "offline" | "topics" | "learning" | "eligibility" | "course" | "design" | "journey" = "accounts") {
  const reportDirectory = feature === "journey" ? ".data/journey/rollout" : feature === "design" ? ".data/coursebook/rollout" : feature === "course" ? ".data/course/rollout" :
    feature === "eligibility" ? ".data/eligibility/rollout" : feature === "learning" ? ".data/learning/rollout" :
    feature === "topics" ? ".data/topics" : feature === "offline" ? ".data/offline-rollout" : ".data/auth-rollout";
  const plan = await buildCleanStoragePlan();
  const local = await validateHostingTree(plan);
  const identity = await hostingBuildIdentity();
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
  const summary = { projectId, ...identity, configDigest, files: entries.length, bytes: local.bytes, planDigest: plan.digest };
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
    await checkHostingDeployment();
    const assertUnchanged = async () => {
      const current = await hostingBuildIdentity();
      if (current.distDigest !== identity.distDigest || current.sourceDigest !== identity.sourceDigest ||
          hash(await readFile("firebase.json")) !== configDigest) {
        throw new Error("Build inputs changed during deployment; refusing to release a mixed build.");
      }
    };
    await assertUnchanged();
    async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
      if (!path.startsWith(`sites/${projectId}/`)) throw new Error("Unexpected Hosting project path.");
      const { access_token } = await applicationDefault().getAccessToken();
      const response = await fetch(`https://firebasehosting.googleapis.com/v1beta1/${path}`, {
        method, headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json", "x-goog-user-project": projectId },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(60_000),
      });
      const result = await response.json() as T & { error?: { message?: string } };
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
      labels: { feature: feature === "journey" ? "azure-cloud-journey" : feature === "design" ? "blue-coursebook" : feature === "course" ? "networking-course" : feature === "eligibility" ? "current-question-bank" : feature === "learning" ? "learning-explanations" :
        feature === "topics" ? "topic-filters" : feature === "offline" ? "offline-download" : "accounts-and-firestore" },
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
        body: gzip, signal: AbortSignal.timeout(60_000),
      });
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
      { message: feature === "journey" ? "Azure Cloud Journey branding and AZ-104 exam selection; content and progress preserved" :
        feature === "design" ? "Blue Coursebook interface for learning, practice and exams; study content and progress preserved" :
        feature === "course" ? "Networking learning pilot with worked examples, interactive tools, checkpoints and offline support" :
        feature === "eligibility" ? "Current-only question bank with historical session compatibility" :
        feature === "learning" ? "Student explanations, documentation-backed answer guidance and versioned grading" :
        feature === "topics" ? "Classified AZ-104 topics and topic-filtered practice, exams and library" :
        feature === "offline" ? "Verified offline download, cached study sessions and reconnect sync" :
        "Google sign-in, personal progress, and selectable Firestore data" },
    );
    const report = {
      status: "released", ...summary, version: version.name, release: release.name,
      url: "https://study-az104.web.app", changedFilesUploaded: required.size, uploadedBytes,
      serverFileHashesMatched: entries.length, authentication: "isolated ADC; no Firebase CLI account-token diagnostics",
      completedAt: new Date().toISOString(),
    };
    await writeData(`${reportDirectory}/hosting-deployment.json`, report);
    return report;
  } finally { await unlock(); }
}

if (isMain(import.meta.url)) {
  if (process.argv.slice(2).some((arg) => !["--apply", "--offline", "--topics", "--learning", "--eligibility", "--course", "--design", "--journey"].includes(arg))) throw new Error("Usage: deploy-hosting-adc.ts [--apply] [--offline | --topics | --learning | --eligibility | --course | --design | --journey]");
  if (["--offline", "--topics", "--learning", "--eligibility", "--course", "--design", "--journey"].filter((flag) => process.argv.includes(flag)).length > 1) throw new Error("Choose a single deployment feature.");
  console.log(JSON.stringify(await deployHostingWithAdc(process.argv.includes("--apply"),
    process.argv.includes("--journey") ? "journey" : process.argv.includes("--design") ? "design" : process.argv.includes("--course") ? "course" : process.argv.includes("--eligibility") ? "eligibility" : process.argv.includes("--learning") ? "learning" : process.argv.includes("--topics") ? "topics" :
      process.argv.includes("--offline") ? "offline" : "accounts"), null, 2));
}
