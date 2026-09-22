import { z } from "zod";
import { QuestionIdSchema, Sha256Schema } from "./schemas.js";
import { SC900_BANK_VERSION, Sc900ReleaseIdSchema } from "./sc900Bank.js";
import { SC900_TOPIC_IDS, Sc900TopicIdSchema } from "./courseCatalog.js";

export { SC900_TOPIC_IDS, Sc900TopicIdSchema };
export const SC900_TOPIC_GUIDE_URL = "https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/sc-900";
export const SC900_TOPIC_VERSION = "sc900-domains-v1" as const;
export const Sc900TopicSelectionSchema = z.array(Sc900TopicIdSchema).min(1).max(3)
  .refine((ids) => new Set(ids).size === ids.length, "SC900 topics must be unique");
export const SC900_TOPIC_GROUPS = [
  { id: "sc-concepts", label: "Security, compliance, and identity concepts", topics: [
    { id: "sc-security-concepts", label: "Security and compliance concepts" },
    { id: "sc-identity-concepts", label: "Identity concepts" },
  ] },
  { id: "sc-entra", label: "Microsoft Entra capabilities", topics: [
    { id: "sc-entra-types", label: "Microsoft Entra capabilities" },
    { id: "sc-entra-authentication", label: "Authentication" },
    { id: "sc-entra-access", label: "Access management" },
    { id: "sc-entra-governance", label: "Identity protection and governance" },
  ] },
  { id: "sc-security", label: "Microsoft security solutions", topics: [
    { id: "sc-infrastructure-security", label: "Azure security capabilities" },
    { id: "sc-cloud-security-posture", label: "Microsoft Defender for Cloud" },
    { id: "sc-sentinel", label: "Microsoft Sentinel" },
    { id: "sc-defender-xdr", label: "Microsoft Defender XDR" },
  ] },
  { id: "sc-compliance", label: "Microsoft compliance solutions", topics: [
    { id: "sc-trust-privacy", label: "Trust and privacy" },
    { id: "sc-compliance-management", label: "Compliance management" },
    { id: "sc-information-protection", label: "Microsoft Purview data protection" },
    { id: "sc-risk-discovery-audit", label: "Microsoft Purview risk and governance" },
  ] },
] as const;

export const Sc900TopicMapSchema = z.object({
  schemaVersion: z.literal(1),
  examId: z.literal("sc900"),
  bankVersion: z.literal(SC900_BANK_VERSION),
  releaseId: Sc900ReleaseIdSchema,
  taxonomyVersion: z.literal(SC900_TOPIC_VERSION),
  guideUrl: z.literal(SC900_TOPIC_GUIDE_URL),
  sourceRevision: Sha256Schema,
  assignments: z.record(QuestionIdSchema, Sc900TopicSelectionSchema),
}).strict().refine((value) => Object.keys(value.assignments).length > 0, "SC900 topic coverage cannot be empty");

export type Sc900TopicId = z.infer<typeof Sc900TopicIdSchema>;
export type Sc900TopicMap = z.infer<typeof Sc900TopicMapSchema>;

export function sc900TopicLabel(id: Sc900TopicId): string {
  const topic = SC900_TOPIC_GROUPS.flatMap((group) => [...group.topics]).find((item) => item.id === id);
  if (!topic) throw new Error("Unknown SC900 topic");
  return topic.label;
}
