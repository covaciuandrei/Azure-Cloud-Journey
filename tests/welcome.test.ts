import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Welcome } from "../src/web/ui/Welcome.js";
import { ExamSelection } from "../src/web/ui/ExamSelection.js";
import { emptyCourseProgress, reduceCourseProgress } from "../src/web/course/progress.js";
import { courseFixture } from "./course-fixture.js";

const noAction = () => {};
test("exam selection offers only the available AZ-104 workspace with honest learning scope", () => {
  const html = renderToStaticMarkup(createElement(ExamSelection, { onSelect: noAction }));
  assert.match(html, /AZURE CLOUD JOURNEY/);
  assert.match(html, /Azure Administrator/);
  assert.match(html, /Available to study/);
  assert.equal((html.match(/<button\b/g) ?? []).length, 1);
  assert.match(html, /<button[^>]*>Select AZ-104<svg[^>]*aria-hidden="true"/);
  assert.match(html, /Guided lessons currently cover networking, not every AZ-104 domain/);
  assert.match(html, /Offline &amp; data/);
  assert.doesNotMatch(html, /coming soon|AZ-900|AZ-305|\u2014/i);
});

test("welcome renders real course and practice counts without inventing progress", () => {
  const course = courseFixture();
  const html = renderToStaticMarkup(createElement(Welcome, {
    course, progress: emptyCourseProgress(), questionCount: 519, onLearn: noAction, onPractice: noAction,
  }));
  assert.match(html, /8 modules \/ 16 lessons/);
  assert.match(html, /519 active questions/);
  assert.match(html, /Open networking course/);
  assert.match(html, /Open practice workspace/);
  assert.match(html, /AZ-104 \/ AZURE ADMINISTRATOR/);
  assert.doesNotMatch(html, /Continue learning|\u2014/);
});

test("welcome continues the real last lesson and does not count a stale revision as studied", () => {
  const course = courseFixture();
  const lesson = course.modules[0]!.lessons[0]!;
  const progress = reduceCourseProgress(emptyCourseProgress(), course, { type: "study", lessonId: lesson.id, studied: true }, 1000);
  const render = () => renderToStaticMarkup(createElement(Welcome, {
    course, progress, questionCount: 519, onLearn: noAction, onPractice: noAction,
  }));
  assert.match(render(), /Continue learning/);
  assert.match(render(), /1 of 16 lessons marked studied on this device/);
  progress.lessons[lesson.id]!.revision = "c".repeat(64);
  assert.match(render(), /0 of 16 lessons marked studied on this device/);
});

test("missing content does not produce fake counts or an invalid resume target", () => {
  const progress = emptyCourseProgress();
  progress.lastLessonId = "missing-lesson";
  const html = renderToStaticMarkup(createElement(Welcome, {
    course: null, progress, questionCount: undefined, onLearn: noAction, onPractice: noAction,
  }));
  assert.match(html, /Networking learning pilot/);
  assert.match(html, /Topic-based practice/);
  assert.doesNotMatch(html, /Continue learning|0 active questions|0 modules/);
});
