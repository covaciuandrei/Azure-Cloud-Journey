import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AuthoredModuleSchema, CoursePointerSchema, CourseSchema } from "../src/domain/course.js";
import {
  SC900_MODULE_IDS, SC900_OBJECTIVE_DATE_NOTICE, courseContentPath, coursePointerPath,
} from "../src/domain/courseCatalog.js";
import { DomainCoverageSchema, validateCoverageReferences } from "../src/domain/courseCoverage.js";
import { loadFullCourseContract, Sc900CurriculumSchema, Sc900ObjectivesSchema } from "../tools/course/contracts.js";
import { loadCoursePublication } from "../tools/course/publication.js";
import { loadCourseCoverage, loadCourseModules, parseCourseSelection } from "../tools/course/validate.js";
import { digest } from "../tools/ingest/normalize-shared.js";
import { writeData } from "../tools/review/data.js";
import { hash, json } from "../tools/web/bank.js";
import { loadCourse } from "../src/web/course/repository.js";
import { courseDomains, courseLabel, modulePracticeTopics } from "../src/web/course/catalog.js";
import { courseStorageKey, emptyCourseProgress, readCourseProgress, reduceCourseProgress } from "../src/web/course/progress.js";
import { CoursePage } from "../src/web/course/CoursePage.js";
import { fullCourseInputs } from "./full-course-fixture.js";

const approvalNote = "Synthetic approval for isolated contract tests only. This is not factual teaching review and never authorizes a production publication.";
const noAction = () => {};

test("SC-900 contracts pin the announced 58 objectives and exact 12-module, 26-lesson allocation", async () => {
  const { curriculum, objectives, domains } = await loadFullCourseContract(process.cwd(), "sc900");
  assert.equal(curriculum.modules.length, 12);
  assert.equal(curriculum.modules.flatMap((module) => module.lessonIds).length, 26);
  assert.equal(domains.length, 4);
  assert.equal(domains.flatMap((domain) => domain.objectives).length, 58);
  assert.deepEqual(curriculum.modules.map((module) => module.id), SC900_MODULE_IDS);
  assert.equal(Sc900ObjectivesSchema.parse(objectives).dateNotice, SC900_OBJECTIVE_DATE_NOTICE);
  assert.equal(Sc900ObjectivesSchema.safeParse({ ...objectives, previousEnglishSnapshotVerified: true }).success, false);
  assert.equal(Sc900ObjectivesSchema.safeParse({ ...objectives, statusAtReview: "effective" }).success, false);
  assert.equal(Sc900ObjectivesSchema.safeParse({ ...objectives, effectiveDate: "2025-11-07" }).success, false);
  const changed = structuredClone(curriculum);
  changed.modules[0]!.lessonIds[0] = "invented-lesson";
  assert.equal(Sc900CurriculumSchema.safeParse(changed).success, false);
  const escaped = structuredClone(curriculum);
  escaped.modules[0]!.sourcePath = "content/sc900/../az104/modules/entra-identities.json";
  assert.equal(Sc900CurriculumSchema.safeParse(escaped).success, false);
  assert.deepEqual(parseCourseSelection(["--exam", "sc900", "--module", "sc-security-foundations"]),
    { exam: "sc900", module: "sc-security-foundations" });
  assert.throws(() => parseCourseSelection(["--exam", "sc900", "--course", "az104"]), /agree/);
  assert.throws(() => parseCourseSelection(["--exam", "sc900", "--module", "sc-made-up"]));
  assert.throws(() => parseCourseSelection(["--exam", "sc900", "--module", "sc-security-foundations", "--domain", "sc-concepts"]), /not both/);
});

test("SC-900 partial validation is bounded; full publication requires exact approvals and explicit activation", async () => {
  const root = resolve(`.data/sc900-course-test-${randomUUID()}`);
  const inputs = await fullCourseInputs("sc900");
  const metadata = {
    schemaVersion: 1, reviewedAt: "2026-09-22", reviewer: "coordinator",
    curriculumDigest: digest(inputs.curriculum), objectivesDigest: digest(inputs.objectives),
    coverageDigest: digest(inputs.coverage), note: approvalNote,
  };
  const writeApprovals = async () => {
    for (const domain of inputs.domains) await writeData(`content/sc900/review-approvals/${domain.id}.json`,
      inputs.modules.filter((module) => domain.moduleIds.includes(module.id)).map((module) => ({
        id: module.id, digest: digest(module), note: approvalNote,
      })), root);
  };
  try {
    await mkdir(root, { recursive: true });
    await writeData("content/sc900/curriculum.json", inputs.curriculum, root);
    await writeData("content/sc900/objectives.json", inputs.objectives, root);
    for (const module of inputs.modules.slice(0, 2)) {
      await writeData(inputs.curriculum.modules.find((entry) => entry.id === module.id)!.sourcePath, module, root);
    }
    await writeData("content/sc900/coverage/sc-concepts.json", inputs.coverage[0], root);
    assert.equal((await loadCourseModules(root, { exam: "sc900", module: "sc-security-foundations" })).modules.length, 1);
    assert.equal((await loadCourseModules(root, { exam: "sc900", domain: "sc-concepts" })).modules.length, 2);
    assert.equal((await loadCourseCoverage(root, inputs.modules.slice(0, 2), "sc-concepts", "sc900")).length, 1);
    await assert.rejects(loadCourseModules(root, { exam: "sc900", module: "entra-identities" }), /Unknown/);
    await assert.rejects(loadCourseCoverage(root, inputs.modules, "storage", "sc900"), /Unknown/);
    await assert.rejects(loadCoursePublication(root, "sc900"), /ENOENT/);
    for (const module of inputs.modules.slice(2)) {
      await writeData(inputs.curriculum.modules.find((entry) => entry.id === module.id)!.sourcePath, module, root);
    }
    for (const coverage of inputs.coverage.slice(1)) await writeData(`content/sc900/coverage/${coverage.domainId}.json`, coverage, root);
    await assert.rejects(loadCoursePublication(root, "sc900"), /review-approvals/);
    await writeApprovals();
    await assert.rejects(loadCoursePublication(root, "sc900"), /metadata.json/);
    await writeData("content/sc900/review-approvals/metadata.json", metadata, root);
    const publication = await loadCoursePublication(root, "sc900");
    const { course, pointer } = publication;
    assert.equal(course.schemaVersion, 3);
    assert.equal(pointer.schemaVersion, 3);
    if (course.schemaVersion !== 3 || pointer.schemaVersion !== 3) throw new Error("Expected SC-900 publication.");
    assert.equal(pointer.active, false);
    assert.equal(pointer.modules, 12);
    assert.equal(pointer.lessons, 26);
    assert.equal(pointer.checkpoints, 78);
    assert.equal(pointer.sha256, hash(json(course)));
    assert.deepEqual([...publication.files.keys()], [
      `exams/sc900/course/releases/${course.releaseId}/sc900.json`, "exams/sc900/course/current.json",
    ]);
    assert.equal(course.objectiveDateNotice, SC900_OBJECTIVE_DATE_NOTICE);
    assert.equal(course.previousEnglishSnapshotVerified, false);
    assert.equal(course.coverage.flatMap((map) => map.objectives).length, 58);
    const calls: string[] = [];
    const fetcher = (active: boolean): typeof fetch => async (input) => {
      calls.push(String(input));
      return String(input).endsWith(coursePointerPath("sc900")) ? Response.json({ ...pointer, active }) : new Response(json(course));
    };
    await assert.rejects(loadCourse("https://study.example/app/", false, fetcher(false), "sc900"), /approval/);
    assert.equal(calls.length, 1, "inactive pointers never load immutable materials or fall back");
    calls.length = 0;
    assert.deepEqual(await loadCourse("https://study.example/app/", false, fetcher(true), "sc900"), course);
    assert.deepEqual(calls, [
      "https://study.example/app/exams/sc900/course/current.json",
      `https://study.example/app/${courseContentPath("sc900", course.releaseId)}`,
    ]);
    await assert.rejects(loadCourse("https://study.example/", false, async () => Response.json(pointer)), /different exam/);
    await assert.rejects(loadCourse("https://study.example/", false, async (input) =>
      String(input).endsWith("current.json") ? Response.json({ ...pointer, active: true }) : new Response(json(course) + " "), "sc900"), /integrity/);
    for (const mutation of [
      { ...pointer, url: `courses/${course.releaseId}/sc900.json` },
      { ...pointer, lessons: 27 }, { ...pointer, modules: 13 }, { ...pointer, checkpoints: 131 },
      { ...pointer, url: pointer.url.replace("/sc900/", "/az104/") },
    ]) assert.equal(CoursePointerSchema.safeParse(mutation).success, false);
    const missing = structuredClone(course); missing.modules[0]!.lessons[0]!.id = "invented-lesson";
    assert.equal(CourseSchema.safeParse(missing).success, false);
    assert.equal(AuthoredModuleSchema.safeParse({ ...inputs.modules[0], id: "sc-not-allocated" }).success, false);
    const unassessed = structuredClone(course.coverage[0]!);
    unassessed.objectives[0]!.lessons[0]!.checkpointIds = [];
    assert.throws(() => validateCoverageReferences(unassessed, course.domains[0]!, course.modules), /checkpoint/);
    const foreign = structuredClone(course.coverage[0]!); foreign.objectives[0]!.objectiveId = "sc-i-01";
    assert.equal(DomainCoverageSchema.safeParse(foreign).success, false);
    const overview = renderToStaticMarkup(createElement(CoursePage, {
      course, progress: emptyCourseProgress(), activeLessonId: null, warning: null,
      onOverview: noAction, onOpenLesson: noAction, onStudy: noAction, onBookmark: noAction, onPractice: noAction, onCheck: noAction,
    }));
    const lesson = renderToStaticMarkup(createElement(CoursePage, {
      course, progress: emptyCourseProgress(), activeLessonId: course.modules[0]!.lessons[0]!.id, warning: null,
      onOverview: noAction, onOpenLesson: noAction, onStudy: noAction, onBookmark: noAction, onPractice: noAction, onCheck: noAction,
    }));
    for (const html of [overview, lesson]) {
      assert.match(html, /Announced outline, effective October 21, 2026/);
      assert.match(html, /No previous English objective snapshot has been verified/);
      assert.doesNotMatch(html, /Five domains of Azure administration/);
    }
    assert.match(overview, /58 mapped official objectives/);
    assert.match(overview, /12 modules \/ 26 lessons/);
    assert.equal(courseDomains(course).length, 4);
    assert.equal(courseLabel(course), "SC-900 course");
    assert.deepEqual(modulePracticeTopics(course.modules[0]!), ["sc-security-concepts"]);
    for (const uid of [null, "alice", "bob"]) {
      assert.equal(courseStorageKey(uid), `az104-networking-course:v1:${uid ? `account:${uid}` : "guest"}`);
      assert.notEqual(courseStorageKey(uid), courseStorageKey(uid, "sc900"));
      const progress = reduceCourseProgress(emptyCourseProgress(), course, {
        type: "bookmark", lessonId: course.modules[0]!.lessons[0]!.id,
      });
      const storage = new Map([[courseStorageKey(uid, "sc900"), JSON.stringify(progress)]]);
      const reader = { getItem: (key: string) => storage.get(key) ?? null };
      assert.deepEqual(readCourseProgress(reader, courseStorageKey(uid)).progress, emptyCourseProgress());
      assert.deepEqual(readCourseProgress(reader, courseStorageKey(uid, "sc900")).progress, progress);
    }
    await assert.rejects(loadCoursePublication(root, "sc900", { activate: true }), /activation.json/);
    const activation = { schemaVersion: 1, examId: "sc900", approved: true, reviewer: "coordinator",
      reviewedAt: "2026-09-22", releaseId: course.releaseId, sha256: pointer.sha256, note: approvalNote };
    await writeData("content/sc900/review-approvals/activation.json", { ...activation, sha256: "0".repeat(64) }, root);
    await assert.rejects(loadCoursePublication(root, "sc900", { activate: true }), /exact SC-900 release/);
    await writeData("content/sc900/review-approvals/activation.json", activation, root);
    const activated = await loadCoursePublication(root, "sc900", { activate: true });
    assert.equal(activated.pointer.schemaVersion === 3 && activated.pointer.active, true);
    const inactiveAgain = (await loadCoursePublication(root, "sc900")).pointer;
    assert.equal(inactiveAgain.schemaVersion === 3 && inactiveAgain.active, false, "activation never happens automatically, even with an approval file");
    for (const field of ["curriculumDigest", "objectivesDigest", "coverageDigest"]) {
      await writeData("content/sc900/review-approvals/metadata.json", { ...metadata, [field]: "0".repeat(64) }, root);
      await assert.rejects(loadCoursePublication(root, "sc900"), /exact curriculum/);
    }
    await writeData("content/sc900/review-approvals/metadata.json", metadata, root);
    await writeData(inputs.curriculum.modules[0]!.sourcePath, { ...inputs.modules[0], summary: "Changed synthetic teaching." }, root);
    await assert.rejects(loadCoursePublication(root, "sc900"), /approve this exact module/);
    await writeData(inputs.curriculum.modules[0]!.sourcePath, inputs.modules[0], root);
    await rm(resolve(root, "content/sc900/review-approvals/sc-security.json"));
    await assert.rejects(loadCoursePublication(root, "sc900"), /sc-security.json/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
