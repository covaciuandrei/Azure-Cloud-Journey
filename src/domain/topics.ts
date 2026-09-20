import { z } from "zod";

export const TOPIC_GUIDE_URL = "https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/az-104";
export const TOPIC_VERSION = "az104-2026-04-17-v1";
export const TOPIC_IDS = [
  "entra-users-groups", "access-rbac", "governance",
  "storage-access", "storage-accounts", "files-blobs",
  "arm-bicep", "virtual-machines", "containers", "app-service",
  "virtual-networks", "network-security", "dns-load-balancing",
  "monitoring", "backup-recovery",
] as const;
export const TopicIdSchema = z.enum(TOPIC_IDS);
export type TopicId = z.infer<typeof TopicIdSchema>;
export const TopicSelectionSchema = z.array(TopicIdSchema).refine((ids) => new Set(ids).size === ids.length, "Topics must be unique.");

export const TOPIC_GROUPS: ReadonlyArray<{
  id: string; label: string; topics: ReadonlyArray<{ id: TopicId; label: string }>;
}> = [
  { id: "identity-governance", label: "Identity and governance", topics: [
    { id: "entra-users-groups", label: "Entra users and groups" },
    { id: "access-rbac", label: "Access control and roles" },
    { id: "governance", label: "Subscriptions, policy, locks and costs" },
  ] },
  { id: "storage", label: "Storage", topics: [
    { id: "storage-access", label: "Storage access and security" },
    { id: "storage-accounts", label: "Storage accounts and redundancy" },
    { id: "files-blobs", label: "Azure Files and Blob Storage" },
  ] },
  { id: "compute", label: "Compute", topics: [
    { id: "arm-bicep", label: "ARM templates and Bicep" },
    { id: "virtual-machines", label: "Virtual machines and scale sets" },
    { id: "containers", label: "Containers and registries" },
    { id: "app-service", label: "App Service" },
  ] },
  { id: "networking", label: "Networking", topics: [
    { id: "virtual-networks", label: "Virtual networks and routing" },
    { id: "network-security", label: "Network security and private access" },
    { id: "dns-load-balancing", label: "DNS and load balancing" },
  ] },
  { id: "monitoring-recovery", label: "Monitoring and recovery", topics: [
    { id: "monitoring", label: "Azure Monitor and troubleshooting" },
    { id: "backup-recovery", label: "Backup and disaster recovery" },
  ] },
];

export function topicLabel(id: TopicId): string {
  const topic = TOPIC_GROUPS.flatMap((group) => group.topics).find((item) => item.id === id);
  if (!topic) throw new Error("Unknown topic.");
  return topic.label;
}

export const TopicMapSchema = z.object({
  schemaVersion: z.literal(1),
  taxonomyVersion: z.literal(TOPIC_VERSION),
  guideUrl: z.literal(TOPIC_GUIDE_URL),
  sourceRevision: z.string().regex(/^[a-f0-9]{64}$/),
  assignments: z.record(z.string().regex(/^q_[a-f0-9]{64}$/), TopicSelectionSchema.refine((ids) => ids.length >= 1 && ids.length <= 3)),
}).strict().refine((value) => Object.keys(value.assignments).length === 606, "Every source question identity needs topics.");
export type TopicMap = z.infer<typeof TopicMapSchema>;

export function matchesTopics(topicIds: readonly TopicId[] | undefined, selected: readonly TopicId[]): boolean {
  if (!topicIds?.length) throw new Error("Question topic classification is missing.");
  return topicIds.some((id) => selected.includes(id));
}
