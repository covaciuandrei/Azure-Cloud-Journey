import { z } from "zod";
import { CleanReleaseIdSchema } from "./cleanBank.js";
import { LearningDatasetSchema, LearningManifestSchema } from "./learning.js";
import { TopicMapSchema } from "./topics.js";

export const DEMO_QUESTION_COUNT = 10;
export const DEMO_NOTICE = "Public demo: 10 original synthetic practice questions, not exam questions. The active authored course is included; see its overview for the published learning scope. Sign-in, cloud sync and offline downloads are disabled; progress stays in this browser.";
export const DEMO_AUTH_ERROR = "Sign-in is disabled in the public demo. Continue as a guest; no Firebase services are contacted.";

// The production schemas retain their exact 606-question contracts.
export const DemoLearningDatasetSchema = z.object({
  ...LearningDatasetSchema.shape,
  explanations: LearningDatasetSchema.shape.explanations.element.array().length(DEMO_QUESTION_COUNT),
}).strict().refine((value) => new Set(value.explanations.map((item) => item.questionId)).size === DEMO_QUESTION_COUNT);
export const DemoLearningManifestSchema = z.object(LearningManifestSchema.shape).strict()
  .refine((value) => Object.keys(value.records).length === DEMO_QUESTION_COUNT);
export const DemoTopicMapSchema = z.object(TopicMapSchema.shape).strict()
  .refine((value) => Object.keys(value.assignments).length === DEMO_QUESTION_COUNT);
export const DemoMetadataSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("original-synthetic-demo"),
  notice: z.literal(DEMO_NOTICE),
  questions: z.literal(DEMO_QUESTION_COUNT),
  releaseId: CleanReleaseIdSchema,
}).strict();
