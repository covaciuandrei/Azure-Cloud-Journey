import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertStorageHeadroom, cleanMediaObjectPath, crc32c, storageLimits, storageOperationClasses, storageRequestClass, StorageReservations, validateCleanFile, validateStaticFavicon, verifyRemoteMedia, type StorageUsage } from "../tools/publish/storage-clean.js";
import { pacificQuotaDay } from "../tools/publish/quota.js";

test("Hosting favicon must be referenced, unchanged and not a source symlink", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "az104-favicon-"));
  const content = Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>");
  const index = '<link rel="icon" href="/favicon.svg">';
  try {
    await mkdir(join(workspace, "public"));
    await writeFile(join(workspace, "public/favicon.svg"), content);
    await validateStaticFavicon(index, content, workspace);
    await assert.rejects(validateStaticFavicon("<html></html>", content, workspace), /regular inspected/);
    await assert.rejects(validateStaticFavicon(index, Buffer.from("changed"), workspace), /regular inspected/);
    await writeFile(join(workspace, "outside.svg"), content);
    await unlink(join(workspace, "public/favicon.svg"));
    await symlink(join(workspace, "outside.svg"), join(workspace, "public/favicon.svg"));
    await assert.rejects(validateStaticFavicon(index, content, workspace), /regular inspected/);
    await unlink(join(workspace, "public/favicon.svg"));
    await rm(join(workspace, "public"), { recursive: true });
    await mkdir(join(workspace, "elsewhere"));
    await writeFile(join(workspace, "elsewhere/favicon.svg"), content);
    await symlink(join(workspace, "elsewhere"), join(workspace, "public"));
    await assert.rejects(validateStaticFavicon(index, content, workspace), /regular inspected/);
  } finally {
    await rm(workspace, { recursive: true });
  }
});

test("Private originals use one release-independent SHA-256 path", () => {
  const sha = "a".repeat(64);
  assert.equal(cleanMediaObjectPath(sha, "png"), `private/az104/assets/${sha}.png`);
  for (const [hash, extension] of [["../raw", "png"], [sha, "../png"], [sha, "json"], [sha.toUpperCase(), "png"]]) {
    assert.throws(() => cleanMediaObjectPath(hash!, extension!), /Private media path/);
  }
});

test("Storage headroom includes observed project usage and unreleased reservations", () => {
  const zero = { requests: 0, transferBytes: 0, storedBytes: 0 };
  assert.doesNotThrow(() => assertStorageHeadroom(zero, zero, { ...zero, requests: 1600 }));
  assert.throws(() => assertStorageHeadroom({ ...zero, requests: 3500 }, { ...zero, requests: 800 }, { ...zero, requests: 784 }), /quota pause/);
  for (const key of Object.keys(zero) as Array<keyof typeof zero>) {
    assert.throws(() => assertStorageHeadroom(zero, zero, { ...zero, [key]: storageLimits[key] + 1 }), /quota pause/);
    assert.throws(() => assertStorageHeadroom(zero, zero, { ...zero, [key]: -1 }), /quota pause/);
  }
});

test("known Storage reads do not consume the write allowance and unknown metrics stay conservative", () => {
  const classes = storageOperationClasses([
    { labels: { method: "WriteObject" }, value: 784, endTime: "2026-09-22T00:00:00Z" },
    { labels: { method: "ListObjects" }, value: 159, endTime: "2026-09-22T00:00:00Z" },
    { labels: { method: "GetObjectMetadata" }, value: 784, endTime: "2026-09-22T00:00:00Z" },
    { labels: { method: "UnknownOperation" }, value: 60, endTime: "2026-09-22T00:00:00Z" },
  ]);
  assert.deepEqual(classes, { classARequests: 1003, classBRequests: 844 });
  const zero = { requests: 0, transferBytes: 0, storedBytes: 0 };
  const observed = { ...zero, requests: 1787, ...classes };
  const legacy = { ...zero, requests: 2712 };
  assert.doesNotThrow(() => assertStorageHeadroom(observed, legacy, { ...zero, classARequests: 80, classBRequests: 1000 }));
  assert.throws(() => assertStorageHeadroom(observed, legacy, { ...zero, classARequests: 1186 }), /quota pause/);
  assert.throws(() => assertStorageHeadroom(observed, legacy, { ...zero, classBRequests: 45000 }), /quota pause/);
  assert.throws(() => assertStorageHeadroom({ ...observed, classARequests: 0, classBRequests: 0 }, zero, zero), /do not cover/);
  assert.throws(() => assertStorageHeadroom(observed, zero, { ...zero, classARequests: -1 }), /quota pause/);
});

test("classified reservations append to the existing journal without refunding or reclassifying old requests", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "storage-classes-"));
  try {
    const now = new Date().toISOString();
    const month = pacificQuotaDay(new Date()).slice(0, 7);
    await mkdir(join(workspace, ".data/rollout"), { recursive: true });
    const previous = { requests: 2712, transferBytes: 2704023936, storedBytes: 53624931 };
    await writeFile(join(workspace, ".data/rollout/storage-journal.json"), JSON.stringify({
      schemaVersion: 1, months: { [month]: previous },
    }));
    const usage: StorageUsage = {
      checkedAt: now, month, periodStart: now, requests: 1787,
      classARequests: 1003, classBRequests: 844, transferBytes: 22355850,
      storedBytes: 50778201, peakStoredBytes: 50778201, hostingStoredBytes: 0, hostingTransferBytes: 0, samples: {},
    };
    const budget = await StorageReservations.open(usage, workspace);
    await budget.reserve({ classBRequests: 2, transferBytes: 100 });
    await budget.reserve({ classARequests: 1, storedBytes: 50 });
    const next = await StorageReservations.open(usage, workspace);
    await next.reserve({ classBRequests: 3 });
    const journal = JSON.parse(await readFile(join(workspace, ".data/rollout/storage-journal.json"), "utf8"));
    assert.equal(journal.schemaVersion, 2, "Older single-counter writers must not discard classified reservations.");
    assert.deepEqual(journal.months[month], {
      ...previous, transferBytes: previous.transferBytes + 100, storedBytes: previous.storedBytes + 50,
      classARequests: 1, classBRequests: 5,
    });
    await assert.rejects(next.reserve({ requests: 1186 }), /quota pause/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("bucket metadata, IAM and ACL reads use Google's Class B table while object listings remain Class A", () => {
  const base = "https://storage.googleapis.com/storage/v1/b/example-bucket";
  for (const path of ["", "/iam", "/acl", "/defaultObjectAcl", "/o/encoded%2Fobject.png"]) {
    assert.deepEqual(storageRequestClass(base + path), { classBRequests: 1 });
  }
  assert.deepEqual(storageRequestClass(base + "/o"), { classARequests: 1 });
  assert.deepEqual(storageRequestClass(base + "/o?softDeleted=true"), { classBRequests: 1 });
  assert.deepEqual(storageRequestClass("https://storage.googleapis.com/storage/v1/b"), { classARequests: 1 });
  assert.deepEqual(storageRequestClass(base + "/unknown"), { requests: 1 });
  assert.deepEqual(storageRequestClass(base + "/o/one", "DELETE"), { requests: 1 });
  assert.deepEqual(storageOperationClasses([
    { labels: { method: "GetBucketMetadata" }, value: 69, endTime: "2026-09-22T00:00:00Z" },
    { labels: { method: "GetIamPolicy" }, value: 34, endTime: "2026-09-22T00:00:00Z" },
  ]), { classARequests: 0, classBRequests: 103 });
});

test("CRC32C uses the server-compatible Castagnoli checksum", () => {
  assert.equal(crc32c(Buffer.from("123456789")), "4waSgw==");
  assert.equal(crc32c(Buffer.alloc(0)), "AAAAAA==");
});

test("Only sanitized data and content-addressed media paths are allowed", () => {
  for (const path of ["data/manifest.json", "content/r_clean/catalog.json", "content/r_clean/questions/q_1.json",
    "content/r_clean/discussions/q_1.json", `content/r_clean/media/${"a".repeat(64)}.png`]) {
    assert.doesNotThrow(() => validateCleanFile(path, "r_clean"));
  }
  for (const path of [".data/raw/a.json", "content/old/catalog.json", "content/r_clean/reviews/a.json",
    "content/r_clean/answers/a.json", "content/r_clean/../../credentials.json", "node_modules/index.js"]) {
    assert.throws(() => validateCleanFile(path, "r_clean"), /allowlist/);
  }
});

test("Media verification requires real server checksums, generation, bytes, and private metadata", () => {
  const media = { source: ".data/clean-bank/content/r_clean/media/a.png", name: cleanMediaObjectPath("a".repeat(64), "png"),
    sha256: "a".repeat(64), md5Hash: "MD5", crc32c: "CRC", byteLength: 12, contentType: "image/png" };
  const remote = { name: media.name, generation: "1", size: "12", contentType: media.contentType, storageClass: "STANDARD",
    md5Hash: media.md5Hash, crc32c: media.crc32c, metadata: { sha256: media.sha256 }, acl: [{ entity: "user-owner", role: "OWNER" }] };
  const privacy = { uniformBucketLevelAccess: false };
  assert.doesNotThrow(() => verifyRemoteMedia(remote, media, privacy));
  for (const changed of [{ size: "13" }, { storageClass: "NEARLINE" }, { md5Hash: "BAD" }, { crc32c: "BAD" },
    { generation: "" }, { timeDeleted: "2026-09-11" }, { softDeleteTime: "2026-09-11" },
    { metadata: { sha256: media.sha256, firebaseStorageDownloadTokens: "forbidden" } },
    { acl: [{ entity: "allUsers", role: "READER" }] }]) {
    assert.throws(() => verifyRemoteMedia({ ...remote, ...changed }, media, privacy), /mismatch/);
  }
});
