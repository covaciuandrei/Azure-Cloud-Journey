import {
  CleanCatalogSchema, CleanDiscussionSchema, CleanDocumentSchema, CleanManifestSchema,
  CleanQuestionSchema, assertDiscussionThreads,
} from "../domain/cleanBank.js";
import {
  Sc900CatalogSchema, Sc900DiscussionSchema, Sc900DocumentSchema, Sc900ManifestSchema,
  Sc900QuestionSchema,
} from "../domain/sc900Bank.js";
import { ExamIdSchema, type ExamId } from "../domain/exams.js";
import type { StudyDiscussion } from "./types.js";

export function bankContract(examId: ExamId) {
  ExamIdSchema.parse(examId);
  return examId === "sc900" ? {
    manifest: Sc900ManifestSchema, catalog: Sc900CatalogSchema,
    document: Sc900DocumentSchema, question: Sc900QuestionSchema, discussion: Sc900DiscussionSchema,
  } : {
    manifest: CleanManifestSchema, catalog: CleanCatalogSchema,
    document: CleanDocumentSchema, question: CleanQuestionSchema, discussion: CleanDiscussionSchema,
  };
}

export function validateDiscussionThreads(value: StudyDiscussion): void {
  assertDiscussionThreads(value);
}
