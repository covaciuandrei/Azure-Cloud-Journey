import { mkdir, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { sc900BankFixture, sc900BankReview, SC900_FIXTURE_TIMESTAMP } from "./sc900-bank-fixture.js";
import { buildSc900StaticPlan, prepareSc900Release, stageSc900Publication, writeSc900FinalApproval } from "../tools/sc900/publication.js";
import { byteSha256 } from "../tools/sc900/canonical.js";
import { buildSc900CloudPlan, CloudApplyApprovalSchema } from "../tools/sc900/cloud-plan.js";

export async function sc900CloudFixture(workspace: string) {
  await mkdir(resolve(workspace, ".data/sc900"), { recursive: true });
  const receipt = {
    checkedAt: new Date(Date.parse("2026-09-21T00:00:00.000Z") + parseInt(randomUUID().slice(0, 8), 16) % 80_000_000).toISOString(),
    examId: 128, url: "https://www.examprepper.co/exam/128/1",
    title: "Microsoft - SC-900 - Page 1 | Examprepper", headings: [" Question 1", " Question 2"],
    nextVisible: 0, lastVisible: 0,
    sourceMethod: "Last paginator button inspected solely to establish source scope; no answers or discussions requested.",
    observedSourceQuestionCount: 2, observedPageCount: 1, discussionRequests: 0,
  };
  const receiptBytes = `${JSON.stringify(receipt, null, 2)}\n`;
  const sourceScopePath = ".data/sc900/source-scope.json";
  await writeFile(resolve(workspace, sourceScopePath), receiptBytes);
  const input = sc900BankFixture();
  input.expectedCapture.receiptSha256 = byteSha256(receiptBytes);
  const prepared = prepareSc900Release(input);
  const staticPlan = buildSc900StaticPlan(input, sc900BankReview(prepared));
  await stageSc900Publication(staticPlan, { workspaceRoot: workspace });
  const final = await writeSc900FinalApproval(staticPlan, {
    schemaVersion: 1, examId: "sc900", releaseId: staticPlan.release.manifest.releaseId,
    planDigest: staticPlan.planDigest, reviewDigest: staticPlan.reviewDigest, reviewer: "Independent synthetic cloud fixture reviewer",
    reviewedAt: SC900_FIXTURE_TIMESTAMP, independent: true, decision: "approve-activation",
  }, workspace);
  const approvalPath = relative(workspace, final.path).split(sep).join("/");
  const plan = await buildSc900CloudPlan(workspace, { target: "emulator", sourceScopePath, approvalPath });
  const approval = CloudApplyApprovalSchema.parse({
    schemaVersion: 1, examId: "sc900", target: "emulator", dataKind: "synthetic-test",
    planDigest: plan.planDigest, staticPlanDigest: plan.staticPlanDigest, sourceScopeSha256: plan.sourceScopeSha256,
    reviewer: "Synthetic emulator-only operator", reviewedAt: SC900_FIXTURE_TIMESTAMP,
    decision: "approve-cloud-upload-and-metadata-switch",
  });
  return { plan, approval, receipt, sourceScopePath, approvalPath, publication: prepared,
    revalidate: () => buildSc900CloudPlan(workspace, { target: "emulator", sourceScopePath, approvalPath, baseline: plan.baseline }) };
}
