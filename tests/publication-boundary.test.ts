import assert from "node:assert/strict";
import test from "node:test";
import { publicContentIssue, publicPathIssue } from "../tools/repository/check-publication.js";

test("public source and original course inputs are allowed, generated/private artifacts are not", () => {
  for (const path of ["src/web/ui/App.tsx", "content/networking/modules/azure-dns.json", ".env.example", "public/offline-worker.js", "firestore.rules", "storage.rules"]) {
    assert.equal(publicPathIssue(path), null);
  }
  for (const path of [".data/clean-bank/data/manifest.json", ".env.local", ".firebase/cache.json",
    "public/content/questions.json", "public/data/manifest.json", "public/teaching/answers.json",
    "public/courses/course.json", "tools/firebase/setup-report.json", "dist/index.html", "firebase-debug.log", "../private.json"]) {
    assert.ok(publicPathIssue(path), path);
  }
});

test("publication diagnostics identify categories without including credential values", () => {
  const fakeKey = `AIza${"a".repeat(35)}`;
  const fakeToken = `ghp_${"b".repeat(36)}`;
  assert.equal(publicContentIssue(fakeKey), "Google API key");
  assert.equal(publicContentIssue(fakeToken), "GitHub credential");
  assert.equal(publicContentIssue(JSON.stringify({ refresh_token: "c".repeat(30) })), "OAuth token value");
  assert.equal(publicContentIssue(`/${"Users"}/${"a-person"}/project`), "Workstation-specific path");
  assert.equal(publicContentIssue("export interface Options { access_token: string }"), null);
  assert.equal(publicContentIssue("admin@example.test"), null);
});
