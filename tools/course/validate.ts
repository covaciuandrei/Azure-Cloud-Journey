import { AuthoredModuleSchema, type AuthoredModule, type AuthoredLesson } from "../../src/domain/course.js";
import { CourseDomainIdSchema, CourseIdSchema, CourseModuleIdSchema, type CourseId, type CourseDomainId } from "../../src/domain/courseCatalog.js";
import { DomainCoverageSchema, validateCoverageReferences } from "../../src/domain/courseCoverage.js";
import { readData, isMain } from "../review/data.js";
import { activeCourseId, CurriculumSchema, loadFullCourseContract } from "./contracts.js";

export const COURSE_SOURCE_DIRECTORY = "content/networking";

export { CurriculumSchema } from "./contracts.js";
export interface CourseSelection { course?: CourseId; module?: string; domain?: CourseDomainId }
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
    if (!unique(lesson.sections.map((section) => section.id)) || !unique(lesson.checkpoints.map((check) => check.id)) || !unique(lesson.sourceIds) ||
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
export async function loadCourseModules(workspace = process.cwd(), selection: CourseSelection | string = {}) {
  const options = typeof selection === "string" ? { module: selection } : selection;
  if (options.module && options.domain) throw new Error("Choose a module or a domain, not both.");
  const courseId = options.course ?? (options.module || options.domain ? "az104" : await activeCourseId(workspace));
  const full = courseId === "az104" ? await loadFullCourseContract(workspace) : null;
  const curriculum = full?.curriculum ?? await readData(`${COURSE_SOURCE_DIRECTORY}/curriculum.json`, CurriculumSchema, workspace);
  if (options.module && !curriculum.modules.some((module) => module.id === options.module)) throw new Error("Unknown curriculum module.");
  if (options.domain && (!full || !full.domains.some((domain) => domain.id === options.domain))) throw new Error("Unknown curriculum domain.");
  const selectedIds = options.domain ? full!.domains.find((domain) => domain.id === options.domain)!.moduleIds : null;
  const modules: AuthoredModule[] = [];
  for (const expected of curriculum.modules.filter((module) =>
    (!options.module || module.id === options.module) && (!selectedIds || selectedIds.includes(module.id)))) {
    const path = full ? full.curriculum.modules.find((module) => module.id === expected.id)!.sourcePath
      : `${COURSE_SOURCE_DIRECTORY}/modules/${expected.id}.json`;
    const module = await readData(path, AuthoredModuleSchema, workspace);
    validateModule(module);
    if (module.id !== expected.id || module.sourceModuleUrl !== expected.sourceModuleUrl ||
        JSON.stringify(module.lessons.map((lesson) => lesson.id)) !== JSON.stringify(expected.lessonIds)) {
      throw new Error(`${module.id}: module coverage does not match the curriculum.`);
    }
    const words = module.lessons.reduce((sum, lesson) => sum + teachingWordCount(lesson), 0);
    if (words < expected.minimumWords) throw new Error(`${module.id}: needs deeper teaching (${words}/${expected.minimumWords} words).`);
    modules.push(module);
  }
  return { courseId, curriculum, modules, full };
}

export async function loadCourseCoverage(workspace: string, modules: AuthoredModule[], onlyDomain?: CourseDomainId) {
  const { domains } = await loadFullCourseContract(workspace);
  const selected = domains.filter((domain) => !onlyDomain || domain.id === onlyDomain);
  const coverage = [];
  for (const domain of selected) {
    const map = await readData(`content/az104/coverage/${domain.id}.json`, DomainCoverageSchema, workspace);
    const required = new Set(map.objectives.flatMap((objective) => objective.lessons.map((target) => target.moduleId)));
    const available = [...modules];
    for (const id of required) {
      if (!available.some((module) => module.id === id)) {
        available.push(...(await loadCourseModules(workspace, { course: "az104", module: id })).modules);
      }
    }
    validateCoverageReferences(map, domain, available);
    coverage.push(map);
  }
  return coverage;
}

export function parseCourseSelection(args: string[]): CourseSelection {
  const options: CourseSelection = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === "--course" && !options.course) options.course = CourseIdSchema.parse(value);
    else if (flag === "--module" && !options.module) options.module = CourseModuleIdSchema.parse(value);
    else if (flag === "--domain" && !options.domain) options.domain = CourseDomainIdSchema.parse(value);
    else throw new Error("Usage: validate.ts [--course networking|az104] [--module <id> | --domain <id>]");
  }
  if (options.module && options.domain) throw new Error("Choose a module or a domain, not both.");
  return options;
}
if (isMain(import.meta.url)) {
  const options = parseCourseSelection(process.argv.slice(2));
  const { modules, courseId } = await loadCourseModules(process.cwd(), options);
  if (courseId === "az104" && !options.module) await loadCourseCoverage(process.cwd(), modules, options.domain);
  console.log(JSON.stringify(modules.map((module) => ({
    id: module.id, lessons: module.lessons.length, words: module.lessons.reduce((sum, lesson) => sum + teachingWordCount(lesson), 0),
    checkpoints: module.lessons.reduce((sum, lesson) => sum + lesson.checkpoints.length, 0),
  })), null, 2));
}
