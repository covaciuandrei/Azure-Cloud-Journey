import type {
  CleanAnswer, CleanCatalog, CleanDiscussion, CleanDocument, CleanManifest, CleanQuestion,
} from "../domain/cleanBank.js";
import type { StudyTopicId } from "../domain/examTopics.js";
import type { LearningExplanation } from "../domain/learning.js";
import type { Retirement } from "../domain/eligibility.js";
import type { ExamId } from "../domain/exams.js";

export type StudyCounts = CleanManifest["counts"];
export type StudyManifest = Omit<CleanManifest, "bankVersion"> & { bankVersion: string; examId?: ExamId };
export type QuestionSummary = CleanCatalog["questions"][number] & { topicIds?: StudyTopicId[] };
export type StudyCatalog = Omit<CleanCatalog, "questions" | "bankVersion"> & {
  bankVersion: string; examId?: ExamId; questions: QuestionSummary[];
};
export type StudyDocument = CleanDocument & { examId?: ExamId; topicIds?: StudyTopicId[]; retirement?: Retirement };
export type StudyDiscussion = CleanDiscussion & { examId?: ExamId };
export type StudyQuestion = CleanQuestion & { examId?: ExamId };
export type StudyAnswer = CleanAnswer;
export interface StudyExplanation {
  explanation: LearningExplanation;
  currentReleaseId: string;
}

export interface StudyRepository {
  readonly examId?: ExamId;
  loadCatalog(releaseId?: string): Promise<StudyCatalog>;
  loadQuestion(id: string, releaseId?: string): Promise<StudyDocument>;
  loadQuestions(ids: readonly string[], releaseId?: string): Promise<StudyDocument[]>;
  loadDiscussion(id: string, releaseId?: string): Promise<StudyDiscussion>;
  mediaUrl(question: StudyQuestion, assetId: string, releaseId?: string): string;
  loadExplanation?(document: StudyDocument): Promise<StudyExplanation>;
}
