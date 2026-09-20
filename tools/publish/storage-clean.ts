import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { applicationDefault } from "firebase-admin/app";
import { approvedAdministrativeAccount, matchesProjectBudget } from "../firebase/preflight.js";
import { loadCleanBank } from "../web/bank.js";
import { buildOfflineManifest } from "../web/offline-manifest.js";
import { readTopicMap } from "../topics/data.js";
import { loadStudyPublication, publicationFileBytes } from "../learning/publication.js";
import { loadCoursePublication } from "../course/publication.js";
import { inspectBucketPrivacy, type BucketPrivacyReport } from "./bucket-privacy.js";
import { pacificQuotaDay } from "./quota.js";

const project = "study-az104";
export const cleanBucket = "study-az104.firebasestorage.app";
export const cleanMediaPrefix = "private/az104/assets";
const rollout = ".data/rollout";
const bankRoot = ".data/clean-bank";
const expectedImages = 784;
const expectedComments = 7994;
const GiB = 1024 ** 3;

// Count every Storage request against BOTH operation classes, including failed attempts.
// Leave headroom for delayed telemetry and other project activity. Reservations never refund.
export const storageLimits = { requests: 4500, transferBytes: 90 * GiB, storedBytes: 4 * GiB };
export interface Amounts { requests: number; transferBytes: number; storedBytes: number }
export interface MetricSample { labels: Record<string, string>; value: number; endTime: string }
interface StorageUsage {
  checkedAt: string;
  month: string;
  periodStart: string;
  requests: number;
  transferBytes: number;
  storedBytes: number;
  peakStoredBytes: number;
  hostingStoredBytes: number;
  hostingTransferBytes: number;
  samples: Record<string, MetricSample[]>;
}
interface Journal {
  schemaVersion: 1;
  months: Record<string, Amounts>;
}
interface CloudObject {
  name: string;
  size?: string;
  generation?: string;
  contentType?: string;
  storageClass?: string;
  md5Hash?: string;
  crc32c?: string;
  metadata?: Record<string, string>;
  acl?: Array<{ entity?: string; role?: string }>;
  timeDeleted?: string;
  softDeleteTime?: string;
  hardDeleteTime?: string;
}
interface BucketInfo {
  name: string;
  projectNumber?: string;
  location?: string;
  storageClass?: string;
  versioning?: { enabled?: boolean };
  softDeletePolicy?: { retentionDurationSeconds?: string };
}
interface Inventory {
  checkedAt: string;
  buckets: Array<BucketInfo & { objects: CloudObject[]; softDeleted: CloudObject[] }>;
  hosting: Array<{ site: string; versions: unknown[]; releases: unknown[]; channels: unknown[] }>;
}
export interface CleanMedia {
  source: string;
  name: string;
  sha256: string;
  md5Hash: string;
  crc32c: string;
  byteLength: number;
  contentType: string;
}
interface CleanPlan {
  schemaVersion: 1;
  releaseId: string;
  manifestHash: string;
  filesHash: string;
  digest: string;
  media: CleanMedia[];
  mediaBytes: number;
  files: Array<{ path: string; sha256: string; bytes: number }>;
}
interface Ready {
  schemaVersion: 1;
  planDigest: string;
  approvedBy: "parent";
  scope: "storage" | "hosting";
  distDigest?: string;
  sourceDigest?: string;
}
interface Progress {
  planDigest: string;
  completed: Array<{ name: string; generation: string; bytes: number; sha256: string; md5Hash: string; crc32c: string }>;
}

function sha(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}
export function cleanMediaObjectPath(sha256: string, extension: string): string {
  if (!/^[a-f0-9]{64}$/.test(sha256) || !["png", "jpg", "gif", "webp"].includes(extension)) {
    throw new Error("Private media path requires an original image SHA-256 and supported extension.");
  }
  return `${cleanMediaPrefix}/${sha256}.${extension}`;
}
export function crc32c(bytes: Uint8Array): string {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0x82f63b78 : 0);
  }
  const result = Buffer.alloc(4);
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return result.toString("base64");
}
async function json<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}
async function optional<T>(path: string): Promise<T | undefined> {
  try { return await json<T>(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
async function persist(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const pending = `${path}.${process.pid}.${randomUUID()}.pending`;
  await writeFile(pending, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await rename(pending, path);
}
function validAmount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
export function assertStorageHeadroom(usage: Amounts, reserved: Amounts, next: Amounts): void {
  for (const key of ["requests", "transferBytes", "storedBytes"] as const) {
    if (![usage[key], reserved[key], next[key]].every(validAmount) ||
        usage[key] + reserved[key] + next[key] > storageLimits[key]) {
      throw new Error(`Storage quota pause: ${key} does not fit the conservative monthly limit.`);
    }
  }
}
class Reservations {
  private constructor(private usage: StorageUsage, private journal: Journal) {}
  static async open(usage: StorageUsage): Promise<Reservations> {
    const journal = await optional<Journal>(`${rollout}/storage-journal.json`) ?? { schemaVersion: 1, months: {} };
    if (journal.schemaVersion !== 1 || !journal.months || typeof journal.months !== "object") {
      throw new Error("Invalid Storage reservation journal.");
    }
    for (const entry of Object.values(journal.months)) {
      if (![entry.requests, entry.transferBytes, entry.storedBytes].every(validAmount)) {
        throw new Error("Invalid Storage reservation values.");
      }
    }
    return new Reservations(usage, journal);
  }
  get current(): Amounts {
    return this.journal.months[this.usage.month] ?? { requests: 0, transferBytes: 0, storedBytes: 0 };
  }
  assert(next: Amounts): void {
    if (pacificQuotaDay(new Date()).slice(0, 7) !== this.usage.month) {
      throw new Error("Storage quota month changed; rerun inspection.");
    }
    assertStorageHeadroom(this.usage, this.current, next);
  }
  async reserve(next: Partial<Amounts>): Promise<void> {
    const amount = { requests: 0, transferBytes: 0, storedBytes: 0, ...next };
    this.assert(amount);
    const before = this.current;
    this.journal.months[this.usage.month] = {
      requests: before.requests + amount.requests,
      transferBytes: before.transferBytes + amount.transferBytes,
      storedBytes: before.storedBytes + amount.storedBytes,
    };
    await persist(`${rollout}/storage-journal.json`, this.journal);
  }
}
class Api {
  private token = "";
  private expires = 0;
  public storageRequests = 0;
  constructor(public reservations?: Reservations) {}
  async request<T>(url: string, init: RequestInit = {}, storageBytes = 0): Promise<T> {
    if (!/^https:\/\/(?:monitoring|firebasehosting|storage|firebase|firebasestorage|firebaserules|cloudbilling|billingbudgets|openidconnect)\.googleapis\.com\//.test(url)) {
      throw new Error("Unexpected cloud API endpoint.");
    }
    const storage = new URL(url).hostname === "storage.googleapis.com";
    if (storage && !this.reservations) throw new Error("Storage requests require a persisted reservation.");
    // Metadata/list responses are bounded; no content downloads or automatic retries are used.
    if (storage) {
      await this.reservations!.reserve({ requests: 1, transferBytes: 1024 ** 2, storedBytes: storageBytes });
      this.storageRequests++;
    }
    if (Date.now() >= this.expires) {
      const result = await applicationDefault().getAccessToken();
      this.token = result.access_token;
      this.expires = Date.now() + Math.max(0, result.expires_in - 60) * 1000;
    }
    const response = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(new URL(url).hostname === "openidconnect.googleapis.com" ? {} : { "x-goog-user-project": project }),
        ...init.headers,
      },
      signal: AbortSignal.timeout(60_000),
      redirect: "error",
    });
    const text = await response.text();
    if (storage && Buffer.byteLength(text) > 1024 ** 2) throw new Error("Unexpectedly large Storage metadata response.");
    const body = text ? JSON.parse(text) as T & { error?: { message?: string } } : {} as T;
    if (!response.ok) {
      throw new Error(`Cloud API ${new URL(url).hostname}${new URL(url).pathname} ${response.status}: ` +
        `${(body as { error?: { message?: string } }).error?.message ?? response.statusText}`);
    }
    return body;
  }
}
async function metric(api: Api, type: string, start: string, end: string, gauge = false): Promise<MetricSample[]> {
  const result: MetricSample[] = [];
  let pageToken = "";
  do {
    const url = new URL(`https://monitoring.googleapis.com/v3/projects/${project}/timeSeries`);
    url.searchParams.set("filter", `metric.type="${type}"`);
    url.searchParams.set("interval.startTime", start);
    url.searchParams.set("interval.endTime", end);
    url.searchParams.set("aggregation.alignmentPeriod", gauge ? "86400s" : "3600s");
    url.searchParams.set("aggregation.perSeriesAligner", gauge ? "ALIGN_MAX" : "ALIGN_SUM");
    url.searchParams.set("pageSize", "100000");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const body = await api.request<{
      timeSeries?: Array<{
        metric?: { labels?: Record<string, string> };
        resource?: { labels?: Record<string, string> };
        points?: Array<{ value: { int64Value?: string; doubleValue?: number }; interval: { endTime: string } }>;
      }>;
      nextPageToken?: string;
    }>(url.href);
    for (const series of body.timeSeries ?? []) {
      const labels = { ...series.resource?.labels, ...series.metric?.labels };
      if (gauge) {
        const points = series.points ?? [];
        if (points.length) {
          result.push({ labels, value: Math.max(...points.map((point) =>
            Number(point.value.int64Value ?? point.value.doubleValue))),
          endTime: points[0]!.interval.endTime });
        }
      } else {
        for (const point of series.points ?? []) {
          result.push({ labels, value: Number(point.value.int64Value ?? point.value.doubleValue), endTime: point.interval.endTime });
        }
      }
    }
    pageToken = body.nextPageToken ?? "";
  } while (pageToken);
  if (result.some((sample) => !validAmount(Math.ceil(sample.value)))) throw new Error(`Invalid usage metric: ${type}`);
  return result;
}
export async function inspectStorageUsage(): Promise<StorageUsage> {
  const now = new Date();
  const month = pacificQuotaDay(now).slice(0, 7);
  // Include the preceding day rather than accidentally omit either UTC/Pacific month-boundary usage.
  const periodStart = new Date(Date.parse(`${month}-01T00:00:00Z`) - 86400_000).toISOString();
  const api = new Api();
  const definitions = [
    ["requests", "storage.googleapis.com/api/request_count", false],
    ["transferBytes", "storage.googleapis.com/network/sent_bytes_count", false],
    ["storedBytes", "storage.googleapis.com/storage/v2/total_bytes", true],
    ["hostingStoredBytes", "firebasehosting.googleapis.com/storage/total_bytes", true],
    ["hostingTransferBytes", "firebasehosting.googleapis.com/network/sent_bytes_count", false],
  ] as const;
  const samples: Record<string, MetricSample[]> = {};
  for (const [key, type, gauge] of definitions) samples[key] = await metric(api, type, periodStart, now.toISOString(), gauge);
  const sum = (key: string) => Math.ceil((samples[key] ?? []).reduce((value, sample) => value + sample.value, 0));
  const usage: StorageUsage = {
    checkedAt: now.toISOString(), month, periodStart, samples,
    requests: sum("requests"), transferBytes: sum("transferBytes"), storedBytes: sum("storedBytes"),
    peakStoredBytes: sum("storedBytes"), hostingStoredBytes: sum("hostingStoredBytes"),
    hostingTransferBytes: sum("hostingTransferBytes"),
  };
  await persist(`${rollout}/storage-usage.json`, usage);
  return usage;
}
async function list<T>(api: Api, endpoint: string, key: string, extra: Record<string, string> = {}): Promise<T[]> {
  const items: T[] = [];
  let pageToken = "";
  do {
    const url = new URL(endpoint);
    for (const [name, value] of Object.entries(extra)) url.searchParams.set(name, value);
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const body = await api.request<Record<string, unknown>>(url.href);
    items.push(...((body[key] ?? []) as T[]));
    if (items.length > 10_000) throw new Error("Cloud inventory exceeded the bounded scope.");
    pageToken = typeof body.nextPageToken === "string" ? body.nextPageToken : "";
  } while (pageToken);
  return items;
}
async function inventory(api: Api): Promise<Inventory> {
  const buckets = await list<BucketInfo>(api, "https://storage.googleapis.com/storage/v1/b", "items", {
    project, maxResults: "100", fields: "nextPageToken,items(name,projectNumber,location,storageClass,versioning,softDeletePolicy)",
  });
  const details: Inventory["buckets"] = [];
  const fields = "nextPageToken,items(name,size,generation,contentType,storageClass,md5Hash,crc32c,metadata,acl,timeDeleted,softDeleteTime,hardDeleteTime)";
  for (const bucket of buckets) {
    if (bucket.projectNumber !== "237261733668") throw new Error("Out-of-project bucket inventory.");
    const endpoint = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket.name)}/o`;
    const objects = await list<CloudObject>(api, endpoint, "items", { versions: "true", projection: "full", maxResults: "100", fields });
    const softDeleted = await list<CloudObject>(api, endpoint, "items", { softDeleted: "true", projection: "full", maxResults: "100", fields });
    details.push({ ...bucket, objects, softDeleted });
  }
  const sites = await list<{ name: string }>(api, `https://firebasehosting.googleapis.com/v1beta1/projects/${project}/sites`, "sites", { pageSize: "100" });
  const hosting: Inventory["hosting"] = [];
  for (const site of sites) {
    const name = site.name.split("/").at(-1);
    if (!name || !site.name.startsWith(`projects/${project}/sites/`)) throw new Error("Unexpected Hosting site.");
    const endpoint = `https://firebasehosting.googleapis.com/v1beta1/sites/${name}`;
    const versions = await list<{ name: string; status?: string }>(api, `${endpoint}/versions`, "versions", { pageSize: "100" });
    const detailedVersions: unknown[] = [];
    for (const version of versions) {
      if (!version.name.startsWith(`sites/${name}/versions/`)) throw new Error("Unexpected Hosting version path.");
      detailedVersions.push(version.status === "DELETED" ? version :
        await api.request(`https://firebasehosting.googleapis.com/v1beta1/${version.name}`));
    }
    hosting.push({
      site: site.name,
      versions: detailedVersions,
      releases: await list(api, `${endpoint}/releases`, "releases", { pageSize: "100" }),
      channels: await list(api, `${endpoint}/channels`, "channels", { pageSize: "100" }),
    });
  }
  const report = { checkedAt: new Date().toISOString(), buckets: details, hosting };
  await persist(`${rollout}/storage-hosting-inventory.json`, report);
  return report;
}
async function inspectStorageHostingControls() {
  const administrativeAccount = approvedAdministrativeAccount();
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS?.startsWith("/") ||
      process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_STORAGE_EMULATOR_HOST) {
    throw new Error("Isolated cloud ADC and no emulators are required.");
  }
  const api = new Api();
  const identity = await api.request<{ email?: string; email_verified?: boolean }>(
    "https://openidconnect.googleapis.com/v1/userinfo",
  );
  if (identity.email !== administrativeAccount || identity.email_verified !== true) {
    throw new Error("Unexpected administrative account.");
  }
  const target = await api.request<{ projectId?: string; projectNumber?: string }>(
    `https://firebase.googleapis.com/v1beta1/projects/${project}`,
  );
  if (target.projectId !== project || target.projectNumber !== "237261733668") throw new Error("Unexpected project identity.");
  const billing = await api.request<{ billingEnabled?: boolean; billingAccountName?: string }>(
    `https://cloudbilling.googleapis.com/v1/projects/${project}/billingInfo`,
  );
  if (!billing.billingEnabled || !billing.billingAccountName) throw new Error("Existing Blaze billing is not enabled.");
  const budgets = await list<Parameters<typeof matchesProjectBudget>[0]>(api,
    `https://billingbudgets.googleapis.com/v1/${billing.billingAccountName}/budgets`, "budgets", { pageSize: "100" });
  const budget = budgets.find(matchesProjectBudget);
  if (!budget) throw new Error("Existing project-only $1 budget and 50/90/100% recipient alerts do not match preflight.");
  const bucket = await api.request<{ location?: string; bucket?: { name?: string } }>(
    `https://firebasestorage.googleapis.com/v1beta/projects/${project}/defaultBucket`,
  );
  if (bucket.bucket?.name?.split("/").at(-1) !== cleanBucket || bucket.location !== "US-EAST1") {
    throw new Error("The existing default bucket identity/location changed.");
  }
  const release = await api.request<{ rulesetName: string }>(
    `https://firebaserules.googleapis.com/v1/projects/${project}/releases/firebase.storage/${cleanBucket}`,
  );
  const rules = await api.request<{ source?: { files?: Array<{ content?: string }> } }>(
    `https://firebaserules.googleapis.com/v1/${release.rulesetName}`,
  );
  if (rules.source?.files?.length !== 1 || rules.source.files[0]?.content !== await readFile("storage.rules", "utf8")) {
    throw new Error("Fresh Storage rules do not match the verified local rules.");
  }
  return {
    checkedAt: new Date().toISOString(), projectId: project, projectNumber: target.projectNumber,
    administrativeAccount: identity.email, cloudControlsReady: true, blockers: [] as string[],
    scope: "storage-hosting", firestoreApiCalls: 0,
    billing: { enabled: true, accountName: billing.billingAccountName },
    storage: { bucketName: cleanBucket, location: bucket.location, rules: { matchesLocal: true, rulesetName: release.rulesetName } },
    budget: { name: budget.name, verified: true, isHardSpendingCap: false },
  };
}
async function prepareCloud() {
  const usage = await inspectStorageUsage();
  const reservations = await Reservations.open(usage);
  const controls = await inspectStorageHostingControls();
  if (!controls.cloudControlsReady || controls.storage.bucketName !== cleanBucket || controls.storage.location !== "US-EAST1") {
    throw new Error(`Cloud safeguards/bucket mismatch: ${controls.blockers.join("; ")}`);
  }
  // Privacy performs at most 4 bucket reads in the existing single-page ACL configuration.
  await reservations.reserve({ requests: 4, transferBytes: 4 * 1024 ** 2 });
  let privacyRequests = 0;
  const privacy = await inspectBucketPrivacy(cleanBucket, {
    fetch: async (url, init) => {
      if (++privacyRequests > 4) await reservations.reserve({ requests: 1, transferBytes: 1024 ** 2 });
      return fetch(url, { ...init, redirect: "error" });
    },
  });
  if (!privacy.safeForPrivateUploads) throw new Error("Bucket is not private.");
  await persist(`${rollout}/storage-controls.json`, { controls, privacy });
  const api = new Api(reservations);
  const cloud = await inventory(api);
  const currentBytes = cloud.buckets.flatMap((bucket) => [...bucket.objects, ...bucket.softDeleted])
    .reduce((total, object) => {
      const size = Number(object.size);
      if (!validAmount(size)) throw new Error("Invalid remote object size.");
      return total + size;
    }, 0);
  usage.storedBytes = Math.max(usage.peakStoredBytes, currentBytes);
  await persist(`${rollout}/storage-usage.json`, usage);
  return { usage, reservations, controls, privacy, privacyRequests, api, cloud };
}
async function lock(): Promise<() => Promise<void>> {
  await mkdir(rollout, { recursive: true });
  const path = `${rollout}/storage-hosting.lock`;
  const handle = await open(path, "wx");
  await handle.writeFile(`${process.pid}\n`);
  return async () => { await handle.close(); await unlink(path); };
}
async function regularFiles(root: string, directory = root): Promise<string[]> {
  const stat = await lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Unsafe data directory: ${directory}`);
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink() || entry.name.startsWith(".")) throw new Error(`Unsafe hidden file/symlink: ${path}`);
    if (entry.isDirectory()) files.push(...await regularFiles(root, path));
    else if (entry.isFile()) files.push(relative(resolve(root), path).split(sep).join("/"));
    else throw new Error(`Not a regular file: ${path}`);
  }
  return files.sort();
}
export function validateCleanFile(path: string, releaseId: string): void {
  const escaped = releaseId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (path !== "data/manifest.json" && path !== "data/approved-comments.json" &&
      !new RegExp(`^content/${escaped}/(?:catalog\\.json|(?:questions|discussions)/[a-zA-Z0-9_-]+\\.json|media/[a-f0-9]{64}\\.(?:png|jpg|gif|webp))$`).test(path)) {
    throw new Error(`File is outside the sanitized bank allowlist: ${path}`);
  }
}
export async function buildCleanStoragePlan(): Promise<CleanPlan> {
  const bank = await loadCleanBank();
  const manifestBytes = await readFile(`${bankRoot}/data/manifest.json`);
  const manifest = bank.manifest;
  if (manifest.counts.comments !== expectedComments || manifest.counts.images !== expectedImages ||
      manifest.mediaBaseUrl !== `content/${manifest.releaseId}/media/`) {
    throw new Error("The sanitized bank does not have the approved 7,994 comments/784 images or media root.");
  }
  const paths = await regularFiles(bankRoot);
  if (JSON.stringify(paths) !== JSON.stringify(bank.files)) throw new Error("The bank file list changed during validation.");
  const releases = new Set(bank.releases.map((release) => release.catalog.releaseId));
  const files: CleanPlan["files"] = [];
  const mediaByHash = new Map<string, CleanMedia>();
  for (const path of paths) {
    const releaseId = path.startsWith("content/") ? path.split("/")[1]! : manifest.releaseId;
    if (!releases.has(releaseId)) throw new Error(`Unexpected sanitized release: ${releaseId}`);
    validateCleanFile(path, releaseId);
    const source = `${bankRoot}/${path}`;
    const bytes = await readFile(source);
    const sha256 = sha(bytes);
    files.push({ path, sha256, bytes: bytes.length });
    if (!path.startsWith(`content/${releaseId}/media/`)) continue;
    const file = path.split("/").at(-1)!;
    if (file.split(".")[0] !== sha256) throw new Error(`Original image SHA-256 mismatch: ${path}`);
    const types: Record<string, string> = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
    const contentType = types[file.split(".").at(-1) ?? ""];
    if (!contentType) throw new Error(`Unsupported original image: ${path}`);
    const previous = mediaByHash.get(sha256);
    const name = cleanMediaObjectPath(sha256, file.split(".").at(-1)!);
    if (previous && (previous.byteLength !== bytes.length || previous.name !== name)) {
      throw new Error("Conflicting media aliases across sanitized releases.");
    }
    if (!previous) {
      mediaByHash.set(sha256, { source, name, sha256, byteLength: bytes.length,
        contentType, md5Hash: createHash("md5").update(bytes).digest("base64"), crc32c: crc32c(bytes) });
    } else if (releaseId === manifest.releaseId) mediaByHash.set(sha256, { ...previous, source });
  }
  const media = [...mediaByHash.values()].sort((a, b) => a.name.localeCompare(b.name));
  if (media.length !== expectedImages || new Set(media.map((item) => item.sha256)).size !== expectedImages) {
    throw new Error("Exactly 784 unique original images are required.");
  }
  const base = {
    schemaVersion: 1 as const, releaseId: manifest.releaseId, manifestHash: sha(manifestBytes),
    filesHash: sha(JSON.stringify(files)), media, mediaBytes: media.reduce((total, item) => total + item.byteLength, 0), files,
  };
  return { ...base, digest: sha(JSON.stringify(base)) };
}
async function approved(plan: CleanPlan): Promise<void> {
  const ready = await optional<Ready>(`${rollout}/bank-ready.json`);
  if (ready?.schemaVersion !== 1 || ready.approvedBy !== "parent" || ready.scope !== "storage" || ready.planDigest !== plan.digest) {
    throw new Error("Upload blocked: the parent must explicitly approve this exact sanitized bank in .data/rollout/bank-ready.json.");
  }
}
export function verifyRemoteMedia(object: CloudObject, media: CleanMedia, privacy: Pick<BucketPrivacyReport, "uniformBucketLevelAccess">): void {
  if (object.name !== media.name || !object.generation || object.timeDeleted || object.softDeleteTime ||
      Number(object.size) !== media.byteLength || object.contentType !== media.contentType ||
      !["STANDARD", "REGIONAL"].includes(object.storageClass ?? "") ||
      object.md5Hash !== media.md5Hash || object.crc32c !== media.crc32c || object.metadata?.sha256 !== media.sha256 ||
      Object.keys(object.metadata ?? {}).some((key) => key !== "sha256") ||
      (!privacy.uniformBucketLevelAccess && !Array.isArray(object.acl)) ||
      object.acl?.some((entry) => entry.entity === "allUsers" || entry.entity === "allAuthenticatedUsers")) {
    throw new Error(`Remote checksum, bytes, metadata, or private ACL mismatch: ${media.name}`);
  }
}
function verifyMediaInventory(inventory: Inventory, plan: CleanPlan, privacy: BucketPrivacyReport): void {
  const bucket = inventory.buckets.find((item) => item.name === cleanBucket);
  const expected = new Map(plan.media.map((item) => [item.name, item]));
  if (!bucket || bucket.softDeleted.length || bucket.objects.length !== plan.media.length ||
      new Set(bucket.objects.map((object) => object.name)).size !== plan.media.length) {
    throw new Error("Storage inventory has missing, additional, or soft-deleted objects.");
  }
  for (const object of bucket.objects) {
    const media = expected.get(object.name);
    if (!media) throw new Error("Unexpected object in Storage inventory.");
    verifyRemoteMedia(object, media, privacy);
  }
}
async function upload(plan: CleanPlan, write: boolean): Promise<unknown> {
  await approved(plan);
  const cloud = await prepareCloud();
  const bucket = cloud.cloud.buckets.find((entry) => entry.name === cleanBucket);
  if (!bucket || bucket.location !== "US-EAST1" || !["STANDARD", "REGIONAL"].includes(bucket.storageClass ?? "")) {
    throw new Error("Unexpected bucket configuration.");
  }
  const expected = new Map(plan.media.map((item) => [item.name, item]));
  if (bucket.softDeleted.length || bucket.objects.some((object) => !expected.has(object.name) || object.timeDeleted) ||
      new Set(bucket.objects.map((object) => object.name)).size !== bucket.objects.length) {
    throw new Error("Unexpected objects, archived versions, or soft-deleted backups found; no overwrite or deletion performed.");
  }
  const existing = new Map(bucket.objects.map((item) => [item.name, item]));
  for (const object of bucket.objects) verifyRemoteMedia(object, expected.get(object.name)!, cloud.privacy);
  const missing = plan.media.filter((item) => !existing.has(item.name));
  cloud.reservations.assert({ requests: missing.length * 2 + 12,
    transferBytes: (missing.length * 2 + 12) * 1024 ** 2,
    storedBytes: missing.reduce((total, item) => total + item.byteLength, 0) });
  if (!write && missing.length) throw new Error(`Verification failed: ${missing.length} private media objects are missing.`);
  const progress: Progress = { planDigest: plan.digest, completed: [] };
  const started = new Date().toISOString();
  let created = 0;
  for (const media of plan.media) {
    let object = existing.get(media.name);
    if (!object) {
      // Stop rather than allow a long run to outlive its fresh guard/usage snapshot.
      if (Date.now() - Date.parse(cloud.controls.checkedAt) > 10 * 60_000) {
        throw new Error("Preflight expired; safely resume with fresh controls and usage.");
      }
      const bytes = await readFile(media.source);
      if (sha(bytes) !== media.sha256 || bytes.length !== media.byteLength) throw new Error("Sanitized media changed during upload.");
      const boundary = `clean-${randomUUID()}`;
      const metadata = { name: media.name, contentType: media.contentType, storageClass: "STANDARD", cacheControl: "private,no-store",
        md5Hash: media.md5Hash, crc32c: media.crc32c, metadata: { sha256: media.sha256 } };
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${media.contentType}\r\n\r\n`),
        bytes, Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      const url = new URL(`https://storage.googleapis.com/upload/storage/v1/b/${cleanBucket}/o`);
      url.searchParams.set("uploadType", "multipart");
      url.searchParams.set("ifGenerationMatch", "0");
      if (!cloud.privacy.uniformBucketLevelAccess) url.searchParams.set("predefinedAcl", "private");
      const inserted = await cloud.api.request<CloudObject>(url.href, {
        method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body,
      }, media.byteLength);
      if (!inserted.generation) throw new Error("Storage upload did not return a generation.");
      object = await cloud.api.request<CloudObject>(
        `https://storage.googleapis.com/storage/v1/b/${cleanBucket}/o/${encodeURIComponent(media.name)}` +
        `?generation=${encodeURIComponent(inserted.generation)}&projection=full`,
      );
      created++;
    }
    verifyRemoteMedia(object, media, cloud.privacy);
    progress.completed.push({ name: media.name, generation: object.generation!, bytes: media.byteLength,
      sha256: media.sha256, md5Hash: media.md5Hash, crc32c: media.crc32c });
    await persist(`${rollout}/storage-progress.json`, progress);
  }
  verifyMediaInventory(await inventory(cloud.api), plan, cloud.privacy);
  const report = { started, checkedAt: new Date().toISOString(), project, bucket: cleanBucket,
    planDigest: plan.digest, status: "verified", objects: progress.completed.length, bytes: plan.mediaBytes,
    created, unchanged: plan.media.length - created, private: true, sharedContentAddressedPaths: true,
    storedCatalogBackups: 0, archivedVersions: 0, softDeletedObjects: 0,
    storageRequestsThisRun: cloud.privacyRequests + cloud.api.storageRequests,
    reservations: cloud.reservations.current,
    constraints: ["Monitoring can lag; reservations and 10%+ headroom are conservative, not a billing hard cap.",
      "No ongoing public Hosting traffic limit is enforced by Blaze budget alerts."] };
  await persist(`${rollout}/storage-report.json`, report);
  return report;
}
export async function validateStaticFavicon(index: string, content: Uint8Array, workspace = process.cwd()): Promise<void> {
  const directory = resolve(workspace, "public");
  const path = resolve(directory, "favicon.svg");
  const directoryStat = await lstat(directory);
  const fileStat = await lstat(path);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() ||
      !fileStat.isFile() || fileStat.isSymbolicLink() ||
      !index.includes('href="/favicon.svg"') ||
      sha(content) !== sha(await readFile(path))) {
    throw new Error("Hosting favicon does not match the regular inspected static source.");
  }
}

export async function validateHostingTree(plan: CleanPlan): Promise<{ files: number; bytes: number }> {
  const paths = await regularFiles("dist");
  const publication = await loadStudyPublication();
  if (publication.source.manifest.releaseId !== plan.releaseId) throw new Error("The teaching publication belongs to another source bank.");
  const expected = new Map(publication.files);
  const course = await loadCoursePublication();
  for (const [path, value] of course.files) expected.set(path, { kind: "json", value });
  const index = await readFile("dist/index.html", "utf8");
  const compiledAssets = new Set([...index.matchAll(/(?:src|href)=["']\/(assets\/[^"']+)["']/g)].map((match) => match[1]!));
  let bytes = 0;
  for (const path of paths) {
    const content = await readFile(`dist/${path}`);
    bytes += content.length;
    const file = expected.get(path);
    if (file) {
      if (!content.equals(await publicationFileBytes(file))) throw new Error(`dist differs from the approved study publication: ${path}`);
      expected.delete(path);
    } else if (path === "favicon.svg") {
      await validateStaticFavicon(index, content);
    } else if (path === "offline-worker.js") {
      const source = await lstat("public/offline-worker.js");
      const directory = await lstat("public");
      if (!source.isFile() || source.isSymbolicLink() || !directory.isDirectory() || directory.isSymbolicLink() ||
          sha(content) !== sha(await readFile("public/offline-worker.js"))) {
        throw new Error("Hosting offline worker differs from the regular inspected source.");
      }
    } else if (path === "data/offline-manifest.json") {
      const expectedManifest = await buildOfflineManifest();
      if (content.toString("utf8") !== `${JSON.stringify(expectedManifest, null, 2)}\n`) {
        throw new Error("Hosting offline manifest does not match the actual sanitized build.");
      }
    } else if (path === "data/topics.json") {
      if (content.toString("utf8") !== `${JSON.stringify(await readTopicMap(), null, 2)}\n`) {
        throw new Error("Hosting topic data differs from the validated classification map.");
      }
    } else if (path !== "index.html" &&
        (!/^assets\/[a-zA-Z0-9_.-]+-[a-zA-Z0-9_-]+\.(?:js|css)$/.test(path) || !compiledAssets.has(path))) {
      throw new Error(`Hosting upload contains an unexpected file: ${path}`);
    }
  }
  if (expected.size || !paths.includes("index.html") || !paths.some((path) => path.endsWith(".js"))) {
    throw new Error("Hosting dist is missing compiled application or sanitized bank files.");
  }
  if (!paths.includes("offline-worker.js") || !paths.includes("data/offline-manifest.json") ||
      !paths.includes("data/topics.json") || !paths.includes("data/learning.json") ||
      (publication.eligibility && !paths.includes("data/eligibility.json")) ||
      !paths.includes("data/course.json") || !paths.includes(course.pointer.url)) {
    throw new Error("Hosting dist is missing the offline worker or its verified download manifest.");
  }
  if ([...compiledAssets].some((asset) => !paths.includes(asset))) throw new Error("Compiled Hosting asset is missing.");
  return { files: paths.length, bytes };
}
export async function hostingBuildIdentity(): Promise<{ distDigest: string; sourceDigest: string }> {
  const distFiles = await regularFiles("dist");
  const sourceFiles = [
    ...(await regularFiles("src")).map((path) => `src/${path}`),
    ...(await regularFiles("tools/web")).map((path) => `tools/web/${path}`),
    ...(await regularFiles("tools/learning")).map((path) => `tools/learning/${path}`),
    ...(await regularFiles("tools/eligibility")).map((path) => `tools/eligibility/${path}`),
    ...(await regularFiles("tools/course")).map((path) => `tools/course/${path}`),
    ...(await regularFiles("content/networking")).map((path) => `content/networking/${path}`),
    "index.html", "public/favicon.svg", "public/offline-worker.js", "package.json", "package-lock.json", "tsconfig.json", "vite.config.ts",
  ].sort();
  const compiledTimes = await Promise.all(distFiles.filter((path) => /^assets\/.*\.js$/.test(path))
    .map(async (path) => (await lstat(`dist/${path}`)).mtimeMs));
  if (!compiledTimes.length) throw new Error("No compiled JavaScript build found.");
  const builtAt = Math.max(...compiledTimes);
  const sources: Array<{ path: string; sha256: string }> = [];
  for (const path of sourceFiles) {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.mtimeMs > builtAt) {
      throw new Error(`Build input changed after compilation; parent must rebuild: ${path}`);
    }
    sources.push({ path, sha256: sha(await readFile(path)) });
  }
  const artifacts = await Promise.all(distFiles.map(async (path) => ({ path, sha256: sha(await readFile(`dist/${path}`)) })));
  return { distDigest: sha(JSON.stringify(artifacts)), sourceDigest: sha(JSON.stringify(sources)) };
}
async function hostingCheck(): Promise<unknown> {
  const plan = await buildCleanStoragePlan();
  await approved(plan);
  const hostingReady = await optional<Ready>(`${rollout}/hosting-ready.json`);
  if (hostingReady?.schemaVersion !== 1 || hostingReady.approvedBy !== "parent" ||
      hostingReady.scope !== "hosting" || hostingReady.planDigest !== plan.digest) {
    throw new Error("Hosting blocked: separate parent approval of the completed integrated build is required.");
  }
  const local = await validateHostingTree(plan);
  const identity = await hostingBuildIdentity();
  if (hostingReady.distDigest !== identity.distDigest || hostingReady.sourceDigest !== identity.sourceDigest) {
    throw new Error("Hosting build/input hashes differ from the separately parent-approved build.");
  }
  const cloud = await prepareCloud();
  const storage = await optional<{ status: string; planDigest: string }>(`${rollout}/storage-report.json`);
  if (storage?.status !== "verified" || storage.planDigest !== plan.digest) throw new Error("Verify private Storage media before Hosting.");
  verifyMediaInventory(cloud.cloud, plan, cloud.privacy);
  const versions = cloud.cloud.hosting.flatMap((site) => site.versions) as Array<{ name?: string; versionBytes?: string; status?: string }>;
  const inventoryBytes = versions.reduce((sum, version) => {
    const amount = version.versionBytes === undefined && version.status === "DELETED" ? 0 : Number(version.versionBytes);
    if (!validAmount(amount)) throw new Error("Hosting version storage size is unavailable; cannot assume no-cost headroom.");
    return sum + amount;
  }, 0);
  const journal = await optional<{ months: Record<string, { storedBytes: number; transferBytes: number }> }>(
    `${rollout}/hosting-journal.json`,
  ) ?? { months: {} };
  const previous = journal.months[cloud.usage.month] ?? { storedBytes: 0, transferBytes: 0 };
  if (![previous.storedBytes, previous.transferBytes].every(validAmount) ||
      Math.max(cloud.usage.hostingStoredBytes, inventoryBytes) + previous.storedBytes + local.bytes > 9_000_000_000 ||
      cloud.usage.hostingTransferBytes + previous.transferBytes + local.bytes * 2 > 9_000_000_000) {
    throw new Error("Hosting quota pause: deployment and bounded validation do not fit no-cost headroom.");
  }
  journal.months[cloud.usage.month] = {
    storedBytes: previous.storedBytes + local.bytes,
    transferBytes: previous.transferBytes + local.bytes * 2,
  };
  await persist(`${rollout}/hosting-journal.json`, journal);
  const report = { checkedAt: new Date().toISOString(), planDigest: plan.digest, ...local, ...identity,
    project, site: project, url: `https://${project}.web.app`, status: "predeploy-verified",
    usage: { storedBytes: cloud.usage.hostingStoredBytes, transferBytes: cloud.usage.hostingTransferBytes },
    reservations: journal.months[cloud.usage.month],
    note: "Public future traffic cannot be hard-capped by the $1 alert; it must be monitored separately." };
  await persist(`${rollout}/hosting-predeploy.json`, report);
  return report;
}
export async function checkHostingDeployment(): Promise<unknown> {
  const unlock = await lock();
  try { return await hostingCheck(); }
  finally { await unlock(); }
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (!["inspect", "plan", "upload", "verify", "hosting-check"].includes(command ?? "")) {
    throw new Error("Use storage-clean.ts inspect|plan|upload|verify|hosting-check.");
  }
  const unlock = await lock();
  try {
    let result: unknown;
    if (command === "inspect") {
      const cloud = await prepareCloud();
      result = { usage: { ...cloud.usage, samples: undefined }, inventory: cloud.cloud, privacy: cloud.privacy };
    } else if (command === "hosting-check") result = await hostingCheck();
    else {
      const plan = await buildCleanStoragePlan();
      await persist(`${rollout}/storage-plan.json`, plan);
      result = command === "plan"
        ? { digest: plan.digest, releaseId: plan.releaseId, media: plan.media.length, bytes: plan.mediaBytes, uploadApproved: false }
        : await upload(plan, command === "upload");
    }
    console.log(JSON.stringify(result, null, 2));
  } finally { await unlock(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Storage/Hosting rollout failed.");
    process.exitCode = 1;
  });
}
