import { copyFile, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { loadCoursePublication } from "../course/publication.js";
import { isMain } from "../review/data.js";
import { assertSafeDirectory, json, regularFiles } from "../web/bank.js";
import { writeAtomic } from "../web/export.js";
import { createDemoBank } from "./fixtures.js";

export const DEMO_PUBLIC_DIRECTORY = ".data/demo/public";

export async function exportDemo(workspace = process.cwd()) {
  const bank = createDemoBank();
  const course = await loadCoursePublication(workspace);
  await assertSafeDirectory(workspace, DEMO_PUBLIC_DIRECTORY);
  const output = resolve(workspace, DEMO_PUBLIC_DIRECTORY);
  await mkdir(output, { recursive: true });
  await regularFiles(output);
  // This fixed, generated-only directory is separate from public and the private bank.
  await rm(output, { recursive: true });
  await mkdir(output, { recursive: true });
  for (const [path, value] of [...bank.files, ...course.files]) {
    await writeAtomic(resolve(output, path), Buffer.from(json(value)));
  }
  await copyFile(resolve(workspace, "public/favicon.svg"), resolve(output, "favicon.svg"));
  return { questions: bank.manifest.counts.questions, ...course.pointer, output: DEMO_PUBLIC_DIRECTORY };
}

if (isMain(import.meta.url)) {
  if (process.argv.length > 2) throw new Error("demo:prepare does not accept arguments.");
  console.log(JSON.stringify(await exportDemo(), null, 2));
}
