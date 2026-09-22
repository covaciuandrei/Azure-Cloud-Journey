import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { assertSafeDirectory, childPath } from "../web/bank.js";
import { pacificQuotaDay } from "./quota.js";

export const HOSTING_MONTHLY_BYTE_CAP = 9_000_000_000;
export const HOSTING_VALIDATION_METADATA_MARGIN = 16 * 1024 * 1024;
export const HOSTING_RESPONSE_HEADER_ALLOWANCE = 4096;
const MAX_RECEIPT_BYTES = 32 * 1024 * 1024;
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const amount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const safePath = z.string().regex(/^[A-Za-z0-9_./-]+$/).refine((path) =>
  !path.startsWith("/") && path.split("/").every((part) => part !== "" && part !== "." && part !== ".."), "Unsafe Hosting artifact path");
export const HostingBuildIdentitySchema = z.object({ distDigest: digest, sourceDigest: digest }).strict();
export type HostingBuildIdentity = z.infer<typeof HostingBuildIdentitySchema>;
const FileSchema = z.object({ path: safePath, sha256: digest, bytes: amount }).strict();
export type HostingMeasuredFile = z.infer<typeof FileSchema>;
export const HostingValidationEnvelopeSchema = z.object({
  schemaVersion: z.literal(1), mode: z.literal("content-addressed-v1"),
  distDigest: digest, sourceDigest: digest, envelopeDigest: digest,
  files: z.array(FileSchema).min(1).max(50_000),
  pathBytes: amount, uniqueRawBytes: amount, uniqueContents: amount,
  metadataMarginBytes: z.literal(HOSTING_VALIDATION_METADATA_MARGIN),
  transferBytes: amount,
}).strict();
export type HostingValidationEnvelope = z.infer<typeof HostingValidationEnvelopeSchema>;
export const HostingValidationApprovalSchema = z.object({
  schemaVersion: z.literal(1), mode: z.literal("content-addressed-v1"),
  decision: z.literal("approve-bounded-hosting-self-validation"),
  approvedBy: z.literal("parent"), approvedAt: z.iso.datetime({ offset: true }), month,
  distDigest: digest, sourceDigest: digest, envelopeDigest: digest,
}).strict();
type Approval = z.infer<typeof HostingValidationApprovalSchema>;
const JournalSchema = z.object({
  months: z.record(month, z.object({ storedBytes: amount, transferBytes: amount }).strict()),
}).strict();
const ReservationSchema = z.object({
  sequence: z.number().int().positive(), requests: z.number().int().positive(),
  maximumResponseBytes: amount, requestDigest: digest, reservedAt: z.iso.datetime({ offset: true }),
}).strict();
export const HostingValidationGrantSchema = z.object({
  schemaVersion: z.literal(1), mode: z.literal("content-addressed-v1"), month,
  approvalPath: safePath, approvalSha256: digest,
  envelope: HostingValidationEnvelopeSchema,
  globalTransferReservationFloor: amount,
  reservedResponseBytes: amount,
  reservations: z.array(ReservationSchema).max(20_000),
}).strict().superRefine((value, context) => {
  if (value.reservations.some((entry, index) => entry.sequence !== index + 1) ||
      value.reservations.reduce((total, entry) => total + entry.maximumResponseBytes, 0) !== value.reservedResponseBytes ||
      value.reservedResponseBytes > value.envelope.transferBytes ||
      value.globalTransferReservationFloor < value.envelope.transferBytes) {
    context.addIssue({ code: "custom", message: "Hosting validation reservations do not reconcile with the original allocation" });
  }
});
type Grant = z.infer<typeof HostingValidationGrantSchema>;
const GrantIdSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-[a-f0-9]{64}$/);

export function deriveHostingValidationEnvelope(filesInput: HostingMeasuredFile[], identityInput: HostingBuildIdentity): HostingValidationEnvelope {
  const identity = HostingBuildIdentitySchema.parse(identityInput);
  const files = z.array(FileSchema).min(1).max(50_000).parse(filesInput).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (new Set(files.map((file) => file.path)).size !== files.length) throw new Error("Duplicate Hosting path in measured inventory.");
  const unique = new Map<string, number>();
  let pathBytes = 0;
  for (const file of files) {
    const previous = unique.get(file.sha256);
    if (previous !== undefined && previous !== file.bytes) throw new Error("Identical Hosting hashes have inconsistent byte lengths.");
    unique.set(file.sha256, file.bytes);
    pathBytes += file.bytes;
  }
  const distDigest = sha(JSON.stringify(files.map(({ path, sha256 }) => ({ path, sha256 }))));
  if (distDigest !== identity.distDigest) throw new Error("Measured Hosting inventory differs from the exact build identity.");
  const uniqueRawBytes = [...unique.values()].reduce((total, bytes) => total + bytes, 0);
  const content = { schemaVersion: 1 as const, mode: "content-addressed-v1" as const, ...identity,
    files, pathBytes, uniqueRawBytes, uniqueContents: unique.size,
    metadataMarginBytes: HOSTING_VALIDATION_METADATA_MARGIN, transferBytes: uniqueRawBytes * 2 + HOSTING_VALIDATION_METADATA_MARGIN };
  const envelope = HostingValidationEnvelopeSchema.parse({ ...content, envelopeDigest: sha(JSON.stringify(content)) });
  if (envelope.pathBytes > HOSTING_MONTHLY_BYTE_CAP || envelope.transferBytes > HOSTING_MONTHLY_BYTE_CAP) {
    throw new Error("The measured Hosting build exceeds the conservative monthly byte cap.");
  }
  return envelope;
}

export async function measureHostingValidationEnvelope(
  identity: HostingBuildIdentity, workspace = process.cwd(),
): Promise<HostingValidationEnvelope> {
  await assertSafeDirectory(workspace, "dist");
  const files: HostingMeasuredFile[] = [];
  async function visit(directory: string) {
    for (const entry of await readdir(childPath(workspace, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      const info = await lstat(childPath(workspace, path));
      if (info.isSymbolicLink() || entry.name.startsWith(".")) throw new Error("Hosting measurement refuses hidden paths and symlinks.");
      if (info.isDirectory()) { await visit(path); continue; }
      if (!info.isFile() || info.nlink !== 1) throw new Error("Hosting measurement requires regular files without hard links.");
      const file = await open(childPath(workspace, path), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const before = await file.stat();
        if (!before.isFile() || before.nlink !== 1 || before.size > HOSTING_MONTHLY_BYTE_CAP ||
            before.ino !== info.ino || before.dev !== info.dev) throw new Error("Hosting file changed before hashing.");
        const hash = createHash("sha256");
        const buffer = Buffer.alloc(1024 * 1024);
        let bytes = 0;
        while (true) {
          const result = await file.read(buffer, 0, buffer.length, null);
          if (!result.bytesRead) break;
          bytes += result.bytesRead;
          if (bytes > before.size) throw new Error("Hosting file grew during measurement.");
          hash.update(buffer.subarray(0, result.bytesRead));
        }
        const after = await file.stat();
        if (bytes !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs ||
            after.ctimeMs !== before.ctimeMs || after.nlink !== 1) throw new Error("Hosting file changed during measurement.");
        files.push({ path: path.slice("dist/".length), sha256: hash.digest("hex"), bytes });
        if (files.length > 50_000) throw new Error("Hosting file inventory exceeds its bound.");
      } finally { await file.close(); }
    }
  }
  await visit("dist");
  return deriveHostingValidationEnvelope(files, identity);
}

async function readBounded(workspace: string, path: string, limit = MAX_RECEIPT_BYTES) {
  safePath.parse(path);
  await assertSafeDirectory(workspace, dirname(path));
  const file = await open(childPath(workspace, path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit) throw new Error("Unsafe or oversized Hosting reservation file.");
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, null);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length !== stat.size) throw new Error("Hosting reservation input changed while reading.");
    return bytes.subarray(0, length);
  } finally { await file.close(); }
}
async function readJson(workspace: string, path: string) {
  return JSON.parse((await readBounded(workspace, path)).toString("utf8")) as unknown;
}
async function optionalJson(workspace: string, path: string) {
  try { return await readJson(workspace, path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
async function persist(workspace: string, path: string, value: unknown) {
  safePath.parse(path);
  await assertSafeDirectory(workspace, dirname(path));
  await mkdir(childPath(workspace, dirname(path)), { recursive: true });
  const target = childPath(workspace, path);
  try {
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("Unsafe existing Hosting reservation target.");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const pending = `${target}.${randomUUID()}.pending`;
  try {
    const handle = await open(pending, "wx", 0o600);
    try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); }
    finally { await handle.close(); }
    await rename(pending, target);
  } finally { await rm(pending, { force: true }); }
}
async function validationLock(workspace: string) {
  await assertSafeDirectory(workspace, ".data/rollout");
  await mkdir(childPath(workspace, ".data/rollout"), { recursive: true });
  const path = childPath(workspace, ".data/rollout/hosting-validation.lock");
  const handle = await open(path, "wx", 0o600);
  await handle.writeFile(`${process.pid}\n`);
  return async () => { await handle.close(); await rm(path); };
}

export async function loadApprovedHostingValidation(
  approvalPath: string, identity: HostingBuildIdentity, workspace = process.cwd(),
) {
  if (!approvalPath.startsWith(".data/") || !approvalPath.endsWith(".json")) throw new Error("Hosting validation approval must be explicit private JSON.");
  const bytes = await readBounded(workspace, approvalPath, 16 * 1024);
  const approval = HostingValidationApprovalSchema.parse(JSON.parse(bytes.toString("utf8")));
  if (approval.month !== pacificQuotaDay(new Date()).slice(0, 7) || Date.parse(approval.approvedAt) > Date.now()) {
    throw new Error("Hosting validation approval is future-dated or belongs to another quota month.");
  }
  const envelope = await measureHostingValidationEnvelope(identity, workspace);
  if (approval.distDigest !== identity.distDigest || approval.sourceDigest !== identity.sourceDigest ||
      approval.envelopeDigest !== envelope.envelopeDigest) throw new Error("Parent approval does not bind the remeasured Hosting build envelope.");
  return { approval, envelope, approvalSha256: sha(bytes) };
}

export function hostingReservationAmounts(pathBytes: number, envelope?: HostingValidationEnvelope) {
  amount.parse(pathBytes);
  if (envelope) {
    const exact = deriveHostingValidationEnvelope(envelope.files, {
      distDigest: envelope.distDigest, sourceDigest: envelope.sourceDigest,
    });
    if (JSON.stringify(exact) !== JSON.stringify(envelope) || pathBytes !== exact.pathBytes) {
      throw new Error("Forged or inconsistent Hosting transfer envelope.");
    }
    return { storedBytes: pathBytes, transferBytes: exact.transferBytes };
  }
  const transferBytes = pathBytes * 2;
  amount.parse(transferBytes);
  return { storedBytes: pathBytes, transferBytes };
}

/** Called only while the existing Storage/Hosting lock is held by the deployment guard. */
export async function reserveContentAddressedHostingUnderLock(options: {
  workspace?: string; approvalPath: string; identity: HostingBuildIdentity; pathBytes: number;
  usage: { checkedAt: string; month: string; hostingStoredBytes: number; hostingTransferBytes: number };
  inventoryBytes: number;
}) {
  const workspace = options.workspace ?? process.cwd();
  const fresh = Date.parse(options.usage.checkedAt);
  if (!Number.isFinite(fresh) || fresh > Date.now() || Date.now() - fresh > 5 * 60_000 ||
      options.usage.month !== pacificQuotaDay(new Date()).slice(0, 7)) throw new Error("Fresh current-month Hosting usage is required.");
  for (const number of [options.usage.hostingStoredBytes, options.usage.hostingTransferBytes, options.inventoryBytes]) amount.parse(number);
  const { approval, envelope, approvalSha256 } = await loadApprovedHostingValidation(options.approvalPath, options.identity, workspace);
  const amounts = hostingReservationAmounts(options.pathBytes, envelope);
  const grantId = `${approval.month}-${envelope.envelopeDigest}`;
  const grantPath = `.data/rollout/hosting-validation/${grantId}.json`;
  const unlock = await validationLock(workspace);
  try {
    const journalPath = ".data/rollout/hosting-journal.json";
    const journal = JournalSchema.parse(await readJson(workspace, journalPath));
    const previous = journal.months[approval.month] ?? { storedBytes: 0, transferBytes: 0 };
    const raw = await optionalJson(workspace, grantPath);
    let grant = raw === undefined ? undefined : HostingValidationGrantSchema.parse(raw);
    if (grant && (grant.approvalSha256 !== approvalSha256 || grant.approvalPath !== options.approvalPath ||
        JSON.stringify(grant.envelope) !== JSON.stringify(envelope) ||
        previous.transferBytes < grant.globalTransferReservationFloor)) throw new Error("Existing Hosting validation allocation was changed or its shared journal regressed.");
    if (grant && grant.reservedResponseBytes >= envelope.transferBytes) throw new Error("Hosting validation allocation is exhausted; no allowance is reset on rerun.");
    const transferReservation = grant ? 0 : amounts.transferBytes;
    if (Math.max(options.usage.hostingStoredBytes, options.inventoryBytes) + previous.storedBytes + amounts.storedBytes > HOSTING_MONTHLY_BYTE_CAP ||
        options.usage.hostingTransferBytes + previous.transferBytes + transferReservation > HOSTING_MONTHLY_BYTE_CAP) {
      throw new Error("Hosting quota pause: measured content-addressed reservation does not fit the unchanged 9 GB cap.");
    }
    journal.months[approval.month] = {
      storedBytes: previous.storedBytes + amounts.storedBytes,
      transferBytes: previous.transferBytes + transferReservation,
    };
    // Reserve globally first. A crash before grant persistence wastes headroom safely; it never grants unreserved bytes.
    await persist(workspace, journalPath, journal);
    if (!grant) {
      grant = HostingValidationGrantSchema.parse({
        schemaVersion: 1, mode: "content-addressed-v1", month: approval.month,
        approvalPath: options.approvalPath, approvalSha256, envelope,
        globalTransferReservationFloor: journal.months[approval.month]!.transferBytes,
        reservedResponseBytes: 0, reservations: [],
      });
      await persist(workspace, grantPath, grant);
    }
    return { grantId, grantPath, envelopeDigest: envelope.envelopeDigest,
      transferBytes: envelope.transferBytes, remainingResponseBytes: envelope.transferBytes - grant.reservedResponseBytes,
      newTransferReservation: transferReservation, reservations: journal.months[approval.month]! };
  } finally { await unlock(); }
}

export type HostingValidationRequest =
  | { kind: "artifact"; path: string }
  | { kind: "metadata"; maximumResponseBytes: number; purpose: "hosting-api" | "browser-overhead" };

async function currentIdentity(workspace: string) {
  const { hostingBuildIdentity } = await import("./storage-clean.js");
  return hostingBuildIdentity(workspace);
}

export async function reserveHostingValidationRequests(
  grantIdInput: string, requests: readonly HostingValidationRequest[], workspace = process.cwd(),
) {
  const grantId = GrantIdSchema.parse(grantIdInput);
  if (!requests.length || requests.length > 50_000) throw new Error("A bounded nonempty validation request batch is required.");
  const unlock = await validationLock(workspace);
  try {
    const grantPath = `.data/rollout/hosting-validation/${grantId}.json`;
    const grant = HostingValidationGrantSchema.parse(await readJson(workspace, grantPath));
    if (grant.month !== pacificQuotaDay(new Date()).slice(0, 7) || grantId !== `${grant.month}-${grant.envelope.envelopeDigest}`) {
      throw new Error("Hosting validation grant is not bound to the current quota month.");
    }
    const approved = await loadApprovedHostingValidation(grant.approvalPath, await currentIdentity(workspace), workspace);
    if (approved.approvalSha256 !== grant.approvalSha256 || JSON.stringify(approved.envelope) !== JSON.stringify(grant.envelope)) {
      throw new Error("Hosting validation build or parent approval changed after allocation.");
    }
    const journal = JournalSchema.parse(await readJson(workspace, ".data/rollout/hosting-journal.json"));
    if (!journal.months[grant.month] || journal.months[grant.month]!.transferBytes < grant.globalTransferReservationFloor ||
        journal.months[grant.month]!.transferBytes > HOSTING_MONTHLY_BYTE_CAP) {
      throw new Error("Shared Hosting journal no longer contains this validation allocation.");
    }
    const files = new Map(grant.envelope.files.map((file) => [file.path, file]));
    const parsed = requests.map((request) => {
      if (request.kind === "artifact") {
        const { path } = z.object({ kind: z.literal("artifact"), path: safePath }).strict().parse(request);
        const file = files.get(path);
        if (!file) throw new Error("Validation request is not in the approved Hosting file inventory.");
        return { kind: "artifact", path, maximumResponseBytes: file.bytes + HOSTING_RESPONSE_HEADER_ALLOWANCE };
      }
      const metadata = z.object({
        kind: z.literal("metadata"), maximumResponseBytes: z.number().int().min(1).max(HOSTING_VALIDATION_METADATA_MARGIN),
        purpose: z.enum(["hosting-api", "browser-overhead"]),
      }).strict().parse(request);
      return { ...metadata, maximumResponseBytes: metadata.maximumResponseBytes + HOSTING_RESPONSE_HEADER_ALLOWANCE };
    });
    const maximumResponseBytes = parsed.reduce((total, request) => total + request.maximumResponseBytes, 0);
    amount.parse(maximumResponseBytes);
    if (grant.reservedResponseBytes + maximumResponseBytes > grant.envelope.transferBytes) {
      throw new Error("Hosting self-validation budget exhausted; stop before sending another request.");
    }
    const reservation = ReservationSchema.parse({ sequence: grant.reservations.length + 1, requests: parsed.length,
      maximumResponseBytes, requestDigest: sha(JSON.stringify(parsed)), reservedAt: new Date().toISOString() });
    grant.reservations.push(reservation);
    grant.reservedResponseBytes += maximumResponseBytes;
    HostingValidationGrantSchema.parse(grant);
    await persist(workspace, grantPath, grant);
    return { grantId, ...reservation, remainingResponseBytes: grant.envelope.transferBytes - grant.reservedResponseBytes };
  } finally { await unlock(); }
}

export async function boundedHostingValidationResponse(response: Response, maximumBodyBytes: number): Promise<Buffer> {
  amount.parse(maximumBodyBytes);
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximumBodyBytes)) {
    await response.body?.cancel(); throw new Error("Validation response exceeds the reserved body-byte limit.");
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > maximumBodyBytes) { await reader.cancel(); throw new Error("Validation response exceeds the reserved body-byte limit."); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}

export async function fetchHostingValidationArtifact(
  grantId: string, path: string, workspace = process.cwd(), fetcher: typeof fetch = fetch,
) {
  const identity = await currentIdentity(workspace);
  const envelope = await measureHostingValidationEnvelope(identity, workspace);
  const file = envelope.files.find((entry) => entry.path === path);
  if (!file) throw new Error("Validation artifact is absent from the approved build.");
  await reserveHostingValidationRequests(grantId, [{ kind: "artifact", path }], workspace);
  const response = await fetcher(`https://study-az104.web.app/${path}`, {
    redirect: "error", cache: "no-store", credentials: "omit", signal: AbortSignal.timeout(60_000),
  });
  const bytes = await boundedHostingValidationResponse(response, file.bytes);
  if (!response.ok || bytes.length !== file.bytes || sha(bytes) !== file.sha256) {
    throw new Error("Live Hosting artifact does not match the approved build; the failed reservation is retained.");
  }
  return bytes;
}
