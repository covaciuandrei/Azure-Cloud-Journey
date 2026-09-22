import { CoursePointerSchema, CourseSchema, type Course } from "../../domain/course.js";
import { MAX_COURSE_BYTES, courseContentPath, coursePointerPath } from "../../domain/courseCatalog.js";
import { ExamIdSchema, type ExamId } from "../../domain/exams.js";

export async function loadCourse(baseUrl: string, downloaded: boolean, fetcher: typeof fetch = fetch, examId: ExamId = "az104"): Promise<Course> {
  ExamIdSchema.parse(examId);
  const base = new URL(baseUrl);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error("Invalid course origin.");
  }
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  const read = async (path: string, limit: number) => {
    const url = new URL(path, base);
    if (url.origin !== base.origin) throw new Error("Course content must use the app's own origin.");
    const response = await fetcher(url.href, {
      cache: "no-store", credentials: "same-origin", redirect: "error",
      ...(downloaded ? { headers: { "X-AZ104-Offline": "1" } } : {}),
    });
    if (!response.ok) throw new Error("Learning materials are unavailable. Reconnect and update the offline download, or retry.");
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > limit) throw new Error("The course response exceeds its size limit.");
    return bytes;
  };
  const parse = (bytes: ArrayBuffer): unknown => {
    try { return JSON.parse(new TextDecoder().decode(bytes)); }
    catch { throw new Error("The course response is not valid data. Reload the app or update its offline copy."); }
  };
  const pointer = CoursePointerSchema.parse(parse(await read(coursePointerPath(examId), 8000)));
  if ((pointer.schemaVersion === 3 ? "sc900" : "az104") !== examId) {
    throw new Error("The course index belongs to a different exam.");
  }
  if (pointer.schemaVersion === 3 && !pointer.active) {
    throw new Error("SC-900 learning materials are awaiting explicit reviewed publication approval.");
  }
  const bytes = await read(pointer.url, MAX_COURSE_BYTES);
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  if (hash !== pointer.sha256) throw new Error("Course content failed its integrity check. Retry or update the offline download.");
  const course = CourseSchema.parse(parse(bytes));
  if (course.schemaVersion !== pointer.schemaVersion || pointer.url !== courseContentPath(course.id, course.releaseId) ||
      course.releaseId !== pointer.releaseId || course.modules.length !== pointer.modules ||
      course.modules.reduce((sum, module) => sum + module.lessons.length, 0) !== pointer.lessons ||
      course.modules.reduce((sum, module) => sum + module.lessons.reduce((count, lesson) => count + lesson.checkpoints.length, 0), 0) !== pointer.checkpoints) {
    throw new Error("The course does not match its published index.");
  }
  return course;
}
