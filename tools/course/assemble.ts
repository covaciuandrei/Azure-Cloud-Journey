import { z } from "zod";
import { CourseSchema, NETWORKING_MODULE_IDS } from "../../src/domain/course.js";
import { digest } from "../ingest/normalize-shared.js";
import { isMain, readData, writeData } from "../review/data.js";
import { COURSE_SOURCE_DIRECTORY, loadCourseModules, teachingWordCount } from "./validate.js";

export async function assembleCourse(workspace = process.cwd()) {
  const { curriculum, modules } = await loadCourseModules(workspace);
  const approvals = await readData(`${COURSE_SOURCE_DIRECTORY}/review-approvals.json`, z.array(z.object({
    id: z.enum(NETWORKING_MODULE_IDS), digest: z.string().regex(/^[a-f0-9]{64}$/), note: z.string().min(30),
  }).strict()).length(8), workspace);
  if (new Set(approvals.map((item) => item.id)).size !== 8) throw new Error("Each course module needs a separate review approval.");
  for (const module of modules) {
    if (approvals.find((item) => item.id === module.id)?.digest !== digest(module)) {
      throw new Error(`${module.id}: approve this exact module content before publication.`);
    }
  }
  const content = {
    schemaVersion: 1 as const, id: "networking" as const, title: "Understand Azure networking",
    reviewedAt: curriculum.reviewedAt, pathUrl: curriculum.pathUrl,
    examGuideUrl: "https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/az-104",
    introduction: "Build a mental model of a working network, one decision at a time. Start with addresses and packets, then follow the same school application through security, DNS, peering, routing, delivery and troubleshooting. This pilot covers all eight modules in the linked Microsoft learning path. Teaching priorities reflect the published objectives and practical dependencies, not predictions about individual exam questions.",
    modules: modules.map((module) => ({
      ...module,
      lessons: module.lessons.map((lesson) => ({
        ...lesson, revision: digest(lesson), wordCount: teachingWordCount(lesson),
        minutes: Math.ceil(teachingWordCount(lesson) / 150) + lesson.checkpoints.length * 2,
      })),
    })),
  };
  return CourseSchema.parse({ ...content, releaseId: `c_${digest(content)}` });
}

if (isMain(import.meta.url)) {
  const course = await assembleCourse();
  await writeData(`.data/course/releases/${course.releaseId}/networking.json`, course);
  await writeData(".data/course/current.json", { releaseId: course.releaseId });
  await writeData(".data/course/content-report.json", {
    releaseId: course.releaseId, modules: course.modules.length,
    lessons: course.modules.reduce((sum, module) => sum + module.lessons.length, 0),
    words: course.modules.reduce((sum, module) => sum + module.lessons.reduce((total, lesson) => total + lesson.wordCount, 0), 0),
    checkpoints: course.modules.reduce((sum, module) => sum + module.lessons.reduce((total, lesson) => total + lesson.checkpoints.length, 0), 0),
    sourceUrls: [...new Set(course.modules.flatMap((module) => [module.sourceModuleUrl, ...module.sources.map((source) => source.url)]))],
  });
  console.log(JSON.stringify({ releaseId: course.releaseId, modules: course.modules.length,
    lessons: course.modules.reduce((sum, module) => sum + module.lessons.length, 0) }, null, 2));
}
