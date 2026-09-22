import { z } from "zod";
import type { AuthoredModule } from "./course.js";
import {
  CourseDomainIdSchema, CourseModuleIdSchema, CoursePracticeTopicSchema, CoursePracticeTopicsSchema,
  SC900_DOMAIN_MODULES, Sc900TopicIdSchema, courseId, courseText, objectiveIdsFor,
} from "./courseCatalog.js";
import { TopicIdSchema } from "./topics.js";

const objectiveId = z.string().regex(/^(ig|st|co|nw|mo|sc-[fisc])-\d{2}$/);
const unique = <T>(values: T[]) => new Set(values).size === values.length;
export const CourseDomainSchema = z.object({
  id: CourseDomainIdSchema, title: courseText,
  weight: z.object({ min: z.number().int().min(0).max(100), max: z.number().int().min(0).max(100) }).strict()
    .refine((value) => value.min <= value.max),
  moduleIds: z.array(CourseModuleIdSchema).min(1).max(8).refine(unique),
  practiceTopics: CoursePracticeTopicsSchema,
  objectives: z.array(z.object({
    id: objectiveId, label: courseText, topicId: CoursePracticeTopicSchema,
  }).strict()).min(1).max(24),
}).strict().superRefine((domain, context) => {
  const expected = objectiveIdsFor(domain.id);
  const sc = domain.id in SC900_DOMAIN_MODULES;
  if (domain.practiceTopics.some((topic) => !(sc ? Sc900TopicIdSchema : TopicIdSchema).safeParse(topic).success) ||
      (sc && JSON.stringify(domain.moduleIds) !== JSON.stringify(SC900_DOMAIN_MODULES[domain.id as keyof typeof SC900_DOMAIN_MODULES])) ||
      (!sc && domain.moduleIds.some((id) => id.startsWith("sc-")))) {
    context.addIssue({ code: "custom", message: `${domain.id}: module and practice topic exam ownership must match.` });
  }
  if (domain.objectives.length !== expected.length || !unique(domain.objectives.map((item) => item.id)) ||
      domain.objectives.some((item) => !expected.includes(item.id) || !domain.practiceTopics.includes(item.topicId))) {
    context.addIssue({ code: "custom", message: `${domain.id}: all official objective identities and their practice topics are required.` });
  }
});
export type CourseDomain = z.infer<typeof CourseDomainSchema>;
export const DomainCoverageSchema = z.object({
  schemaVersion: z.literal(1), domainId: CourseDomainIdSchema, reviewedAt: z.string().date(),
  objectives: z.array(z.object({
    objectiveId,
    lessons: z.array(z.object({
      moduleId: CourseModuleIdSchema, lessonId: courseId,
      sectionIds: z.array(courseId).min(1).max(12).refine(unique),
      checkpointIds: z.array(courseId).max(5).refine(unique),
      evidence: courseText.refine((value) => value.length >= 80 && value.split(/\s+/).length >= 12,
        "Explain the substantive teaching, worked application and assessment in the evidence."),
    }).strict()).min(1).max(12),
  }).strict()).min(1).max(24),
}).strict().superRefine((coverage, context) => {
  const expected = objectiveIdsFor(coverage.domainId);
  const ids = coverage.objectives.map((item) => item.objectiveId);
  if (ids.length !== expected.length || !unique(ids) || ids.some((id) => !expected.includes(id))) {
    context.addIssue({ code: "custom", message: `${coverage.domainId}: cover every official objective exactly once, with no foreign IDs.` });
  }
});
export type DomainCoverage = z.infer<typeof DomainCoverageSchema>;

export function validateCoverageReferences(coverage: DomainCoverage, domain: CourseDomain, modules: readonly AuthoredModule[]): void {
  DomainCoverageSchema.parse(coverage);
  if (coverage.domainId !== domain.id) throw new Error("Coverage belongs to a different domain.");
  for (const objective of coverage.objectives) {
    const targets = objective.lessons.map((target) => `${target.moduleId}/${target.lessonId}`);
    if (!unique(targets)) throw new Error(`${objective.objectiveId}: duplicate coverage lesson targets.`);
    let worked = false;
    for (const target of objective.lessons) {
      const sharedWatcher = objective.objectiveId === "mo-06" && target.moduleId === "network-watcher";
      if (!domain.moduleIds.includes(target.moduleId) && !sharedWatcher) {
        throw new Error(`${objective.objectiveId}: foreign-domain module ${target.moduleId}.`);
      }
      const module = modules.find((item) => item.id === target.moduleId);
      const lesson = module?.lessons.find((item) => item.id === target.lessonId);
      if (!lesson || target.sectionIds.some((id) => !lesson.sections.some((section) => section.id === id)) ||
          target.checkpointIds.some((id) => !lesson.checkpoints.some((checkpoint) => checkpoint.id === id))) {
        throw new Error(`${objective.objectiveId}: coverage references a missing module, lesson, section or checkpoint.`);
      }
      const blocks = lesson.sections.filter((section) => target.sectionIds.includes(section.id)).flatMap((section) => section.blocks);
      const prose = blocks.flatMap((block) => block.type === "paragraph" ? [block.text]
        : block.type === "example" ? [block.scenario, block.result, ...block.steps.flatMap((step) => [step.action, step.why])]
          : block.type === "list" ? block.items : []).join(" ");
      if (prose.split(/\s+/).filter(Boolean).length < 80) {
        throw new Error(`${objective.objectiveId}: cited sections need substantive teaching, not a label or glossary mention.`);
      }
      worked ||= blocks.some((block) => block.type === "example");
    }
    if (!worked) throw new Error(`${objective.objectiveId}: cite at least one worked application section.`);
    if (domain.id.startsWith("sc-") && !objective.lessons.some((target) => target.checkpointIds.length > 0)) {
      throw new Error(`${objective.objectiveId}: cite at least one relevant checkpoint.`);
    }
  }
}
