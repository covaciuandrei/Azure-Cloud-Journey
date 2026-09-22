import { z } from "zod";
import { CoursePointerSchema, type Course } from "../../src/domain/course.js";
import { MAX_COURSE_BYTES, courseContentPath, coursePointerPath, courseText, type CourseId } from "../../src/domain/courseCatalog.js";
import { assembleCourse } from "./assemble.js";
import { hash, json } from "../web/bank.js";
import { readData } from "../review/data.js";

export const Sc900CourseActivationSchema = z.object({
  schemaVersion: z.literal(1), examId: z.literal("sc900"), approved: z.literal(true),
  reviewer: z.literal("coordinator"), reviewedAt: z.string().date(),
  releaseId: z.string().regex(/^c_[a-f0-9]{64}$/), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  note: courseText.refine((value) => value.length >= 80),
}).strict();

export async function loadCoursePublication(workspace = process.cwd(), selectedCourse?: CourseId, options: { activate?: boolean } = {}) {
  const course = await assembleCourse(workspace, selectedCourse);
  const { releaseId } = course;
  const url = courseContentPath(course.id, releaseId);
  const bytes = Buffer.byteLength(json(course));
  if (bytes > MAX_COURSE_BYTES) throw new Error(`Published course exceeds the 4 MiB size limit (${bytes} bytes).`);
  const sha256 = hash(json(course));
  if (options.activate) {
    if (course.id !== "sc900") throw new Error("Explicit course activation applies only to the SC-900 publication.");
    const approval = await readData("content/sc900/review-approvals/activation.json", Sc900CourseActivationSchema, workspace);
    if (approval.releaseId !== releaseId || approval.sha256 !== sha256) {
      throw new Error("Approve this exact SC-900 release and byte hash before activation.");
    }
  }
  const pointer = CoursePointerSchema.parse({
    schemaVersion: course.schemaVersion, ...(course.id !== "networking" ? { id: course.id } : {}),
    ...(course.id === "sc900" ? { active: options.activate === true } : {}),
    releaseId, url, sha256, modules: course.modules.length,
    lessons: course.modules.reduce((sum, module) => sum + module.lessons.length, 0),
    checkpoints: course.modules.reduce((sum, module) =>
      sum + module.lessons.reduce((count, lesson) => count + lesson.checkpoints.length, 0), 0),
  });
  return { course, pointer, files: new Map<string, Course | typeof pointer>([
    [url, course], [coursePointerPath(course.id === "sc900" ? "sc900" : "az104"), pointer],
  ]) };
}
