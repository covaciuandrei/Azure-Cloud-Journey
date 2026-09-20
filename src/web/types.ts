import type {
  CleanAnswer, CleanCatalog, CleanDiscussion, CleanDocument, CleanManifest, CleanQuestion,
} from "../domain/cleanBank.js";
import type { TopicId } from "../domain/topics.js";
import type { LearningExplanation } from "../domain/learning.js";
import type { Retirement } from "../domain/eligibility.js";

export type StudyCounts = CleanManifest["counts"];
export type StudyManifest = CleanManifest;
export type QuestionSummary = CleanCatalog["questions"][number] & { topicIds?: TopicId[] };
export type StudyCatalog = Omit<CleanCatalog, "questions"> & { questions: QuestionSummary[] };
export type StudyDocument = CleanDocument & { topicIds?: TopicId[]; retirement?: Retirement };
export type StudyDiscussion = CleanDiscussion;
export type StudyQuestion = CleanQuestion;
export type StudyAnswer = CleanAnswer;
export interface StudyExplanation {
  explanation: LearningExplanation;
  currentReleaseId: string;
}

export interface StudyRepository {
  loadCatalog(releaseId?: string): Promise<StudyCatalog>;
  loadQuestion(id: string, releaseId?: string): Promise<StudyDocument>;
  loadQuestions(ids: readonly string[], releaseId?: string): Promise<StudyDocument[]>;
  loadDiscussion(id: string, releaseId?: string): Promise<StudyDiscussion>;
  mediaUrl(question: StudyQuestion, assetId: string, releaseId?: string): string;
  loadExplanation?(document: StudyDocument): Promise<StudyExplanation>;
}
