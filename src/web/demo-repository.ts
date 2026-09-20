import { DEMO_QUESTION_COUNT, DemoLearningManifestSchema, DemoMetadataSchema, DemoTopicMapSchema } from "../domain/demo.js";
import { createStudyRepository } from "./data.js";
import { httpLearningReader, withLearningExplanations } from "./learning-repository.js";
import { withQuestionTopics } from "./topic-repository.js";
import type { StudyRepository } from "./types.js";

export function createDemoRepository(base: string, fetcher: typeof fetch = fetch): StudyRepository {
  const read = async (path: string): Promise<unknown> => {
    const response = await fetcher(new URL(path, base).href, {
      cache: "no-store", credentials: "same-origin", redirect: "error",
    });
    if (!response.ok) throw new Error("Demo content is missing. Run npm run demo:prepare.");
    return response.json();
  };
  let topics: Promise<ReturnType<typeof DemoTopicMapSchema.parse>> | undefined;
  const repository = withLearningExplanations(withQuestionTopics(createStudyRepository(base, fetcher), () => {
    if (!topics) {
      const pending = read("data/topics.json").then((value) => DemoTopicMapSchema.parse(value));
      topics = pending;
      void pending.catch(() => { if (topics === pending) topics = undefined; });
    }
    return topics;
  }), httpLearningReader(base, fetcher), DemoLearningManifestSchema);
  return {
    ...repository,
    async loadCatalog(releaseId) {
      const [catalog, metadata] = await Promise.all([
        repository.loadCatalog(releaseId), read("data/demo.json").then((value) => DemoMetadataSchema.parse(value)),
      ]);
      if (catalog.releaseId !== metadata.releaseId || catalog.counts.questions !== DEMO_QUESTION_COUNT ||
          catalog.counts.comments !== 0 || catalog.counts.images !== 0) {
        throw new Error("This is not the original synthetic demo bank.");
      }
      return catalog;
    },
  };
}
