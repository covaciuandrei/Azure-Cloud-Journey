import {
  CLEAN_BANK_VERSION, CleanCatalogSchema, CleanDiscussionSchema, CleanDocumentSchema, CleanManifestSchema,
} from "../../src/domain/cleanBank.js";
import {
  DEMO_NOTICE, DEMO_QUESTION_COUNT, DemoLearningDatasetSchema, DemoLearningManifestSchema,
  DemoMetadataSchema, DemoTopicMapSchema,
} from "../../src/domain/demo.js";
import { LearningExplanationSchema } from "../../src/domain/learning.js";
import { TOPIC_GUIDE_URL, TOPIC_VERSION } from "../../src/domain/topics.js";
import { digest } from "../ingest/normalize-shared.js";
import { materializeLearningRelease } from "../learning/publication.js";
import { hash, json } from "../web/bank.js";

const cards = [
  ["destination mailbox", "blue", "green", "orange"],
  ["approved route label", "garden", "river", "hill"],
  ["fictional server name", "maple", "cedar", "birch"],
  ["permitted connection tag", "reading", "painting", "music"],
  ["selected gateway marker", "north", "south", "west"],
  ["target subnet label", "library", "kitchen", "workshop"],
  ["active rule name", "daylight", "moonlight", "starlight"],
  ["chosen endpoint alias", "notebook", "pencil", "ruler"],
  ["next-hop marker", "bridge", "tunnel", "ferry"],
  ["healthy service label", "violet", "amber", "silver"],
] as const;

const rich = (text: string) => [{ type: "text" as const, spans: [{ type: "text" as const, text, marks: [] }] }];

export function createDemoBank() {
  if (cards.length !== DEMO_QUESTION_COUNT) throw new Error("The demo must contain exactly ten original sample cards.");
  const sourceRevision = digest({ kind: "original-synthetic-demo", cards });
  const baseReleaseId = `r_${digest({ sourceRevision, version: 1 })}`;
  const documents = cards.map(([label, correct, ...distractors], index) => {
    const number = index + 1;
    const prompt = `Original sample ${number}. A fictional network card says its ${label} is "${correct}". Which entry matches that card? Use only this sentence, not assumptions about a real cloud service.`;
    const id = `q_${digest({ sourceRevision, number, prompt })}`;
    const revision = digest({ prompt, correct, distractors });
    // Legacy occurrence/provenance tokens are required by the existing strict bank format.
    // These records are original fixtures, not material obtained from that provider.
    const occurrence = `examprepper-45-q${String(number).padStart(6, "0")}`;
    const url = `https://example.invalid/azure-cloud-journey/original-demo/${number}`;
    const options = [correct, ...distractors].map((text) => ({
      id: `opt_${digest({ id, text })}`, content: rich(text),
    }));
    const value = { kind: "option-selection", optionIds: [options[0]!.id] };
    return CleanDocumentSchema.parse({
      schemaVersion: 1, releaseId: baseReleaseId,
      question: {
        schemaVersion: 1, id, sourceRevision: revision, kind: "single-select", prompt: rich(prompt),
        options, shuffle: { allowed: true }, fixedOptionOrder: options.map((option) => option.id),
        sourceOccurrenceIds: [occurrence], assetIds: [], commentCount: 0,
        readiness: { grading: "automatic" }, media: [],
        sources: [{ questionNumber: number, pageNumber: 1, url }],
      },
      answers: {
        schemaVersion: 1, id, questionId: id, sourceRevision: revision,
        originalAnswers: [{
          sourceOccurrenceId: occurrence, value,
          explanation: rich(`The fictional card explicitly names "${correct}" as its ${label}. This is original sample data, not an exam answer.`),
          answerAssetIds: [], provenance: { source: "examprepper", url },
        }],
        effectiveAnswer: { value }, provisional: false,
      },
      discussionEnabled: false,
    });
  });
  const counts = {
    questions: documents.length, comments: 0, images: 0, automatic: documents.length,
    manual: 0, omittedComments: 0, sourceQuestions: documents.length, duplicatesGrouped: 0,
  };
  const catalog = CleanCatalogSchema.parse({
    schemaVersion: 1, bankVersion: CLEAN_BANK_VERSION, releaseId: baseReleaseId, sourceRevision, counts,
    questions: documents.map((document, index) => ({
      id: document.question.id, number: index + 1, kind: document.question.kind,
      grading: "automatic", provisional: false, commentCount: 0, omittedCommentCount: 0,
      hasImages: false, preview: `Original sample ${index + 1}: identify the ${cards[index]![0]}.`,
      searchText: `Original synthetic sample ${cards[index]!.join(" ")}`,
      sourceNumbers: [index + 1], discussionEnabled: false,
    })),
  });
  const discussions = documents.map((document) => CleanDiscussionSchema.parse({
    schemaVersion: 1, releaseId: baseReleaseId, questionId: document.question.id, comments: [],
  }));
  const explanations = documents.map((document, index) => {
    const [label, correct] = cards[index]!;
    const value = document.answers.effectiveAnswer.value;
    if (value.kind !== "option-selection") throw new Error("Demo cards require an automatic choice key.");
    return LearningExplanationSchema.parse({
      schemaVersion: 1, questionId: document.question.id, questionSourceRevision: document.question.sourceRevision,
      originalKeyDigest: digest(value), status: "supported", concept: "Read an explicitly stated fictional network label",
      summary: `The fictional card names "${correct}" as its ${label}. Matching that exact value is the complete task. No Azure subscription, cloud knowledge, or external reference is required to solve this deliberately simple sample.`,
      reasoning: [
        `First identify the field requested by the prompt, which is the ${label}. Then read the value supplied in the same sentence. The sample gives every fact needed for the answer, so there is no reason to invent configuration details or assume that the fictional names represent an actual deployed environment.`,
        `Choose the entry whose text matches "${correct}". The app may shuffle the displayed choices, but the stored answer follows the choice identity rather than its position or letter. Submitting the response demonstrates local scoring and explanation rendering without reproducing third-party questions, images, comments, or answer keys.`,
      ],
      correctOptionIds: value.optionIds,
      options: document.question.options.map((option, position) => ({
        optionId: option.id, verdict: position === 0 ? "correct" : "incorrect",
        explanation: position === 0
          ? `This entry matches the value "${correct}" stated directly on the fictional card. That explicit match is all the sample requires.`
          : `This entry does not match the value "${correct}" supplied by the fictional card. Its plausibility as a label does not change the given facts.`,
      })),
      answerParts: [],
      takeaway: "Use this sample to explore shuffled choices, feedback, saved browser progress, and review. It is not an assessment of certification readiness; the separate authored course contains the actual teaching.",
      caveat: "Original synthetic demonstration only. The documentation link is background reading for the accompanying course, not evidence that these invented labels describe a real service.",
      sources: [{
        url: "https://learn.microsoft.com/en-us/training/paths/az-104-manage-virtual-networks/",
        title: "Networking learning path, background reading",
        supports: "Background for the separate authored course only. The sample answer is established entirely by its fictional prompt.",
      }],
    });
  });
  const dataset = DemoLearningDatasetSchema.parse({
    schemaVersion: 1, baseReleaseId, sourceRevision, explanations,
    releaseId: `r_${digest({ base: baseReleaseId, explanations })}`,
  });
  const release = materializeLearningRelease({ catalog, documents, discussions }, dataset);
  const releaseId = release.catalog.releaseId;
  const manifest = CleanManifestSchema.parse({
    schemaVersion: 1, bankVersion: CLEAN_BANK_VERSION, releaseId, sourceRevision,
    approvedCommentsDigest: hash(JSON.stringify([])), counts,
    catalogUrl: `content/${releaseId}/catalog.json`,
    questionBaseUrl: `content/${releaseId}/questions/`,
    discussionBaseUrl: `content/${releaseId}/discussions/`,
    mediaBaseUrl: `content/${releaseId}/media/`,
  });
  const learning = DemoLearningManifestSchema.parse({
    schemaVersion: 1, releaseId, baseReleaseId, sourceRevision,
    records: Object.fromEntries(explanations.map((explanation) => [explanation.questionId, {
      sha256: hash(json(explanation)), sourceRevisions: [explanation.questionSourceRevision],
    }])),
  });
  const topics = DemoTopicMapSchema.parse({
    schemaVersion: 1, taxonomyVersion: TOPIC_VERSION, guideUrl: TOPIC_GUIDE_URL, sourceRevision,
    assignments: Object.fromEntries(documents.map((document) => [
      document.question.id, ["virtual-networks", "network-security", "dns-load-balancing"],
    ])),
  });
  const metadata = DemoMetadataSchema.parse({
    schemaVersion: 1, kind: "original-synthetic-demo", notice: DEMO_NOTICE,
    questions: DEMO_QUESTION_COUNT, releaseId,
  });
  const files = new Map<string, unknown>([
    ["data/demo.json", metadata], ["data/manifest.json", manifest],
    ["data/topics.json", topics], ["data/learning.json", learning],
    [manifest.catalogUrl, release.catalog],
  ]);
  for (const document of release.documents) files.set(`${manifest.questionBaseUrl}${document.question.id}.json`, document);
  for (const discussion of release.discussions) files.set(`${manifest.discussionBaseUrl}${discussion.questionId}.json`, discussion);
  for (const explanation of explanations) files.set(`teaching/${releaseId}/questions/${explanation.questionId}.json`, explanation);
  return { manifest, release, dataset, learning, topics, metadata, files };
}
