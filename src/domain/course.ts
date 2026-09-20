import { z } from "zod";

export const NETWORKING_MODULE_IDS = [
  "virtual-networks", "network-security-groups", "azure-dns", "vnet-peering",
  "routing", "load-balancer", "application-gateway", "network-watcher",
] as const;
export const CourseModuleIdSchema = z.enum(NETWORKING_MODULE_IDS);
const id = z.string().regex(/^[a-z][a-z0-9-]{2,79}$/);
const text = z.string().trim().min(1).max(8000).refine((value) =>
  !/\u2014|&mdash;|&#8212;|&#x2014;/i.test(value), "Do not use em dashes.");
const officialUrl = z.string().url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password &&
    (url.hostname === "microsoft.com" || url.hostname.endsWith(".microsoft.com"));
}, "Use an official Microsoft reference.");
export const CourseSourceSchema = z.object({
  id, url: officialUrl, title: text, supports: text,
}).strict();
export const CourseBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("paragraph"), text }).strict(),
  z.object({ type: z.literal("list"), ordered: z.boolean(), items: z.array(text).min(2).max(12) }).strict(),
  z.object({
    type: z.literal("table"), caption: text, headers: z.array(text).min(2).max(5),
    rows: z.array(z.array(text).min(2).max(5)).min(2).max(15),
  }).strict().refine((block) => block.rows.every((row) => row.length === block.headers.length), "Table columns must align."),
  z.object({
    type: z.literal("callout"), tone: z.enum(["remember", "caution", "exam"]), title: text, text,
  }).strict(),
  z.object({
    type: z.literal("example"), title: text, scenario: text,
    steps: z.array(z.object({ action: text, why: text }).strict()).min(2).max(10), result: text,
  }).strict(),
  z.object({
    type: z.literal("prediction"), id, prompt: text, answer: text, explanation: text,
  }).strict(),
  z.object({
    type: z.literal("diagram"), title: text, description: text,
    nodes: z.array(z.object({
      id, label: text, detail: text, column: z.number().int().min(0).max(2), row: z.number().int().min(0).max(2),
    }).strict()).min(2).max(7),
    edges: z.array(z.object({ from: id, to: id, label: text }).strict()).min(1).max(9),
  }).strict().superRefine((block, context) => {
    const ids = new Set(block.nodes.map((node) => node.id));
    if (ids.size !== block.nodes.length ||
        new Set(block.nodes.map((node) => `${node.column}/${node.row}`)).size !== block.nodes.length ||
        block.edges.some((edge) => !ids.has(edge.from) || !ids.has(edge.to) || edge.from === edge.to)) {
      context.addIssue({ code: "custom", message: "Diagram nodes and edges must form a valid, non-overlapping layout." });
    }
  }),
  z.object({ type: z.literal("code"), language: z.enum(["text", "azurecli", "powershell", "bicep", "json", "kusto"]), code: text, explanation: text }).strict(),
  z.object({ type: z.literal("interactive"), tool: z.enum(["subnet", "routes", "nsg"]), introduction: text }).strict(),
]);
export type CourseBlock = z.infer<typeof CourseBlockSchema>;
export const CheckpointSchema = z.object({
  id, kind: z.enum(["single", "multiple"]), prompt: text,
  choices: z.array(z.object({ id, text, explanation: text }).strict()).min(3).max(5),
  correctIds: z.array(id).min(1).max(4), explanation: text,
}).strict().superRefine((value, context) => {
  const ids = new Set(value.choices.map((choice) => choice.id));
  if (ids.size !== value.choices.length || new Set(value.correctIds).size !== value.correctIds.length ||
      value.correctIds.some((choiceId) => !ids.has(choiceId)) ||
      (value.kind === "single" && value.correctIds.length !== 1) ||
      value.correctIds.length === value.choices.length) {
    context.addIssue({ code: "custom", message: "Checkpoint choices and answer identities do not reconcile." });
  }
});
export type CourseCheckpoint = z.infer<typeof CheckpointSchema>;
export const AuthoredLessonSchema = z.object({
  id, title: text, summary: text, objectives: z.array(text).min(2).max(6),
  sections: z.array(z.object({
    id, title: text, blocks: z.array(CourseBlockSchema).min(1).max(16),
  }).strict()).min(4).max(12),
  checkpoints: z.array(CheckpointSchema).min(3).max(5),
  takeaways: z.array(text).min(3).max(7),
  sourceIds: z.array(id).min(1).max(12),
}).strict();
export const AuthoredModuleSchema = z.object({
  schemaVersion: z.literal(1), id: CourseModuleIdSchema, title: text, summary: text,
  priority: z.enum(["core", "supporting"]), priorityReason: text,
  sourceModuleUrl: officialUrl, reviewedAt: z.string().date(),
  officialObjectives: z.array(text).min(2).max(12),
  lessons: z.array(AuthoredLessonSchema).min(2).max(4),
  glossary: z.array(z.object({ term: text, definition: text }).strict()).min(5).max(20),
  sources: z.array(CourseSourceSchema).min(3).max(20),
  lab: z.object({
    title: text, purpose: text, prerequisites: z.array(text).min(2).max(8),
    costWarning: text, steps: z.array(text).min(4).max(12),
    expectedResults: z.array(text).min(2).max(6), cleanup: z.array(text).min(2).max(6),
  }).strict(),
}).strict();
export type AuthoredModule = z.infer<typeof AuthoredModuleSchema>;
export type AuthoredLesson = z.infer<typeof AuthoredLessonSchema>;
export const CourseLessonSchema = AuthoredLessonSchema.extend({
  revision: z.string().regex(/^[a-f0-9]{64}$/), wordCount: z.number().int().positive(),
  minutes: z.number().int().min(1).max(90),
});
export type CourseLesson = z.infer<typeof CourseLessonSchema>;
export const CourseModuleSchema = AuthoredModuleSchema.extend({
  lessons: z.array(CourseLessonSchema).min(2).max(4),
});
export type CourseModule = z.infer<typeof CourseModuleSchema>;
export const CourseSchema = z.object({
  schemaVersion: z.literal(1), id: z.literal("networking"), title: text,
  releaseId: z.string().regex(/^c_[a-f0-9]{64}$/), reviewedAt: z.string().date(),
  pathUrl: officialUrl, examGuideUrl: officialUrl, introduction: text,
  modules: z.array(CourseModuleSchema).length(8),
}).strict().superRefine((course, context) => {
  if (course.modules.some((module, index) => module.id !== NETWORKING_MODULE_IDS[index]) ||
      new Set(course.modules.flatMap((module) => module.lessons.map((lesson) => lesson.id))).size !==
        course.modules.reduce((sum, module) => sum + module.lessons.length, 0)) {
    context.addIssue({ code: "custom", message: "All eight modules and unique lesson IDs are required." });
  }
});
export type Course = z.infer<typeof CourseSchema>;
export const CoursePointerSchema = z.object({
  schemaVersion: z.literal(1), releaseId: z.string().regex(/^c_[a-f0-9]{64}$/),
  url: z.string().regex(/^courses\/c_[a-f0-9]{64}\/networking\.json$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  modules: z.literal(8), lessons: z.number().int().min(16).max(32),
  checkpoints: z.number().int().min(48).max(160),
}).strict().refine((pointer) => pointer.url === `courses/${pointer.releaseId}/networking.json`);

export function checkpointCorrect(checkpoint: CourseCheckpoint, selectedIds: readonly string[]) {
  return selectedIds.length === checkpoint.correctIds.length &&
    new Set(selectedIds).size === selectedIds.length &&
    selectedIds.every((choiceId) => checkpoint.correctIds.includes(choiceId));
}
