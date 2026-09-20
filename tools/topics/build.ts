import { z } from "zod";
import { loadCleanBank } from "../web/bank.js";
import { readData, readOptionalData, writeData } from "../review/data.js";
import { TOPIC_GROUPS, TOPIC_IDS, TOPIC_GUIDE_URL, TOPIC_VERSION, TopicIdSchema, TopicMapSchema, TopicSelectionSchema } from "../../src/domain/topics.js";

const ClassificationSchema = z.object({
  id: z.string().regex(/^q_[a-f0-9]{64}$/),
  number: z.number().int().min(1).max(606),
  primaryTopicId: TopicIdSchema,
  topicIds: TopicSelectionSchema.refine((ids) => ids.length >= 1 && ids.length <= 3),
  confidence: z.enum(["high", "medium", "low"]),
  rationale: z.string().min(5).max(600),
}).strict().refine((item) => item.topicIds[0] === item.primaryTopicId);
const BatchSchema = z.object({ batch: z.number().int().min(1).max(4), assignments: z.array(ClassificationSchema).length(151) }).strict();

const bank = await loadCleanBank();
const current = bank.releases.find((release) => release.catalog.releaseId === bank.manifest.releaseId)!;
const ordered = [...current.documents].sort((a, b) => a.question.sources[0]!.questionNumber - b.question.sources[0]!.questionNumber);
const classifications = new Map<string, z.infer<typeof ClassificationSchema>>();
for (let batch = 1; batch <= 4; batch++) {
  const data = await readData(`.data/topics/batch-${batch}.result.json`, BatchSchema);
  if (data.batch !== batch) throw new Error("Classification batch identity mismatch.");
  const expected = new Map(ordered.slice((batch - 1) * 151, batch * 151).map(({ question }) =>
    [question.id, Math.min(...question.sources.map((source) => source.questionNumber))]));
  for (const item of data.assignments) {
    if (expected.get(item.id) !== item.number || classifications.has(item.id)) throw new Error(`Unexpected or duplicate topic assignment: ${item.number}`);
    classifications.set(item.id, item);
  }
  if (new Set(data.assignments.map((item) => item.id)).size !== expected.size) throw new Error("Incomplete classification batch.");
}
const overrides = await readOptionalData(".data/topics/overrides.json", z.array(z.object({
  number: ClassificationSchema.shape.number,
  topicIds: TopicSelectionSchema.refine((ids) => ids.length >= 1 && ids.length <= 3),
  confidence: z.enum(["high", "medium", "low"]),
  rationale: z.string().min(5).max(600),
}).strict()).refine((rows) => new Set(rows.map((row) => row.number)).size === rows.length)) ?? [];
for (const correction of overrides) {
  const existing = [...classifications.values()].find((item) => item.number === correction.number);
  if (!existing) throw new Error("Unknown topic override.");
  const override = ClassificationSchema.parse({ ...existing, ...correction, primaryTopicId: correction.topicIds[0] });
  classifications.set(existing.id, override);
}
if (classifications.size !== 604) throw new Error("Every practice question must be classified.");
const bySource = new Map<number, string[]>();
const assignments: Record<string, string[]> = {};
for (const { question } of current.documents) {
  const topics = classifications.get(question.id)!.topicIds;
  assignments[question.id] = topics;
  for (const source of question.sources) bySource.set(source.questionNumber, topics);
}
for (const release of bank.releases) {
  for (const { question } of release.documents) {
    const topicSets = question.sources.map((source) => bySource.get(source.questionNumber));
    if (topicSets.some((ids) => !ids || JSON.stringify(ids) !== JSON.stringify(topicSets[0]))) {
      throw new Error("Duplicate source topics are inconsistent.");
    }
    assignments[question.id] = topicSets[0]!;
  }
}
const map = TopicMapSchema.parse({
  schemaVersion: 1, taxonomyVersion: TOPIC_VERSION, guideUrl: TOPIC_GUIDE_URL,
  sourceRevision: bank.manifest.sourceRevision,
  assignments: Object.fromEntries(Object.entries(assignments).sort(([a], [b]) => a.localeCompare(b))),
});
await writeData(".data/topics/topic-map.json", map);
const rows = [...classifications.values()].sort((a, b) => a.number - b.number);
await writeData(".data/topics/classification-report.json", {
  taxonomyVersion: TOPIC_VERSION, guideUrl: TOPIC_GUIDE_URL,
  practiceQuestions: rows.length, sourceIdentities: Object.keys(map.assignments).length,
  topicCounts: Object.fromEntries(TOPIC_IDS.map((id) => [id, rows.filter((row) => row.topicIds.includes(id)).length])),
  domainCounts: Object.fromEntries(TOPIC_GROUPS.map((group) => [group.id,
    rows.filter((row) => group.topics.some((topic) => row.topicIds.includes(topic.id))).length])),
  confidence: Object.fromEntries(["high", "medium", "low"].map((level) => [level, rows.filter((row) => row.confidence === level).length])),
  lowConfidence: rows.filter((row) => row.confidence === "low"),
  multiTopic: rows.filter((row) => row.topicIds.length > 1).map((row) => ({ number: row.number, topics: row.topicIds })),
  assignments: rows,
});
console.log(JSON.stringify({ practiceQuestions: rows.length, sourceIdentities: Object.keys(map.assignments).length,
  lowConfidence: rows.filter((row) => row.confidence === "low").map((row) => row.number) }, null, 2));
