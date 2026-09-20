import { CourseSchema, NETWORKING_MODULE_IDS, type Course } from "../src/domain/course.js";

export function courseFixture(): Course {
  return CourseSchema.parse({
    schemaVersion: 1, id: "networking", title: "Synthetic networking course", reviewedAt: "2026-09-20",
    releaseId: `c_${"a".repeat(64)}`,
    pathUrl: "https://learn.microsoft.com/en-us/training/paths/az-104-manage-virtual-networks/",
    examGuideUrl: "https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/az-104",
    introduction: "Synthetic test content, never published as a real Azure lesson.",
    modules: NETWORKING_MODULE_IDS.map((id, index) => ({
      schemaVersion: 1, id, title: `Test module ${index + 1}`, summary: "A synthetic module for application contract tests.",
      priority: "core", priorityReason: "A fixture used to validate UI and state, not an exam priority claim.",
      sourceModuleUrl: `https://learn.microsoft.com/en-us/training/modules/${id}/`,
      reviewedAt: "2026-09-20", officialObjectives: ["Test one objective", "Test another objective"],
      lessons: [1, 2].map((number) => ({
        id: `lesson-${index}-${number}`, title: `Lesson ${index + 1}.${number}`,
        summary: "A synthetic lesson summary for reader and storage tests.",
        objectives: ["Understand the fixture", "Keep old progress isolated"],
        revision: "b".repeat(64), wordCount: 1000, minutes: 12,
        sections: [1, 2, 3, 4].map((section) => ({
          id: `section-${section}`, title: `Section ${section}`,
          blocks: [{ type: "paragraph", text: "This is only synthetic test prose; no cloud facts are being asserted." }],
        })),
        checkpoints: [1, 2, 3].map((question) => ({
          id: `check-${question}`, kind: "single", prompt: "Select the fixture's correct value.",
          choices: [
            { id: "correct", text: "Expected value", explanation: "This is correct by construction of the synthetic fixture." },
            { id: "wrong-one", text: "Wrong value one", explanation: "This is a rejected synthetic fixture choice." },
            { id: "wrong-two", text: "Wrong value two", explanation: "This is also a rejected synthetic fixture choice." },
          ], correctIds: ["correct"], explanation: "The synthetic fixture requires exactly the expected value.",
        })),
        takeaways: ["Takeaway one", "Takeaway two", "Takeaway three"], sourceIds: ["reference-one"],
      })),
      glossary: [1, 2, 3, 4, 5].map((term) => ({ term: `Term ${term}`, definition: "Synthetic definition." })),
      sources: [1, 2, 3].map((source) => ({
        id: ["reference-one", "reference-two", "reference-three"][source - 1], title: `Test reference ${source}`,
        url: `https://learn.microsoft.com/en-us/azure/virtual-network/test-${source}`,
        supports: "Synthetic citation binding only, not published teaching.",
      })),
      lab: {
        title: "Synthetic optional lab", purpose: "Exercise the UI's cost and cleanup presentation.",
        prerequisites: ["A test context", "No live credentials"], costWarning: "Do not provision anything for this fixture.",
        steps: ["Read", "Predict", "Observe", "Compare"], expectedResults: ["One result", "Another result"],
        cleanup: ["Close the owned test context", "Keep unrelated data"],
      },
    })),
  });
}
