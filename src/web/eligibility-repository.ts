import { EligibilityPolicySchema, retirementFor, type EligibilityPolicy } from "../domain/eligibility.js";
import type { StudyCatalog, StudyDocument, StudyRepository } from "./types.js";

export function httpEligibilityLoader(baseUrl: string, fetcher: typeof fetch = fetch) {
  const base = new URL(baseUrl);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password) throw new Error("Invalid relevance-policy origin.");
  return async () => {
    const response = await fetcher(new URL("data/eligibility.json", base).href, {
      cache: "no-store", credentials: "same-origin", redirect: "error",
    });
    if (!response.ok) throw new Error("The current question list could not be loaded. Retry online or update the offline download.");
    try { return await response.json(); }
    catch { throw new Error("The relevance policy is unavailable in this copy. Update the app or offline download."); }
  };
}

export function withCurrentQuestions(repository: StudyRepository, readPolicy: () => Promise<unknown>): StudyRepository {
  let pending: Promise<EligibilityPolicy> | undefined;
  const policy = () => {
    if (!pending) {
      const next = readPolicy().then((value) => EligibilityPolicySchema.parse(value));
      pending = next;
      void next.catch(() => { if (pending === next) pending = undefined; });
    }
    return pending;
  };
  const currentCatalog = async (catalog: StudyCatalog) => {
    const eligibility = await policy();
    const active = new Set(eligibility.activeQuestionIds);
    const reviewed = new Set(eligibility.reviewedQuestionIds);
    if (catalog.releaseId !== eligibility.releaseId && catalog.releaseId !== eligibility.teachingReleaseId) {
      throw new Error("This copy predates the current study answers. Update the offline download or reload online.");
    }
    const questions = catalog.questions.filter((question) => active.has(question.id));
    if (catalog.sourceRevision !== eligibility.sourceRevision || questions.length !== active.size ||
        catalog.questions.some((question) => !reviewed.has(question.id)) ||
        questions.some((question) => retirementFor(eligibility, {
          id: question.id, sources: (question.sourceNumbers ?? [question.number]).map((questionNumber) => ({ questionNumber })),
        }))) throw new Error("The relevance policy does not match the question bank.");
    return { ...catalog, questions, counts: eligibility.activeCounts };
  };
  const mark = async (document: StudyDocument): Promise<StudyDocument> => {
    const retired = retirementFor(await policy(), document.question);
    return retired ? { ...document, retirement: retired } : document;
  };
  return {
    ...repository,
    async loadCatalog(releaseId) {
      const catalog = await repository.loadCatalog(releaseId);
      return releaseId === undefined ? currentCatalog(catalog) : catalog;
    },
    async loadQuestion(id, releaseId) {
      if (releaseId === undefined && !(await policy()).activeQuestionIds.includes(id)) {
        throw new Error("This question has been retired from the current study bank.");
      }
      return mark(await repository.loadQuestion(id, releaseId));
    },
    async loadQuestions(ids, releaseId) {
      if (releaseId === undefined) {
        const active = new Set((await policy()).activeQuestionIds);
        if (ids.some((id) => !active.has(id))) throw new Error("This selection includes a retired question.");
      }
      return Promise.all((await repository.loadQuestions(ids, releaseId)).map(mark));
    },
  };
}
