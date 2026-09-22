import {
  SC900_BANK_VERSION, Sc900CatalogSchema, Sc900DocumentSchema, Sc900ManifestSchema,
} from "../../src/domain/sc900Bank.js";
import { Sc900LearningExplanationSchema, Sc900LearningManifestSchema } from "../../src/domain/sc900Learning.js";
import { SC900_TOPIC_GUIDE_URL, SC900_TOPIC_VERSION, Sc900TopicMapSchema } from "../../src/domain/sc900Topics.js";
import { Sc900DemoMetadataSchema, SC900_DEMO_NOTICE } from "../../src/domain/sc900Demo.js";
import { sc900Hash, sc900OptionId, sc900QuestionId, byteSha256 } from "../sc900/canonical.js";
import { json } from "../web/bank.js";

const cards = [
  ["A school gate checks that a visitor really is the named person. It has not decided which rooms that person may enter.", "Authentication", "Authorization", "Retention", "sc-identity-concepts"],
  ["After checking identity, a school system decides whether the teacher may edit a class record.", "Authorization", "Authentication", "Hashing", "sc-entra-access"],
  ["A temporary helper needs to read one timetable today. The school grants only that permission for the required time.", "Least privilege", "Permanent administrator access", "Disabling sign-in", "sc-entra-access"],
  ["A school protects a room with a locked building entrance, a separate room lock, and monitoring. One failed control does not remove every other control.", "Defense in depth", "A single shared password", "Removing all logs", "sc-security-concepts"],
  ["A fictional service agreement assigns building maintenance to the provider and user access decisions to the school. Both parties still have security duties.", "Shared responsibility", "No customer responsibility", "No provider responsibility", "sc-security-concepts"],
  ["A program compares a file's freshly computed digest with a trusted digest to detect changes. The digest is not a key that decrypts the file.", "Hashing for an integrity comparison", "Decrypting the file", "Granting a user role", "sc-security-concepts"],
  ["A teacher transforms a private message so someone needs the correct decryption key to read its contents.", "Encryption", "A public file name", "An access review meeting", "sc-security-concepts"],
  ["A fictional security console collects events from several systems and relates suspicious activity across those events.", "SIEM-style event correlation", "Deleting every event", "Only changing display colors", "sc-sentinel"],
  ["A school policy detects a student record being sent to an unapproved recipient and blocks that disclosure.", "Data loss prevention", "Publishing every student record", "Disabling the policy", "sc-information-protection"],
  ["A school must preserve a record for a specified period. This requirement concerns how long the record is kept, not how its contents are encrypted.", "Retention", "Password length", "Network address assignment", "sc-information-protection"],
] as const;
const rich = (text: string) => [{ type: "text" as const, spans: [{ type: "text" as const, text, marks: [] }] }];

export function createSc900DemoBank() {
  const sourceRevision = sc900Hash("synthetic-demo", cards);
  const releaseId = `r_${sc900Hash("synthetic-demo-release", { sourceRevision, version: 1 })}`;
  const documents = cards.map(([scenario, correct, ...rest], index) => {
    const [wrong1, wrong2] = rest;
    const number = index + 1;
    const prompt = rich(`Original synthetic SC-900 sample ${number}. ${scenario} Which description matches this scenario?`);
    const options = [correct, wrong1, wrong2].map((text) => ({ id: sc900OptionId(rich(text)), content: rich(text) }));
    const id = sc900QuestionId({ kind: "single-select", prompt, options });
    const revision = sc900Hash("synthetic-demo-question", { prompt, options });
    // Provider tokens are format compatibility only; every sentence is an original fixture.
    const occurrence = `examprepper-128-q${String(number).padStart(6, "0")}`;
    const url = `https://example.invalid/original-sc900-demo/${number}`;
    const value = { kind: "option-selection", optionIds: [options[0]!.id] };
    return Sc900DocumentSchema.parse({
      schemaVersion: 1, examId: "sc900", releaseId,
      question: {
        schemaVersion: 1, examId: "sc900", id, sourceRevision: revision, kind: "single-select",
        prompt, options, shuffle: { allowed: true }, fixedOptionOrder: options.map((option) => option.id),
        sourceOccurrenceIds: [occurrence], assetIds: [], commentCount: 0,
        readiness: { grading: "automatic" }, media: [], sources: [{ questionNumber: number, pageNumber: 1, url }],
      },
      answers: {
        schemaVersion: 1, examId: "sc900", id, questionId: id, sourceRevision: revision,
        originalAnswers: [{ sourceOccurrenceId: occurrence, value,
          explanation: rich(`The scenario describes ${correct.toLowerCase()}. This is an original synthetic example, not a captured exam question.`),
          answerAssetIds: [], provenance: { source: "examprepper", url } }],
        effectiveAnswer: { value }, provisional: false,
      },
      discussionEnabled: false,
    });
  });
  const counts = { questions: 10, comments: 0, images: 0, automatic: 10, manual: 0,
    omittedComments: 0, sourceQuestions: 10, duplicatesGrouped: 0 };
  const catalog = Sc900CatalogSchema.parse({
    schemaVersion: 1, examId: "sc900", bankVersion: SC900_BANK_VERSION, releaseId, sourceRevision, counts,
    questions: documents.map((document, index) => ({
      id: document.question.id, number: index + 1, kind: "single-select", grading: "automatic",
      provisional: false, commentCount: 0, omittedCommentCount: 0, hasImages: false,
      preview: cards[index]![0], searchText: cards[index]!.join(" "),
      sourceNumbers: [index + 1], discussionEnabled: false,
    })),
  });
  const explanations = documents.map((document, index) => {
    const [scenario, correct] = cards[index]!;
    const value = document.answers.effectiveAnswer.value;
    if (value.kind !== "option-selection") throw new Error("Synthetic samples require a choice key.");
    return Sc900LearningExplanationSchema.parse({
      schemaVersion: 1, examId: "sc900", questionId: document.question.id,
      questionSourceRevision: document.question.sourceRevision, originalKeyDigest: sc900Hash("demo-key", value),
      status: "supported", concept: correct, summary: scenario,
      reasoning: [
        `Read the action in the scenario before choosing a product or term. ${scenario} The described action matches ${correct.toLowerCase()}.`,
        `The other labels describe different purposes from the action given. Answer using the stated facts rather than inventing extra permissions or configuration. This original sample demonstrates the application and is not a prediction of a certification question.`,
      ],
      correctOptionIds: value.optionIds,
      options: document.question.options.map((option, position) => ({
        optionId: option.id, verdict: position === 0 ? "correct" : "incorrect",
        explanation: position === 0
          ? `This describes the action given in the scenario: ${correct.toLowerCase()}. No additional unstated service capability is required.`
          : `This choice does not describe the requested action. The scenario is about ${correct.toLowerCase()}, not an unrelated change or the removal of its stated control.`,
      })),
      answerParts: [], takeaway: `Identify the purpose of the control first. Here the defining action is ${correct.toLowerCase()}, and the surrounding scenario supplies the facts needed to distinguish it.`,
      caveat: "Original synthetic sample only. Ten samples cannot measure certification readiness or replace a complete reviewed question bank.",
      sources: [{ url: SC900_TOPIC_GUIDE_URL, title: "SC-900 study guide, announced October 21, 2026 outline",
        supports: "Background taxonomy for the separate authored course. This scenario and its answer choices are original synthetic sample data." }],
    });
  });
  const learning = Sc900LearningManifestSchema.parse({
    schemaVersion: 1, examId: "sc900", bankVersion: SC900_BANK_VERSION,
    releaseId, baseReleaseId: releaseId, sourceRevision, questionCount: 10,
    records: Object.fromEntries(explanations.map((item) => [item.questionId, {
      sha256: byteSha256(json(item)), sourceRevisions: [item.questionSourceRevision],
    }])),
  });
  const topics = Sc900TopicMapSchema.parse({
    schemaVersion: 1, examId: "sc900", bankVersion: SC900_BANK_VERSION, releaseId,
    taxonomyVersion: SC900_TOPIC_VERSION, guideUrl: SC900_TOPIC_GUIDE_URL, sourceRevision,
    assignments: Object.fromEntries(documents.map((document, index) => [document.question.id, [cards[index]![4]]])),
  });
  const manifest = Sc900ManifestSchema.parse({
    schemaVersion: 1, examId: "sc900", bankVersion: SC900_BANK_VERSION, releaseId, sourceRevision,
    captureLedgerDigest: sc900Hash("synthetic-demo-not-a-capture", cards),
    approvedCommentsDigest: byteSha256("[]"), counts,
    catalogUrl: `content/${releaseId}/catalog.json`, questionBaseUrl: `content/${releaseId}/questions/`,
    discussionBaseUrl: `content/${releaseId}/discussions/`, mediaBaseUrl: `content/${releaseId}/media/`,
  });
  const metadata = Sc900DemoMetadataSchema.parse({
    schemaVersion: 1, examId: "sc900", kind: "original-synthetic-demo", questions: 10,
    notice: SC900_DEMO_NOTICE, releaseId,
  });
  const files = new Map<string, unknown>([
    ["manifest.json", manifest], ["data/demo.json", metadata],
    [`content/${releaseId}/topics.json`, topics],
    [`content/${releaseId}/learning/manifest.json`, learning], [manifest.catalogUrl, catalog],
  ]);
  for (const document of documents) files.set(`${manifest.questionBaseUrl}${document.question.id}.json`, document);
  for (const explanation of explanations) files.set(`content/${releaseId}/learning/questions/${explanation.questionId}.json`, explanation);
  return { manifest, catalog, documents, explanations, learning, topics, metadata, files };
}
