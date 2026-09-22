import { z } from "zod";
import { CleanReleaseIdSchema } from "./cleanBank.js";
import { Sha256Schema, TimestampSchema } from "./schemas.js";

export const Sc900AvailabilitySchema = z.discriminatedUnion("activated", [
  z.object({
    schemaVersion: z.literal(1), examId: z.literal("sc900"), activated: z.literal(false),
  }).strict(),
  z.object({
    schemaVersion: z.literal(1), examId: z.literal("sc900"), activated: z.literal(true),
    kind: z.enum(["approved-source", "original-synthetic-demo"]),
    bankReleaseId: CleanReleaseIdSchema,
    courseReleaseId: z.string().regex(/^c_[a-f0-9]{64}$/),
    sourceCaptureDigest: Sha256Schema,
    approvedBy: z.string().trim().min(1),
    approvedAt: TimestampSchema,
  }).strict(),
]);

export const SC900_INACTIVE = {
  schemaVersion: 1, examId: "sc900", activated: false,
} as const;
export const SC900_UNAVAILABLE_NOTICE =
  "SC-900 is not available yet. Its complete authorized question capture, explanations, and original course must pass independent review before activation.";
