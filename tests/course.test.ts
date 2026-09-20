import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { CourseBlockSchema, CourseSchema, CheckpointSchema, checkpointCorrect } from "../src/domain/course.js";
import { chooseRoute, containsAddress, evaluateRules, ipv4Address, ipv4Number, subnetDetails, type DemoRoute } from "../src/domain/networkingTools.js";
import { courseStorageKey, currentLessonProgress, emptyCourseProgress, readCourseProgress, reduceCourseProgress } from "../src/web/course/progress.js";
import { loadCourse } from "../src/web/course/repository.js";
import { parseLearningRoute } from "../src/web/course/navigation.js";
import { courseFixture } from "./course-fixture.js";

test("CIDR calculations explain exact ranges, alignment and Azure reservations", () => {
  const subnet = subnetDetails("10.20.1.0/24");
  assert.equal(subnet.hostBits, 8);
  assert.equal(subnet.total, 256);
  assert.equal(subnet.mask, "255.255.255.0");
  assert.equal(subnet.firstAssignable, "10.20.1.4");
  assert.equal(subnet.lastAssignable, "10.20.1.254");
  assert.equal(subnet.assignable, 251);
  assert.equal(subnetDetails("10.20.1.150/25").network, "10.20.1.128/25");
  assert.equal(subnetDetails("10.20.1.150/25").aligned, false);
  assert.equal(subnetDetails("10.20.1.0/23").network, "10.20.0.0/23");
  assert.equal(subnetDetails("10.20.1.0/23").lastAddress, "10.20.1.255");
  assert.equal(subnetDetails("255.255.255.255/32").lastAddress, "255.255.255.255");
  assert.equal(subnetDetails("0.0.0.0/0").total, 4294967296);
  assert.equal(subnetDetails("10.0.0.0/30").azureSubnetSupported, false);
  assert.equal(subnetDetails("10.0.0.0/29").assignable, 3);
  assert.equal(subnetDetails("127.0.0.0/24").azureSubnetSupported, false);
  assert.equal(subnetDetails("168.63.129.0/24").reservedOverlap, "168.63.129.16/32");
  assert.equal(subnetDetails("224.0.0.0/24").assignable, null);
  assert.equal(containsAddress("10.20.1.0/24", "10.20.2.0"), false);
  for (const invalid of ["10.256.0.0/24", "10.20.1/24", "10.020.1.1/24", "10.1.2.3/33", "10.1.2.3/-1", "1e2.0.0.0/24", "10.1.2.3"]) {
    assert.throws(() => subnetDetails(invalid));
  }
  for (const address of ["0.0.0.0", "10.20.1.4", "172.20.0.5", "255.255.255.255"]) {
    assert.equal(ipv4Address(ipv4Number(address)), address);
  }
});

test("ordinary route selection considers prefix length before route source preference", () => {
  const routes: DemoRoute[] = [
    { id: "udr-default", prefix: "0.0.0.0/0", source: "User", nextHop: "NVA" },
    { id: "peering", prefix: "10.40.0.0/16", source: "System", nextHop: "Peering" },
  ];
  assert.equal(chooseRoute("10.40.1.5", routes)?.id, "peering");
  routes.push({ id: "udr-specific", prefix: "10.40.0.0/16", source: "User", nextHop: "NVA" });
  assert.equal(chooseRoute("10.40.1.5", routes)?.id, "udr-specific");
  routes.push({ id: "office-custom", prefix: "172.20.0.0/16", source: "User", nextHop: "NVA" });
  routes.push({ id: "bgp-specific", prefix: "172.20.8.0/24", source: "BGP", nextHop: "Gateway" });
  assert.equal(chooseRoute("172.20.8.10", routes)?.id, "bgp-specific");
  assert.equal(chooseRoute("198.51.100.7", routes)?.id, "udr-default");
  assert.equal(chooseRoute("198.51.100.7", []), null);
  assert.throws(() => chooseRoute("not-an-ip", routes));
});

test("NSGs evaluate the first matching rule, not the last matching allow", () => {
  const flow = { source: "10.20.1.4", destination: "10.20.2.5", protocol: "TCP" as const, port: 1433 };
  const allow = { name: "AllowWeb", priority: 200, source: "10.20.1.0/24", destination: "10.20.2.0/24",
    protocol: "TCP" as const, port: 1433, action: "Allow" as const };
  const deny = { name: "DenyDatabase", priority: 100, source: "*", destination: "*",
    protocol: "TCP" as const, port: 1433, action: "Deny" as const };
  assert.equal(evaluateRules(flow, [allow, deny]).action, "Deny");
  assert.equal(evaluateRules(flow, [{ ...allow, priority: 100 }, { ...deny, priority: 200 }]).action, "Allow");
  assert.throws(() => evaluateRules({ ...flow, port: 70000 }, [deny]), /port/);
  assert.throws(() => evaluateRules({ ...flow, protocol: "UDP" }, [allow, deny]), /default rule/);
});

test("learning schema rejects em dashes, ambiguous checkpoint keys and broken diagrams", () => {
  const course = courseFixture();
  assert.throws(() => CourseSchema.parse({ ...course, title: "Do not use \u2014 here" }), /em dashes/);
  assert.throws(() => CourseSchema.parse({ ...course, title: "Do not use &mdash; here" }), /em dashes/);
  const checkpoint = course.modules[0]!.lessons[0]!.checkpoints[0]!;
  assert.throws(() => CheckpointSchema.parse({ ...checkpoint, correctIds: ["correct", "wrong-one"] }));
  assert.equal(checkpointCorrect(checkpoint, ["correct"]), true);
  assert.equal(checkpointCorrect(checkpoint, ["correct", "correct"]), false);
  assert.equal(checkpointCorrect(checkpoint, ["wrong-one"]), false);
  assert.throws(() => CourseBlockSchema.parse({ type: "diagram", title: "Broken example", description: "Invalid connection",
    nodes: [{ id: "one", label: "One", detail: "First", column: 0, row: 0 }, { id: "two", label: "Two", detail: "Second", column: 1, row: 0 }],
    edges: [{ from: "one", to: "missing", label: "Invalid" }],
  }));
});

test("learning progress is account-isolated and preserves invalid device data rather than overwriting it", () => {
  assert.notEqual(courseStorageKey(null), courseStorageKey("alice"));
  assert.notEqual(courseStorageKey("alice"), courseStorageKey("bob"));
  assert.throws(() => courseStorageKey("../bob"));
  const result = readCourseProgress({ getItem() { return "{broken"; } }, courseStorageKey(null));
  assert.equal(result.writable, false);
  assert.match(result.warning!, /left untouched/);
  assert.equal(readCourseProgress({ getItem() { return null; } }, courseStorageKey(null)).writable, true);
});

test("studying, checkpoints and bookmarks persist separately and stale lesson checks do not count", () => {
  const course = courseFixture();
  const lesson = course.modules[0]!.lessons[0]!;
  let progress = emptyCourseProgress();
  progress = reduceCourseProgress(progress, course, { type: "open", lessonId: lesson.id }, 1);
  assert.equal(progress.lastLessonId, lesson.id);
  assert.deepEqual(progress.lessons, {});
  progress = reduceCourseProgress(progress, course, { type: "bookmark", lessonId: lesson.id }, 2);
  progress = reduceCourseProgress(progress, course, { type: "check", lessonId: lesson.id, checkpointId: "check-1", selectedIds: ["wrong-one"] }, 3);
  assert.equal(progress.lessons[lesson.id]!.studiedAt, null);
  progress = reduceCourseProgress(progress, course, { type: "study", lessonId: lesson.id, studied: true }, 4);
  assert.equal(progress.lessons[lesson.id]!.studiedAt, 4);
  progress = reduceCourseProgress(progress, course, { type: "check", lessonId: lesson.id, checkpointId: "check-1", selectedIds: ["correct"] }, 5);
  assert.equal(progress.lessons[lesson.id]!.answers["check-1"]!.attempts, 2);
  const updated = currentLessonProgress(progress, { ...lesson, revision: "c".repeat(64) });
  assert.equal(updated.bookmarked, true);
  assert.equal(updated.studiedAt, null);
  assert.deepEqual(updated.answers, {});
  assert.equal(progress.lessons[lesson.id]!.studiedAt, 4);
  assert.throws(() => reduceCourseProgress(progress, course, {
    type: "check", lessonId: lesson.id, checkpointId: "check-1", selectedIds: ["foreign"],
  }));
});

test("course loading uses same-origin static files, checks integrity and honors cache-only mode", async () => {
  const course = courseFixture();
  const body = JSON.stringify(course);
  const pointer = {
    schemaVersion: 1, releaseId: course.releaseId, url: `courses/${course.releaseId}/networking.json`,
    sha256: createHash("sha256").update(body).digest("hex"), modules: 8, lessons: 16, checkpoints: 48,
  };
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push(String(input));
    assert.equal(init?.cache, "no-store");
    assert.equal(new Headers(init?.headers).get("X-AZ104-Offline"), "1");
    return String(input).endsWith("/data/course.json") ? Response.json(pointer) : new Response(body);
  };
  assert.deepEqual(await loadCourse("https://study.example/app/", true, fetcher), course);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((url) => url.startsWith("https://study.example/app/")));
  await assert.rejects(loadCourse("https://study.example/", false, async (input) =>
    String(input).endsWith("/data/course.json") ? Response.json(pointer) : new Response(`${body} `)), /integrity/);
  await assert.rejects(loadCourse("https://study.example/", false, async () => new Response("Unavailable", { status: 503 })), /unavailable/);
  await assert.rejects(loadCourse("file:///private/", false, fetcher), /origin/);
});

test("root and exams routes always open exam selection while workspace deep links stay direct", () => {
  for (const hash of ["", "#", "#exams"]) {
    assert.deepEqual(parseLearningRoute(hash), { section: "exams", lessonId: null, error: null });
  }
  for (const [hash, section] of [["#home", "welcome"], ["#learn", "learn"], ["#practice", "practice"]]) {
    assert.deepEqual(parseLearningRoute(hash!), { section, lessonId: null, error: null });
  }
  assert.deepEqual(parseLearningRoute("#learn/cidr-and-subnets"),
    { section: "learn", lessonId: "cidr-and-subnets", error: null });
});

test("learning deep links reject unsafe, malformed and unrecognized identities", () => {
  for (const hash of ["#learn/../../secret", "#learn/%GG", "#learn/", "#learn/AZ-104", "#exams/az-900", "#unknown"]) {
    const route = parseLearningRoute(hash);
    assert.notEqual(route.error, null);
    assert.equal(route.lessonId, null);
  }
});
