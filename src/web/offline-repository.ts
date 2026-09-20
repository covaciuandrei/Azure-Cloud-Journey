import type { StudyDocument, StudyRepository } from "./types.js";

export function createOfflineAwareRepository(
  primary: StudyRepository,
  downloaded: StudyRepository,
  useDownload: () => boolean,
  localBaseUrl: string,
): StudyRepository {
  const owners = new WeakMap<StudyDocument["question"], StudyRepository>();
  const choose = () => useDownload() ? downloaded : primary;
  const load = async <T>(read: (repository: StudyRepository) => Promise<T>): Promise<{ value: T; owner: StudyRepository }> => {
    const owner = choose();
    try { return { value: await read(owner), owner }; }
    catch (error) {
      if (owner === primary && owner !== downloaded && useDownload()) {
        return { value: await read(downloaded), owner: downloaded };
      }
      throw error;
    }
  };
  return {
    async loadExplanation(document) {
      return (await load((repository) => {
        if (!repository.loadExplanation) throw new Error("Teaching explanations are unavailable for this source.");
        return repository.loadExplanation(document);
      })).value;
    },
    async loadCatalog(releaseId) { return (await load((repository) => repository.loadCatalog(releaseId))).value; },
    async loadQuestion(id, releaseId) {
      const { value, owner } = await load((repository) => repository.loadQuestion(id, releaseId));
      owners.set(value.question, owner);
      return value;
    },
    async loadQuestions(ids, releaseId) {
      const { value, owner } = await load((repository) => repository.loadQuestions(ids, releaseId));
      value.forEach((document) => owners.set(document.question, owner));
      return value;
    },
    async loadDiscussion(id, releaseId) {
      return (await load((repository) => repository.loadDiscussion(id, releaseId))).value;
    },
    mediaUrl(question, assetId, releaseId) {
      const owner = owners.get(question);
      if (!owner) throw new Error("Load the question before resolving downloaded images.");
      const original = new URL(owner.mediaUrl(question, assetId, releaseId));
      return useDownload() ? new URL(original.pathname, localBaseUrl).href : original.href;
    },
  };
}
