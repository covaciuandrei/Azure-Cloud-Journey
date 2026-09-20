import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { loadAuthoredExplanations } from "./validate.js";
import { readData, readOptionalData, writeData } from "../review/data.js";
import { LearningExplanationSchema } from "../../src/domain/learning.js";
import { TOPIC_IDS } from "../../src/domain/topics.js";
import { z } from "zod";

const args = process.argv.slice(2);
const drafts = args.includes("--drafts");
const eligibility = args.includes("--eligibility");
const course = args.includes("--course");
if ([drafts, eligibility, course].filter(Boolean).length > 1) throw new Error("Choose one source-check scope.");
if (!course && (args.length > 1 || args.some((argument) => !["--drafts", "--eligibility"].includes(argument)))) {
  throw new Error("Usage: check-sources.ts [--drafts | --eligibility | --course [--all | --module <id> | --domain <id>]]");
}
const records = [];
if (course) {
  const { loadCourseModules, parseCourseSelection } = await import("../course/validate.js");
  const targets = args.filter((argument) => argument !== "--course");
  const options = targets.length === 1 && targets[0] === "--all" ? { course: "az104" as const } : parseCourseSelection(targets);
  const { modules, curriculum, full } = await loadCourseModules(process.cwd(), options);
  records.push(...modules.map((module) => ({
    sources: [...module.sources, { id: "official-module", url: module.sourceModuleUrl, title: module.title, supports: module.summary }],
  })));
  records.push({ sources: [{ url: curriculum.pathUrl }, { url: full?.objectives.guideUrl ??
    "https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/az-104" }] });
} else if (eligibility) {
  const { EligibilityPolicySchema } = await import("../../src/domain/eligibility.js");
  const pointer = await readData(".data/eligibility/current.json", z.object({ policyId: z.string().regex(/^e_[a-f0-9]{64}$/) }).strict());
  const policy = await readData(`.data/eligibility/releases/${pointer.policyId}.json`, EligibilityPolicySchema);
  records.push(...policy.retired);
} else if (drafts) {
  const files = await readdir(".data/learning/authored");
  for (const topic of TOPIC_IDS) {
    if (!files.includes(`${topic}.json`)) continue;
    const batch = await readData(`.data/learning/authored/${topic}.json`, z.object({
      topic: z.literal(topic), explanations: z.array(LearningExplanationSchema),
    }).strict());
    records.push(...batch.explanations);
  }
} else {
  records.push(...(await loadAuthoredExplanations()).records.values());
}
const urls = [...new Set(records.flatMap((record) => record.sources.map((source) => source.url)))].sort();
const CacheSchema = z.object({
  checkedAt: z.string(),
  results: z.array(z.object({
    url: z.string(), status: z.number(), finalUrl: z.string(), title: z.string(),
    sha256: z.string(), checkedAt: z.string(),
  }).strict()),
}).strict();
const existing = await readOptionalData(".data/learning/source-verification.json", CacheSchema);
const results = new Map((existing?.results ?? []).map((result) => [result.url, result]));
const failures: Array<{ url: string; error: string }> = [];
for (const url of urls) {
  const cached = results.get(url);
  if (cached && Date.now() - Date.parse(cached.checkedAt) < 86400_000 && cached.status === 200) continue;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000), headers: { Accept: "text/html" } });
    const finalUrl = new URL(response.url);
    if (finalUrl.protocol !== "https:" || !(finalUrl.hostname === "microsoft.com" || finalUrl.hostname.endsWith(".microsoft.com"))) {
      throw new Error("Documentation redirected outside the approved source domains.");
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const content = await response.text();
    if (content.length > 8 * 1024 * 1024) throw new Error("Documentation response was unexpectedly large.");
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(content)?.[1]?.replace(/\s+/g, " ").trim() ?? "";
    if (!title || /page not found|404 - not found/i.test(title)) throw new Error("The URL did not resolve to a documentation page.");
    results.set(url, {
      url, status: response.status, finalUrl: response.url, title,
      sha256: createHash("sha256").update(content).digest("hex"), checkedAt: new Date().toISOString(),
    });
  } catch (error) {
    failures.push({ url, error: error instanceof Error ? error.message : "Documentation request failed." });
  }
  await writeData(".data/learning/source-verification.json", { checkedAt: new Date().toISOString(), results: [...results.values()] });
}
const report = { drafts, questions: records.length, total: urls.length, verified: urls.filter((url) => results.get(url)?.status === 200).length, failures };
await writeData(course ? ".data/course/source-check-report.json" :
  eligibility ? ".data/eligibility/source-check-report.json" : ".data/learning/source-check-report.json", report);
console.log(JSON.stringify(report, null, 2));
if (failures.length) process.exitCode = 2;
