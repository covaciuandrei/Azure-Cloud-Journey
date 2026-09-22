import { AuthoredModuleSchema, CourseSchema, type AuthoredModule } from "../src/domain/course.js";
import { DomainCoverageSchema } from "../src/domain/courseCoverage.js";
import { digest } from "../tools/ingest/normalize-shared.js";
import { loadFullCourseContract } from "../tools/course/contracts.js";
import { teachingWordCount } from "../tools/course/validate.js";
import { courseFixture } from "./course-fixture.js";

export async function fullCourseInputs(examId: "az104" | "sc900" = "az104") {
  const contract = await loadFullCourseContract(process.cwd(), examId);
  const template = courseFixture().modules[0]!;
  const modules: AuthoredModule[] = contract.curriculum.modules.map((expected) => AuthoredModuleSchema.parse({
    ...template, id: expected.id, sourceModuleUrl: expected.sourceModuleUrl,
    lessons: expected.lessonIds.map((id) => {
      const { revision: _revision, minutes: _minutes, wordCount: _words, ...lesson } = template.lessons[0]!;
      return {
        ...lesson, id, title: `Synthetic ${id}`,
        sections: lesson.sections.map((section, index) => ({
          ...section,
          blocks: [
            { type: "paragraph", text: `${id}: ` + ("This synthetic exercise uses colored tokens to demonstrate a reasoning process, not a real cloud service. Read the fictional requirements, compare the available choices, predict the result, and explain why the rejected alternative would not satisfy those requirements. ").repeat(10) },
            ...(index === 0 ? [{ type: "example", title: "A synthetic worked application", scenario: "A fictional puzzle requires two blue tokens.",
              steps: [{ action: "Select two blue tokens.", why: "Both match the stated color requirement." },
                { action: "Reject the red token.", why: "It does not match the fictional requirement." }],
              result: "The selected pair satisfies the fictional requirement without claiming a cloud fact." }]
              : index === 1 ? [{ type: "prediction", id: "predict-token", prompt: "Would a red token fit?", answer: "No.",
                explanation: "The fictional requirement explicitly asks for blue tokens." }]
              : index === 2 ? [{ type: "callout", tone: "exam", title: "Not exam material", text: "This tests software behavior, not certification readiness." }]
              : [{ type: "diagram", title: "Synthetic token flow", description: "The synthetic input flows to an output.",
                nodes: [{ id: "input", label: "Input", detail: "Two blue tokens", column: 0, row: 0 },
                  { id: "output", label: "Output", detail: "Accepted pair", column: 1, row: 0 }],
                edges: [{ from: "input", to: "output", label: "Validate" }] }]),
          ],
        })),
      };
    }),
  }));
  const coverage = contract.domains.map((domain) => {
    const module = modules.find((module) => module.id === domain.moduleIds[0])!;
    return DomainCoverageSchema.parse({
      schemaVersion: 1, domainId: domain.id, reviewedAt: "2026-09-20",
      objectives: domain.objectives.map((objective) => ({
        objectiveId: objective.id,
        lessons: [{
          moduleId: module.id, lessonId: module.lessons[0]!.id,
          sectionIds: ["section-1"], checkpointIds: ["check-1"],
          evidence: `Synthetic binding for ${objective.id}: the selected section contains a token-selection worked application and the cited checkpoint assesses that fictional decision. This fixture exercises contracts, not Azure teaching quality.`,
        }],
      })),
    });
  });
  return { ...contract, modules, coverage };
}

export async function fullCourseFixture() {
  const { curriculum, objectives, domains, modules, coverage } = await fullCourseInputs();
  const content = {
    schemaVersion: 2, id: "az104", title: curriculum.title, reviewedAt: curriculum.reviewedAt,
    pathUrl: curriculum.pathUrl, examGuideUrl: objectives.guideUrl, objectiveEffectiveDate: objectives.effectiveDate,
    introduction: "Synthetic full-course fixture. This is not authored teaching and must never be published.",
    domains, coverage, modules: modules.map((module) => {
      const entry = curriculum.modules.find((entry) => entry.id === module.id)!;
      return { ...module, domainId: entry.domainId, practiceTopics: entry.practiceTopics,
        lessons: module.lessons.map((lesson) => ({ ...lesson, revision: digest(lesson), wordCount: teachingWordCount(lesson), minutes: 16 })) };
    }),
  };
  const course = CourseSchema.parse({ ...content, releaseId: `c_${digest(content)}` });
  if (course.schemaVersion !== 2) throw new Error("Expected full-course fixture.");
  return course;
}
