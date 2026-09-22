# SC900 canonical bank and local publication contract

The canonical/publication helpers do not capture pages, call cloud APIs or update
a live application. The separately guarded executor is documented below.
Imported material belongs only in ignored `.data/`.
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
  `Sc900SourcePageUrlSchema` is shared by the capture, question, and original
  answer schemas. Source question `n` belongs to page `floor((n - 1) / 5) + 1`.
  Page numbers are bounded to `ceil(999999 / 5)` by the six-digit occurrence
  representation. These are format/pagination bounds, not expected source
  coverage. Original-answer provenance must match its occurrence-derived page
  and the corresponding document question source, even when parsing domain
  records without the publisher.
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
SC900 media URLs and nested rich-link targets use the shared public-URL
credential guard. Publication also scans all input text at entry, so literal
credential-bearing URLs cannot bypass the typed link checks. Rejection uses a
generic error without printing, stripping, or rewriting URL values.
The parsed bank, source, discussion, learning, and relevance records are checked
again before any source, capture, or release digest is computed.

`Sc900PublicationInput` in `publication.ts` consists of `ledger`, `documents`,
`discussions`, `topics`, `learning`, `eligibility`, and an
`assets: ReadonlyMap<string, Uint8Array>` keyed by raw image SHA-256.
It also requires `expectedCapture: { questions, pages, receiptSha256 }`, supplied
by the caller from the independently verified source-scope receipt. This is not
a claim that all questions have been captured. Publication fails unless the
complete ledger's reported question and page counts exactly match these
independent expectations. The publisher does not infer expectations from the
ledger itself or hardcode the source count. The caller verifies the receipt
bytes and supplies their raw SHA-256; the release identity and private proof
bind that digest. Prepared releases carry `expectedCapture` for safe rebuilds.
The full-discussion version-1 ledger and its canonical source hashes are unchanged.
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
  Retirements require rationale and official references, except for the explicitly
  adjudicated duplicate-copy category described below.

`prepareSc900Release(input)` validates all input and derives an immutable
`r_<sha256>` from exam-scoped content, capture, and metadata. It replaces draft
release paths, derives catalog and learning manifests, and derives the
eligibility policy hash. It does **not** approve anything.

## Explicit owner-authorized questions, answers and media scope

`Sc900CaptureLedgerSchema` still means complete version-1 capture including
source discussions. Do not feed questions-only results into it or manufacture
`loaded`, verified-empty or reviewed-comment claims.

`src/domain/sc900Scope.ts` defines a separate `Sc900ScopedCaptureLedgerSchema`:
`schemaVersion: 2`, `scope: "questions-answers-media"`, `verified: true` only for
the complete declared scope, and the unchanged source/page/question/image
attribution fields. It adds `authorizationDigest`, `sourceScopeReceiptSha256`,
`rawPageInventoryDigest`, `assetInventoryDigest`, and `sourceCommentCount: null`.
Each occurrence has `discussionState: "unavailable"`,
`discussionDisposition: "omitted-owner-authorized"`, `sourceCommentCount: null`,
`parsedCommentCount: 0`, and `commentIds: []`. It has no expected source-comment
count. Zero parsed/stored comments is not a claim that zero source comments exist.

The private `Sc900QuestionsOnlyAuthorizationSchema` receipt must contain
`schemaVersion: 1`, `examId: "sc900"`, `scope: "questions-answers-media"`,
`decision: "authorize-publication-without-source-discussions"`,
`authorizedBy: "owner"`, `authorizedAt`, the actual `authorizationText`,
`sourceScopeReceiptSha256`, `rawPageInventoryDigest`, `assetInventoryDigest`,
and exact `questions`, `pages`, and `images` counts. The coordinator supplies
this genuine authorization, not an automatic helper or content author.

Use `sc900RawPageInventoryDigest(pages)` over the exact parsed page entries
sorted by page number, `sc900AssetInventoryDigest(assets)` over parsed asset
entries sorted by ID, and `sc900AuthorizationDigest(receipt)` over the parsed
receipt. `assertSc900ScopedAuthorization(ledger, receipt)` verifies all counts,
digests and inventory bindings. `sc900SourceRevision(ledger)` accepts either
ledger type; version-2 source identity includes the authorization digest.
Changing the authorization or any raw page or asset invalidates the source,
release, metadata and review bindings.

Pass version 2 as `Sc900PublicationInput.ledger`, with the receipt in
`ownerAuthorization`. It is required for version 2 and forbidden for version 1.
Existing normalizer `verifiedCaptureLedger` remains version 1 or null; the
explicit `authorizedQuestionsOnlyLedger` is a separate result. Neither result
approves answer correctness or publication. A null ledger is never upgraded.

`Sc900ScopedPublicationReviewSchema` requires `schemaVersion: 2`, the same scope
and `authorizationDigest`. Its checks include `allComments: null`,
`ownerAuthorizedDiscussionOmission: true`, and
`answersAgainstMicrosoftDocumentation: true`, alongside the complete
page/answer/asset/topic/learning/relevance checks. `sc900ReviewTargets` returns
`discussionHash: null` and an exact `discussionOmissionHash`, not a fake review
of an empty thread. The review cannot predate owner authorization.

Scoped manifests, catalogs, question records and unavailable-discussion stubs
carry `discussionScope`, containing the scope, authorization digest, unknown
source total and explicit unavailable/omitted disposition. A scoped manifest's
`approvedCommentsDigest` is `null`. All source questions and original assets are
conserved, one record per source occurrence; no lossy canonical merging is
allowed in this scope. `counts.comments` and `counts.omittedComments` remain
stored/filtered-record accounting, not source totals. Full-mode semantics and
AZ-104 contracts are unchanged.

The private publication proof retains the receipt. Final bank reviews and
cloud-apply approvals must explicitly repeat the exact public `discussionScope`.
Hosting availability, Firestore bank metadata, runtime readers and offline
activation verify the same binding. Owner text and private proof never enter
the public export. Availability is still inactive until the parent approves
the bank/course combination. The UI states:
**Source discussions unavailable; answers reviewed against Microsoft documentation**.

## Duplicate exclusions and definitive active answers

`Sc900DuplicateExclusionSchema` adds only the SC-900 category `"duplicate"` with
`duplicateOfQuestionId`, `adjudicationDigest`, and substantive `evidence`, plus
the normal source numbers and rationale. `sources: []` is allowed only for this
category; a fabricated Microsoft citation is not required to prove that two
source tasks duplicate one another. Use
`sc900DuplicateAdjudicationDigest(exclusion)` to bind the exact IDs, source
numbers, reason, evidence and any supplied references. Any evidence change
requires fresh adjudication and publication approval.

The retained target must be in `activeQuestionIds`. Self-links, unknown targets,
excluded targets and cycles are rejected. The duplicate source record, original
answer, explanation and all its assets remain in the immutable archive and
Storage; only new-practice selection excludes it. Other exclusion categories
retain their official-source requirements.

Every active SC-900 record requires `answers.provisional: false` and teaching
that is neither incomplete nor outdated. For every automatic teaching status,
the effective key must equal a nonempty reviewed key, every option verdict must
be `correct` or `incorrect`, and those verdicts must match the key. Active manual
items require explicit reviewed answer parts. Held/historical items may retain
provisional source keys. A documented qualification with a definite key is shown
as a qualification, not as an unreviewed answer.

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
`Sc900ReleasePointerSchema` and `Sc900ReleasePointer` are exported from
`src/domain/sc900Bank.ts`. The existing `Sc900StudyReleasePointerSchema` export
from `sc900Learning.ts` aliases the same schema. Its exact fields are
`schemaVersion: 1`, `examId: "sc900"`, `bankVersion: "sc900-approved-v1"`,
`releaseId`, and `sourceRevision`.

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
   and review digests. `writeSc900FinalApproval(plan, finalReview)` validates the
   unchanged stage and stores an immutable approval separately under
   `.data/sc900-publication/approvals/<r_sha>/`, without changing the stage receipt.
   The immutable stage receipt is never promoted or replaced. Re-staging with
   a different receipt is rejected even when a valid independent final approval
   exists. Neither API changes application availability or a hosting pointer.
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
`eligibility`, `releases`, `receipt`, `inventory`, `expectedCapture`, and `source.directory`.

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

## Guarded Firestore and Storage executor

The separate `upload.ts` command supplies the real executor. The estimation
helpers above remain nonexecuting. No production upload is performed merely by
importing a module, building the app, or running a plan.

First select an independently approved complete static bank and its **original**
`.data/sc900/source-scope.json` receipt. The executor hashes the untouched receipt
bytes, compares them to `expectedCapture.receiptSha256`, and validates numeric
exam 128, the exact terminal page URL/title, sequential last-page headings,
five-question page allocation, observed totals, zero Next/Last controls, and zero
discussion requests in this scope-only observation. The bank's separate ledger
must prove completeness of its declared capture scope. Full mode requires
captured/reviewed discussions; version-2 questions-only mode requires the exact
owner authorization and the scoped independent review. An unapproved partial
capture is never eligible.

```bash
npm run sc900:cloud -- --plan \
  --approval .data/sc900-publication/current-approval.json \
  --scope .data/sc900/source-scope.json
```

For a subsequent release, also pass
`--baseline .data/sc900-cloud/current-production.json`. Omission means all three
SC-900 metadata documents must be absent, not permission to overwrite them.
The plan is saved under `.data/sc900-cloud/plans/<planDigest>.json`; it binds
the complete document/object inventory, target, exact static approval, source
receipt and metadata baseline. `--dry-run` is an alias for local planning.

The operator must independently approve that exact plan in a private JSON file.
`CloudApplyApprovalSchema` in `cloud-plan.ts` defines the required fields:
`schemaVersion: 1`, `examId: "sc900"`, `target: "production"`,
`dataKind: "authorized-source"`, `planDigest`, `staticPlanDigest`,
`sourceScopeSha256`, the approved administrator as `reviewer`, `reviewedAt`,
and `decision: "approve-cloud-upload-and-metadata-switch"`.
For questions-only publication also include the exact `discussionScope` from the
cloud plan. Omission or a different owner-authorization digest blocks apply.
The command does not generate this approval or accept an approval for another
plan. The existing isolated user ADC and `AZURE_CLOUD_JOURNEY_ADMIN_EMAIL`
configuration are required only for explicit production apply.

```bash
npm run sc900:cloud -- --apply '.data/sc900-cloud/plans/<planDigest>.json' \
  --cloud-approval '.data/sc900-cloud/approvals/<planDigest>.json'
```

Apply refuses emulator environment variables for production and requires the
existing `.data/upload-journal.json`, `.data/operation-journal.json`,
`.data/rollout/storage-journal.json` and `.data/rollout/hosting-journal.json`.
It holds both existing upload and Storage/Hosting locks. It refreshes the
approved ADC identity, exact project/default bucket, deployed rules, private
bucket controls, billing alert configuration and project-wide quota evidence.
The shared Pacific-day limits remain 45,000 reads and 18,000 writes/deletes.
Observed Firestore high-water usage is preserved monotonically in the same
journals so a restart or delayed telemetry cannot restore spent headroom.
Existing monthly Storage limits and the 9 GB Hosting headroom check are reused.
Failed and uncertain requests are charged in advance and never refunded.
Disk space is checked at least every 120 seconds and must remain above
2,500,000,000 bytes.

Original images are created at their already-approved
`published/sc900/<release>/assets/<hash>.<ext>` locations using generation-zero
preconditions, private cache/ACL settings and SHA-256 metadata only. Every image
is downloaded through authenticated, generation-pinned access to verify the
original bytes. Unsafe existing ACLs, download tokens or conflicting bytes are
errors, not instructions to overwrite or repair a bucket.

Documents are first created privately under `sc900ImportRuns/<stageDigest>`.
They are then promoted create-only to `studyBanks/sc900/releases/<release>`.
Catalogs, questions, comments and explanations use `sc900-json-v1` envelopes;
the SC-only runtime decoder verifies the payload hash and preserves nested
arrays, manual answers, images and thread identities. Comment envelopes retain
the top-level `questionId` needed by bounded Firestore discussion queries.
AZ-104 encoding and paths are unchanged.

Only after revalidating the source, approvals, every staged/final document and
every original image does one atomic Firestore commit replace
`studyMetadata/sc900Bank`, `sc900Topics` and `sc900Learning`. Each write uses the
approved expected absence or exact prior update time. Concurrent changes or a
mixed pointer state stop publication. A lost response after a successful commit
is recovered by verifying the exact complete target, not writing it again.

Checkpoints are fsynced and atomically replaced under
`.data/sc900-cloud/progress/`. They are hints, never substitutes for final remote
verification. Re-running the same approved apply resumes safely after
interruption or a quota pause. Quota pauses return exit code 3; other errors
return exit code 1. SIGINT/SIGTERM abort pending HTTP requests, checkpoint the
uncertain phase and release the shared locks, with exit code 130/143. A request
may already have committed; resume verifies its actual state rather than
assuming that interruption rolled it back. After a forced kill or machine
failure, inspect the recorded lock PID and remove a stale lock only after
confirming that its owner is no longer running. Never remove an active lock or
reset a quota journal. There is no deletion API, automatic request retry, Hosting
deployment, rules change, app-availability update, course activation or AZ-104
write path in this executor.

For synthetic tests use `--emulator` for both planning and apply, or run:

```bash
npm run test:sc900-cloud
```

The test runner uses isolated loopback ports 18180/19199, the exact
`demo-az104-study` project, an isolated Firebase CLI home, and no ADC credentials.
Synthetic plans cannot be applied to production; production plans cannot be
redirected into the emulator mode. Never copy synthetic fixtures into a real
source approval. Emulator success does not authorize a real bank or deployment.

## Explicit content-addressed Hosting validation allocation

The ADC Hosting deployer supports `--sc900` for the approved combined publication,
with reports under `.data/sc900/rollout/` and the `approved-sc900-exam` release
label. This does not approve content or activate a missing SC-900 course/bank.
The guard retains every AZ-104 path and saved-session archive. If the verified
Hosting selection includes SC-900 releases, its private Storage check requires
the **exact union** of the original AZ-104 inventory and the original SC-900
media paths derived from every retained, independently approved release. Unknown,
missing, modified, duplicate-generation or soft-deleted objects are rejected.
Checksums, private ACLs and absence of download tokens remain mandatory. There
is no prefix-based permission for extra objects, deletion or repair.

Default Hosting transfer accounting remains `2 * allPathBytes`. An optional
explicit parent-approved mode instead reserves the following bounded allowance
for the operator's deployment and subsequent validation requests:

```text
2 * uniqueUncompressedContentBytes + 16 * 1024 * 1024
```

Each dist file is independently rehashed using SHA-256 and its actual byte
length. Only equal content hashes with equal lengths share a payload accounting
entry; all aliases remain in the file inventory and Hosting storage reservation.
Storage is still charged at **all path bytes**. This formula is an allocated
validation envelope, not a claim about compressed transfer, server-side storage
savings or future user traffic. The monthly 9,000,000,000-byte caps and all
previous global reservations remain unchanged.

After building the final dist, obtain a local measurement:

```bash
node --import tsx tools/firebase/deploy-hosting-adc.ts --sc900 --measure-content-addressed
```

The parent must independently review the measured envelope and write a private
approval matching `HostingValidationApprovalSchema` in
`tools/publish/hosting-validation-budget.ts`: `schemaVersion: 1`,
`mode: "content-addressed-v1"`,
`decision: "approve-bounded-hosting-self-validation"`, `approvedBy: "parent"`,
`approvedAt`, the current Pacific quota `month` (`YYYY-MM`), `distDigest`,
`sourceDigest` and `envelopeDigest`. No caller-supplied byte allowance is accepted.
The deployer and guard independently remeasure the actual build and reject any
changed source, content, hash/length conflict, symbolic link or hard link.
The Hosting deployer, storage guard and budget-helper source files are themselves
included in build identity, so rebuild after changing these safeguards.

```bash
node --import tsx tools/firebase/deploy-hosting-adc.ts --sc900 \
  --content-addressed-validation .data/rollout/hosting-validation-approval.json
# Only after independent review and all existing preflight gates:
node --import tsx tools/firebase/deploy-hosting-adc.ts --sc900 \
  --content-addressed-validation .data/rollout/hosting-validation-approval.json --apply
```

The guard reserves the allocation in the existing
`.data/rollout/hosting-journal.json` **before** writing a build-bound grant under
`.data/rollout/hosting-validation/`. A crash between those writes can conservatively
waste allowance, never create unreserved credit. Rerunning the same approved
build preserves consumed validation allowance; it does not clear failed request
charges or replenish the grant. Another Hosting version still reserves its
full path-based storage bytes. Previous months and reservations are retained.

The deployer continues to upload each required content hash once and verifies
every remote file alias through the server manifest. Before requesting data,
it persistently reserves bounded batches for its metadata responses and upload
acknowledgements. Responses are streamed with the reserved maximum body size,
redirects and hidden retries are disabled in this mode, and unexpected extra
pagination stops rather than exceeding the reserved batch.

The resulting deployment report provides `validationGrantId`. All subsequent
operator content/browser checks **must reserve their maximum responses before
sending requests**, using these helpers:

- `fetchHostingValidationArtifact(grantId, path, workspace?)`: reserves one
  request, fetches only `https://study-az104.web.app/<path>`, enforces the measured
  body-byte bound and verifies exact bytes/hash. Failures and retries keep their
  reservations. Paths are relative to dist without a leading slash.
- `reserveHostingValidationRequests(grantId, requests, workspace?)`: persistently
  reserves a batch before an external browser/network workflow. Artifact entries
  are `{ kind: "artifact", path }`, with their measured file length charged on
  **every request**, even aliases/repeats. Metadata entries are
  `{ kind: "metadata", purpose: "hosting-api" | "browser-overhead", maximumResponseBytes }`;
  the caller must enforce that response maximum. A fixed 4096-byte response-header
  allowance is charged per request. Use `boundedHostingValidationResponse` for
  directly fetched metadata bodies. A browser harness must intercept requests
  before sending, reserve all expected Hosting paths/retries, and refuse
  unreserved requests, redirects or responses above their reserved maximum.

Both helpers revalidate the build, approval, current month and global reservation
floor under a validation lock. They stop when the original envelope is exhausted,
on unexpected artifact paths or if journals regress. Never edit/reset a grant
or journal, turn off the guard, substitute a cheaper maximum, or continue
untracked validation. Extra checks need remaining allocation or a separately
approved global reservation that still fits the existing caps. Ordinary future
user traffic is outside this self-validation ledger and still requires monitoring.
