import { z } from "zod";
import {
  AZ104_MODULE_IDS, COURSE_DOMAIN_IDS, CourseDomainIdSchema, CourseIdSchema, CourseModuleIdSchema,
  NETWORKING_MODULE_IDS, courseId, courseText, officialCourseUrl,
  SC900_DOMAIN_IDS, SC900_MODULE_IDS, SC900_MODULE_LESSONS, SC900_DOMAIN_MODULES,
  SC900_OBJECTIVE_DATE_NOTICE, SC900_MODULE_TOPICS, SC900_TOPIC_IDS, Sc900TopicIdSchema, objectiveIdsFor,
} from "../../src/domain/courseCatalog.js";
import { CourseDomainSchema } from "../../src/domain/courseCoverage.js";
import { TopicIdSchema, TopicSelectionSchema } from "../../src/domain/topics.js";
import { readData } from "../review/data.js";

const unique = <T>(values: T[]) => new Set(values).size === values.length;
export const CourseConfigSchema = z.object({
  schemaVersion: z.literal(1), activeCourse: CourseIdSchema.exclude(["sc900"]),
}).strict();
export const CurriculumModuleSchema = z.object({
  id: CourseModuleIdSchema, sourceModuleUrl: officialCourseUrl,
  lessonIds: z.array(courseId).min(2).max(4).refine(unique), minimumWords: z.number().int().positive(),
}).strict();
export const CurriculumSchema = z.object({
  pathUrl: officialCourseUrl, reviewedAt: z.string().date(),
  modules: z.array(CurriculumModuleSchema).length(8),
}).strict().refine((curriculum) => curriculum.modules.every((module, index) => module.id === NETWORKING_MODULE_IDS[index]),
  "Legacy curriculum must preserve the networking module order.");
export const FullCurriculumSchema = z.object({
  schemaVersion: z.literal(2), examCode: z.literal("AZ-104"), title: courseText,
  pathUrl: officialCourseUrl, reviewedAt: z.string().date(),
  objectiveGuide: z.literal("content/az104/objectives.json"),
  domains: z.array(z.object({
    id: CourseDomainIdSchema, title: courseText, moduleIds: z.array(CourseModuleIdSchema).min(1).max(8).refine(unique),
  }).strict()).length(5),
  modules: z.array(CurriculumModuleSchema.extend({
    domainId: CourseDomainIdSchema,
    sourcePath: z.string().regex(/^content\/(?:az104|networking)\/modules\/[a-z][a-z0-9-]+\.json$/),
    practiceTopics: TopicSelectionSchema.refine((topics) => topics.length > 0),
  }).strict()).length(21),
}).strict().superRefine((curriculum, context) => {
  const ids = curriculum.modules.map((module) => module.id);
  if (!unique(ids) || AZ104_MODULE_IDS.some((id) => !ids.includes(id)) ||
      !unique(curriculum.modules.flatMap((module) => module.lessonIds)) ||
      curriculum.domains.some((domain, index) => domain.id !== COURSE_DOMAIN_IDS[index]) ||
      JSON.stringify(curriculum.domains.flatMap((domain) => domain.moduleIds)) !== JSON.stringify(ids) ||
      curriculum.modules.some((module) => !curriculum.domains.find((domain) => domain.id === module.domainId)?.moduleIds.includes(module.id) ||
        module.sourcePath !== `content/${NETWORKING_MODULE_IDS.some((id) => id === module.id) ? "networking" : "az104"}/modules/${module.id}.json`)) {
    context.addIssue({ code: "custom", message: "Full curriculum module order, domain ownership, source paths and lesson identities must reconcile." });
  }
});
export const ObjectivesSchema = z.object({
  schemaVersion: z.literal(1), examCode: z.literal("AZ-104"), guideUrl: officialCourseUrl,
  effectiveDate: z.string().date(), checkedAt: z.string().date(), coverageMeaning: courseText,
  domains: z.array(z.object({
    id: CourseDomainIdSchema, title: courseText, weight: CourseDomainSchema.shape.weight,
    groups: z.array(z.object({
      id: TopicIdSchema, title: courseText,
      objectives: z.array(z.object({ id: courseId, label: courseText }).strict()).min(1).max(24),
    }).strict()).min(1).max(4),
  }).strict()).length(5),
}).strict().refine((guide) => guide.domains.every((domain, index) => domain.id === COURSE_DOMAIN_IDS[index]) &&
  unique(guide.domains.flatMap((domain) => domain.groups.map((group) => group.id))),
"Official domains and topic identities must be unique and ordered.");

const scTopics = z.array(Sc900TopicIdSchema).min(1).refine(unique);
export const Sc900CurriculumSchema = z.object({
  schemaVersion: z.literal(1), examCode: z.literal("SC-900"), title: courseText,
  pathUrl: officialCourseUrl, reviewedAt: z.string().date(),
  objectiveGuide: z.literal("content/sc900/objectives.json"),
  domains: z.array(z.object({
    id: z.enum(SC900_DOMAIN_IDS), title: courseText,
    moduleIds: z.array(z.enum(SC900_MODULE_IDS)).min(1).max(4).refine(unique),
  }).strict()).length(4),
  modules: z.array(CurriculumModuleSchema.extend({
    id: z.enum(SC900_MODULE_IDS), domainId: z.enum(SC900_DOMAIN_IDS),
    sourcePath: z.string().regex(/^content\/sc900\/modules\/sc-[a-z-]+\.json$/),
    practiceTopics: scTopics,
  }).strict()).length(12),
}).strict().superRefine((curriculum, context) => {
  if (curriculum.domains.some((domain, index) => domain.id !== SC900_DOMAIN_IDS[index] ||
        JSON.stringify(domain.moduleIds) !== JSON.stringify(SC900_DOMAIN_MODULES[domain.id])) ||
      curriculum.modules.some((module, index) => module.id !== SC900_MODULE_IDS[index] ||
        !SC900_DOMAIN_MODULES[module.domainId].includes(module.id) ||
        module.sourcePath !== `content/sc900/modules/${module.id}.json` ||
        JSON.stringify(module.practiceTopics) !== JSON.stringify(SC900_MODULE_TOPICS[module.id]) ||
        JSON.stringify(module.lessonIds) !== JSON.stringify(SC900_MODULE_LESSONS[module.id]))) {
    context.addIssue({ code: "custom", message: "SC-900 curriculum requires exact domain, module, lesson and source path allocations." });
  }
});
export const Sc900ObjectivesSchema = z.object({
  schemaVersion: z.literal(1), examCode: z.literal("SC-900"), guideUrl: officialCourseUrl,
  certificationUrl: officialCourseUrl, effectiveDate: z.literal("2026-10-21"),
  checkedAt: z.string().date(), statusAtReview: z.literal("announced-upcoming"),
  dateNotice: z.literal(SC900_OBJECTIVE_DATE_NOTICE),
  previousEnglishSnapshotVerified: z.literal(false), coverageMeaning: courseText,
  domains: z.array(z.object({
    id: z.enum(SC900_DOMAIN_IDS), title: courseText, weight: CourseDomainSchema.shape.weight,
    groups: z.array(z.object({
      id: Sc900TopicIdSchema, title: courseText,
      objectives: z.array(z.object({ id: courseId, label: courseText }).strict()).min(1).max(21),
    }).strict()).min(1).max(4),
  }).strict()).length(4),
}).strict().superRefine((guide, context) => {
  if (guide.checkedAt >= guide.effectiveDate ||
      JSON.stringify(guide.domains.flatMap((domain) => domain.groups.map((group) => group.id))) !== JSON.stringify(SC900_TOPIC_IDS) ||
      guide.domains.some((domain, index) => {
        const expected = objectiveIdsFor(domain.id);
        const actual = domain.groups.flatMap((group) => group.objectives.map((objective) => objective.id));
        return domain.id !== SC900_DOMAIN_IDS[index] || !unique(actual) ||
          actual.length !== expected.length || expected.some((id) => !actual.includes(id));
      })) {
    context.addIssue({ code: "custom", message: "SC-900 requires all 58 announced future objective identities in their ordered domains." });
  }
});

export async function activeCourseId(workspace = process.cwd()) {
  return (await readData("content/course.json", CourseConfigSchema, workspace)).activeCourse;
}

export async function loadFullCourseContract(workspace = process.cwd(), examId: "az104" | "sc900" = "az104") {
  const [curriculum, objectives] = examId === "sc900" ? await Promise.all([
    readData("content/sc900/curriculum.json", Sc900CurriculumSchema, workspace),
    readData("content/sc900/objectives.json", Sc900ObjectivesSchema, workspace),
  ]) : await Promise.all([
    readData("content/az104/curriculum.json", FullCurriculumSchema, workspace),
    readData("content/az104/objectives.json", ObjectivesSchema, workspace),
  ]);
  const domains = curriculum.domains.map((domain) => {
    const official = objectives.domains.find((item) => item.id === domain.id)!;
    return CourseDomainSchema.parse({
      ...domain, weight: official.weight, practiceTopics: official.groups.map((group) => group.id),
      objectives: official.groups.flatMap((group) => group.objectives.map((objective) => ({ ...objective, topicId: group.id }))),
    });
  });
  return { curriculum, objectives, domains };
}
