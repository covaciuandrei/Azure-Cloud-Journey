# Azure Cloud Journey

Understand Azure concepts, then put them into practice.

**Live application:** [study-az104.web.app](https://study-az104.web.app)

**Source repository:** [covaciuandrei/Azure-Cloud-Journey](https://github.com/covaciuandrei/Azure-Cloud-Journey)

The application is hosted on **Firebase Hosting**. GitHub stores the application
source and original learning material; it is not the current web host.

Choose **AZ-104: Azure Administrator** or **SC-900: Security, Compliance, and
Identity Fundamentals**, then enter **Learn** or **Practice & exams**. Both exams
are live. Existing AZ-104 lesson links, practice history and content remain
available and unchanged.

## What is included

- A React and TypeScript interface with a blue Coursebook layout.
- An original AZ-104 course covering **5 domains, 21 modules, 59 lessons,
  241 checkpoints and all 82 listed official objectives**.
- An independently reviewed original SC-900 course: **4 domains,
  12 modules, 26 lessons, 112 checkpoints and 58 announced objectives**.
- **183 active SC-900 practice questions**, with documentation-reviewed
  explanations and preserved original question and answer images.
- First-principles explanations, worked examples, diagrams, glossary entries
  and references to official documentation.
- Interactive subnet, route and NSG teaching tools.
- Shuffled answer choices, topic filters, practice sessions and timed exams.
- Separate guest and signed-in progress, Google sign-in and recent statistics.
- Integrity-checked offline downloads in the full hosted application.
- Firebase rules and guarded administration/publication tooling.

This is an independent study application, not an official Microsoft course.
The AZ-104 course maps the published objectives effective **April 17, 2026**, with
source and editorial reviews dated **September 20, 2026**. The official bullets
are illustrative, related topics can appear, and this course does not guarantee
exam coverage, readiness or perfect accuracy.

## Run the public-source demo

Requirements: Node.js **20.19 or newer** and npm.

```bash
git clone https://github.com/covaciuandrei/Azure-Cloud-Journey.git
cd Azure-Cloud-Journey
npm ci
npm run demo
```

Open **http://127.0.0.1:5174/**.

The explicit demo uses 10 original synthetic practice questions and the active
authored course selected in `content/course.json` (the full AZ-104 course). It needs no Firebase credentials, does not fetch the
production question bank, and does not connect to production accounts. It is
visibly marked as a demo. Sample questions are software demonstrations, not
claimed exam questions. Forty-question exams and offline downloads are disabled
in this small source demo; the full hosted app retains those features.

```bash
npm run typecheck
npm run test:public
npm run build:demo
npm run preview:demo
```

The built demo is written to `dist-demo/`; its preview runs at
**http://127.0.0.1:4174/**. Demo output is isolated from the full application's
`public/` export and `dist/` deployment.

## Content and repository boundaries

| In Git | Not in Git |
| --- | --- |
| Application source, styles, domain contracts and tests | OAuth credentials, tokens and private environment files |
| Original course inputs in `content/networking/`, `content/az104/` and `content/sc900/` | The downloaded third-party practice bank, comments and images |
| Synthetic demo question generation | Generated `public/data`, `content`, `teaching`, `courses` and `exams` exports |
| Firebase rules and deployment safeguards | Browser profiles, account histories, emulator logs and caches |
| Dependency lockfile and public-source CI | Private working artifacts, quota journals and deployment receipts |

The live application currently has **519 active practice questions**. That bank
is separate from the public repository and is not redistributed here. Its
historical copies remain available in the owner's existing environment for
saved-session compatibility.

`content/networking/`, `content/az104/` and `content/sc900/` contain original teaching material,
not copied Microsoft lesson text. Official references are linked for verification.

Do not copy a Firebase credential file, the private working directory or a full
production content export into Git. The repository check examines tracked Git
blobs and blocks common credential patterns, generated data and local reports:

```bash
node --import tsx tools/repository/check-publication.ts
```

This is a targeted guard, not a substitute for reviewing content rights and
staged changes before publication.

## Learning

The course covers the complete published
[AZ-104 objective outline](https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/az-104):

| Domain | Modules | Lessons | Checkpoints | Mapped objectives |
| --- | ---: | ---: | ---: | ---: |
| Identity and governance | 3 | 8 | 32 | 15 |
| Storage | 3 | 9 | 36 | 17 |
| Compute | 4 | 13 | 54 | 24 |
| Networking | 8 | 21 | 87 | 13 |
| Monitoring and recovery | 3 | 8 | 32 | 13 |

The existing networking path is retained, including its foundational IP/DNS
reasoning. New chapters cover identity and licensing, access and governance,
storage security and recovery, ARM/Bicep, VMs, containers, App Service,
monitoring, backup and Site Recovery. All 346 registered first-party reference
URLs were checked, and domain reviewers independently examined the teaching,
worked applications and every scored answer explanation. Source availability
checks alone are not treated as factual approval.

The lessons assume a PC-literate student who needs the underlying concepts
explained before memorizing product settings. A fictional school application connects the examples. Worked
examples explain both the action and its reason; checkpoints explain every
answer choice.

The course includes a searchable overview, bookmarks, lesson continuation,
module navigation and an on-page section index. Core/supporting labels describe
teaching priority, not predicted exam-question frequency.

The overview groups all five domains, links their practice topics, and exposes
objective-to-section and checkpoint evidence. Dated previews, retirement plans,
SKU differences and conflicting upstream documentation are explicitly scoped.

**Learning progress is device-only**, with separate guest and Firebase UID
records. A Studied marker is self-reported reading, not a mastery rating.
Checkpoint results are separate from practice-exam scores. Changed lesson
revisions require renewed review without rewriting historical practice scores.
Both course versions retain the `az104-networking-course:v1` browser namespace.
All existing lesson IDs are retained. Eighteen networking lesson revisions are
unchanged, preserving their study/check results. Three networking lessons gained
required configuration examples and therefore correctly require renewed review:
private access, Bastion, and Layer 4 load balancing. Their bookmarks remain.

Optional Azure labs are instructions only and have not been executed by the
application. They describe prerequisites, possible costs, expected observations
and scoped cleanup. Reading and in-app exercises require no Azure subscription.
Check service availability, preview status and pricing before any real lab.

## Practice in the full application

| Mode | Behavior |
| --- | --- |
| Library | Browse/search questions, filter topics, reveal explanations and retained discussions. |
| Free practice | Sets of 10, 20, 30 or 40 questions with feedback after submission. |
| Exam | 40 questions in 60 minutes; answers stay hidden until completion. |
| History | Resume unfinished sessions and review recent completed attempts. |
| Statistics | Separate automatic, provisional and manual outcomes. |

Eligible choices shuffle by stable option ID. Questions that require a fixed
order retain an explicit order. Image questions use visual comparison rather
than invented automatic grades.

Exam deadlines use wall-clock time and continue while reading lessons. Old
attempts retain their original release, keys, answer order, deadline and scores.
Retired questions are excluded from new sessions without deleting historical
attempts.

## SC-900 publication status

SC-900 uses a separate exam context, not the AZ-104 bank with different labels.
Its original course and curated bank are independently reviewed, digest-approved
and published: **4 domains, 12 modules, 26 lessons, 112 explained checkpoints
and 58 announced objectives**, plus **183 active practice questions**.

The English study guide reviewed on **September 22,
2026** announces an effective date of **October 21, 2026**. This is a future
outline at review time; no verified earlier English outline is claimed.

All **219 source occurrences across 44 pages** have been collected through the
signed-in browser, with every source answer revealed and **252 original images**
preserved. Draft normalization retains all 219 questions; it found no exact
duplicates, which does not rule out near-duplicates. Seventeen valid JPEG images
have incorrect source PNG labels. Draft rendering uses their detected format
without changing the bytes, while preserving both labels and explicit warnings.
As in the AZ-104 importer, verified raster signatures and dimensions determine
the normalized MIME type; corrupt bytes, unsafe types and dimension mismatches
still fail. A MIME correction never establishes missing discussion evidence.

Browser-generated discussion requests returned a verification challenge. The
owner explicitly authorized a questions, answers and media release without
those discussions. Their source totals remain unknown, not zero, and the
interface explains that discussions are unavailable.

All 219 source records and 252 original images are retained in Firestore/private-ACL
Storage and the approved export. New practice excludes 28 unresolved or
condition-dependent items, six obsolete/unsuitable items, and two duplicate
copies. Source markings are preserved separately from reviewed explanations;
incorrect original image markings are clearly identified.

SC-900 offers free practice in sets
of 10, 20, 30 or 40 and a **40-question, 45-minute mock**. Forty questions is the
app's practice format, not a claim about the actual exam's exact question count.
AZ-104 keeps its existing 40-question, 60-minute mock and published content.

Storage safeguards distinguish known Class A and Class B operations, with
bounded ceilings below the published 5,000/50,000 monthly allowances. Historical
unclassified reservations remain charged to both classes; no spent usage is
erased. Hosting validation is separately bound to the exact measured build,
and the existing budget alert is not represented as a hard cap on future traffic.

Legacy `#home`, `#learn`, `#learn/<lesson>` and `#practice` links, browser keys,
AZ-104 account paths and course releases remain unchanged. SC-900 uses
`#/sc900/home`, `#/sc900/learn`, `#/sc900/learn/<lesson>` and `#/sc900/practice`.
Its guest/account state, pending sync queue, history and learning progress are
isolated. Switching exams retains open attempts and wall-clock deadlines.
SC-900 account practice is scoped under `users/<uid>/exams/sc900/`; learning
progress remains device-only, matching AZ-104.

Static SC-900 files live under `exams/sc900/`. `manifest.json` points to immutable
`content/r_<sha>/` question, discussion, media, topic, eligibility and teaching
files. Teaching uses `content/r_<sha>/learning/manifest.json` and
`learning/questions/<question>.json`. The course pointer is
`course/current.json`, with content in `course/releases/c_<sha>/sc900.json`.
`availability.json` is inactive by default and never enables an empty,
unreviewed or synthetic production bank. Offline packages and active pointers
are separate per exam; removing one download preserves the other and does not
erase progress.

The public-source demo never substitutes for missing production data. For an
explicit SC-900 source demo, set `VITE_STUDY_SC900_DEMO=true` when running
`npm run demo` or `npm run build:demo`. This still requires the independently
approved, explicitly activated SC-900 course; it adds exactly **10 original
synthetic SC-900 samples** with prominent demo notices, not a production bank.
Without those course approvals, the command fails rather than showing a
partially available exam.

### SC-900 authoring and guarded publication

Read `content/sc900/authoring-contract.json`, `curriculum.json`, `objectives.json`
and `publication-plan.json`. Original modules retain the existing authored
module shape with the allocated SC-900 IDs. Partial checks do not approve
publication:

```bash
node --import tsx tools/course/validate.ts --exam sc900 --module sc-security-foundations
node --import tsx tools/course/validate.ts --exam sc900 --domain sc-concepts
node --import tsx tools/course/assemble.ts --exam sc900
```

The browser collector `tools/ingest/sc900-capture.mjs` normally requires verified
discussion loading and stops on a challenge. Its explicit `--questions-only`
mode collects only accessible question content through the signed-in browser,
without sending discussion requests to the server. It saves separately under
`.data/sc900/question-content/`, records discussions as unrequested, restores
normal browser request handling afterward, and never sets full capture complete.
Original image bytes come only from the displayed question images in Chrome's
existing resource cache, not screenshots, new asset requests or whole-browser
archives. Resource reads and image decoding have bounded waits.
For an existing installed Playwright driver and the owner's browser on port 9224:

```bash
PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core/index.mjs \
  node tools/ingest/sc900-capture.mjs --max-pages 44 --questions-only
node --import tsx tools/sc900/normalize.ts \
  --input .data/sc900/question-content/raw/pages \
  --output .data/sc900/question-content/normalized \
  --draft --expected-pages 44 --expected-occurrences 219
```

Draft normalization deliberately exits 2 while discussions or other required
evidence are incomplete. This mode does not bypass verification or retrieve
blocked discussions, and it cannot activate the bank.

Full course assembly requires all domain/module approvals plus exact curriculum,
objective and coverage digests. Its version-3 pointer stays inactive unless
`loadCoursePublication(workspace, "sc900", { activate: true })` receives a
coordinator approval in `content/sc900/review-approvals/activation.json` binding
the exact release ID and byte hash.

The separate bank contract is in `src/domain/sc900*.ts`; stable namespaced hashes
are in `tools/sc900/canonical.ts`. Generic schemas do not guess source totals.
The publisher requires independently supplied capture-scope counts and a
verified UI-capture ledger complete for its declared scope. The original
version-1 contract requires revealed answers, exact original assets and loaded
discussions. A verified empty discussion is valid; a failed or missing response
is not evidence of zero comments.

An explicit owner authorization can instead approve the distinct version-2
**questions, answers and media** scope. Its private receipt binds the source
scope, every raw page and the original asset inventory. Source discussions stay
`unavailable`, with unknown source totals represented as `null`, not invented
empty threads or discussion reviews. Every question, original author key,
image and documentation-reviewed explanation is still required. The interface
discloses: **Source discussions unavailable; answers reviewed against Microsoft
documentation**. There is no automatic waiver or permissive fallback.

All source records and images remain archived. Independently adjudicated
duplicate copies can be excluded from new practice without merging or deleting
their originals. Duplicate exclusions require an exact evidence digest and an
active retained target; only that category can omit an irrelevant Microsoft
citation. Every active automatic key must match definite reviewed option
verdicts. Provisional, incomplete, historical or unresolved items remain
excluded from new practice.
Public attribution, teaching references and rich-content links must not contain
signed access tokens or credential-bearing URLs. Publication rejects them
before hashing or exporting, without echoing the values or silently stripping
query parameters; the private capture remains unchanged.

`tools/sc900/publication.ts` prepares deterministic releases, binds per-question
review hashes, stages only under ignored `.data/sc900-publication/`, and records
independent final approval separately from immutable staged content.
`selectSc900HostingPublication` in `tools/web/sc900-publication.ts` is a
parent-controlled local API that combines those approvals with the activated
course, preserves archived releases and atomically selects a complete Hosting
bundle. The normal export and Hosting guard revalidate its files. Neither API
deploys to Firebase.

SC-900 has a separate **explicitly approved cloud executor** in
`tools/sc900/upload.ts`. Planning is local-only; apply requires the exact approved
static bank, original source-scope receipt, a separate cloud-plan approval,
fresh administrator/project/rules/privacy checks, and the existing shared
quota journals. Immutable private staging and original-byte verification precede
an atomic, preconditioned switch of the three SC-900 Firestore metadata records.
Nested rich content uses a versioned, hash-checked JSON envelope in Firestore.
Media retains its approved `published/sc900/<release>/assets/...` path but has
private access settings, with no anonymous ACLs or download tokens.

`npm run test:sc900-cloud` exercises only isolated `demo-az104-study` emulators
with synthetic fixtures. No production upload or SC-900 activation is implied
by those tests. Capture completeness and factual approval are mandatory for
the explicitly declared scope. Questions-only data needs the exact owner
authorization plus independently reviewed scoped publication, final and cloud
approvals; a draft or an unauthorized incomplete ledger remains ineligible. See
[`tools/sc900/README.md`](tools/sc900/README.md) for the guarded plan/apply workflow.
Budgets are never reset or split by exam, and this executor does not deploy
Hosting, change application availability, alter rules or modify AZ-104 data.

## Full local application

The full data pipeline intentionally requires the owner's approved private
publication artifacts. A Git clone alone does not include them. Use the demo
unless you already have that authorized content and its associated metadata.

Restore private content only from a trusted owner-controlled backup. Keep
`.data/clean-bank`, teaching/relevance/topic inputs and quota journals outside
Git, at the locations expected by the publication tools. Do not reset quota
journals or substitute synthetic data in a production publication.

For the existing Firebase project, copy `.env.example` to `.env.local` and set
`VITE_FIREBASE_API_KEY` to its Firebase web API key. Web configuration is public
in the built client; Firebase rules enforce access. Administrative OAuth
credentials are different and must never enter a browser bundle.

```bash
node --import tsx tools/course/assemble.ts
npm run dev
```

The full app runs at **http://127.0.0.1:5173/**. For its production build:

```bash
npm run build
npm run preview
```

The full preview runs at **http://127.0.0.1:4173/**. The build validates and
exports the private bank before compiling the client and producing a
checksum-bound offline manifest. Missing or invalid publication inputs are
errors, not an automatic switch to demo data.

`npm test` includes private-bank integration tests. `npm run test:public` is the
self-contained suite used by the public repository's CI.

## Accounts and offline use

The full application supports Google sign-in. Guest practice is stored locally;
signed-in practice synchronizes only beneath the user's own Firebase UID.
Malformed caches and conflicting account revisions are reported rather than
silently discarded. Learning progress remains local, including when signed in.

Open **Offline & data** in the header for downloads, the question-source selector
and account save controls. Firestore and the bundled snapshot are explicit
choices. Online data errors do not silently switch sources.

Offline downloads verify individual file hashes and update atomically. Older
downloads need **Update download** to include a new interface or course.
Historical assets are included only when a saved session needs them. Removing a
download does not erase progress.

## Course authoring

`content/course.json` is the tracked activation switch. Its reviewed active value is
`{"schemaVersion":1,"activeCourse":"az104"}`. Builds, demo exports and source
checks use the active course; they do not substitute an incomplete course when
publication fails. The `"networking"` value remains supported for legacy
publication and compatibility tests. Full-course activation requires all module
and metadata approvals, not just structurally valid content.

Existing networking lessons remain under `content/networking/modules/`.
New modules use the exact IDs, lesson order, source paths, official module URLs
and practice topics in `content/az104/curriculum.json`. Authors use the unchanged
module schema version 1, now accepting all 21 module IDs. Read
`content/az104/authoring-contract.json` before authoring. Outputs remain
private/generated under `.data/course/`.

```bash
node --import tsx tools/course/validate.ts
node --import tsx tools/learning/check-sources.ts --course
node --import tsx tools/course/assemble.ts

# Partial authoring: unrelated domains and approvals are not required.
node --import tsx tools/course/validate.ts --module storage-access
node --import tsx tools/course/validate.ts --domain storage
node --import tsx tools/learning/check-sources.ts --course --domain storage
node --import tsx tools/learning/check-sources.ts --course --module storage-access

# Require every planned module and coverage map, even before activation.
node --import tsx tools/course/validate.ts --course az104
node --import tsx tools/learning/check-sources.ts --course --all
```

Module validation checks the assigned lessons, minimum teaching depth,
worked examples, predictions, explained checkpoints, diagrams and source IDs.
Domain validation also requires that domain's coverage file and referenced
modules. Full validation never skips missing files.

Coverage files are `content/az104/coverage/<domain-id>.json`, with the exact shape
in the authoring contract: `{schemaVersion:1,domainId,reviewedAt,objectives}`.
Each objective entry is `{objectiveId,lessons}`; each lesson target is
`{moduleId,lessonId,sectionIds,checkpointIds,evidence}`. Every one of the 82
official objective IDs must appear exactly once in its own domain. Targets must
resolve to real sections/checkpoints, include substantive teaching (at least
80 prose words across the target's selected sections), and include a worked
example across the objective's targets. Evidence requires at least 80 characters
and 12 words explaining the teaching, application and assessment, including the
reason for an empty checkpoint list. `mo-06` alone can additionally target
`network-watcher`. These structural gates are not a factual review: a reviewer
must still inspect the reasoning, relevance, sources and checkpoint keys.

Legacy publication requires `content/networking/review-approvals.json`.
Full publication requires **all five**
`content/az104/review-approvals/<domain-id>.json` files, including networking,
each an array of `{id,digest,note}` for exactly its assigned modules. Digests bind
the parsed authored module; notes require at least 30 characters. No legacy
approval fallback is allowed for the full course.

The coordinator also supplies `content/az104/review-approvals/metadata.json`:

```json
{
  "schemaVersion": 1,
  "reviewedAt": "YYYY-MM-DD",
  "reviewer": "coordinator",
  "curriculumDigest": "<64 lowercase hex characters>",
  "objectivesDigest": "<64 lowercase hex characters>",
  "coverageDigest": "<64 lowercase hex characters>",
  "note": "<at least 80 characters describing the independent metadata and coverage review>"
}
```

Use `digest()` from `tools/ingest/normalize-shared.ts` over the parsed curriculum,
the parsed objectives, and the array of parsed coverage files in curriculum
domain order, respectively. The tools never create approvals or add timestamps
to the digest input. Missing or stale module or metadata approvals block assembly.
Authors must not self-approve.

To activate after review, the coordinator changes only `activeCourse` to
`"az104"`, then assembles and validates the resulting publication before
publishing. Schema 1 `networking.json` packages and offline downloads remain
readable. Schema 2 publishes `courses/<release-id>/az104.json`, with domain
metadata, module practice topics and coverage evidence bound into its release
and pointer hash. Both packages have a **4 MiB** byte limit; full pointers are
bounded to 21 modules, 42-84 lessons and 126-420 checkpoints, while the tracked
curriculum requires exactly its 59 lesson identities. The synthetic 59-lesson
test package is about 1.2 MB; actual authored bytes must pass the same measured
limit, not an extrapolated allowance. Do not add copied exam material or replace
meaningful qualification with a claim of certainty.

## Deployment safeguards

Branding does not rename the existing Firebase project or change saved-data
identities. The current project remains `study-az104`.

Publishing commands require:

- `GOOGLE_APPLICATION_CREDENTIALS` pointing to an isolated ADC file outside Git.
- `AZURE_CLOUD_JOURNEY_ADMIN_EMAIL` explicitly naming the approved administrator.
- Verified project identity, matching deployed rules and private Storage media.
- Preserved daily/monthly operation journals and sufficient quota headroom.
- A separately validated production build, never `dist-demo/`.

The project-only $1 budget provides alerts, not a hard spending cap. Conservative
Firestore limits remain 18,000 writes, 45,000 reads and 18,000 deletes per
Pacific day. The existing private Storage bucket remains in `US-EAST1`.

The guarded Hosting tool supports local planning followed by explicit apply.
It checks build identity again before release and refuses concurrent changes:

```bash
node --import tsx tools/firebase/deploy-hosting-adc.ts --journey
# Only after acceptance, identity and quota checks:
node --import tsx tools/firebase/deploy-hosting-adc.ts --journey --apply
```

After full-course activation and final acceptance, the coordinator instead uses
`--az104` (and then `--az104 --apply`). This feature requires an active AZ-104
package and writes receipts beneath `.data/full-course/rollout`, preserving
earlier pilot and journey receipts. Its Hosting label is `complete-az104-course`;
it does not upload learning progress or question data to Firestore.

A UI-only Hosting deployment does not upload new Firestore content or private
Storage objects. Publishing this repository does not automatically deploy the
Firebase app. GitHub Actions validates the public source and demo only.
