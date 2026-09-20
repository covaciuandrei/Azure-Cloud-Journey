import type { Course, CourseModule } from "../../domain/course.js";
import type { CourseDomain } from "../../domain/courseCoverage.js";
import type { TopicId } from "../../domain/topics.js";
import { NETWORKING_MODULE_IDS } from "../../domain/courseCatalog.js";

const legacyPracticeTopics: Record<typeof NETWORKING_MODULE_IDS[number], TopicId[]> = {
  "virtual-networks": ["virtual-networks"], "network-security-groups": ["network-security"],
  "azure-dns": ["dns-load-balancing"], "vnet-peering": ["virtual-networks"], routing: ["virtual-networks"],
  "load-balancer": ["dns-load-balancing"], "application-gateway": ["dns-load-balancing"], "network-watcher": ["monitoring"],
};
export function modulePracticeTopics(module: CourseModule): TopicId[] {
  if ("practiceTopics" in module) return [...module.practiceTopics];
  const id = NETWORKING_MODULE_IDS.find((id) => id === module.id);
  if (!id) throw new Error(`Practice topics are missing for ${module.id}.`);
  return [...legacyPracticeTopics[id]];
}
export function courseDomains(course: Course): CourseDomain[] {
  return course.schemaVersion === 2 ? course.domains : [{
    id: "networking", title: "Networking", weight: { min: 15, max: 20 },
    moduleIds: course.modules.map((module) => module.id),
    practiceTopics: ["virtual-networks", "network-security", "dns-load-balancing", "monitoring"], objectives: [],
  }];
}
export function courseLabel(course: Course | null): string {
  return course?.id === "az104" ? "AZ-104 course" : course ? "Networking course" : "Learning course";
}
