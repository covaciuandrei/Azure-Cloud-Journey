import { copyFile, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { loadCoursePublication } from "../course/publication.js";
import { isMain } from "../review/data.js";
import { assertSafeDirectory, json, regularFiles } from "../web/bank.js";
import { writeAtomic } from "../web/export.js";
import { createDemoBank } from "./fixtures.js";
import { createSc900DemoBank } from "./sc900-fixtures.js";
import { Sc900AvailabilitySchema, SC900_INACTIVE } from "../../src/domain/examAvailability.js";

export const DEMO_PUBLIC_DIRECTORY = ".data/demo/public";

export async function exportDemo(workspace = process.cwd(), options: { sc900?: boolean } = {}) {
  const bank = createDemoBank();
  const course = await loadCoursePublication(workspace);
  const files = new Map<string, unknown>([...bank.files, ...course.files,
    ["exams/sc900/availability.json", SC900_INACTIVE]]);
  if (options.sc900) {
    const sc900Course = await loadCoursePublication(workspace, "sc900", { activate: true });
    const sc900 = createSc900DemoBank();
    for (const [path, value] of sc900.files) files.set(`exams/sc900/${path}`, value);
    for (const [path, value] of sc900Course.files) files.set(path, value);
    files.set("exams/sc900/availability.json", Sc900AvailabilitySchema.parse({
      schemaVersion: 1, examId: "sc900", activated: true, kind: "original-synthetic-demo",
      bankReleaseId: sc900.manifest.releaseId, courseReleaseId: sc900Course.course.releaseId,
      sourceCaptureDigest: sc900.manifest.captureLedgerDigest,
      approvedBy: "explicit-source-demo", approvedAt: new Date().toISOString(),
    }));
  }
  await assertSafeDirectory(workspace, DEMO_PUBLIC_DIRECTORY);
  const output = resolve(workspace, DEMO_PUBLIC_DIRECTORY);
  await mkdir(output, { recursive: true });
  await regularFiles(output);
  // This fixed, generated-only directory is separate from public and the private bank.
  await rm(output, { recursive: true });
  await mkdir(output, { recursive: true });
  for (const [path, value] of files) {
    await writeAtomic(resolve(output, path), Buffer.from(json(value)));
  }
  await copyFile(resolve(workspace, "public/favicon.svg"), resolve(output, "favicon.svg"));
  return { questions: bank.manifest.counts.questions, ...course.pointer, output: DEMO_PUBLIC_DIRECTORY };
}

if (isMain(import.meta.url)) {
  if (process.argv.length > 2) throw new Error("demo:prepare does not accept arguments.");
  console.log(JSON.stringify(await exportDemo(process.cwd(), { sc900: process.env.VITE_STUDY_SC900_DEMO === "true" }), null, 2));
}
