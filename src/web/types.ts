import type {
  CleanAnswer, CleanCatalog, CleanDiscussion, CleanDocument, CleanManifest, CleanQuestion,
} from "../domain/cleanBank.js";
import type { StudyTopicId } from "../domain/examTopics.js";
import type { LearningExplanation } from "../domain/learning.js";
import type { Retirement } from "../domain/eligibility.js";
import type { ExamId } from "../domain/exams.js";
import type { Sc900DiscussionScope } from "../domain/sc900Scope.js";
import type { Sc900Retirement } from "../domain/sc900Eligibility.js";

export type StudyCounts = CleanManifest["counts"];
export type StudyManifest = Omit<CleanManifest, "bankVersion" | "approvedCommentsDigest"> & {
  bankVersion: string; examId?: ExamId; approvedCommentsDigest: string | null; discussionScope?: Sc900DiscussionScope | undefined;
};
export type QuestionSummary = CleanCatalog["questions"][number] & { topicIds?: StudyTopicId[] };
export type StudyCatalog = Omit<CleanCatalog, "questions" | "bankVersion"> & {
  bankVersion: string; examId?: ExamId; questions: QuestionSummary[]; discussionScope?: Sc900DiscussionScope | undefined;
};
export type StudyDocument = Omit<CleanDocument, "question"> & {
  question: StudyQuestion; examId?: ExamId; topicIds?: StudyTopicId[]; retirement?: Retirement | Sc900Retirement;
};
export type StudyDiscussion = CleanDiscussion & { examId?: ExamId; discussionScope?: Sc900DiscussionScope | undefined };
export type StudyQuestion = CleanQuestion & { examId?: ExamId; discussionScope?: Sc900DiscussionScope | undefined };
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
