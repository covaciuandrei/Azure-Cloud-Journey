# Azure Cloud Journey

Understand Azure concepts, then put them into practice.

**Live application:** [study-az104.web.app](https://study-az104.web.app)

**Source repository:** [covaciuandrei/Azure-Cloud-Journey](https://github.com/covaciuandrei/Azure-Cloud-Journey)

The application is hosted on **Firebase Hosting**. GitHub stores the application
source and original learning material; it is not the current web host.

Choose **AZ-104: Azure Administrator** on the opening screen, then enter
**Learn** or **Practice & exams**. Existing lesson and practice links still open
directly. AZ-104 is currently the only available exam.

## What is included

- A React and TypeScript interface with a blue Coursebook layout.
- An original AZ-104 course covering **5 domains, 21 modules, 59 lessons,
  241 checkpoints and all 82 listed official objectives**.
- First-principles explanations, worked examples, diagrams, glossary entries
  and references to official documentation.
- Interactive subnet, route and NSG teaching tools.
- Shuffled answer choices, topic filters, practice sessions and timed exams.
- Separate guest and signed-in progress, Google sign-in and recent statistics.
- Integrity-checked offline downloads in the full hosted application.
- Firebase rules and guarded administration/publication tooling.

This is an independent study application, not an official Microsoft course.
The course maps the published objectives effective **April 17, 2026**, with
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
| Original course inputs in `content/networking/` and `content/az104/` | The downloaded third-party practice bank, comments and images |
| Synthetic demo question generation | Generated `public/data`, `content`, `teaching` and `courses` exports |
| Firebase rules and deployment safeguards | Browser profiles, account histories, emulator logs and caches |
| Dependency lockfile and public-source CI | Private working artifacts, quota journals and deployment receipts |

The live application currently has **519 active practice questions**. That bank
is separate from the public repository and is not redistributed here. Its
historical copies remain available in the owner's existing environment for
saved-session compatibility.

`content/networking/` and `content/az104/` contain original teaching material,
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
