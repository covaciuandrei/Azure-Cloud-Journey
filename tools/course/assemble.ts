import { z } from "zod";
import { CourseSchema, CourseModuleIdSchema } from "../../src/domain/course.js";
import { MAX_COURSE_BYTES, type CourseId, courseText } from "../../src/domain/courseCatalog.js";
import { digest, jsonFile } from "../ingest/normalize-shared.js";
import { isMain, readData, writeData } from "../review/data.js";
import { COURSE_SOURCE_DIRECTORY, loadCourseCoverage, loadCourseModules, parseCourseSelection, teachingWordCount } from "./validate.js";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const ModuleApprovalsSchema = z.array(z.object({
  id: CourseModuleIdSchema, digest: sha256, note: courseText.refine((value) => value.length >= 30),
}).strict()).min(1).max(8);
export const MetadataApprovalSchema = z.object({
  schemaVersion: z.literal(1), reviewedAt: z.string().date(), reviewer: z.literal("coordinator"),
  curriculumDigest: sha256, objectivesDigest: sha256, coverageDigest: sha256,
  note: courseText.refine((value) => value.length >= 80),
}).strict();

function finalizedCourse(content: unknown) {
  const course = CourseSchema.parse(content);
  const bytes = Buffer.byteLength(jsonFile(course));
  if (bytes > MAX_COURSE_BYTES) throw new Error(`Published course exceeds the 4 MiB size limit (${bytes} bytes).`);
  return course;
}

export async function assembleCourse(workspace = process.cwd(), selectedCourse?: CourseId) {
  const { curriculum, modules, full, courseId } = await loadCourseModules(workspace, selectedCourse ? { course: selectedCourse } : {});
  const coverage = full && courseId !== "networking" ? await loadCourseCoverage(workspace, modules, undefined, courseId) : null;
  const groups = full ? full.domains.map((domain) => ({
    path: `content/${courseId}/review-approvals/${domain.id}.json`, ids: domain.moduleIds,
  })) : [{ path: `${COURSE_SOURCE_DIRECTORY}/review-approvals.json`, ids: modules.map((module) => module.id) }];
  const approvals = [];
  for (const group of groups) {
    const reviewed = await readData(group.path, ModuleApprovalsSchema, workspace);
    if (reviewed.length !== group.ids.length || new Set(reviewed.map((item) => item.id)).size !== group.ids.length ||
        reviewed.some((item) => !group.ids.includes(item.id))) throw new Error(`${group.path}: each assigned module needs a separate review approval.`);
    approvals.push(...reviewed);
  }
  for (const module of modules) {
    if (approvals.find((item) => item.id === module.id)?.digest !== digest(module)) {
      throw new Error(`${module.id}: approve this exact module content before publication.`);
    }
  }
  if (full) {
    const approval = await readData(`content/${courseId}/review-approvals/metadata.json`, MetadataApprovalSchema, workspace);
    if (approval.curriculumDigest !== digest(full.curriculum) || approval.objectivesDigest !== digest(full.objectives) ||
        approval.coverageDigest !== digest(coverage)) {
      throw new Error("Approve this exact curriculum, objective guide and coverage mapping before publication.");
    }
  }
  const publishedModules = modules.map((module) => ({
    ...module,
    lessons: module.lessons.map((lesson) => ({
      ...lesson, revision: digest(lesson), wordCount: teachingWordCount(lesson),
      minutes: Math.ceil(teachingWordCount(lesson) / 150) + lesson.checkpoints.length * 2,
    })),
  }));
  if (full) {
    if (courseId === "sc900" && "statusAtReview" in full.objectives) {
      const content = {
        schemaVersion: 3 as const, id: "sc900" as const, title: full.curriculum.title,
        reviewedAt: full.curriculum.reviewedAt, pathUrl: full.curriculum.pathUrl,
        examGuideUrl: full.objectives.guideUrl, objectiveEffectiveDate: full.objectives.effectiveDate,
        objectiveStatusAtReview: full.objectives.statusAtReview, objectiveCheckedAt: full.objectives.checkedAt,
        objectiveDateNotice: full.objectives.dateNotice,
        previousEnglishSnapshotVerified: full.objectives.previousEnglishSnapshotVerified,
        introduction: `Learn security, identity and compliance foundations through worked applications and explained checkpoints. ${full.objectives.coverageMeaning}`,
        domains: full.domains, coverage,
        modules: publishedModules.map((module) => {
          const expected = full.curriculum.modules.find((item) => item.id === module.id)!;
          return { ...module, domainId: expected.domainId, practiceTopics: expected.practiceTopics };
        }),
      };
      return finalizedCourse({ ...content, releaseId: `c_${digest(content)}` });
    }
    const content = {
      schemaVersion: 2 as const, id: "az104" as const, title: full.curriculum.title,
      reviewedAt: full.curriculum.reviewedAt, pathUrl: full.curriculum.pathUrl,
      examGuideUrl: full.objectives.guideUrl, objectiveEffectiveDate: full.objectives.effectiveDate,
      introduction: `Learn Azure administration across identity and governance, storage, compute, networking, and monitoring and recovery. Follow the worked examples and explained checkpoints, then use the linked practice topics. ${full.objectives.coverageMeaning}`,
      domains: full.domains, coverage,
      modules: publishedModules.map((module) => {
        const expected = full.curriculum.modules.find((item) => item.id === module.id)!;
        return { ...module, domainId: expected.domainId, practiceTopics: expected.practiceTopics };
      }),
    };
    return finalizedCourse({ ...content, releaseId: `c_${digest(content)}` });
  }
  const content = {
    schemaVersion: 1 as const, id: "networking" as const, title: "Understand Azure networking",
    reviewedAt: curriculum.reviewedAt, pathUrl: curriculum.pathUrl,
    examGuideUrl: "https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/az-104",
    introduction: "Build a mental model of a working network, one decision at a time. Start with addresses and packets, then follow the same school application through security, DNS, peering, routing, delivery and troubleshooting. This pilot covers all eight modules in the linked Microsoft learning path. Teaching priorities reflect the published objectives and practical dependencies, not predictions about individual exam questions.",
    modules: publishedModules,
  };
  return finalizedCourse({ ...content, releaseId: `c_${digest(content)}` });
}

if (isMain(import.meta.url)) {
  const selection = parseCourseSelection(process.argv.slice(2));
  if (selection.module || selection.domain) throw new Error("Assembly requires a complete approved course, not a partial selection.");
  const course = await assembleCourse(process.cwd(), selection.course ?? selection.exam);
  const directory = course.id === "sc900" ? ".data/exams/sc900/course" : ".data/course";
  await writeData(`${directory}/releases/${course.releaseId}/${course.id}.json`, course);
  await writeData(`${directory}/current.json`, { releaseId: course.releaseId, id: course.id });
  await writeData(`${directory}/content-report.json`, {
    releaseId: course.releaseId, modules: course.modules.length, bytes: Buffer.byteLength(jsonFile(course)),
    lessons: course.modules.reduce((sum, module) => sum + module.lessons.length, 0),
    words: course.modules.reduce((sum, module) => sum + module.lessons.reduce((total, lesson) => total + lesson.wordCount, 0), 0),
    checkpoints: course.modules.reduce((sum, module) => sum + module.lessons.reduce((total, lesson) => total + lesson.checkpoints.length, 0), 0),
    sourceUrls: [...new Set(course.modules.flatMap((module) => [module.sourceModuleUrl, ...module.sources.map((source) => source.url)]))],
  });
  console.log(JSON.stringify({ releaseId: course.releaseId, modules: course.modules.length, bytes: Buffer.byteLength(jsonFile(course)),
    lessons: course.modules.reduce((sum, module) => sum + module.lessons.length, 0) }, null, 2));
}
