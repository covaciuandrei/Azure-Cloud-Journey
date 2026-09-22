import { EligibilityPolicySchema, type EligibilityPolicy } from "../domain/eligibility.js";
import type { StudyCatalog, StudyDocument, StudyRepository } from "./types.js";
import { Sc900EligibilityPolicySchema, type Sc900EligibilityPolicy } from "../domain/sc900Eligibility.js";
import { assertExam, examBaseUrl, type ExamId } from "../domain/exams.js";
import { loadSc900Manifest } from "./sc900-http.js";

export function httpEligibilityLoader(baseUrl: string, fetcher: typeof fetch = fetch, examId: ExamId = "az104") {
  const base = new URL(examBaseUrl(baseUrl, examId));
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password) throw new Error("Invalid relevance-policy origin.");
  return async () => {
    const path = examId === "sc900"
      ? `content/${(await loadSc900Manifest(baseUrl, fetcher)).releaseId}/eligibility.json` : "data/eligibility.json";
    const response = await fetcher(new URL(path, base).href, {
      cache: "no-store", credentials: "same-origin", redirect: "error",
    });
    if (!response.ok) throw new Error("The current question list could not be loaded. Retry online or update the offline download.");
    try { return await response.json(); }
    catch { throw new Error("The relevance policy is unavailable in this copy. Update the app or offline download."); }
  };
}

export function withCurrentQuestions(repository: StudyRepository, readPolicy: () => Promise<unknown>): StudyRepository {
  const examId = repository.examId ?? "az104";
  let pending: Promise<EligibilityPolicy | Sc900EligibilityPolicy> | undefined;
  const retirementFor = (policy: EligibilityPolicy | Sc900EligibilityPolicy,
    question: { id: string; sources: { questionNumber: number }[] }) =>
    policy.retired.find((item) => item.questionId === question.id ||
      question.sources.some((source) => item.sourceNumbers.includes(source.questionNumber)));
  const policy = () => {
    if (!pending) {
      const next = readPolicy().then((value) => {
        const parsed = (examId === "sc900" ? Sc900EligibilityPolicySchema : EligibilityPolicySchema).parse(value);
        assertExam(parsed, examId);
        return parsed;
      });
      pending = next;
      void next.catch(() => { if (pending === next) pending = undefined; });
    }
    return pending;
  };
  const currentCatalog = async (catalog: StudyCatalog) => {
    assertExam(catalog, examId);
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
    assertExam(document, examId);
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
