import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertStorageHeadroom, cleanMediaObjectPath, crc32c, storageLimits, validateCleanFile, validateStaticFavicon, verifyRemoteMedia } from "../tools/publish/storage-clean.js";

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
  assert.throws(() => assertStorageHeadroom({ ...zero, requests: 3000 }, { ...zero, requests: 800 }, { ...zero, requests: 784 }), /quota pause/);
  for (const key of Object.keys(zero) as Array<keyof typeof zero>) {
    assert.throws(() => assertStorageHeadroom(zero, zero, { ...zero, [key]: storageLimits[key] + 1 }), /quota pause/);
    assert.throws(() => assertStorageHeadroom(zero, zero, { ...zero, [key]: -1 }), /quota pause/);
  }
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
