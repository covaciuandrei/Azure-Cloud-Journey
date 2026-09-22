import { z } from "zod";
import { TopicIdSchema } from "./topics.js";

export const NETWORKING_MODULE_IDS = [
  "virtual-networks", "network-security-groups", "azure-dns", "vnet-peering",
  "routing", "load-balancer", "application-gateway", "network-watcher",
] as const;
export const AZ104_MODULE_IDS = [
  "entra-identities", "azure-access-control", "azure-governance",
  "storage-accounts", "storage-access", "blob-and-file-data",
  "infrastructure-as-code", "virtual-machines", "azure-containers", "azure-app-service",
  ...NETWORKING_MODULE_IDS, "azure-monitor", "azure-backup", "site-recovery",
] as const;
export const COURSE_DOMAIN_IDS = [
  "identity-governance", "storage", "compute", "networking", "monitoring-recovery",
] as const;
export const SC900_DOMAIN_IDS = ["sc-concepts", "sc-entra", "sc-security", "sc-compliance"] as const;
export const SC900_OBJECTIVE_DATE_NOTICE = "Microsoft's English guide currently publishes objectives effective October 21, 2026. That date is in the future relative to this review. The certification page explicitly announces the upcoming update. Do not label this outline as already effective or retire otherwise useful current questions solely because of this future outline.";
export const SC900_MODULE_LESSONS = {
  "sc-security-foundations": ["sc-shared-responsibility-and-defense", "sc-zero-trust-crypto-and-grc"],
  "sc-identity-foundations": ["sc-identity-authentication-authorization", "sc-directories-providers-federation"],
  "sc-entra-identities": ["sc-entra-tenants-and-identity-types", "sc-hybrid-and-workload-identities"],
  "sc-authentication-access": ["sc-authentication-mfa-passwords", "sc-conditional-access-and-roles"],
  "sc-identity-governance": ["sc-access-lifecycle-reviews-pim", "sc-identity-risk-and-protection"],
  "sc-infrastructure-protection": ["sc-segmentation-firewalls-ddos", "sc-safe-admin-and-key-vault"],
  "sc-defender-cloud": ["sc-cloud-posture-and-recommendations", "sc-workload-protection-and-alerts"],
  "sc-sentinel-operations": ["sc-siem-data-detection-incidents", "sc-soar-hunting-response"],
  "sc-defender-xdr": ["sc-xdr-email-endpoint-identity", "sc-cloud-apps-vulnerabilities-intelligence", "sc-defender-portal-investigation"],
  "sc-trust-compliance": ["sc-trust-privacy-and-evidence", "sc-purview-compliance-manager-score"],
  "sc-information-lifecycle": ["sc-classification-labels-and-explorers", "sc-data-loss-prevention", "sc-retention-records-and-lifecycle"],
  "sc-insider-discovery-audit": ["sc-insider-risk-and-investigations", "sc-ediscovery-audit-and-evidence"],
} as const;
export const SC900_MODULE_IDS = Object.keys(SC900_MODULE_LESSONS) as (keyof typeof SC900_MODULE_LESSONS)[];
export const SC900_DOMAIN_MODULES = {
  "sc-concepts": SC900_MODULE_IDS.slice(0, 2),
  "sc-entra": SC900_MODULE_IDS.slice(2, 5),
  "sc-security": SC900_MODULE_IDS.slice(5, 9),
  "sc-compliance": SC900_MODULE_IDS.slice(9),
} as const;
export const SC900_TOPIC_IDS = [
  "sc-security-concepts", "sc-identity-concepts", "sc-entra-types", "sc-entra-authentication",
  "sc-entra-access", "sc-entra-governance", "sc-infrastructure-security", "sc-cloud-security-posture",
  "sc-sentinel", "sc-defender-xdr", "sc-trust-privacy", "sc-compliance-management",
  "sc-information-protection", "sc-risk-discovery-audit",
] as const;
export const SC900_MODULE_TOPICS = {
  "sc-security-foundations": ["sc-security-concepts"],
  "sc-identity-foundations": ["sc-identity-concepts"],
  "sc-entra-identities": ["sc-entra-types"],
  "sc-authentication-access": ["sc-entra-authentication", "sc-entra-access"],
  "sc-identity-governance": ["sc-entra-governance"],
  "sc-infrastructure-protection": ["sc-infrastructure-security"],
  "sc-defender-cloud": ["sc-cloud-security-posture"],
  "sc-sentinel-operations": ["sc-sentinel"],
  "sc-defender-xdr": ["sc-defender-xdr"],
  "sc-trust-compliance": ["sc-trust-privacy", "sc-compliance-management"],
  "sc-information-lifecycle": ["sc-information-protection"],
  "sc-insider-discovery-audit": ["sc-risk-discovery-audit"],
} as const satisfies Record<typeof SC900_MODULE_IDS[number], ReadonlyArray<typeof SC900_TOPIC_IDS[number]>>;
export const Sc900TopicIdSchema = z.enum(SC900_TOPIC_IDS);
export const CoursePracticeTopicSchema = z.union([TopicIdSchema, Sc900TopicIdSchema]);
export type CoursePracticeTopic = z.infer<typeof CoursePracticeTopicSchema>;
export const CoursePracticeTopicsSchema = z.array(CoursePracticeTopicSchema).min(1)
  .refine((values) => new Set(values).size === values.length, "Topics must be unique.");
export const CourseModuleIdSchema = z.enum([...AZ104_MODULE_IDS, ...SC900_MODULE_IDS]);
export const CourseDomainIdSchema = z.enum([...COURSE_DOMAIN_IDS, ...SC900_DOMAIN_IDS]);
export const CourseIdSchema = z.enum(["networking", "az104", "sc900"]);
export type CourseId = z.infer<typeof CourseIdSchema>;
export type CourseDomainId = z.infer<typeof CourseDomainIdSchema>;
export const MAX_COURSE_BYTES = 4 * 1024 * 1024;
export const courseText = z.string().trim().min(1).max(8000).refine((value) =>
  !/\u2014|&mdash;|&#8212;|&#x2014;/i.test(value), "Do not use em dashes.");
export const courseId = z.string().regex(/^[a-z][a-z0-9-]{2,79}$/);
export const officialCourseUrl = z.string().url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password &&
    (url.hostname === "microsoft.com" || url.hostname.endsWith(".microsoft.com"));
}, "Use an official Microsoft reference.");

const objectiveRanges: Record<CourseDomainId, readonly [string, number]> = {
  "identity-governance": ["ig", 15], storage: ["st", 17], compute: ["co", 24],
  networking: ["nw", 13], "monitoring-recovery": ["mo", 13],
  "sc-concepts": ["sc-f", 11], "sc-entra": ["sc-i", 12],
  "sc-security": ["sc-s", 21], "sc-compliance": ["sc-c", 14],
};
export function objectiveIdsFor(domainId: CourseDomainId): string[] {
  const [prefix, count] = objectiveRanges[domainId];
  return Array.from({ length: count }, (_, index) => `${prefix}-${String(index + 1).padStart(2, "0")}`);
}

export function courseContentPath(courseId: CourseId, releaseId: string): string {
  return courseId === "sc900" ? `exams/sc900/course/releases/${releaseId}/sc900.json`
    : `courses/${releaseId}/${courseId}.json`;
}
export function coursePointerPath(examId: "az104" | "sc900" = "az104"): string {
  return examId === "sc900" ? "exams/sc900/course/current.json" : "data/course.json";
}
