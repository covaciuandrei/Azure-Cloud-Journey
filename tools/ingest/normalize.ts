import { lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { MAX_DOCUMENT_BYTES } from "../../src/domain/index.js";
import {
  RECORD_COLLECTIONS, normalizeCaptures,
  type CaptureInput, type NormalizationOptions, type NormalizedDataset,
} from "./normalize-core.js";
import {
  errorMessage, jsonFile, relativeWorkspacePath, workspacePath,
} from "./normalize-shared.js";

export interface NormalizeDirectoryOptions extends NormalizationOptions {
  workspaceRoot?: string;
  inputDirectory?: string;
  outputDirectory?: string;
  requireComplete?: boolean;
}

export async function assertNoSymlinks(workspace: string, path: string): Promise<void> {
  const absolute = workspacePath(workspace, path);
  const components = relative(resolve(workspace), absolute).split(sep);
  let current = resolve(workspace);
  for (const component of components) {
    current = resolve(current, component);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error(`Refusing symbolic link in data path: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      break;
    }
  }
}

export async function readCaptureInputs(workspace: string, inputDirectory: string): Promise<CaptureInput[]> {
  const directory = workspacePath(workspace, inputDirectory);
  await assertNoSymlinks(workspace, inputDirectory);
  const entries = await readdir(directory, { withFileTypes: true });
  const pageEntries = entries.filter((entry) => /^page-.*\.json$/.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name));
  if (!pageEntries.length) throw new Error(`${inputDirectory}: no numbered rendered page captures found`);
  const inputs: CaptureInput[] = [];
  for (const entry of pageEntries) {
    if (!entry.isFile() || !/^page-\d{3}\.json$/.test(entry.name)) {
      throw new Error(`${inputDirectory}/${entry.name}: expected a regular page-NNN.json capture`);
    }
    const path = relativeWorkspacePath(workspace, resolve(directory, entry.name));
    inputs.push({ path, content: await readFile(workspacePath(workspace, path), "utf8") });
  }
  return inputs;
}

function pathsOverlap(workspace: string, first: string, second: string): boolean {
  const a = workspacePath(workspace, first);
  const b = workspacePath(workspace, second);
  return a === b || a.startsWith(`${b}${sep}`) || b.startsWith(`${a}${sep}`);
}

async function assertReplaceable(path: string, checkReview: boolean): Promise<string | null> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Refusing to replace non-regular normalized record: ${path}`);
    const previous = await readFile(path, "utf8");
    if (checkReview) {
      let value: { published?: boolean; review?: { status?: string }; conversion?: { status?: string } };
      try { value = JSON.parse(previous) as typeof value; }
      catch { throw new Error(`Cannot safely replace unrecognized normalized record ${path}; preserve it for inspection`); }
      if (value.published || value.review?.status === "completed" || value.conversion?.status === "completed") {
        throw new Error(`Refusing to overwrite reviewed/published/converted data at ${path}; move curation to separate overlays`);
      }
    }
    return previous;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

let pendingSequence = 0;
async function writeJsonAtomic(path: string, value: unknown, checkReview = false): Promise<void> {
  const content = jsonFile(value);
  const previous = await assertReplaceable(path, checkReview);
  if (previous === content) return;
  await mkdir(dirname(path), { recursive: true });
  const pending = `${path}.pending-${process.pid}-${pendingSequence++}`;
  await writeFile(pending, content, { flag: "wx" });
  try { await rename(pending, path); }
  finally {
    try { await unlink(pending); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

export async function writeNormalizedDataset(
  dataset: NormalizedDataset, options: NormalizeDirectoryOptions = {},
): Promise<void> {
  const workspace = resolve(options.workspaceRoot ?? process.cwd());
  const outputDirectory = options.outputDirectory ?? ".data/normalized";
  const inputDirectory = options.inputDirectory ?? ".data/raw/pages";
  const assetDirectory = options.assetDirectory ?? ".data/assets";
  for (const protectedPath of [inputDirectory, assetDirectory, ".data/raw", ".data/reviews", ".data/conversions"]) {
    if (pathsOverlap(workspace, outputDirectory, protectedPath)) {
      throw new Error(`Normalized output ${outputDirectory} must be separate from ${protectedPath}`);
    }
  }
  await assertNoSymlinks(workspace, outputDirectory);
  await assertNoSymlinks(workspace, assetDirectory);
  const output = workspacePath(workspace, outputDirectory);
  for (const collection of RECORD_COLLECTIONS) {
    const directory = resolve(output, collection);
    await assertNoSymlinks(workspace, directory);
    for (const record of dataset[collection]) {
      const bytes = Buffer.byteLength(jsonFile(record));
      if (bytes > MAX_DOCUMENT_BYTES) throw new Error(`${collection}/${record.id}: serialized document ${bytes} bytes exceeds safety limit`);
      await assertReplaceable(resolve(directory, `${record.id}.json`), ["questions", "answers"].includes(collection));
    }
  }
  await dataset.assetRegistry.unpack(workspace, assetDirectory);
  for (const collection of RECORD_COLLECTIONS) {
    const directory = resolve(output, collection);
    await mkdir(directory, { recursive: true });
    const records = dataset[collection];
    for (let offset = 0; offset < records.length; offset += 32) {
      await Promise.all(records.slice(offset, offset + 32).map((record) =>
        writeJsonAtomic(resolve(directory, `${record.id}.json`), record, ["questions", "answers"].includes(collection))));
    }
    const currentNames = new Set(records.map((record) => `${record.id}.json`));
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.name.endsWith(".json") || currentNames.has(entry.name)) continue;
      const oldPath = resolve(directory, entry.name);
      if (!entry.isFile() || !/^(?:q_[a-f0-9]{64}|c_[a-f0-9]{64}|[a-f0-9]{64}|examprepper-45-q\d{6})\.json$/.test(entry.name)) {
        throw new Error(`Unknown file in normalized source collection; left untouched: ${oldPath}`);
      }
      const old = await assertReplaceable(oldPath, true);
      if (!old || (JSON.parse(old) as { schemaVersion?: number }).schemaVersion !== 1) {
        throw new Error(`Unknown stale source document; left untouched: ${oldPath}`);
      }
      await unlink(oldPath);
    }
  }
  await writeJsonAtomic(resolve(output, "catalog.json"), dataset.catalog);
  await writeJsonAtomic(resolve(output, "manifest.json"), dataset.manifest);
}

export async function normalizeDirectory(options: NormalizeDirectoryOptions = {}): Promise<NormalizedDataset> {
  const workspace = resolve(options.workspaceRoot ?? process.cwd());
  const inputDirectory = options.inputDirectory ?? ".data/raw/pages";
  const assetDirectory = relativeWorkspacePath(workspace, options.assetDirectory ?? ".data/assets");
  const inputs = await readCaptureInputs(workspace, inputDirectory);
  const dataset = normalizeCaptures(inputs, { ...options, assetDirectory });
  if (options.requireComplete && !dataset.manifest.coverage.complete) {
    const coverage = dataset.manifest.coverage;
    throw new Error(`Incomplete capture: missing pages [${coverage.missingPages.join(", ")}]; missing source questions [${coverage.missingQuestionNumbers.join(", ")}]`);
  }
  await writeNormalizedDataset(dataset, { ...options, workspaceRoot: workspace, assetDirectory });
  return dataset;
}

export function parseNormalizeArgs(args: string[]): NormalizeDirectoryOptions & { help?: boolean } {
  const options: NormalizeDirectoryOptions & { help?: boolean } = {};
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === "--require-complete") { options.requireComplete = true; continue; }
    if (argument === "--help") { options.help = true; continue; }
    const names = { "--input": "inputDirectory", "--output": "outputDirectory", "--assets": "assetDirectory" } as const;
    if (!(argument in names)) throw new Error(`Unknown normalization argument ${argument}`);
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a directory`);
    options[names[argument as keyof typeof names]] = value;
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseNormalizeArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: npm run data:normalize -- [--input .data/raw/pages] [--output .data/normalized] [--assets .data/assets] [--require-complete]");
    return;
  }
  const { manifest } = await normalizeDirectory(options);
  console.log(JSON.stringify({
    importId: manifest.importId, output: options.outputDirectory ?? ".data/normalized",
    coverage: manifest.coverage, records: manifest.records,
    duplicateGroups: manifest.duplicateGroups, conflictingOriginalKeys: manifest.conflictingOriginalKeys,
    conversionPending: manifest.conversionPending, commentReviewPending: manifest.reviewPending,
    warnings: manifest.issues,
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => { console.error(errorMessage(error)); process.exitCode = 1; });
}
