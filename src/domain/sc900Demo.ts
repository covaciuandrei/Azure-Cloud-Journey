import { z } from "zod";
import { CleanReleaseIdSchema } from "./cleanBank.js";

export const SC900_DEMO_NOTICE =
  "SC-900 source demo: 10 original synthetic sample questions, not captured exam questions. No production question bank is included. Accounts, cloud sync and offline downloads are disabled.";
export const Sc900DemoMetadataSchema = z.object({
  schemaVersion: z.literal(1), examId: z.literal("sc900"),
  kind: z.literal("original-synthetic-demo"), questions: z.literal(10),
  notice: z.literal(SC900_DEMO_NOTICE), releaseId: CleanReleaseIdSchema,
}).strict();
