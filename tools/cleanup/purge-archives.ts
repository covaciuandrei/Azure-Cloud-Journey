import { lstat, readFile, readdir, rmdir, unlink } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { sha256 } from "../ingest/normalize-shared.js";
import { isMain, writeData } from "../review/data.js";

const sourceDirectories = [
  ".data/raw", ".data/normalized", ".data/prepared", ".data/reviews",
  ".data/curation", ".data/conversions", ".data/review-work",
  ".data/review-validation", ".data/deduplication",
];
const sourceFiles = [
  ".data/comment-quality-review-samples.json", ".data/review-application-report.json",
  ".data/app-overview-desktop.png", ".data/app-review-mobile.png",
  ".data/compact-session-text.png", ".data/image-question-157-wide.png",
  ".data/image-session-157-wide.png", ".data/landing-page-desktop.png",
  ".data/plain-ui-desktop.png", ".data/plain-ui-mobile.png",
  ".data/plain-ui-question-369.png", ".data/text-question-explanation-split.png",
  ".data/three-pane-image-question.png", "firestore-debug.log",
];
const sessionFiles = process.env.AZ104_ARCHIVE_SESSION_FILES;
if (sessionFiles && (!isAbsolute(sessionFiles) ||
    !/^[a-f0-9-]{36}\/files$/.test(relative(resolve(homedir(), ".copilot/session-state"), resolve(sessionFiles)).split(sep).join("/")))) {
  throw new Error("Optional archive cleanup must name one explicit Copilot session files directory.");
}
const captureCopies = sessionFiles ? [`${sessionFiles}/pilot-discussion-1.json`] : [];
const captureCaches = sessionFiles ? [
  `${sessionFiles}/examprepper-browser/Default/Cache`,
  `${sessionFiles}/examprepper-browser/Default/Code Cache`,
  `${sessionFiles}/examprepper-browser/Default/Service Worker/CacheStorage`,
] : [];
interface PurgeFile { path: string; sha256: string; bytes: number }
interface PurgePlan { files: PurgeFile[]; directories: string[]; createdAt: string }
const planPath = ".data/rollout/local-purge-plan.json";

function allowed(path: string) {
  const local = relative(process.cwd(), path).split(sep).join("/");
  return sourceFiles.includes(local) ||
    sourceDirectories.some((prefix) => local === prefix || local.startsWith(`${prefix}/`)) ||
    /^\.playwright-mcp\/(?:page-[^/]+\.yml|console-[^/]+\.log)$/.test(local) ||
    captureCopies.includes(path) ||
    captureCaches.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

async function exists(path: string) {
  try { return await lstat(path); }
  catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function safeParents(path: string) {
  for (let parent = path; parent !== dirname(parent); parent = dirname(parent)) {
    const stat = await exists(parent);
    if (stat?.isSymbolicLink()) throw new Error(`Refusing to follow symlink: ${parent}`);
  }
}

export async function planArchivePurge(): Promise<PurgePlan> {
  const plan: PurgePlan = { files: [], directories: [], createdAt: new Date().toISOString() };
  async function visit(path: string) {
    if (!allowed(path)) throw new Error(`Unapproved deletion scope: ${path}`);
    await safeParents(path);
    const stat = await exists(path);
    if (!stat) return;
    if (stat.isDirectory()) {
      plan.directories.push(path);
      for (const name of await readdir(path)) await visit(resolve(path, name));
    } else if (stat.isFile()) {
      const bytes = await readFile(path);
      plan.files.push({ path, sha256: sha256(bytes), bytes: bytes.length });
    } else throw new Error(`Not a regular dataset artifact: ${path}`);
  }
  for (const path of [...sourceDirectories, ...sourceFiles, ...captureCopies, ...captureCaches]) await visit(resolve(path));
  if (await exists(".playwright-mcp")) {
    for (const filename of await readdir(".playwright-mcp")) {
      const path = resolve(".playwright-mcp", filename);
      if (allowed(path)) await visit(path);
    }
  }
  await writeData(planPath, plan);
  return plan;
}

export async function purgeArchives() {
  const manifest = JSON.parse(await readFile(".data/clean-bank/data/manifest.json", "utf8")) as {
    counts: { questions: number; comments: number; images: number };
  };
  if (manifest.counts.questions !== 604 || manifest.counts.comments !== 7994 || manifest.counts.images !== 784) {
    throw new Error("A complete verified clean bank is required before deleting source archives.");
  }
  const plan = JSON.parse(await readFile(planPath, "utf8")) as PurgePlan;
  for (const item of plan.files) {
    if (!allowed(item.path)) throw new Error(`Unapproved deletion scope: ${item.path}`);
    await safeParents(item.path);
    if (!(await exists(item.path))) continue;
    if (sha256(await readFile(item.path)) !== item.sha256) {
      throw new Error(`Artifact changed after planning: ${item.path}`);
    }
  }
  let deleted = 0;
  for (const item of plan.files) {
    if (await exists(item.path)) {
      await safeParents(item.path);
      if (sha256(await readFile(item.path)) !== item.sha256) throw new Error(`Artifact changed before deletion: ${item.path}`);
      await unlink(item.path);
      deleted++;
    }
  }
  for (const path of [...plan.directories].sort((a, b) => b.length - a.length)) {
    if (!allowed(path)) throw new Error(`Unapproved directory cleanup: ${path}`);
    if (await exists(path)) await rmdir(path);
  }
  for (const item of plan.files) {
    if (await exists(item.path)) throw new Error(`Artifact survived purge: ${item.path}`);
  }
  const report = {
    completedAt: new Date().toISOString(), filesDeletedThisRun: deleted,
    filesAbsent: plan.files.length, bytesRemoved: plan.files.reduce((sum, item) => sum + item.bytes, 0),
    preserved: ["604 practice questions", "606 source identities in compatible versions", "7994 approved comments",
      "784 original images", "learner localStorage", "Firebase credentials and tooling"],
    scope: "Application-controlled dataset archives, diagnostic captures and dedicated source-browser caches.",
    exclusions: "No erasure claim for external chat history, provider recovery systems, user attachments or OS backups.",
  };
  await writeData(".data/rollout/local-purge-report.json", report);
  return report;
}

if (isMain(import.meta.url)) {
  const command = process.argv[2];
  if (command === "plan") {
    const plan = await planArchivePurge();
    console.log(JSON.stringify({ files: plan.files.length, directories: plan.directories.length,
      bytes: plan.files.reduce((sum, item) => sum + item.bytes, 0) }, null, 2));
  } else if (command === "apply") {
    console.log(JSON.stringify(await purgeArchives(), null, 2));
  } else throw new Error("Usage: purge-archives.ts plan | apply");
}
