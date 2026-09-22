# SC900 canonical bank and local publication contract

These tools do not capture pages, normalize source HTML, call cloud APIs, upload,
or update a live application. Imported material belongs only in ignored `.data/`.
Tests use original synthetic text and a generated one-pixel image.

## Identities and source bounds

- Every bank, question, answer, discussion, comment, learning, topic, relevance,
  review, and receipt record explicitly identifies `examId: "sc900"`.
- Bank and metadata manifests use `bankVersion: "sc900-approved-v1"`.
- Occurrence IDs are `examprepper-128-q` followed by exactly six digits.
  `sc900OccurrenceId(number)` constructs them. The six-digit representational
  ceiling is not an asserted source question count.
- `src/domain/sc900Capture.ts` defines the exact `Sc900CaptureLedgerSchema`.
  `sourceUrl` must be exactly `https://www.examprepper.co/exam/128/1`.
  Every page URL must be exactly
  `https://www.examprepper.co/exam/128/<pageNumber>`, without alternate hosts,
  protocols, exams, trailing slashes, queries, or fragments.
  `SC900_SOURCE_URL` and `sc900SourcePageUrl(number)` expose this contract.
  Its `reported: { questions, pages }` is established by verified rendered
  capture, never a guessed count. `pages` contains `pageNumber`, `url`,
  `rawSha256`, and complete `questionNumbers`. `occurrences` contains `id`,
  `questionNumber`, `pageNumber`, `answerRevealed: true`,
  `discussionState: "loaded"`, `expectedCommentCount`, `parsedCommentCount`,
  `commentIds`, and `assetIds`. `assets` records byte hash `id`, content type,
  byte length, width, and height. See the schema for all required root fields.
- The ledger verifies every reported page and source number exactly once,
  successful answer reveal and discussion loading, reconciled comments,
  globally unique comment IDs, and the exact asset inventory.
  A successfully loaded empty discussion with expected/parsed counts both zero
  and an empty comment-ID list remains valid. Unknown/failed loading is not an
  empty discussion.
- `sc900SchemasForLedger(ledger)` exposes ledger-bound question, document,
  catalog, and manifest schemas. The publisher additionally validates original
  answers, comments, source URLs, images, and complete metadata against it.
  Existing AZ104 schemas and immutable counts are unchanged.

`tools/sc900/canonical.ts` exports these Node-only canonical helpers:

| Helper | Contract |
| --- | --- |
| `canonicalJson(value)` | Plain, finite JSON, recursively sorted object keys, preserved array order |
| `sc900Hash(scope, value)` | SHA-256 of canonical `{ schemaVersion: 1, examId: "sc900", scope, value }` |
| `sc900SourceRevision(ledger)` | `sc900Hash("source", parsedVerifiedLedger)` |
| `sc900OptionId(content)` | `opt_` plus `sc900Hash("option", richContent)` |
| `sc900QuestionId(question)` | `q_` plus `sc900Hash("question", { kind, prompt, options })` |
| `byteSha256(bytes)` | Raw transport/image hash, not a semantic content identity |

Duplicate equal options can have a positive numeric suffix on the option ID.
Question option order remains part of canonical identity. All semantic hashes
are exam scoped. Raw image and transport hashes intentionally remain byte
hashes, always used inside an SC900 path.

## Normalizer output and metadata

`Sc900Document` preserves CleanDocument rich content, answer-selection, manual,
and media shapes, with explicit SC900 IDs and boundaries. Add `examId` to the
document, question, answers, discussion, and every comment. Original answers
are retained one per occurrence. Empty discussions still have a document.
No captured comments or images may silently disappear.

`Sc900PublicationInput` in `publication.ts` consists of `ledger`, `documents`,
`discussions`, `topics`, `learning`, `eligibility`, and an
`assets: ReadonlyMap<string, Uint8Array>` keyed by raw image SHA-256.
Draft records can use the exported `SC900_DRAFT_RELEASE_ID`; media paths must
use that same draft release until binding.

- `src/domain/sc900Topics.ts`: exact assignments for each canonical question.
  Topic IDs reuse the SC900 course taxonomy, not AZ104 topics.
- `src/domain/sc900Learning.ts`: explanations reuse the rich teaching contract,
  with `examId`. Every canonical question requires a complete explanation.
  `questionSourceRevision` is the ledger-bound source revision.
  `sc900OriginalKeyDigest(document)` binds retained source answers.
- `src/domain/sc900Eligibility.ts`: all canonical question IDs are reviewed and
  partitioned into active/retired sets with reconciled active counts.
  Retirements require rationale and official references.

`prepareSc900Release(input)` validates all input and derives an immutable
`r_<sha256>` from exam-scoped content, capture, and metadata. It replaces draft
release paths, derives catalog and learning manifests, and derives the
eligibility policy hash. It does **not** approve anything.

## Exact paths

The static repository base is **`exams/sc900/`**. The only bank pointer is
`exams/sc900/manifest.json`. Its `catalogUrl`, `questionBaseUrl`,
`discussionBaseUrl`, and `mediaBaseUrl` are relative to that scoped base,
not to the site root:

```text
content/<r_sha>/catalog.json
content/<r_sha>/questions/
content/<r_sha>/discussions/
content/<r_sha>/media/
```

`exams/sc900/availability.json` is always emitted as the typed `SC900_INACTIVE`
record: `{ "schemaVersion": 1, "examId": "sc900", "activated": false }`.
This publisher cannot activate the exam. A bank-only final approval is not
combined bank-and-course approval. The parent activation coordinator owns the
separate live availability transition after checking both immutable releases
and the source capture proof. The immutable local stage stays inactive.

Other immutable files under the same base are:

```text
content/<r_sha>/topics.json
content/<r_sha>/eligibility.json
content/<r_sha>/learning/manifest.json
content/<r_sha>/learning/questions/<q_sha>.json
```

Question and discussion filenames are `<q_sha>.json`. Media filenames are
`<raw_sha>.<png|jpg|gif|webp>`. The media object's cloud path is
`published/sc900/<r_sha>/assets/<raw_sha>.<extension>`.

The Firestore release root is `studyBanks/sc900/releases/<r_sha>`. The only
SC900 metadata pointer paths are `studyMetadata/sc900Bank`,
`studyMetadata/sc900Topics`, and `studyMetadata/sc900Learning`.

## Review, staging, and later activation approval

1. Call `prepareSc900Release(input)` and `sc900ReviewTargets(release)` to obtain
   exact document/discussion/learning/topic/relevance hashes for independent
   review. The helper does not generate an approval.
2. Supply a genuine `Sc900PublicationReview`, including reviewer, review time,
   exact release/source/capture digests, all seven complete-review checks, and
   every review target. Calling `buildSc900StaticPlan(input, review)` fails for
   incomplete or stale reviews.
3. `stageSc900Publication(plan)` writes and verifies a complete local immutable
   export at `.data/sc900-publication/<r_sha>/`. Files and inventories use exact
   byte hashes; unknown files, symlinks, hard links, stale files, unsupported
   image signatures, and conflicting stages are rejected. Repeating identical
   staging is a no-op.
   A private `publication-proof.json` sidecar stores the verified capture ledger
   and complete review. It is never part of the public file map.
4. `approval-receipt.json` defaults to **`activate: false`**. It binds source,
   capture, release, review digest, entire file inventory digest, byte total,
   and file count. A self-review cannot turn activation on.
5. A later external reviewer supplies `Sc900FinalReview` naming the exact plan
   and review digests. `stageSc900Publication(plan, { finalReview })` validates
   the existing complete stage against its existing receipt, then atomically
   promotes only `approval-receipt.json` from false to true as the final write.
   A release-local lock serializes promotions. Identical approval is idempotent;
   downgrades, changed approved receipts, stale approvals, and changed stage
   bytes are rejected. All static files, including inactive availability, stay
   unchanged.
6. Alternatively, `writeSc900FinalApproval(plan, finalReview)` validates the
   unchanged stage and stores an immutable approval separately under
   `.data/sc900-publication/approvals/<r_sha>/`, without changing the stage receipt.
   Neither API changes application availability or a hosting pointer.
   The final review is a caller-supplied attestation,
   not authenticated reviewer identity; approval authority must be verified
   outside this local library.

## Approved loader for offline generation

`loadSc900Publication(workspace, { approvalPath? })` reads an explicitly selected
final approval. By default the parent must place the exact approved receipt at
`.data/sc900-publication/current-approval.json`. Alternatively, pass the
workspace-relative immutable approval receipt path returned by
`writeSc900FinalApproval`. The loader never guesses the newest release and never
falls back to AZ104, demo material, or an unapproved stage.

It reconstructs and validates the entire bank from staged files, private proof,
full review, and independent receipt, including all exact hashes, ledger counts,
metadata coverage, image signatures, and source attributions.

Its `files` is `Map<string, { kind: "source"; path: string }>`, compatible with
the existing `publicationFileBytes` helper and preserving exact canonical bytes.
Map keys are rooted at `exams/sc900/`. Private proof, receipts, and inventory are
excluded. The result also exposes `manifest`, `catalog`, `documents`,
`discussions`, `topics`, `learning` (learning manifest), `explanations` (map),
`eligibility`, `releases`, `receipt`, `inventory`, and `source.directory`.

An offline generator must validate the separate **live** availability record
against this bank release, its capture digest, and the independently approved
course release. It must not compare live activated availability bytes with the
immutable stage's intentionally inactive availability scaffold. All other bank
bytes must match the returned exact inventory.

Limits are operational ceilings, not inferred source counts: 10,000 files,
800,000 bytes per JSON document, 8 MiB per image, 512 MiB total, and 40 million
pixels per image. Private review proof is bounded to 16 MiB. Staging stops if
less than 2.5 GiB would remain free, including private sidecars.

`sc900CloudRequirements(plan)` returns **nonexecutable** conservative Firestore
operation counts, scoped target paths, and Storage byte/object totals.
The estimate includes individual comment documents in addition to static JSON
records and metadata documents, plus existence and verification reads. It does
not assume a whole discussion can replace the runtime's paginated comments.
`reserveSc900CloudHeadroom(...)` requires exact final approval and fresh usage,
then uses the existing shared upload lock, Pacific-day read journal, and write
journal. It makes no network requests. Firestore encoding, cloud controls,
Storage quotas, runtime wiring, final live publication, and real content review
are explicitly outside this API. In particular, nested rich-content arrays
must not be sent to Firestore without a separately verified encoding.
