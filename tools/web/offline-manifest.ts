import { readFile, lstat, rm } from "node:fs/promises";
import { resolve } from "node:path";
import {
  OFFLINE_AVAILABILITY_MAX_BYTES, OFFLINE_MANIFEST_MAX_BYTES, OfflineFileSchema, OfflineManifestSchema,
  Sc900OfflineFileSchema, offlineManifestUrl, parseOfflineManifest, selectOfflineFiles,
  type OfflineFile, type OfflineManifest,
} from "../../src/domain/offline.js";
import { ExamIdSchema, type ExamId } from "../../src/domain/exams.js";
import { Sc900AvailabilitySchema } from "../../src/domain/examAvailability.js";
import { Sc900CoursePointerSchema } from "../../src/domain/course.js";
import { mediaExtension } from "../../src/domain/cleanBank.js";
import { Sc900CatalogSchema, Sc900DiscussionSchema, Sc900DocumentSchema, Sc900ManifestSchema } from "../../src/domain/sc900Bank.js";
import { assertSafeDirectory, childPath, hash, json, regularFiles } from "./bank.js";
import { writeAtomic } from "./export.js";
import { isMain } from "../review/data.js";
import { loadStudyPublication, publicationFileBytes } from "../learning/publication.js";
import { loadCoursePublication } from "../course/publication.js";
import { loadSc900HostingPublication } from "./sc900-publication.js";

type FileProperties = Omit<OfflineFile, "url" | "bytes" | "sha256">;

async function readBoundedFile(path: string, maximum = OFFLINE_MANIFEST_MAX_BYTES): Promise<Buffer> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > maximum) {
    throw new Error(`Unsafe or oversized offline file: ${path}`);
  }
  const bytes = await readFile(path);
  if (bytes.length > maximum) throw new Error(`Offline file exceeds its size limit: ${path}`);
  return bytes;
}

async function createFileList(workspace: string, outputDir: string, examId: ExamId) {
  const root = childPath(workspace, outputDir);
  await assertSafeDirectory(workspace, outputDir);
  const names = new Set(await regularFiles(root));
  const files: OfflineFile[] = [];
  const schema = examId === "sc900" ? Sc900OfflineFileSchema : OfflineFileSchema;
  const add = async (path: string, properties: FileProperties, expected?: Buffer) => {
    if (!names.has(path)) throw new Error(`Missing offline file: ${path}`);
    const absolute = resolve(root, path);
    const info = await lstat(absolute);
    const declaredHash = properties.kind === "image" ? /\/([a-f0-9]{64})\.(png|jpg|gif|webp)$/.exec(path)?.[1] : undefined;
    schema.parse({ url: `/${path}`, bytes: info.size, sha256: declaredHash ?? "0".repeat(64), ...properties });
    const bytes = await readBoundedFile(absolute, Math.min(info.size, 16 * 1024 * 1024));
    if (expected && !bytes.equals(expected)) throw new Error(`Offline file differs from the active approved publication: ${path}`);
    files.push(schema.parse({ url: `/${path}`, sha256: hash(bytes), bytes: bytes.length, ...properties }));
  };
  const index = (await readBoundedFile(resolve(root, "index.html"))).toString("utf8");
  const assets = [...new Set([...index.matchAll(/(?:src|href)=["']\/(assets\/[^"']+)["']/g)].map((match) => match[1]!))];
  for (const path of ["index.html", "favicon.svg", "offline-worker.js", ...assets]) await add(path, { kind: "shell" });
  return { root, files, add };
}

async function buildSc900OfflineManifest(workspace: string, outputDir: string): Promise<OfflineManifest> {
  const publication = await loadSc900HostingPublication(workspace);
  if (!publication.active) throw new Error("SC-900 offline packaging requires an explicitly selected approved publication.");
  if (publication.files.size > 10000) throw new Error("SC-900 offline publication contains too many files.");
  const approved = new Map<string, Buffer>();
  let totalBytes = 0;
  for (const [path, file] of publication.files) {
    const bytes = await publicationFileBytes(file);
    totalBytes += bytes.length;
    if (totalBytes > 256 * 1024 * 1024) throw new Error("SC-900 offline publication exceeds the total byte limit.");
    approved.set(path, bytes);
  }
  const approvedJson = (path: string, maximum = OFFLINE_MANIFEST_MAX_BYTES): unknown => {
    const bytes = approved.get(path);
    if (!bytes) throw new Error(`Missing approved SC-900 offline file: ${path}`);
    if (bytes.length > maximum) throw new Error(`Approved SC-900 offline metadata exceeds its size limit: ${path}`);
    return JSON.parse(bytes.toString("utf8"));
  };
  const manifest = Sc900ManifestSchema.parse(approvedJson("exams/sc900/manifest.json"));
  const pointer = Sc900CoursePointerSchema.parse(approvedJson("exams/sc900/course/current.json"));
  const availability = Sc900AvailabilitySchema.parse(approvedJson("exams/sc900/availability.json", OFFLINE_AVAILABILITY_MAX_BYTES));
  if (!availability.activated || availability.kind !== "approved-source" ||
      !pointer.active || availability.bankReleaseId !== manifest.releaseId || availability.courseReleaseId !== pointer.releaseId ||
      availability.sourceCaptureDigest !== manifest.captureLedgerDigest) {
    throw new Error("SC-900 offline availability does not activate this exact approved bank, capture, and course.");
  }
  const { files, add } = await createFileList(workspace, outputDir, "sc900");
  const contentRoot = `exams/sc900/content/${manifest.releaseId}/`;
  const catalog = Sc900CatalogSchema.parse(approvedJson(`${contentRoot}catalog.json`));
  if (catalog.releaseId !== manifest.releaseId || catalog.sourceRevision !== manifest.sourceRevision ||
      JSON.stringify(catalog.counts) !== JSON.stringify(manifest.counts)) {
    throw new Error("SC-900 offline catalog differs from the approved manifest.");
  }
  const imageOwners = new Map<string, Set<string>>();
  for (const [path] of approved) {
    if (!/^exams\/sc900\/content\/r_[a-f0-9]{64}\/questions\/q_[a-f0-9]{64}\.json$/.test(path)) continue;
    const document = Sc900DocumentSchema.parse(approvedJson(path));
    for (const media of document.question.media) {
      const ids = imageOwners.get(media.id) ?? new Set<string>();
      ids.add(document.question.id);
      imageOwners.set(media.id, ids);
    }
  }
  const images = new Set<string>();
  for (const [path, bytes] of approved) {
    let properties: FileProperties = { kind: "data" };
    const content = /^exams\/sc900\/content\/(r_[a-f0-9]{64})\/(.+)$/.exec(path);
    if (/^exams\/sc900\/course\/releases\/c_[a-f0-9]{64}\/sc900\.json$/.test(path) && path !== pointer.url) continue;
    if (content) {
      const releaseId = content[1]!;
      const leaf = content[2]!;
      const question = /^(questions|discussions|learning\/questions)\/(q_[a-f0-9]{64})\.json$/.exec(leaf);
      if (question) {
        const part = question[1] === "questions" ? "question" : question[1] === "discussions" ? "discussion" : "explanation";
        properties = { kind: "data", releaseId, questionId: question[2]!, part };
        if (part === "discussion") {
          const discussion = Sc900DiscussionSchema.parse(approvedJson(path));
          const owner = releaseId === manifest.releaseId ? catalog :
            Sc900CatalogSchema.parse(approvedJson(`exams/sc900/content/${releaseId}/catalog.json`));
          if (discussion.releaseId !== releaseId || discussion.questionId !== question[2] ||
              discussion.comments.length !== owner.questions.find((item) => item.id === question[2])?.commentCount) {
            throw new Error("SC-900 offline discussion differs from the approved catalog.");
          }
          if (!discussion.comments.length) continue;
          properties.commentCount = discussion.comments.length;
        }
      } else if (/^media\/[a-f0-9]{64}\.(png|jpg|gif|webp)$/.test(leaf)) {
        const sha256 = hash(bytes);
        if (images.has(sha256)) continue;
        images.add(sha256);
        const owners = imageOwners.get(sha256);
        if (!owners?.size) throw new Error("An approved SC-900 offline image has no question owner.");
        properties = { kind: "image", releaseId, questionIds: [...owners].sort() };
      } else {
        const part = leaf === "catalog.json" ? "catalog" : leaf === "topics.json" ? "topics" :
          leaf === "eligibility.json" ? "eligibility" : leaf === "learning/manifest.json" ? "learning-manifest" : null;
        if (!part) throw new Error(`Unapproved SC-900 offline path: ${path}`);
        properties = { kind: "data", releaseId, part };
      }
    }
    await add(path, properties, bytes);
  }
  files.sort((a, b) => a.url.localeCompare(b.url));
  const value = {
    schemaVersion: 1 as const, examId: "sc900" as const, releaseId: manifest.releaseId,
    learningReleaseId: manifest.releaseId,
    counts: { questions: catalog.counts.questions, comments: catalog.counts.comments, images: images.size }, files,
  };
  return parseOfflineManifest({ ...value, buildId: hash(JSON.stringify(value)) }, "sc900");
}

export async function buildOfflineManifest(workspace = process.cwd(), outputDir = "dist", examId: ExamId = "az104"): Promise<OfflineManifest> {
  ExamIdSchema.parse(examId);
  if (examId === "sc900") return buildSc900OfflineManifest(workspace, outputDir);
  const bank = await loadStudyPublication(workspace);
  const course = await loadCoursePublication(workspace);
  if (!bank.eligibility) throw new Error("The offline package requires the reviewed current question bank.");
  const { files, add } = await createFileList(workspace, outputDir, "az104");
  await add("data/manifest.json", { kind: "data" });
  await add("data/topics.json", { kind: "data" });
  await add("data/learning.json", { kind: "data" });
  if (bank.eligibility) await add("data/eligibility.json", { kind: "data" });
  for (const [path, value] of course.files) await add(path, { kind: "data" }, Buffer.from(json(value)));
  for (const release of bank.releases) {
    const releaseId = release.catalog.releaseId;
    await add(`content/${releaseId}/catalog.json`, { kind: "data", releaseId, part: "catalog" });
    for (const document of release.documents) {
      const questionId = document.question.id;
      await add(`content/${releaseId}/questions/${questionId}.json`, { kind: "data", releaseId, questionId, part: "question" });
      if (document.question.commentCount) {
        await add(`content/${releaseId}/discussions/${questionId}.json`, {
          kind: "data", releaseId, questionId, part: "discussion", commentCount: document.question.commentCount,
        });
      }
    }
  }
  for (const path of bank.files.keys()) {
    const match = /^teaching\/(r_[a-f0-9]{64})\/questions\/(q_[a-f0-9]{64})\.json$/.exec(path);
    if (match) await add(path, { kind: "data", releaseId: match[1]!, questionId: match[2]!, part: "explanation" });
  }
  const current = bank.releases.find((release) => release.catalog.releaseId === bank.manifest.releaseId)!;
  const media = new Map(bank.releases.flatMap((release) =>
    release.documents.flatMap((document) => document.question.media)).map((file) => [file.id, file]));
  const owners = new Map<string, Set<string>>();
  for (const release of bank.releases) {
    for (const document of release.documents) {
      for (const file of document.question.media) {
        const ids = owners.get(file.id) ?? new Set<string>();
        ids.add(document.question.id);
        owners.set(file.id, ids);
      }
    }
  }
  for (const file of media.values()) {
    await add(`content/${bank.manifest.releaseId}/media/${file.id}.${mediaExtension(file.contentType)}`, {
      kind: "image", releaseId: bank.manifest.releaseId, questionIds: [...owners.get(file.id)!].sort(),
    });
  }
  files.sort((a, b) => a.url.localeCompare(b.url));
  const value = {
    schemaVersion: 1 as const, releaseId: bank.manifest.releaseId, learningReleaseId: bank.learning.releaseId,
    counts: { questions: current.catalog.counts.questions, comments: current.catalog.counts.comments, images: media.size }, files,
  };
  return OfflineManifestSchema.parse({ ...value, buildId: hash(JSON.stringify(value)) });
}

export async function exportOfflineManifest(workspace = process.cwd(), outputDir = "dist", examId: ExamId = "az104") {
  const manifest = await buildOfflineManifest(workspace, outputDir, examId);
  const bytes = Buffer.from(json(manifest));
  if (bytes.length > OFFLINE_MANIFEST_MAX_BYTES) throw new Error("Offline download manifest exceeds the size limit.");
  await writeAtomic(resolve(childPath(workspace, outputDir), offlineManifestUrl(examId).slice(1)), bytes);
  return manifest;
}

export async function selectedOfflineExamIds(workspace = process.cwd()): Promise<ExamId[]> {
  return (await loadSc900HostingPublication(workspace)).active ? ["az104", "sc900"] : ["az104"];
}

export async function exportSelectedOfflineManifests(workspace = process.cwd(), outputDir = "dist"): Promise<OfflineManifest[]> {
  const examIds = await selectedOfflineExamIds(workspace);
  const manifests: OfflineManifest[] = [];
  for (const examId of examIds) manifests.push(await exportOfflineManifest(workspace, outputDir, examId));
  if (!examIds.includes("sc900")) {
    await assertSafeDirectory(workspace, `${outputDir}/exams/sc900`);
    await rm(resolve(childPath(workspace, outputDir), offlineManifestUrl("sc900").slice(1)), { force: true });
  }
  return manifests;
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  let examId: ExamId | undefined;
  if (args[0] === "--exam") { examId = ExamIdSchema.parse(args[1]); args.splice(0, 2); }
  if (args.length > 1 || args[0]?.startsWith("--")) throw new Error("Usage: offline-manifest.ts [--exam az104|sc900] [output-directory]");
  const manifests = examId === undefined
    ? await exportSelectedOfflineManifests(process.cwd(), args[0] ?? "dist")
    : [await exportOfflineManifest(process.cwd(), args[0] ?? "dist", examId)];
  const summaries = manifests.map((manifest) => {
    const current = selectOfflineFiles(manifest);
    return { buildId: manifest.buildId, files: current.length, bytes: current.reduce((sum, file) => sum + file.bytes, 0) };
  });
  console.log(JSON.stringify(manifests.length === 1 ? summaries[0] :
    summaries.map((summary, index) => ({ examId: manifests[index]!.examId ?? "az104", ...summary })), null, 2));
}
