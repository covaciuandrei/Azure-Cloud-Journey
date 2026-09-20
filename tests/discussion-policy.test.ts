import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import { CommentSchema } from "../src/domain/index.js";

const bank = ".data/clean-bank";
test("every retained snapshot stores only the frozen approved comment IDs with repaired threads", async () => {
  const decisions = JSON.parse(await readFile(".data/comment-quality-decisions.json", "utf8")) as {
    decisions: Array<{ id: string; retained: boolean }>;
  };
  const approved = new Set(decisions.decisions.filter((item) => item.retained).map((item) => item.id));
  assert.equal(approved.size, 7994);
  const manifest = JSON.parse(await readFile(`${bank}/data/manifest.json`, "utf8")) as { releaseId: string };
  for (const release of await readdir(`${bank}/content`)) {
    const directory = `${bank}/content/${release}/discussions`;
    const seen = new Set<string>();
    let withDiscussion = 0;
    for (const file of await readdir(directory)) {
      const data = JSON.parse(await readFile(`${directory}/${file}`, "utf8")) as { comments: unknown[] };
      const comments = data.comments.map((item) => CommentSchema.parse(item));
      if (comments.length) withDiscussion++;
      const ids = new Set(comments.map((item) => item.id));
      for (const comment of comments) {
        assert.ok(approved.has(comment.id), "Removed comments must not survive in a legacy payload.");
        assert.ok(!seen.has(comment.id), "Comment IDs must be unique within a snapshot.");
        seen.add(comment.id);
        assert.ok(ids.has(comment.rootId));
        assert.ok(comment.parentId === null || ids.has(comment.parentId));
        for (const id of comment.childIds) {
          assert.equal(comments.find((item) => item.id === id)?.parentId, comment.id);
        }
        if (comment.parentId) {
          assert.ok(comments.find((item) => item.id === comment.parentId)?.childIds.includes(comment.id));
        }
      }
    }
    assert.deepEqual(seen, approved, `The approved set must be complete in ${release}.`);
    if (release === manifest.releaseId) assert.equal(withDiscussion, 262);
  }
});
