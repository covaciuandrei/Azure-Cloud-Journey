import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { TOPIC_IDS, TOPIC_VERSION, TOPIC_GUIDE_URL, matchesTopics, type TopicId, type TopicMap } from "../src/domain/topics.js";
import { TopicFilter } from "../src/web/ui/TopicFilter.js";
import { Setup } from "../src/web/ui/Setup.js";
import { createTopicLoader, withQuestionTopics } from "../src/web/topic-repository.js";
import type { QuestionSummary, StudyCatalog, StudyRepository } from "../src/web/types.js";
import { readTopicMap } from "../tools/topics/data.js";

const id = (n: number) => `q_${n.toString(16).padStart(64, "0")}`;
const revision = "a".repeat(64);
function summary(n: number, topics: TopicId[]): QuestionSummary {
  return { id: id(n), number: n + 1, kind: "single-select", grading: "automatic", provisional: false,
    commentCount: 0, omittedCommentCount: 0, hasImages: false, preview: "Fixture", searchText: "Fixture",
    discussionEnabled: false, topicIds: topics };
}
function catalog(count: number): StudyCatalog {
  return { schemaVersion: 1, bankVersion: "approved-7994-v1", sourceRevision: revision,
    releaseId: `r_${"b".repeat(64)}`,
    counts: { questions: count, comments: 0, images: 0, automatic: count, manual: 0, omittedComments: 0 },
    questions: Array.from({ length: count }, (_, n) => summary(n, ["virtual-machines"])) };
}
function topicMap(): TopicMap {
  return { schemaVersion: 1, taxonomyVersion: TOPIC_VERSION, guideUrl: TOPIC_GUIDE_URL, sourceRevision: revision,
    assignments: Object.fromEntries(Array.from({ length: 606 }, (_, n) => [id(n), ["virtual-machines"]])) };
}

test("topic matching uses any selected topic, with no implicit all-topics fallback", () => {
  assert.equal(matchesTopics(["virtual-machines", "network-security"], ["network-security"]), true);
  assert.equal(matchesTopics(["virtual-machines"], ["storage-access"]), false);
  assert.equal(matchesTopics(["virtual-machines"], []), false);
  assert.equal(matchesTopics(["virtual-machines"], TOPIC_IDS), true);
  assert.throws(() => matchesTopics(undefined, TOPIC_IDS), /missing/);
  const questions = [summary(0, ["virtual-machines", "network-security"])];
  assert.equal(questions.filter((q) => matchesTopics(q.topicIds, ["virtual-machines", "network-security"])).length, 1);
});

test("topic picker starts with every domain selected and supports an explicit empty selection", () => {
  const props = { questions: catalog(40).questions, onChange: () => {} };
  const all = renderToStaticMarkup(createElement(TopicFilter, { ...props, selected: [...TOPIC_IDS] }));
  assert.match(all, /All topics selected/);
  assert.equal((all.match(/checked=""/g) ?? []).length, 5);
  const none = renderToStaticMarkup(createElement(TopicFilter, { ...props, selected: [] }));
  assert.match(none, /0 of 15 subtopics selected/);
  assert.equal((none.match(/checked=""/g) ?? []).length, 0);
  const partial = renderToStaticMarkup(createElement(TopicFilter, { ...props, selected: ["virtual-machines"] }));
  assert.match(partial, /aria-checked="mixed"/);
});

test("exam setup refuses undersized pools instead of repeating questions or changing the format", () => {
  const small = renderToStaticMarkup(createElement(Setup, { mode: "exam", catalog: catalog(25), onStart: () => {} }));
  assert.match(small, /Only 25 questions match/);
  assert.match(small, /<button[^>]+type="submit"[^>]+disabled=""[^>]*>Start exam/);
  assert.match(small, /40 questions in 60 minutes/);
  const full = renderToStaticMarkup(createElement(Setup, { mode: "exam", catalog: catalog(40), onStart: () => {} }));
  assert.doesNotMatch(full, /type="submit"[^>]+disabled/);
  assert.match(full, /All topics selected/);
});

test("topic loading is cached, retryable and validates source coverage", async () => {
  let reads = 0;
  const load = createTopicLoader(async () => { reads++; return topicMap(); });
  const core = catalog(40);
  const repository: StudyRepository = {
    async loadCatalog() { return core; },
    async loadQuestion() { throw new Error("Unused"); },
    async loadQuestions() { throw new Error("Unused"); },
    async loadDiscussion() { throw new Error("Unused"); },
    mediaUrl() { throw new Error("Unused"); },
  };
  const decorated = withQuestionTopics(repository, load);
  const first = await decorated.loadCatalog();
  await decorated.loadCatalog();
  assert.equal(reads, 1);
  assert.deepEqual(first.questions[0]?.topicIds, ["virtual-machines"]);
  assert.notStrictEqual(first.questions[0], core.questions[0]);
  const wrong = withQuestionTopics(repository, createTopicLoader(async () => ({ ...topicMap(), sourceRevision: "c".repeat(64) })));
  await assert.rejects(wrong.loadCatalog(), /incomplete/);
  let attempts = 0;
  const retry = createTopicLoader(async () => { if (++attempts === 1) throw new Error("temporarily offline"); return topicMap(); });
  await assert.rejects(retry(), /temporarily offline/);
  assert.equal((await retry()).sourceRevision, revision);
});

test("reviewed classifications cover every question and retain consistent duplicate aliases", async () => {
  const map = await readTopicMap();
  const manifest = JSON.parse(await readFile(".data/clean-bank/data/manifest.json", "utf8")) as { catalogUrl: string };
  const current = JSON.parse(await readFile(`.data/clean-bank/${manifest.catalogUrl}`, "utf8")) as StudyCatalog;
  const legacy = JSON.parse(await readFile(".data/clean-bank/content/r_61ae993f4534c2d7b370d43a31ccc51c025bac080f0459df307f4d3ecaa7f296/catalog.json", "utf8")) as StudyCatalog;
  assert.equal(Object.keys(map.assignments).length, 606);
  assert.ok(current.questions.every((question) => map.assignments[question.id]?.length));
  const byNumber = (number: number) => map.assignments[current.questions.find((question) => question.number === number)!.id]!;
  for (const [number, topic] of [[83, "containers"], [91, "governance"], [206, "files-blobs"],
    [405, "storage-accounts"], [533, "storage-access"], [542, "app-service"], [604, "monitoring"]] as const) {
    assert.equal(byNumber(number)[0], topic);
  }
  assert.ok(!byNumber(533).includes("virtual-machines"), "Incidental VM names must not override the storage-firewall subject.");
  for (const [primary, duplicate] of [[48, 54], [152, 165]]) {
    const old = legacy.questions.find((question) => question.number === duplicate)!;
    assert.deepEqual(map.assignments[old.id], byNumber(primary!));
  }
});
