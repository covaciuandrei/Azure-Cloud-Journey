import { z } from "zod";
import { TopicIdSchema, TOPIC_GROUPS, TOPIC_IDS, topicLabel, type TopicId } from "./topics.js";
import {
  SC900_TOPIC_GROUPS, SC900_TOPIC_IDS, Sc900TopicIdSchema, sc900TopicLabel, type Sc900TopicId,
} from "./sc900Topics.js";
import { ExamIdSchema, type ExamId } from "./exams.js";

export type StudyTopicId = TopicId | Sc900TopicId;
export function topicIdsForExam(examId: ExamId): readonly StudyTopicId[] {
  return ExamIdSchema.parse(examId) === "sc900" ? SC900_TOPIC_IDS : TOPIC_IDS;
}
export function topicGroupsForExam(examId: ExamId): ReadonlyArray<{
  id: string; label: string; topics: ReadonlyArray<{ id: StudyTopicId; label: string }>;
}> {
  return ExamIdSchema.parse(examId) === "sc900" ? SC900_TOPIC_GROUPS : TOPIC_GROUPS;
}
export function parseTopicSelection(value: unknown, examId: ExamId): StudyTopicId[] {
  return z.array(ExamIdSchema.parse(examId) === "sc900" ? Sc900TopicIdSchema : TopicIdSchema)
    .refine((ids) => new Set(ids).size === ids.length, "Topics must be unique.").parse(value);
}
export { matchesTopics as matchesStudyTopics } from "./topics.js";
export function studyTopicLabel(id: StudyTopicId): string {
  const sc900 = Sc900TopicIdSchema.safeParse(id);
  return sc900.success ? sc900TopicLabel(sc900.data) : topicLabel(TopicIdSchema.parse(id));
}
