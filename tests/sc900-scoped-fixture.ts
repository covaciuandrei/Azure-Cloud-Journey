import { Sc900CaptureLedgerSchema } from "../src/domain/sc900Capture.js";
import { Sc900QuestionsOnlyAuthorizationSchema, Sc900ScopedCaptureLedgerSchema } from "../src/domain/sc900Scope.js";
import { Sc900ScopedPublicationReviewSchema } from "../src/domain/sc900Publication.js";
import {
  sc900AssetInventoryDigest, sc900AuthorizationDigest, sc900RawPageInventoryDigest, sc900SourceRevision,
} from "../tools/sc900/canonical.js";
import { sc900OriginalKeyDigest, sc900ReviewTargets, type Sc900PreparedRelease, type Sc900PublicationInput } from "../tools/sc900/publication.js";
import { sc900BankFixture, SC900_FIXTURE_TIMESTAMP } from "./sc900-bank-fixture.js";

export function sc900ScopedFixture(input: Sc900PublicationInput = sc900BankFixture()): Sc900PublicationInput {
  const source = Sc900CaptureLedgerSchema.parse(input.ledger);
  const ownerAuthorization = Sc900QuestionsOnlyAuthorizationSchema.parse({
    schemaVersion: 1, examId: "sc900", scope: "questions-answers-media",
    decision: "authorize-publication-without-source-discussions", authorizedBy: "owner",
    authorizedAt: SC900_FIXTURE_TIMESTAMP,
    authorizationText: "Synthetic owner authorization for testing scoped publication. This is not approval of any real data.",
    sourceScopeReceiptSha256: input.expectedCapture.receiptSha256,
    rawPageInventoryDigest: sc900RawPageInventoryDigest(source.pages),
    assetInventoryDigest: sc900AssetInventoryDigest(source.assets),
    questions: source.reported.questions, pages: source.reported.pages, images: source.assets.length,
  });
  const ledger = Sc900ScopedCaptureLedgerSchema.parse({
    ...source, schemaVersion: 2, scope: "questions-answers-media",
    authorizationDigest: sc900AuthorizationDigest(ownerAuthorization),
    sourceScopeReceiptSha256: ownerAuthorization.sourceScopeReceiptSha256,
    rawPageInventoryDigest: ownerAuthorization.rawPageInventoryDigest,
    assetInventoryDigest: ownerAuthorization.assetInventoryDigest, sourceCommentCount: null,
    occurrences: source.occurrences.map((occurrence) => ({
      id: occurrence.id, questionNumber: occurrence.questionNumber, pageNumber: occurrence.pageNumber,
      answerRevealed: true, discussionState: "unavailable", discussionDisposition: "omitted-owner-authorized",
      sourceCommentCount: null, parsedCommentCount: 0, commentIds: [], assetIds: occurrence.assetIds,
    })),
  });
  const sourceRevision = sc900SourceRevision(ledger);
  const documents = input.documents.map((original) => {
    const value = structuredClone(original);
    value.question.commentCount = 0;
    value.question.sourceRevision = sourceRevision;
    value.answers.sourceRevision = sourceRevision;
    value.discussionEnabled = false;
    return value;
  });
  const discussions = input.discussions.map((discussion) => ({ ...discussion, comments: [] }));
  const learning = structuredClone(input.learning);
  learning.sourceRevision = sourceRevision;
  learning.explanations.forEach((explanation) => {
    explanation.questionSourceRevision = sourceRevision;
    explanation.originalKeyDigest = sc900OriginalKeyDigest(documents.find((document) => document.question.id === explanation.questionId)!);
  });
  return { ...input, ownerAuthorization, ledger, documents, discussions, learning,
    topics: { ...input.topics, sourceRevision },
    eligibility: { ...input.eligibility, sourceRevision, activeCounts: { ...input.eligibility.activeCounts, comments: 0 } },
  };
}

export function sc900ScopedReview(release: Sc900PreparedRelease) {
  if (release.ledger.schemaVersion !== 2) throw new Error("Expected scoped fixture.");
  return Sc900ScopedPublicationReviewSchema.parse({
    schemaVersion: 2, examId: "sc900", scope: "questions-answers-media",
    authorizationDigest: release.ledger.authorizationDigest,
    releaseId: release.manifest.releaseId, sourceRevision: release.manifest.sourceRevision,
    captureLedgerDigest: release.manifest.captureLedgerDigest, reviewer: "Synthetic independent factual reviewer",
    reviewedAt: SC900_FIXTURE_TIMESTAMP, decision: "approved",
    checks: { allPages: true, allAnswers: true, allComments: null, allAssets: true, topics: true,
      learning: true, relevance: true, ownerAuthorizedDiscussionOmission: true, answersAgainstMicrosoftDocumentation: true },
    questions: sc900ReviewTargets(release),
  });
}
