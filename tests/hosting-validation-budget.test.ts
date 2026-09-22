import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import {
  HOSTING_MONTHLY_BYTE_CAP, HOSTING_RESPONSE_HEADER_ALLOWANCE, HOSTING_VALIDATION_METADATA_MARGIN,
  HostingValidationApprovalSchema, boundedHostingValidationResponse, deriveHostingValidationEnvelope,
  fetchHostingValidationArtifact, hostingReservationAmounts, loadApprovedHostingValidation,
  measureHostingValidationEnvelope, reserveContentAddressedHostingUnderLock, reserveHostingValidationRequests,
  type HostingBuildIdentity, type HostingMeasuredFile,
} from "../tools/publish/hosting-validation-budget.js";
import { hostingBuildIdentity } from "../tools/publish/storage-clean.js";
import { hostingFeatureDetails, parseHostingDeployArgs } from "../tools/firebase/deploy-hosting-adc.js";
import { pacificQuotaDay } from "../tools/publish/quota.js";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function identityFor(files: HostingMeasuredFile[]): HostingBuildIdentity {
  return { distDigest: hash(JSON.stringify([...files].sort((a, b) => a.path < b.path ? -1 : 1)
    .map(({ path, sha256 }) => ({ path, sha256 })))), sourceDigest: hash("original synthetic source") };
}
async function put(root: string, path: string, bytes: string) {
  await mkdir(dirname(resolve(root, path)), { recursive: true });
  await writeFile(resolve(root, path), bytes);
}
async function fixture(root: string) {
  for (const directory of ["src", "tools/web", "tools/learning", "tools/eligibility", "tools/course", "tools/sc900",
    "content/networking", "content/az104", "content/sc900"]) await mkdir(resolve(root, directory), { recursive: true });
  for (const path of ["src/app.ts", "index.html", "public/favicon.svg", "public/offline-worker.js",
    "package.json", "package-lock.json", "tsconfig.json", "vite.config.ts", "firebase.json",
    "tools/publish/hosting-validation-budget.ts", "tools/publish/storage-clean.ts", "tools/firebase/deploy-hosting-adc.ts"]) {
    await put(root, path, `original synthetic fixture ${path}`);
  }
  await put(root, "dist/index.html", '<script src="/assets/index-fixture.js"></script>');
  await put(root, "dist/content/old/question.json", '{"fixture":"shared original data"}');
  await put(root, "dist/content/current/question.json", '{"fixture":"shared original data"}');
  await put(root, "dist/exams/sc900/manifest.json", '{"fixture":"scoped manifest"}');
  await put(root, "dist/assets/index-fixture.js", "/* original synthetic application */");
  const builtAt = new Date(Date.now() + 1000);
  await utimes(resolve(root, "dist/assets/index-fixture.js"), builtAt, builtAt);
  const identity = await hostingBuildIdentity(root);
  const envelope = await measureHostingValidationEnvelope(identity, root);
  const month = pacificQuotaDay(new Date()).slice(0, 7);
  const approvalPath = ".data/rollout/validation-approval.json";
  const approval = HostingValidationApprovalSchema.parse({
    schemaVersion: 1, mode: "content-addressed-v1", decision: "approve-bounded-hosting-self-validation",
    approvedBy: "parent", approvedAt: new Date().toISOString(), month, ...identity, envelopeDigest: envelope.envelopeDigest,
  });
  await put(root, approvalPath, `${JSON.stringify(approval, null, 2)}\n`);
  const journal = { months: {
    "2020-01": { storedBytes: 123, transferBytes: 456 },
    [month]: { storedBytes: 1_000_000, transferBytes: 8_188_060_050 },
  } };
  await put(root, ".data/rollout/hosting-journal.json", JSON.stringify(journal));
  const usage = { checkedAt: new Date().toISOString(), month,
    hostingStoredBytes: 1_000_000, hostingTransferBytes: 227_724_059 };
  const reserve = () => reserveContentAddressedHostingUnderLock({
    workspace: root, identity, approvalPath, pathBytes: envelope.pathBytes, usage, inventoryBytes: 2_000_000,
  });
  return { identity, envelope, month, approval, approvalPath, usage, journal, reserve };
}
async function isolated(run: (root: string) => Promise<void>) {
  const root = resolve(`.data/hosting-validation-tests/${randomUUID()}`);
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test("content-addressed envelope deduplicates payload only, retains every path and keeps the default formula", () => {
  const files = [
    { path: "content/old/image.png", sha256: hash("synthetic image"), bytes: 216_353_895 },
    { path: "content/current/image.png", sha256: hash("synthetic image"), bytes: 216_353_895 },
    { path: "exams/sc900/question.json", sha256: hash("synthetic sc data"), bytes: 17_000_000 },
  ];
  const identity = identityFor(files);
  const envelope = deriveHostingValidationEnvelope(files, identity);
  assert.equal(envelope.files.length, 3);
  assert.equal(envelope.uniqueContents, 2);
  assert.equal(envelope.pathBytes, 449_707_790);
  assert.equal(envelope.uniqueRawBytes, 233_353_895);
  assert.equal(envelope.transferBytes, 2 * 233_353_895 + 16 * 1024 * 1024);
  assert.ok(envelope.transferBytes < 584_215_891);
  const alreadyReserved = 8_188_060_050;
  const observed = 227_724_059;
  assert.ok(alreadyReserved + observed + envelope.transferBytes <= HOSTING_MONTHLY_BYTE_CAP);
  assert.ok(alreadyReserved + observed + envelope.pathBytes * 2 > HOSTING_MONTHLY_BYTE_CAP);
  assert.deepEqual(hostingReservationAmounts(envelope.pathBytes), { storedBytes: envelope.pathBytes, transferBytes: envelope.pathBytes * 2 });
  assert.deepEqual(hostingReservationAmounts(envelope.pathBytes, envelope),
    { storedBytes: envelope.pathBytes, transferBytes: envelope.transferBytes });
  assert.throws(() => deriveHostingValidationEnvelope([{ ...files[0]! }, { ...files[1]!, bytes: 1 }], identity), /inconsistent/);
  for (const bytes of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => deriveHostingValidationEnvelope([{ ...files[0]!, bytes }], identity));
    assert.throws(() => hostingReservationAmounts(bytes));
  }
  assert.throws(() => hostingReservationAmounts(envelope.pathBytes, { ...envelope, transferBytes: 1 }), /Forged/);
  assert.throws(() => deriveHostingValidationEnvelope([files[0]!, files[0]!], identity), /Duplicate Hosting path/);
});

test("actual bytes are rehashed and hard links, symlinks, changed builds and forged approvals fail closed", async () => isolated(async (root) => {
  const f = await fixture(root);
  assert.equal(f.envelope.files.length, 5);
  assert.equal(f.envelope.uniqueContents, 4);
  assert.deepEqual((await loadApprovedHostingValidation(f.approvalPath, f.identity, root)).envelope, f.envelope);
  await link(resolve(root, "dist/index.html"), resolve(root, "dist/hardlink.html"));
  await assert.rejects(measureHostingValidationEnvelope(f.identity, root), /hard links/);
  await rm(resolve(root, "dist/hardlink.html"));
  await symlink(resolve(root, "dist/index.html"), resolve(root, "dist/symlink.html"));
  await assert.rejects(measureHostingValidationEnvelope(f.identity, root), /symlinks/);
  await rm(resolve(root, "dist/symlink.html"));
  await put(root, f.approvalPath, JSON.stringify({ ...f.approval, envelopeDigest: hash("cheap forged allowance") }));
  await assert.rejects(loadApprovedHostingValidation(f.approvalPath, f.identity, root), /Parent approval/);
  await put(root, f.approvalPath, JSON.stringify(f.approval));
  await put(root, "dist/content/current/question.json", '{"fixture":"changed same file"}');
  await assert.rejects(loadApprovedHostingValidation(f.approvalPath, f.identity, root), /exact build identity/);
}));

test("global reservation preserves previous months and reruns retain consumed validation allowance", async () => isolated(async (root) => {
  const f = await fixture(root);
  const grant = await f.reserve();
  const journalPath = resolve(root, ".data/rollout/hosting-journal.json");
  const first = JSON.parse(await readFile(journalPath, "utf8"));
  assert.deepEqual(first.months["2020-01"], f.journal.months["2020-01"]);
  assert.equal(first.months[f.month].storedBytes, f.journal.months[f.month]!.storedBytes + f.envelope.pathBytes);
  assert.equal(first.months[f.month].transferBytes, f.journal.months[f.month]!.transferBytes + f.envelope.transferBytes);
  const requests = [{ kind: "artifact" as const, path: "content/old/question.json" },
    { kind: "artifact" as const, path: "content/current/question.json" }];
  const charge = await reserveHostingValidationRequests(grant.grantId, requests, root);
  const file = f.envelope.files.find((entry) => entry.path === requests[0]!.path)!;
  assert.equal(charge.maximumResponseBytes, 2 * (file.bytes + HOSTING_RESPONSE_HEADER_ALLOWANCE));
  const second = await f.reserve();
  assert.equal(second.newTransferReservation, 0);
  assert.equal(second.remainingResponseBytes, charge.remainingResponseBytes);
  const updated = JSON.parse(await readFile(journalPath, "utf8"));
  assert.equal(updated.months[f.month].transferBytes, first.months[f.month].transferBytes);
  assert.equal(updated.months[f.month].storedBytes, first.months[f.month].storedBytes + f.envelope.pathBytes);
  const another = await reserveHostingValidationRequests(grant.grantId, requests, root);
  assert.equal(another.sequence, 2);
  assert.equal(another.remainingResponseBytes, charge.remainingResponseBytes - another.maximumResponseBytes);
  await put(root, "dist/content/current/question.json", '{"fixture":"changed after allocation"}');
  await assert.rejects(reserveHostingValidationRequests(grant.grantId, requests, root), /Parent approval/);
}));

test("cap exhaustion, nonfinite requests and monthly journal regression never send a request or reset reservations", async () => isolated(async (root) => {
  const f = await fixture(root);
  const journalPath = resolve(root, ".data/rollout/hosting-journal.json");
  const original = await readFile(journalPath);
  await assert.rejects(reserveContentAddressedHostingUnderLock({
    workspace: root, identity: f.identity, approvalPath: f.approvalPath, pathBytes: f.envelope.pathBytes,
    usage: { ...f.usage, hostingTransferBytes: HOSTING_MONTHLY_BYTE_CAP }, inventoryBytes: 0,
  }), /unchanged 9 GB cap/);
  assert.deepEqual(await readFile(journalPath), original);
  const grant = await f.reserve();
  const first = await reserveHostingValidationRequests(grant.grantId,
    [{ kind: "metadata", purpose: "hosting-api", maximumResponseBytes: 8 * 1024 * 1024 }], root);
  await assert.rejects(reserveHostingValidationRequests(grant.grantId,
    [{ kind: "metadata", purpose: "browser-overhead", maximumResponseBytes: 8 * 1024 * 1024 }], root), /exhausted/);
  const saved = JSON.parse(await readFile(resolve(root, grant.grantPath), "utf8"));
  assert.equal(saved.reservedResponseBytes, first.maximumResponseBytes);
  assert.deepEqual(saved.reservations.map((entry: { sequence: number }) => entry.sequence), [1]);
  const originalGrantBytes = await readFile(resolve(root, grant.grantPath));
  await put(root, grant.grantPath, JSON.stringify({ ...saved, envelope: { ...saved.envelope, transferBytes: HOSTING_MONTHLY_BYTE_CAP } }));
  await assert.rejects(reserveHostingValidationRequests(grant.grantId, [{ kind: "artifact", path: "index.html" }], root), /changed after allocation|original allocation/);
  await writeFile(resolve(root, grant.grantPath), originalGrantBytes);
  for (const maximumResponseBytes of [-1, NaN, Infinity]) {
    await assert.rejects(reserveHostingValidationRequests(grant.grantId,
      [{ kind: "metadata", purpose: "hosting-api", maximumResponseBytes }], root));
  }
  await assert.rejects(reserveHostingValidationRequests(grant.grantId, [{ kind: "artifact", path: "../credentials.json" }], root));
  await writeFile(journalPath, original);
  await assert.rejects(reserveHostingValidationRequests(grant.grantId, [{ kind: "artifact", path: "index.html" }], root), /journal/);
}));

test("live-validation helper charges failed requests first, retains retries and checks response hashes and limits", async () => isolated(async (root) => {
  const f = await fixture(root);
  const grant = await f.reserve();
  const grantPath = resolve(root, grant.grantPath);
  let calls = 0;
  await assert.rejects(fetchHostingValidationArtifact(grant.grantId, "index.html", root, async (url, init) => {
    calls++;
    assert.equal(url, "https://study-az104.web.app/index.html");
    assert.equal(init?.redirect, "error");
    assert.ok(JSON.parse(await readFile(grantPath, "utf8")).reservedResponseBytes > 0);
    throw new Error("Synthetic failed request");
  }), /Synthetic failed request/);
  const afterFailure = JSON.parse(await readFile(grantPath, "utf8")).reservedResponseBytes;
  const expected = await readFile(resolve(root, "dist/index.html"));
  assert.deepEqual(await fetchHostingValidationArtifact(grant.grantId, "index.html", root,
    async () => new Response(expected)), expected);
  assert.equal(JSON.parse(await readFile(grantPath, "utf8")).reservedResponseBytes, afterFailure * 2);
  await assert.rejects(fetchHostingValidationArtifact(grant.grantId, "index.html", root,
    async () => new Response("incorrect synthetic response")), /does not match/);
  const before = JSON.parse(await readFile(grantPath, "utf8")).reservedResponseBytes;
  await put(root, "src/app.ts", "Changed source after deployment");
  await assert.rejects(fetchHostingValidationArtifact(grant.grantId, "index.html", root, async () => {
    calls++; return new Response(expected);
  }), /Build input changed|Parent approval/);
  assert.equal(calls, 1);
  assert.equal(JSON.parse(await readFile(grantPath, "utf8")).reservedResponseBytes, before);
  await assert.rejects(boundedHostingValidationResponse(new Response("oversized", { headers: { "content-length": "999" } }), 3), /limit/);
  let cancelled = false;
  await assert.rejects(boundedHostingValidationResponse(new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(10)); }, cancel() { cancelled = true; },
  })), 3), /limit/);
  assert.equal(cancelled, true);
}));

test("SC900 deployment feature and explicit validation mode do not alter legacy defaults", () => {
  assert.deepEqual(parseHostingDeployArgs([]), { apply: false, feature: "accounts", options: {} });
  assert.deepEqual(parseHostingDeployArgs(["--apply", "--az104"]), { apply: true, feature: "az104", options: {} });
  assert.deepEqual(parseHostingDeployArgs(["--sc900", "--content-addressed-validation", ".data/approved.json", "--apply"]), {
    apply: true, feature: "sc900", options: { contentAddressedApprovalPath: ".data/approved.json" },
  });
  assert.equal(hostingFeatureDetails("sc900").reportDirectory, ".data/sc900/rollout");
  assert.equal(hostingFeatureDetails("sc900").label, "approved-sc900-exam");
  assert.equal(hostingFeatureDetails("az104").reportDirectory, ".data/full-course/rollout");
  assert.equal(hostingFeatureDetails("course", "networking").label, "networking-course");
  assert.deepEqual(parseHostingDeployArgs(["--sc900", "--measure-content-addressed"]), {
    apply: false, feature: "sc900", options: { measureContentAddressed: true },
  });
  for (const args of [["--apply", "--measure-content-addressed"], ["--content-addressed-validation"],
    ["--sc900", "--az104"], ["--apply", "--apply"], ["--cheaper-budget", "1"]]) assert.throws(() => parseHostingDeployArgs(args));
  assert.equal(HOSTING_VALIDATION_METADATA_MARGIN, 16 * 1024 * 1024);
});
