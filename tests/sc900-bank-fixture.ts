import type { RichContent } from "../src/domain/schemas.js";
import {
  SC900_BANK_VERSION, Sc900DocumentSchema, type Sc900Discussion, type Sc900Document,
} from "../src/domain/sc900Bank.js";
import { SC900_SOURCE_URL, Sc900CaptureLedgerSchema, sc900OccurrenceId } from "../src/domain/sc900Capture.js";
import { SC900_TOPIC_GUIDE_URL, SC900_TOPIC_VERSION } from "../src/domain/sc900Topics.js";
import type { Sc900PublicationReview } from "../src/domain/sc900Publication.js";
import { byteSha256, sc900Hash, sc900OptionId, sc900QuestionId, sc900SourceRevision } from "../tools/sc900/canonical.js";
import {
  SC900_DRAFT_RELEASE_ID, buildSc900StaticPlan, prepareSc900Release, sc900OriginalKeyDigest, sc900ReviewTargets,
  type Sc900PublicationInput, type Sc900PreparedRelease,
} from "../tools/sc900/publication.js";

export const SC900_FIXTURE_TIMESTAMP = "2026-09-22T00:00:00Z";
export const sc900FixtureText = (value: string): RichContent =>
  [{ type: "text", spans: [{ type: "text", text: value, marks: [] }] }];

export function sc900BankFixture(): Sc900PublicationInput {
  const text = sc900FixtureText;
  const timestamp = SC900_FIXTURE_TIMESTAMP;
  const sourceUrl = SC900_SOURCE_URL;
  const paragraph = "This is original synthetic fixture content, not imported examination material.";
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64");
  const assetId = byteSha256(png);
  const rootId = `c_${sc900Hash("comment", "synthetic-root")}`;
  const childId = `c_${sc900Hash("comment", "synthetic-child")}`;
  const ledger = Sc900CaptureLedgerSchema.parse({
    schemaVersion: 1, examId: "sc900", sourceExamId: "128", captureMethod: "rendered-browser-ui",
    verified: true, sourceUrl, capturedAt: timestamp, reported: { questions: 2, pages: 1 },
    pages: [{ pageNumber: 1, url: sourceUrl, rawSha256: byteSha256("synthetic captured page"), questionNumbers: [1, 2] }],
    occurrences: [1, 2].map((number) => ({
      id: sc900OccurrenceId(number), questionNumber: number, pageNumber: 1,
      answerRevealed: true, discussionState: "loaded",
      expectedCommentCount: number === 1 ? 2 : 0, parsedCommentCount: number === 1 ? 2 : 0,
      commentIds: number === 1 ? [rootId, childId] : [], assetIds: [assetId],
    })),
    assets: [{ id: assetId, contentType: "image/png", byteLength: png.length, width: 1, height: 1 }],
  });
  const sourceRevision = sc900SourceRevision(ledger);
  const image: RichContent = [{ type: "image", assetId, alt: "Synthetic one-pixel diagram", width: 1, height: 1 }];
  const documents: Sc900Document[] = [1, 2].map((number) => {
    const kind = number === 1 ? "single-select" as const : "manual" as const;
    const options = number === 1 ? ["Synthetic option A", "Synthetic option B"].map((value) => ({
      id: sc900OptionId(text(value)), content: text(value),
    })) : [];
    const prompt: RichContent = [
      ...text(`Synthetic source question ${number}`), ...image,
      { type: "code", code: "fictional-example", language: null },
      { type: "list", ordered: true, start: 1, items: [text("Synthetic list item")] },
      { type: "table", caption: [], rows: [{ cells: [{ header: true, rowSpan: 1, colSpan: 1, blocks: text("Synthetic cell") }] }] },
    ];
    const id = sc900QuestionId({ kind, prompt, options });
    const value = number === 1 ? { kind: "option-selection" as const, optionIds: [options[0]!.id] } :
      { kind: "manual" as const, reason: "image-only" as const, sourceAnswerAssetIds: [assetId] };
    return Sc900DocumentSchema.parse({
      schemaVersion: 1, examId: "sc900", releaseId: SC900_DRAFT_RELEASE_ID,
      question: {
        schemaVersion: 1, examId: "sc900", id, sourceRevision, kind, prompt, options,
        shuffle: { allowed: false }, fixedOptionOrder: options.map((option) => option.id),
        sourceOccurrenceIds: [sc900OccurrenceId(number)], assetIds: [assetId],
        commentCount: number === 1 ? 2 : 0, readiness: { grading: number === 1 ? "automatic" : "manual" },
        media: [{
          id: assetId, objectPath: `published/sc900/${SC900_DRAFT_RELEASE_ID}/assets/${assetId}.png`,
          contentType: "image/png", width: 1, height: 1, byteLength: png.length,
          sourceUrls: ["https://example.test/synthetic-pixel.png"],
        }],
        sources: [{ questionNumber: number, pageNumber: 1, url: sourceUrl }],
      },
      answers: {
        schemaVersion: 1, examId: "sc900", id, questionId: id, sourceRevision,
        originalAnswers: [{
          sourceOccurrenceId: sc900OccurrenceId(number), value,
          explanation: text(paragraph), answerAssetIds: number === 1 ? [] : [assetId],
          provenance: { source: "examprepper", url: sourceUrl },
        }],
        effectiveAnswer: { value }, provisional: true,
      },
      discussionEnabled: number === 1,
    });
  });
  const discussions: Sc900Discussion[] = documents.map((document, index) => ({
    schemaVersion: 1, examId: "sc900", releaseId: SC900_DRAFT_RELEASE_ID, questionId: document.question.id,
    comments: index === 0 ? [rootId, childId].map((id, commentIndex) => ({
      schemaVersion: 1, examId: "sc900", id, questionId: document.question.id,
      sourceOccurrenceId: sc900OccurrenceId(1), sourceRevision, sourceCommentId: null, sourceCreatedAt: null,
      author: "Synthetic fixture author", votes: 0, voteText: "0", displayedTimestamp: "fixture timestamp",
      capturedAt: timestamp, bodyText: paragraph, bodyTextContent: paragraph, body: text(paragraph),
      parentId: commentIndex === 0 ? null : rootId, rootId, childIds: commentIndex === 0 ? [childId] : [],
      treePath: commentIndex === 0 ? [0] : [0, 0], trust: "untrusted-source-content",
    })) : [],
  }));
  return {
    ledger, documents, discussions, assets: new Map([[assetId, png]]),
    topics: {
      schemaVersion: 1, examId: "sc900", bankVersion: SC900_BANK_VERSION, releaseId: SC900_DRAFT_RELEASE_ID,
      taxonomyVersion: SC900_TOPIC_VERSION, guideUrl: SC900_TOPIC_GUIDE_URL, sourceRevision,
      assignments: Object.fromEntries(documents.map((document) => [document.question.id, ["sc-security-concepts"]])),
    },
    learning: {
      schemaVersion: 1, examId: "sc900", bankVersion: SC900_BANK_VERSION,
      releaseId: SC900_DRAFT_RELEASE_ID, baseReleaseId: SC900_DRAFT_RELEASE_ID, sourceRevision,
      explanations: documents.map((document) => ({
        schemaVersion: 1, examId: "sc900", questionId: document.question.id, questionSourceRevision: sourceRevision,
        originalKeyDigest: sc900OriginalKeyDigest(document), status: "supported", concept: "Synthetic security concept",
        summary: paragraph, reasoning: [paragraph, paragraph],
        correctOptionIds: document.question.kind === "manual" ? null : [document.question.options[0]!.id],
        options: document.question.options.map((option, index) => ({
          optionId: option.id, verdict: index === 0 ? "correct" : "incorrect", explanation: paragraph,
        })),
        answerParts: document.question.kind === "manual" ? [{
          label: "Synthetic diagram", answer: "Synthetic manual answer", explanation: paragraph, alternatives: [],
        }] : [],
        takeaway: paragraph, caveat: null,
        sources: [{ url: SC900_TOPIC_GUIDE_URL, title: "Synthetic reference attribution", supports: paragraph }],
      })),
    },
    eligibility: {
      schemaVersion: 1, examId: "sc900", bankVersion: SC900_BANK_VERSION,
      policyId: `e_${"0".repeat(64)}`, releaseId: SC900_DRAFT_RELEASE_ID, teachingReleaseId: SC900_DRAFT_RELEASE_ID,
      sourceRevision, reviewedAt: "2026-09-22",
      reviewedQuestionIds: documents.map((document) => document.question.id),
      activeQuestionIds: documents.map((document) => document.question.id),
      activeCounts: { questions: 2, comments: 2, images: 1, automatic: 1, manual: 1, omittedComments: 0,
        sourceQuestions: 2, duplicatesGrouped: 0 },
      retired: [],
    },
  };
}

export function sc900BankReview(release: Sc900PreparedRelease): Sc900PublicationReview {
  return {
    schemaVersion: 1, examId: "sc900", releaseId: release.manifest.releaseId,
    sourceRevision: release.manifest.sourceRevision, captureLedgerDigest: release.manifest.captureLedgerDigest,
    reviewer: "Synthetic fixture content reviewer", reviewedAt: SC900_FIXTURE_TIMESTAMP, decision: "approved",
    checks: { allPages: true, allAnswers: true, allComments: true, allAssets: true, topics: true, learning: true, relevance: true },
    questions: sc900ReviewTargets(release),
  };
}

export function sc900BankPlanFixture() {
  const input = sc900BankFixture();
  return buildSc900StaticPlan(input, sc900BankReview(prepareSc900Release(input)));
}
