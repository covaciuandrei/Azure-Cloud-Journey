import { CoursePointerSchema, type Course } from "../../src/domain/course.js";
import { assembleCourse } from "./assemble.js";
import { hash, json } from "../web/bank.js";

export async function loadCoursePublication(workspace = process.cwd()) {
  const course = await assembleCourse(workspace);
  const { releaseId } = course;
  const url = `courses/${releaseId}/networking.json`;
  const pointer = CoursePointerSchema.parse({
    schemaVersion: 1, releaseId, url, sha256: hash(json(course)), modules: course.modules.length,
    lessons: course.modules.reduce((sum, module) => sum + module.lessons.length, 0),
    checkpoints: course.modules.reduce((sum, module) =>
      sum + module.lessons.reduce((count, lesson) => count + lesson.checkpoints.length, 0), 0),
  });
  return { course, pointer, files: new Map<string, Course | typeof pointer>([[url, course], ["data/course.json", pointer]]) };
}
