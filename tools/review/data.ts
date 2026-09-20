import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { assertNoSymlinks } from "../ingest/normalize.js";
import { canonicalJson, jsonFile, workspacePath } from "../ingest/normalize-shared.js";

export async function readData<T>(
  path: string, schema: z.ZodType<T>, workspace = process.cwd(),
): Promise<T> {
  const root = resolve(workspace);
  await assertNoSymlinks(root, path);
  return schema.parse(JSON.parse(await readFile(workspacePath(root, path), "utf8")));
}

export function isMissingFile(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

export async function readOptionalData<T>(
  path: string, schema: z.ZodType<T>, workspace = process.cwd(),
): Promise<T | undefined> {
  try {
    return await readData(path, schema, workspace);
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
}

export async function writeData(path: string, value: unknown, workspace = process.cwd()): Promise<void> {
  const absolute = workspacePath(workspace, path);
  await assertNoSymlinks(workspace, path);
  await mkdir(dirname(absolute), { recursive: true });
  const temporary = `${absolute}.${process.pid}.tmp`;
  await writeFile(temporary, jsonFile(value), { flag: "wx" });
  await rename(temporary, absolute);
}

export async function writeOverlay(
  path: string, value: unknown, replaceExisting: boolean,
): Promise<"written" | "unchanged"> {
  const current = await readOptionalData(path, z.unknown());
  if (current !== undefined) {
    if (canonicalJson(current) === canonicalJson(value)) return "unchanged";
    if (!replaceExisting) {
      throw new Error(`${path}: an existing overlay differs; inspect it before using --replace-existing.`);
    }
  }
  await writeData(path, value);
  return "written";
}

export function isMain(moduleUrl: string): boolean {
  const entry = process.argv[1];
  return entry !== undefined && moduleUrl === pathToFileURL(resolve(entry)).href;
}
