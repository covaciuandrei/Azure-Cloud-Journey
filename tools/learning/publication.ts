import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import {
  CleanCatalogSchema, CleanDocumentSchema, CleanDiscussionSchema, CleanManifestSchema,
  type CleanDocument, type CleanManifest,
} from "../../src/domain/cleanBank.js";
import {
  LearningDatasetSchema, LearningManifestSchema, type LearningDataset, type LearningExplanation, type LearningManifest,
} from "../../src/domain/learning.js";
import { digest } from "../ingest/normalize-shared.js";
import { readData, readOptionalData } from "../review/data.js";
import { loadCleanBank, type CleanBank, type CleanRelease, hash, json } from "../web/bank.js";
import { validateExplanation } from "./validate.js";
import { EligibilityIdSchema, EligibilityPolicySchema, type EligibilityPolicy } from "../../src/domain/eligibility.js";
import { materializeEligibleRelease } from "../eligibility/policy.js";

export type PublicationFile = { kind: "source"; path: string } | { kind: "json"; value: unknown };
export interface StudyPublication {
  source: CleanBank;
  manifest: CleanManifest;
  releases: CleanRelease[];
  files: Map<string, PublicationFile>;
  learning: LearningManifest;
  explanations: Map<string, LearningExplanation>;
  eligibility?: EligibilityPolicy;
}

export function materializeLearningRelease(base: CleanRelease, dataset: LearningDataset): CleanRelease {
  if (dataset.baseReleaseId !== base.catalog.releaseId || dataset.sourceRevision !== base.catalog.sourceRevision) {
    throw new Error("Teaching content belongs to another source bank.");
  }
  const explanations = new Map(dataset.explanations.map((item) => [item.questionId, item]));
  const documents = base.documents.map((original) => {
    const explanation = explanations.get(original.question.id);
    if (!explanation) throw new Error("A current question has no teaching explanation.");
    validateExplanation(explanation, original);
    const value = structuredClone(original);
    value.releaseId = dataset.releaseId;
    value.question.media = value.question.media.map((media) => ({
      ...media, objectPath: media.objectPath.replace(base.catalog.releaseId, dataset.releaseId),
    }));
    const uncertain = ["conditional", "outdated", "incomplete"].includes(explanation.status);
    value.answers.provisional = uncertain || (value.question.readiness.grading === "manual" && explanation.status === "corrected");
    if (explanation.status === "corrected" && value.answers.effectiveAnswer.value.kind === "option-selection") {
      if (!explanation.correctOptionIds?.length) throw new Error("A corrected choice key needs explicit option identities.");
      value.answers.effectiveAnswer = { value: { kind: "option-selection", optionIds: [...explanation.correctOptionIds] } };
    }
    return CleanDocumentSchema.parse(value);
  });
  const byId = new Map(documents.map((document) => [document.question.id, document]));
  const catalog = CleanCatalogSchema.parse({
    ...base.catalog, releaseId: dataset.releaseId,
    questions: base.catalog.questions.map((summary) => ({
      ...summary, provisional: byId.get(summary.id)!.answers.provisional,
    })),
  });
  const discussions = base.discussions.map((discussion) =>
    CleanDiscussionSchema.parse({ ...discussion, releaseId: dataset.releaseId }));
  return { catalog, documents, discussions };
}

export async function publicationFileBytes(file: PublicationFile): Promise<Buffer> {
  return file.kind === "source" ? readFile(file.path) : Buffer.from(json(file.value));
}

export async function loadStudyPublication(workspace = process.cwd()): Promise<StudyPublication> {
  const source = await loadCleanBank(workspace);
  const current = await readData(".data/learning/current.json", z.object({
    releaseId: z.string().regex(/^r_[a-f0-9]{64}$/),
  }).strict(), workspace);
  const base = source.releases.find((release) => release.catalog.releaseId === source.manifest.releaseId)!;
  const folders = await readdir(resolve(workspace, ".data/learning/releases"));
  if (!folders.includes(current.releaseId)) throw new Error("The current teaching release is missing.");
  const generated: Array<{ dataset: LearningDataset; release: CleanRelease }> = [];
  for (const name of folders.sort()) {
    if (!/^r_[a-f0-9]{64}$/.test(name)) throw new Error("Unexpected teaching release directory.");
    const dataset = await readData(`.data/learning/releases/${name}/dataset.json`, LearningDatasetSchema, workspace);
    if (dataset.releaseId !== name || source.releases.some((release) => release.catalog.releaseId === name) ||
        name !== `r_${digest({ base: dataset.baseReleaseId, explanations: dataset.explanations })}`) {
      throw new Error("Teaching release identity or content digest does not match.");
    }
    generated.push({ dataset, release: materializeLearningRelease(base, dataset) });
  }
  const active = generated.find((entry) => entry.dataset.releaseId === current.releaseId)!;
  const files = new Map<string, PublicationFile>();
  for (const path of source.files) {
    if (path === "data/approved-comments.json") continue;
    files.set(path, { kind: "source", path: resolve(source.directory, path) });
  }
  const revisions = new Map<string, Set<string>>();
  for (const release of source.releases) {
    for (const document of release.documents) {
      const values = revisions.get(document.question.id) ?? new Set<string>();
      values.add(document.question.sourceRevision);
      revisions.set(document.question.id, values);
    }
  }
  let learning: LearningManifest | undefined;
  for (const { dataset, release } of generated) {
    const prefix = `content/${dataset.releaseId}`;
    files.set(`${prefix}/catalog.json`, { kind: "json", value: release.catalog });
    for (const document of release.documents) files.set(`${prefix}/questions/${document.question.id}.json`, { kind: "json", value: document });
    for (const discussion of release.discussions) files.set(`${prefix}/discussions/${discussion.questionId}.json`, { kind: "json", value: discussion });
    for (const path of source.files.filter((path) => path.startsWith(`content/${dataset.baseReleaseId}/media/`))) {
      files.set(path.replace(dataset.baseReleaseId, dataset.releaseId), { kind: "source", path: resolve(source.directory, path) });
    }
    const records: Record<string, { sha256: string; sourceRevisions: string[] }> = {};
    for (const explanation of dataset.explanations) {
      const allowed = revisions.get(explanation.questionId);
      if (!allowed?.has(explanation.questionSourceRevision)) throw new Error("Unknown explanation source revision.");
      const sourceDocument = source.releases.flatMap((candidate) => candidate.documents).find((document) =>
        document.question.id === explanation.questionId && document.question.sourceRevision === explanation.questionSourceRevision);
      if (!sourceDocument) throw new Error("The explanation source question is missing.");
      validateExplanation(explanation, sourceDocument);
      const path = `teaching/${dataset.releaseId}/questions/${explanation.questionId}.json`;
      files.set(path, { kind: "json", value: explanation });
      records[explanation.questionId] = { sha256: hash(json(explanation)), sourceRevisions: [...allowed].sort() };
    }
    const index = LearningManifestSchema.parse({
      schemaVersion: 1, releaseId: dataset.releaseId, baseReleaseId: dataset.baseReleaseId,
      sourceRevision: dataset.sourceRevision, records,
    });
    files.set(`teaching/${dataset.releaseId}/manifest.json`, { kind: "json", value: index });
    if (dataset.releaseId === current.releaseId) learning = index;
  }
  if (!learning) throw new Error("The current teaching index could not be generated.");
  const eligibilityPointer = await readOptionalData(".data/eligibility/current.json", z.object({
    policyId: EligibilityIdSchema,
  }).strict(), workspace);
  const eligibleReleases: CleanRelease[] = [];
  let eligibility: EligibilityPolicy | undefined;
  if (eligibilityPointer) {
    const policies = await readdir(resolve(workspace, ".data/eligibility/releases"));
    for (const name of policies.sort()) {
      if (!/^e_[a-f0-9]{64}\.json$/.test(name)) throw new Error("Unexpected eligibility policy file.");
      const policy = await readData(`.data/eligibility/releases/${name}`, EligibilityPolicySchema, workspace);
      if (`${policy.policyId}.json` !== name) throw new Error("Eligibility policy file identity differs.");
      const teaching = generated.find((entry) => entry.dataset.releaseId === policy.teachingReleaseId);
      if (!teaching) throw new Error("The reviewed teaching release is unavailable.");
      const release = materializeEligibleRelease(teaching.release, policy);
      eligibleReleases.push(release);
      const prefix = `content/${release.catalog.releaseId}`;
      files.set(`${prefix}/catalog.json`, { kind: "json", value: release.catalog });
      for (const document of release.documents) files.set(`${prefix}/questions/${document.question.id}.json`, { kind: "json", value: document });
      for (const discussion of release.discussions) files.set(`${prefix}/discussions/${discussion.questionId}.json`, { kind: "json", value: discussion });
      for (const path of source.files.filter((path) => path.startsWith(`content/${source.manifest.releaseId}/media/`))) {
        files.set(path.replace(source.manifest.releaseId, release.catalog.releaseId), {
          kind: "source", path: resolve(source.directory, path),
        });
      }
      if (policy.policyId === eligibilityPointer.policyId) eligibility = policy;
    }
    if (!eligibility || eligibility.teachingReleaseId !== current.releaseId) {
      throw new Error("The current teaching release needs a matching relevance review before publication.");
    }
    files.set("data/eligibility.json", { kind: "json", value: eligibility });
  }
  const releaseId = eligibility?.releaseId ?? current.releaseId;
  const manifest = CleanManifestSchema.parse({
    ...source.manifest, releaseId, counts: eligibility?.activeCounts ?? active.release.catalog.counts,
    catalogUrl: `content/${releaseId}/catalog.json`,
    questionBaseUrl: `content/${releaseId}/questions/`,
    discussionBaseUrl: `content/${releaseId}/discussions/`,
    mediaBaseUrl: `content/${releaseId}/media/`,
  });
  files.set("data/manifest.json", { kind: "json", value: manifest });
  files.set("data/learning.json", { kind: "json", value: learning });
  return {
    source, manifest, learning,
    explanations: new Map(active.dataset.explanations.map((item) => [item.questionId, item])),
    releases: [
      ...eligibleReleases.filter((release) => release.catalog.releaseId === releaseId),
      ...eligibleReleases.filter((release) => release.catalog.releaseId !== releaseId),
      active.release, ...generated.filter((entry) => entry !== active).map((entry) => entry.release), ...source.releases,
    ],
    files,
    ...(eligibility ? { eligibility } : {}),
  };
}
