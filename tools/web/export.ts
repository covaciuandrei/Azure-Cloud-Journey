import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { StudyManifest } from "../../src/web/types.js";
import { assertSafeDirectory, childPath, regularFiles } from "./bank.js";
import { readTopicMap } from "../topics/data.js";
import { loadStudyPublication, publicationFileBytes } from "../learning/publication.js";
import { loadCoursePublication } from "../course/publication.js";
import { loadSc900HostingPublication } from "./sc900-publication.js";

export interface ExportSnapshotOptions {
  workspaceRoot?: string;
  outputDir?: string;
}
export interface ExportSnapshotResult {
  manifest: StudyManifest;
  files: number;
  bytes: number;
}

export async function writeAtomic(path: string, bytes: Uint8Array): Promise<void> {
  try {
    if ((await readFile(path)).equals(bytes)) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(dirname(path), { recursive: true });
  const staging = `${path}.clean-${process.pid}`;
  try {
    await writeFile(staging, bytes, { flag: "wx" });
    await rename(staging, path);
  } finally {
    await rm(staging, { force: true });
  }
}

export async function exportSnapshot(options: ExportSnapshotOptions = {}): Promise<ExportSnapshotResult> {
  const workspace = resolve(options.workspaceRoot ?? process.cwd());
  const output = childPath(workspace, options.outputDir ?? "public");
  const bank = await loadStudyPublication(workspace);
  if (!bank.eligibility) throw new Error("A complete approved question-relevance policy is required before exporting this app.");
  const course = await loadCoursePublication(workspace);
  for (const [path, value] of course.files) bank.files.set(path, { kind: "json", value });
  const sc900 = await loadSc900HostingPublication(workspace);
  for (const [path, value] of sc900.files) bank.files.set(path, value);
  const topics = await readTopicMap(workspace);
  if (topics.sourceRevision !== bank.manifest.sourceRevision ||
      bank.releases.some((release) => release.catalog.questions.some((question) => !topics.assignments[question.id]))) {
    throw new Error("Topic assignments do not cover this question bank.");
  }
  const withinBank = relative(bank.source.directory, output);
  if (!withinBank || (withinBank !== ".." && !withinBank.startsWith(`..${sep}`))) {
    throw new Error("Export output must not overwrite the frozen bank");
  }
  await assertSafeDirectory(workspace, relative(workspace, output));
  // Validate the complete frozen snapshot before replacing any served payload.
  const existing = new Set<string>();
  for (const directory of ["content", "data", "teaching", "courses"]) {
    try {
      for (const path of await regularFiles(resolve(output, directory))) existing.add(`${directory}/${path}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  let bytes = 0;
  const pointers = ["data/course.json", "data/learning.json", "data/manifest.json",
    "exams/sc900/manifest.json", "exams/sc900/course/current.json", "exams/sc900/availability.json"];
  const paths = [...[...bank.files.keys()].filter((path) => !pointers.includes(path)).sort(),
    ...pointers.filter((path) => bank.files.has(path))];
  for (const path of paths) {
    const file = bank.files.get(path);
    if (!file) throw new Error(`Missing publication file: ${path}`);
    const content = await publicationFileBytes(file);
    await writeAtomic(resolve(output, path), content);
    existing.delete(path);
    bytes += content.length;
  }
  const topicBytes = Buffer.from(`${JSON.stringify(topics, null, 2)}\n`);
  await writeAtomic(resolve(output, "data/topics.json"), topicBytes);
  existing.delete("data/topics.json");
  bytes += topicBytes.length;
  for (const path of existing) await rm(resolve(output, path));
  return { manifest: bank.manifest, files: paths.length + 1, bytes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length > 2) throw new Error("data:export does not accept arguments.");
  exportSnapshot().then(({ manifest, files, bytes }) => {
    console.log(`Exported frozen bank: ${manifest.counts.questions} questions, ${manifest.counts.comments} comments, ` +
      `${manifest.counts.images} images (${files} files, ${bytes} bytes).`);
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
