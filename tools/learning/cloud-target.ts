import { STUDY_CURRENT_BANK_PATH, STUDY_LEARNING_PATH } from "../../src/domain/cloud.js";
import { loadCleanTarget } from "../publish/clean-sync.js";
import { uploadPlanInternals } from "../publish/plan.js";
import { loadStudyPublication } from "./publication.js";

export async function learningCloudTarget(workspace = process.cwd()) {
  const publication = await loadStudyPublication(workspace);
  const current = publication.releases.find((release) => release.catalog.releaseId === publication.manifest.releaseId)!;
  const immutable = new Map<string, Record<string, unknown>>();
  const add = (path: string, data: Record<string, unknown>) => {
    uploadPlanInternals.documentOperation("stage", path, data);
    immutable.set(path, data);
  };
  const releaseId = current.catalog.releaseId;
  add(`studyReleases/${releaseId}/catalogs/az104`, current.catalog);
  for (const document of current.documents) add(`studyReleases/${releaseId}/questions/${document.question.id}`, document);
  for (const [id, explanation] of publication.explanations) {
    add(`studyExplanations/${publication.learning.releaseId}/questions/${id}`, explanation);
  }
  const pointers = new Map<string, Record<string, unknown>>([
    [STUDY_CURRENT_BANK_PATH, { schemaVersion: 1, releaseId, sourceRevision: publication.manifest.sourceRevision }],
    [STUDY_LEARNING_PATH, publication.learning],
  ]);
  for (const [path, data] of pointers) uploadPlanInternals.documentOperation("stage", path, data);
  if (immutable.size !== current.documents.length + publication.explanations.size + 1 ||
      current.documents.length !== publication.manifest.counts.questions ||
      publication.explanations.size !== 606 || pointers.size !== 2) {
    throw new Error("The active cloud target must match the reviewed catalog and preserve historical explanations.");
  }
  return { publication, immutable, pointers };
}

export async function loadCurrentStudyTarget() {
  const target = await loadCleanTarget();
  const learning = await learningCloudTarget();
  for (const [path, value] of [...learning.immutable, ...learning.pointers]) target.set(path, value);
  return target;
}
