import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";

interface Entry { id: string; number: number; sourceNumbers?: number[] }
interface Catalog { questions: Entry[] }
const bank = ".data/clean-bank";
async function catalog(release: string): Promise<Catalog> {
  return JSON.parse(await readFile(`${bank}/content/${release}/catalog.json`, "utf8")) as Catalog;
}

test("the frozen active bank groups exactly the two confirmed duplicate pairs", async () => {
  const manifest = JSON.parse(await readFile(`${bank}/data/manifest.json`, "utf8")) as { releaseId: string };
  const current = await catalog(manifest.releaseId);
  assert.equal(current.questions.length, 604);
  assert.equal(new Set(current.questions.map((entry) => entry.id)).size, 604);
  const byNumber = (number: number) => current.questions.find((entry) => (entry.sourceNumbers ?? [entry.number]).includes(number));
  assert.equal(byNumber(48)?.id, byNumber(54)?.id);
  assert.equal(byNumber(152)?.id, byNumber(165)?.id);
  const occurrences = current.questions.flatMap((entry) => entry.sourceNumbers ?? [entry.number]).sort((a, b) => a - b);
  assert.deepEqual(occurrences, Array.from({ length: 606 }, (_, index) => index + 1));
  for (const [left, right] of [[17, 18], [125, 126], [210, 217], [214, 258], [494, 495]]) {
    assert.notEqual(byNumber(left!)?.id, byNumber(right!)?.id);
  }
});

test("sanitized historical snapshots retain every source identity for saved sessions", async () => {
  const releases = await readdir(`${bank}/content`);
  assert.ok(releases.length >= 4);
  let originalFound = false;
  for (const release of releases) {
    const snapshot = await catalog(release);
    const numbers = new Set(snapshot.questions.flatMap((entry) => entry.sourceNumbers ?? [entry.number]));
    assert.equal(numbers.size, 606);
    assert.ok(snapshot.questions.length === 604 || snapshot.questions.length === 606);
    if (snapshot.questions.length === 606) {
      originalFound = true;
      for (const [left, right] of [[48, 54], [152, 165]]) {
        assert.notEqual(
          snapshot.questions.find((entry) => (entry.sourceNumbers ?? [entry.number]).includes(left!))?.id,
          snapshot.questions.find((entry) => (entry.sourceNumbers ?? [entry.number]).includes(right!))?.id,
        );
      }
    }
  }
  assert.ok(originalFound, "The source-ID compatibility snapshot must remain available.");
});
