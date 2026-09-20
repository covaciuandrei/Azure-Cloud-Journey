import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CoursePointerSchema, CourseSchema, LegacyCourseSchema } from "../src/domain/course.js";
import { MAX_COURSE_BYTES } from "../src/domain/courseCatalog.js";
import { DomainCoverageSchema, validateCoverageReferences } from "../src/domain/courseCoverage.js";
import { FullCurriculumSchema } from "../tools/course/contracts.js";
import { loadCoursePublication } from "../tools/course/publication.js";
import { validateHostingCourse } from "../tools/firebase/deploy-hosting-adc.js";
import { loadCourseCoverage, loadCourseModules, parseCourseSelection } from "../tools/course/validate.js";
import { digest } from "../tools/ingest/normalize-shared.js";
import { writeData } from "../tools/review/data.js";
import { hash, json } from "../tools/web/bank.js";
import { loadCourse } from "../src/web/course/repository.js";
import { courseDomains, modulePracticeTopics } from "../src/web/course/catalog.js";
import { courseStorageKey, currentLessonProgress, emptyCourseProgress, readCourseProgress, reduceCourseProgress } from "../src/web/course/progress.js";
import { CoursePage } from "../src/web/course/CoursePage.js";
import { ExamSelection } from "../src/web/ui/ExamSelection.js";
import { Welcome } from "../src/web/ui/Welcome.js";
import { fullCourseFixture, fullCourseInputs } from "./full-course-fixture.js";

const noAction = () => {};
test("full-course fixture publishes 21 modules, 59 lessons and all 82 mapped objectives with bounded bytes", async (context) => {
  const course = await fullCourseFixture();
  assert.equal(course.modules.length, 21);
  assert.equal(course.modules.flatMap((module) => module.lessons).length, 59);
  assert.equal(course.domains.flatMap((domain) => domain.objectives).length, 82);
  assert.equal(course.coverage.flatMap((map) => map.objectives).length, 82);
  const bytes = Buffer.byteLength(json(course));
  context.diagnostic(`Synthetic full-course package: ${bytes} bytes; limit ${MAX_COURSE_BYTES}. Actual authored publication is measured independently.`);
  assert.ok(bytes < MAX_COURSE_BYTES);
  const pointer = CoursePointerSchema.parse({
    schemaVersion: 2, id: "az104", releaseId: course.releaseId, url: `courses/${course.releaseId}/az104.json`,
    sha256: hash(json(course)), modules: 21, lessons: 59, checkpoints: 177,
  });
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push(String(input));
    assert.equal(new Headers(init?.headers).get("X-AZ104-Offline"), "1");
    return String(input).endsWith("data/course.json") ? Response.json(pointer) : new Response(json(course));
  };
  assert.deepEqual(await loadCourse("https://study.example/", true, fetcher), course);
  assert.match(calls[1]!, /\/az104\.json$/);
  for (const changed of [
    { ...pointer, url: pointer.url.replace("az104.json", "networking.json") },
    { ...pointer, lessons: 85 }, { ...pointer, checkpoints: 421 }, { ...pointer, modules: 22 },
    { ...pointer, url: pointer.url.replace("az104.json", "../az104.json") },
  ]) assert.equal(CoursePointerSchema.safeParse(changed).success, false);
  await assert.rejects(loadCourse("https://study.example/", false, async (input) => String(input).endsWith("data/course.json")
    ? Response.json({ ...pointer, lessons: 60 }) : new Response(json(course))), /published index/);
  await assert.rejects(loadCourse("https://study.example/", false, async (input) => String(input).endsWith("data/course.json")
    ? Response.json(pointer) : new Response(" ".repeat(MAX_COURSE_BYTES + 1))), /size limit/);
});

test("coverage rejects missing/duplicate/foreign objectives, invalid targets, empty evidence and mention-only teaching", async () => {
  const course = await fullCourseFixture();
  const domain = course.domains[0]!;
  const map = course.coverage[0]!;
  const validate = (value: unknown) => validateCoverageReferences(DomainCoverageSchema.parse(value), domain, course.modules);
  const changed = () => structuredClone(map);
  const missing = changed(); missing.objectives.pop();
  assert.throws(() => validate(missing), /every official objective/);
  const duplicate = changed(); duplicate.objectives[1] = duplicate.objectives[0]!;
  assert.throws(() => validate(duplicate), /every official objective/);
  const foreign = changed(); foreign.objectives[0]!.objectiveId = "ig-99";
  assert.throws(() => validate(foreign), /every official objective/);
  for (const field of ["lessonId", "moduleId", "sectionIds", "checkpointIds", "evidence"] as const) {
    const malformed = changed();
    const target = malformed.objectives[0]!.lessons[0]!;
    if (field === "moduleId") target.moduleId = "storage-accounts";
    else if (field === "sectionIds") target.sectionIds = ["missing-section"];
    else if (field === "checkpointIds") target.checkpointIds = ["missing-checkpoint"];
    else target[field] = field === "evidence" ? "   " : "missing-lesson";
    assert.throws(() => validate(malformed));
  }
  const noExample = changed(); noExample.objectives[0]!.lessons[0]!.sectionIds = ["section-2"];
  assert.throws(() => validate(noExample), /worked application/);
  const thin = structuredClone(course.modules);
  thin[0]!.lessons[0]!.sections[0]!.blocks = [{ type: "paragraph", text: "A mention without substantive teaching." }];
  assert.throws(() => validateCoverageReferences(map, domain, thin), /substantive teaching/);
  const full = structuredClone(course);
  full.modules[0]!.lessons[0]!.sourceIds = ["missing-source"];
  assert.equal(CourseSchema.safeParse(full).success, false);
  const badOrder = structuredClone(course);
  badOrder.domains.reverse();
  assert.equal(CourseSchema.safeParse(badOrder).success, false);
});

test("monitoring allows the explicit mo-06 Network Watcher cross-link, not arbitrary cross-domain claims", async () => {
  const course = await fullCourseFixture();
  const domain = course.domains[4]!;
  const map = structuredClone(course.coverage[4]!);
  const watcher = course.modules.find((module) => module.id === "network-watcher")!;
  const target = map.objectives.find((objective) => objective.objectiveId === "mo-06")!.lessons[0]!;
  target.moduleId = watcher.id; target.lessonId = watcher.lessons[0]!.id;
  assert.doesNotThrow(() => validateCoverageReferences(map, domain, course.modules));
  map.objectives[0]!.lessons = [target];
  assert.throws(() => validateCoverageReferences(map, domain, course.modules), /foreign-domain/);
});

test("strict full publication binds every module and parsed metadata; partial validation requires only selected inputs", async () => {
  const root = resolve(`.data/full-course-test-${randomUUID()}`);
  const inputs = await fullCourseInputs();
  const approvalNote = "Synthetic test approval only, never a factual review or permission to publish teaching.";
  try {
    await mkdir(resolve(root, "content"), { recursive: true });
    await writeData("content/course.json", { schemaVersion: 1, activeCourse: "networking" }, root);
    await cp("content/networking", resolve(root, "content/networking"), { recursive: true });
    await writeData("content/az104/curriculum.json", inputs.curriculum, root);
    await writeData("content/az104/objectives.json", inputs.objectives, root);
    assert.equal((await loadCoursePublication(root)).course.id, "networking", "missing planned inputs do not break legacy activation");
    await assert.rejects(loadCoursePublication(root, "az104"), /ENOENT/);
    assert.throws(() => parseCourseSelection(["--domain", "storage", "--module", "storage-access"]), /not both/);
    assert.throws(() => parseCourseSelection(["--module", "unknown-module"]));
    for (const module of inputs.modules) {
      const entry = inputs.curriculum.modules.find((entry) => entry.id === module.id)!;
      await writeData(entry.sourcePath, module, root);
      assert.equal((await loadCourseModules(root, { module: module.id })).modules.length, 1);
    }
    for (const map of inputs.coverage) await writeData(`content/az104/coverage/${map.domainId}.json`, map, root);
    assert.equal((await loadCourseModules(root, { domain: "storage" })).modules.length, 3);
    assert.equal((await loadCourseCoverage(root, inputs.modules, "storage")).length, 1);
    await writeData("content/course.json", { schemaVersion: 1, activeCourse: "az104" }, root);
    await assert.rejects(loadCoursePublication(root), /review-approvals/);
    for (const domain of inputs.domains) {
      await writeData(`content/az104/review-approvals/${domain.id}.json`,
        inputs.modules.filter((module) => domain.moduleIds.includes(module.id)).map((module) => ({
          id: module.id, digest: digest(module), note: approvalNote,
        })), root);
    }
    await assert.rejects(loadCoursePublication(root), /metadata.json/);
    const metadata = {
      schemaVersion: 1, reviewedAt: "2026-09-20", reviewer: "coordinator",
      curriculumDigest: digest(inputs.curriculum), objectivesDigest: digest(inputs.objectives),
      coverageDigest: digest(inputs.coverage), note: approvalNote,
    };
    await writeData("content/az104/review-approvals/metadata.json", metadata, root);
    const publication = await loadCoursePublication(root);
    assert.equal(publication.pointer.schemaVersion, 2);
    assert.equal(publication.pointer.lessons, 59);
    assert.equal(publication.pointer.sha256, hash(json(publication.course)));
    for (const [path, value] of publication.files) await writeData(`dist/${path}`, value, root);
    assert.equal((await validateHostingCourse(root)).id, "az104");
    const oversized = inputs.modules.map((module, index) => index >= 10 ? module : {
      ...module, glossary: Array.from({ length: 20 }, (_, term) => ({
        term: `${term}`.padEnd(8000, "x"), definition: "Synthetic size-bound fixture. ".padEnd(8000, "x"),
      })),
    });
    for (const module of oversized.slice(0, 10)) {
      await writeData(inputs.curriculum.modules.find((entry) => entry.id === module.id)!.sourcePath, module, root);
    }
    for (const domain of inputs.domains) {
      await writeData(`content/az104/review-approvals/${domain.id}.json`,
        oversized.filter((module) => domain.moduleIds.includes(module.id)).map((module) => ({
          id: module.id, digest: digest(module), note: approvalNote,
        })), root);
    }
    await assert.rejects(loadCoursePublication(root), /4 MiB size limit/);
    for (const module of inputs.modules.slice(0, 10)) {
      await writeData(inputs.curriculum.modules.find((entry) => entry.id === module.id)!.sourcePath, module, root);
    }
    for (const domain of inputs.domains) {
      await writeData(`content/az104/review-approvals/${domain.id}.json`,
        inputs.modules.filter((module) => domain.moduleIds.includes(module.id)).map((module) => ({
          id: module.id, digest: digest(module), note: approvalNote,
        })), root);
    }
    for (const field of ["curriculumDigest", "objectivesDigest", "coverageDigest"]) {
      await writeData("content/az104/review-approvals/metadata.json", { ...metadata, [field]: "0".repeat(64) }, root);
      await assert.rejects(loadCoursePublication(root), /exact curriculum, objective guide and coverage/);
    }
    await writeData("content/az104/review-approvals/metadata.json", metadata, root);
    await writeData("content/az104/curriculum.json", { ...inputs.curriculum, title: "A changed synthetic course title" }, root);
    await assert.rejects(loadCoursePublication(root), /exact curriculum/);
    await writeData("content/az104/curriculum.json", inputs.curriculum, root);
    const changedObjectives = structuredClone(inputs.objectives);
    changedObjectives.domains[0]!.groups[0]!.objectives[0]!.label = "A changed synthetic objective meaning";
    await writeData("content/az104/objectives.json", changedObjectives, root);
    await assert.rejects(loadCoursePublication(root), /exact curriculum/);
    await writeData("content/az104/objectives.json", inputs.objectives, root);
    await writeData(inputs.curriculum.modules[0]!.sourcePath, { ...inputs.modules[0], summary: "Changed synthetic teaching." }, root);
    await assert.rejects(loadCoursePublication(root), /approve this exact module/);
    await writeData(inputs.curriculum.modules[0]!.sourcePath, inputs.modules[0], root);
    const mutated = structuredClone(inputs.coverage[0]!);
    mutated.objectives[0]!.lessons[0]!.evidence += " A changed synthetic teaching claim.";
    await writeData("content/az104/coverage/identity-governance.json", mutated, root);
    await assert.rejects(loadCoursePublication(root), /exact curriculum/);
    await writeData("content/az104/coverage/identity-governance.json", inputs.coverage[0], root);
    await rm(resolve(root, "content/az104/review-approvals/networking.json"));
    await assert.rejects(loadCoursePublication(root), /networking.json/, "full publication never falls back to legacy networking approval");
    await rm(resolve(root, "content/az104/modules/azure-monitor.json"));
    assert.equal((await loadCourseModules(root, { domain: "storage" })).modules.length, 3);
    await assert.rejects(loadCourseModules(root), /azure-monitor/);
    const foreignPath = structuredClone(inputs.curriculum);
    foreignPath.modules[0]!.sourcePath = "content/az104/modules/storage-access.json";
    assert.equal(FullCurriculumSchema.safeParse(foreignPath).success, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("activating the full course preserves guest and account bookmarks, checks, studied markers and lesson revisions", async () => {
  const full = await fullCourseFixture();
  const { domains: _domains, coverage: _coverage, objectiveEffectiveDate: _effective, ...legacyFields } = full;
  const legacy = LegacyCourseSchema.parse({
    ...legacyFields, schemaVersion: 1, id: "networking",
    modules: full.modules.filter((module) => module.domainId === "networking").map(({ domainId: _domain, practiceTopics: _topics, ...module }) => module),
  });
  const lesson = legacy.modules[0]!.lessons[0]!;
  for (const uid of [null, "alice", "bob"]) {
    let progress = reduceCourseProgress(emptyCourseProgress(), legacy, { type: "study", lessonId: lesson.id, studied: true }, 1);
    progress = reduceCourseProgress(progress, legacy, { type: "bookmark", lessonId: lesson.id }, 2);
    progress = reduceCourseProgress(progress, legacy, { type: "check", lessonId: lesson.id, checkpointId: "check-1", selectedIds: ["correct"] }, 3);
    const stored = JSON.stringify(progress);
    const read = readCourseProgress({ getItem: () => stored }, courseStorageKey(uid));
    assert.equal(read.writable, true);
    const fullLesson = full.modules.flatMap((module) => module.lessons).find((item) => item.id === lesson.id)!;
    assert.deepEqual(currentLessonProgress(read.progress, fullLesson), progress.lessons[lesson.id]);
    const next = reduceCourseProgress(read.progress, full, { type: "bookmark", lessonId: full.modules[0]!.lessons[0]!.id }, 4);
    assert.deepEqual(next.lessons[lesson.id], progress.lessons[lesson.id]);
  }
});

test("full course renders real domain counts, grouped navigation, coverage links and typed practice topics", async () => {
  const course = await fullCourseFixture();
  const props = { course, progress: emptyCourseProgress(), activeLessonId: null, warning: null,
    onOverview: noAction, onOpenLesson: noAction, onStudy: noAction, onBookmark: noAction, onPractice: noAction, onCheck: noAction };
  const html = renderToStaticMarkup(createElement(CoursePage, props));
  assert.match(html, /Five domains of Azure administration/);
  assert.match(html, /82 mapped official objectives/);
  assert.equal((html.match(/Practice this domain/g) ?? []).length, 5);
  assert.match(html, /21 modules \/ 59 lessons/);
  const reader = renderToStaticMarkup(createElement(CoursePage, { ...props, activeLessonId: course.modules[0]!.lessons[0]!.id }));
  assert.match(reader, /Official objective coverage/);
  assert.match(reader, /ig-01/);
  assert.match(reader, /href="#course-section-/);
  for (const domain of courseDomains(course)) assert.match(reader, new RegExp(domain.title));
  assert.deepEqual(modulePracticeTopics(course.modules[0]!), ["entra-users-groups"]);
  assert.deepEqual(modulePracticeTopics(course.modules.at(-1)!), ["backup-recovery"]);
  const welcome = renderToStaticMarkup(createElement(Welcome, { course, progress: emptyCourseProgress(),
    questionCount: 10, onLearn: noAction, onPractice: noAction }));
  const exam = renderToStaticMarkup(createElement(ExamSelection, { course, onSelect: noAction }));
  assert.match(welcome, /Open AZ-104 course/);
  assert.match(exam, /21 modules and 59 lessons/);
  assert.doesNotMatch(welcome + exam, /pilot covers networking|not every AZ-104 domain/);
});
