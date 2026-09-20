import { CoursePointerSchema, type Course } from "../../src/domain/course.js";
import { MAX_COURSE_BYTES, type CourseId } from "../../src/domain/courseCatalog.js";
import { assembleCourse } from "./assemble.js";
import { hash, json } from "../web/bank.js";

export async function loadCoursePublication(workspace = process.cwd(), selectedCourse?: CourseId) {
  const course = await assembleCourse(workspace, selectedCourse);
  const { releaseId } = course;
  const url = `courses/${releaseId}/${course.id}.json`;
  const bytes = Buffer.byteLength(json(course));
  if (bytes > MAX_COURSE_BYTES) throw new Error(`Published course exceeds the 4 MiB size limit (${bytes} bytes).`);
  const pointer = CoursePointerSchema.parse({
    schemaVersion: course.schemaVersion, ...(course.id === "az104" ? { id: course.id } : {}),
    releaseId, url, sha256: hash(json(course)), modules: course.modules.length,
    lessons: course.modules.reduce((sum, module) => sum + module.lessons.length, 0),
    checkpoints: course.modules.reduce((sum, module) =>
      sum + module.lessons.reduce((count, lesson) => count + lesson.checkpoints.length, 0), 0),
  });
  return { course, pointer, files: new Map<string, Course | typeof pointer>([[url, course], ["data/course.json", pointer]]) };
}
