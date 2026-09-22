import { z } from "zod";

export const EXAM_IDS = ["az104", "sc900"] as const;
export const ExamIdSchema = z.enum(EXAM_IDS);
export type ExamId = z.infer<typeof ExamIdSchema>;

export const EXAMS = {
  az104: {
    id: "az104", code: "AZ-104", title: "Azure Administrator",
    basePath: "", manifestPath: "data/manifest.json",
    mockQuestionCount: 40, mockDurationMinutes: 60,
    freeSizes: [10, 20, 30, 40],
    bankMetadataPath: "studyMetadata/az104Bank",
    topicsMetadataPath: "studyMetadata/az104Topics",
    learningMetadataPath: "studyMetadata/az104Learning",
  },
  sc900: {
    id: "sc900", code: "SC-900", title: "Security, Compliance, and Identity Fundamentals",
    basePath: "exams/sc900/", manifestPath: "manifest.json",
    mockQuestionCount: 40, mockDurationMinutes: 45,
    freeSizes: [10, 20, 30, 40],
    bankMetadataPath: "studyMetadata/sc900Bank",
    topicsMetadataPath: "studyMetadata/sc900Topics",
    learningMetadataPath: "studyMetadata/sc900Learning",
  },
} as const;

export function examConfig(examId: ExamId) {
  return EXAMS[ExamIdSchema.parse(examId)];
}

// Call only after parsing a legacy-compatible schema, never on arbitrary input.
export function examIdOf(value: { examId?: ExamId | undefined }): ExamId {
  return value.examId === undefined ? "az104" : ExamIdSchema.parse(value.examId);
}

export function assertExam(value: { examId?: ExamId | undefined }, expected: ExamId): void {
  if (examIdOf(value) !== ExamIdSchema.parse(expected)) {
    throw new Error(`The data belongs to a different exam, not ${examConfig(expected).code}.`);
  }
}

export function examBaseUrl(base: string, examId: ExamId): string {
  const url = new URL(base);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Invalid exam data base URL.");
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return new URL(examConfig(examId).basePath, url).href;
}
