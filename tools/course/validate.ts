import { z } from "zod";
import { AuthoredModuleSchema, type AuthoredModule, type AuthoredLesson } from "../../src/domain/course.js";
import { readData, isMain } from "../review/data.js";

export const COURSE_SOURCE_DIRECTORY = "content/networking";

export const CurriculumSchema = z.object({
  pathUrl: z.string().url(), reviewedAt: z.string().date(),
  modules: z.array(z.object({
    id: AuthoredModuleSchema.shape.id, sourceModuleUrl: z.string().url(),
    lessonIds: z.array(z.string()).min(2).max(4), minimumWords: z.number().int().positive(),
  }).strict()).length(8),
}).strict();
export function teachingWordCount(lesson: AuthoredLesson): number {
  const strings: string[] = [];
  const visit = (value: unknown) => {
    if (typeof value === "string") strings.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") Object.values(value).forEach(visit);
  };
  visit(lesson.sections);
  return strings.join(" ").split(/\s+/).filter(Boolean).length;
}
export function validateModule(module: AuthoredModule): void {
  AuthoredModuleSchema.parse(module);
  const unique = (values: string[]) => new Set(values).size === values.length;
  if (!unique(module.sources.map((source) => source.id)) || !unique(module.sources.map((source) => source.url)) ||
      !unique(module.lessons.map((lesson) => lesson.id))) throw new Error(`${module.id}: duplicate sources or lessons.`);
  for (const lesson of module.lessons) {
    if (!unique(lesson.sections.map((section) => section.id)) || !unique(lesson.checkpoints.map((check) => check.id)) ||
        lesson.sourceIds.some((id) => !module.sources.some((source) => source.id === id))) {
      throw new Error(`${lesson.id}: section/checkpoint IDs or citations are invalid.`);
    }
    const blocks = lesson.sections.flatMap((section) => section.blocks);
    if (!blocks.some((block) => block.type === "example") || !blocks.some((block) => block.type === "prediction") ||
        !blocks.some((block) => block.type === "callout" && block.tone === "exam")) {
      throw new Error(`${lesson.id}: every lesson needs a worked example, prediction, and exam-relevant distinction.`);
    }
    if (teachingWordCount(lesson) < 650) throw new Error(`${lesson.id}: lesson is too thin for a self-contained explanation.`);
  }
  if (!module.lessons.some((lesson) => lesson.sections.some((section) => section.blocks.some((block) => block.type === "diagram")))) {
    throw new Error(`${module.id}: a module needs an explanatory diagram.`);
  }
}
export async function loadCourseModules(workspace = process.cwd(), only?: string) {
  const curriculum = await readData(`${COURSE_SOURCE_DIRECTORY}/curriculum.json`, CurriculumSchema, workspace);
  if (only && !curriculum.modules.some((module) => module.id === only)) throw new Error("Unknown curriculum module.");
  const modules: AuthoredModule[] = [];
  for (const expected of curriculum.modules.filter((module) => !only || module.id === only)) {
    const module = await readData(`${COURSE_SOURCE_DIRECTORY}/modules/${expected.id}.json`, AuthoredModuleSchema, workspace);
    validateModule(module);
    if (module.id !== expected.id || module.sourceModuleUrl !== expected.sourceModuleUrl ||
        JSON.stringify(module.lessons.map((lesson) => lesson.id)) !== JSON.stringify(expected.lessonIds)) {
      throw new Error(`${module.id}: module coverage does not match the curriculum.`);
    }
    const words = module.lessons.reduce((sum, lesson) => sum + teachingWordCount(lesson), 0);
    if (words < expected.minimumWords) throw new Error(`${module.id}: needs deeper teaching (${words}/${expected.minimumWords} words).`);
    modules.push(module);
  }
  return { curriculum, modules };
}
if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--module")) throw new Error("Usage: validate.ts [--module <id>]");
  const { modules } = await loadCourseModules(process.cwd(), args[1]);
  console.log(JSON.stringify(modules.map((module) => ({
    id: module.id, lessons: module.lessons.length, words: module.lessons.reduce((sum, lesson) => sum + teachingWordCount(lesson), 0),
    checkpoints: module.lessons.reduce((sum, lesson) => sum + lesson.checkpoints.length, 0),
  })), null, 2));
}
