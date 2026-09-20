import { readFile, lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { OFFLINE_COURSE_MAX_BYTES, OfflineManifestSchema, selectOfflineFiles, type OfflineFile, type OfflineManifest } from "../../src/domain/offline.js";
import { mediaExtension } from "../../src/domain/cleanBank.js";
import { assertSafeDirectory, childPath, hash, json, regularFiles } from "./bank.js";
import { writeAtomic } from "./export.js";
import { isMain } from "../review/data.js";
import { loadStudyPublication } from "../learning/publication.js";
import { loadCoursePublication } from "../course/publication.js";

export async function buildOfflineManifest(workspace = process.cwd(), outputDir = "dist"): Promise<OfflineManifest> {
  const root = childPath(workspace, outputDir);
  await assertSafeDirectory(workspace, outputDir);
  const bank = await loadStudyPublication(workspace);
  const course = await loadCoursePublication(workspace);
  if (!bank.eligibility) throw new Error("The offline package requires the reviewed current question bank.");
  const names = new Set(await regularFiles(root));
  const files: OfflineFile[] = [];
  const add = async (path: string, properties: Omit<OfflineFile, "url" | "bytes" | "sha256">, expected?: Buffer) => {
    if (!names.has(path)) throw new Error(`Missing offline file: ${path}`);
    const absolute = resolve(root, path);
    const info = await lstat(absolute);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Unsafe offline file: ${path}`);
    if (expected && info.size > OFFLINE_COURSE_MAX_BYTES) throw new Error(`Offline course exceeds the 4 MiB size limit: ${path}`);
    const bytes = await readFile(absolute);
    if (expected && !bytes.equals(expected)) throw new Error(`Offline course differs from the active approved publication: ${path}`);
    files.push({ url: `/${path}`, sha256: hash(bytes), bytes: bytes.length, ...properties });
  };
  const index = await readFile(resolve(root, "index.html"), "utf8");
  const assets = [...new Set([...index.matchAll(/(?:src|href)=["']\/(assets\/[^"']+)["']/g)].map((match) => match[1]!))];
  for (const path of ["index.html", "favicon.svg", "offline-worker.js", ...assets]) await add(path, { kind: "shell" });
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

export async function exportOfflineManifest(workspace = process.cwd(), outputDir = "dist") {
  const manifest = await buildOfflineManifest(workspace, outputDir);
  const bytes = Buffer.from(json(manifest));
  if (bytes.length > 4 * 1024 * 1024) throw new Error("Offline download manifest exceeds the size limit.");
  await writeAtomic(resolve(childPath(workspace, outputDir), "data/offline-manifest.json"), bytes);
  return manifest;
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 1) throw new Error("Usage: offline-manifest.ts [output-directory]");
  const manifest = await exportOfflineManifest(process.cwd(), args[0] ?? "dist");
  const current = selectOfflineFiles(manifest);
  console.log(JSON.stringify({ buildId: manifest.buildId, files: current.length, bytes: current.reduce((sum, file) => sum + file.bytes, 0) }, null, 2));
}
