import { z } from "zod";

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
export const CourseModuleIdSchema = z.enum(AZ104_MODULE_IDS);
export const CourseDomainIdSchema = z.enum(COURSE_DOMAIN_IDS);
export const CourseIdSchema = z.enum(["networking", "az104"]);
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
};
export function objectiveIdsFor(domainId: CourseDomainId): string[] {
  const [prefix, count] = objectiveRanges[domainId];
  return Array.from({ length: count }, (_, index) => `${prefix}-${String(index + 1).padStart(2, "0")}`);
}
