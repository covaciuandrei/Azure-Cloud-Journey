import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  cleanBucket, crc32c, mediaFromApprovedSc900Files, verifyCombinedHostingMediaInventory, type CleanMedia,
} from "../tools/publish/storage-clean.js";
import type { BucketPrivacyReport } from "../tools/publish/bucket-privacy.js";
import type { PublicationFile } from "../tools/learning/publication.js";
import { sc900BankFixture, sc900BankReview } from "./sc900-bank-fixture.js";
import { buildSc900StaticPlan, prepareSc900Release, stageSc900Publication } from "../tools/sc900/publication.js";

const privacy: BucketPrivacyReport = { bucketName: cleanBucket, safeForPrivateUploads: true,
  uniformBucketLevelAccess: false, publicAccessPrevention: null, anonymousIamBindings: [], anonymousDefaultObjectAcls: [] };
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function original(bytes: Buffer, name: string): CleanMedia {
  return { name, source: ".data/original.png", byteLength: bytes.length, sha256: hash(bytes),
    contentType: "image/png", md5Hash: createHash("md5").update(bytes).digest("base64"), crc32c: crc32c(bytes) };
}
function remote(item: CleanMedia) {
  return { name: item.name, size: String(item.byteLength), generation: "1", contentType: item.contentType,
    storageClass: "STANDARD", cacheControl: "private,no-store", md5Hash: item.md5Hash, crc32c: item.crc32c,
    metadata: { sha256: item.sha256 }, acl: [{ entity: "user-owner", role: "OWNER" }] };
}
function inventory(objects: ReturnType<typeof remote>[], softDeleted: ReturnType<typeof remote>[] = []) {
  return { buckets: [{ name: cleanBucket, projectNumber: "237261733668", objects, softDeleted }] };
}

test("combined Hosting guard accepts only the exact approved media union, including retained SC releases", () => {
  const bytes = Buffer.from("original synthetic media fixture");
  const digest = hash(bytes);
  const az = original(bytes, `private/az104/assets/${digest}.png`);
  const sc = original(bytes, `published/sc900/r_${"a".repeat(64)}/assets/${digest}.png`);
  const archived = original(bytes, `published/sc900/r_${"b".repeat(64)}/assets/${digest}.png`);
  const all = [remote(az), remote(sc), remote(archived)];
  assert.doesNotThrow(() => verifyCombinedHostingMediaInventory(inventory([remote(az)]), [az], [], privacy));
  assert.doesNotThrow(() => verifyCombinedHostingMediaInventory(inventory(all), [az], [sc, archived], privacy));
  assert.throws(() => verifyCombinedHostingMediaInventory(inventory(all), [az], [], privacy), /additional|unknown/);
  assert.throws(() => verifyCombinedHostingMediaInventory(inventory(all.slice(0, 2)), [az], [sc, archived], privacy), /missing/);
  assert.throws(() => verifyCombinedHostingMediaInventory(inventory([...all, remote(sc)]), [az], [sc, archived], privacy), /unknown|archived/);
  assert.throws(() => verifyCombinedHostingMediaInventory(inventory(all, [remote(sc)]), [az], [sc, archived], privacy), /soft-deleted/);
  for (const change of [
    { name: `published/sc900/r_${"c".repeat(64)}/assets/${digest}.png` },
    { size: "1" }, { md5Hash: "bad" }, { crc32c: "bad" }, { generation: "" },
    { cacheControl: "public,max-age=31536000" },
    { metadata: { sha256: digest, firebaseStorageDownloadTokens: "SYNTHETIC-NOT-A-CREDENTIAL" } },
    { acl: [{ entity: "allUsers", role: "READER" }] },
    { acl: [{ entity: "allAuthenticatedUsers", role: "READER" }] },
    { timeDeleted: "2026-09-22T00:00:00Z" },
  ]) {
    const changed = [remote(az), { ...remote(sc), ...change }, remote(archived)];
    assert.throws(() => verifyCombinedHostingMediaInventory(inventory(changed), [az], [sc, archived], privacy));
  }
  assert.throws(() => verifyCombinedHostingMediaInventory(inventory(all),
    [az], [{ ...sc, name: "published/sc900/arbitrary.png" }, archived], privacy), /approved/);
});

test("SC media allowlist derives original byte metadata from each explicitly retained approved question", async () => {
  const root = resolve(`.data/hosting-media-test-${randomUUID()}`);
  try {
    await mkdir(root, { recursive: true });
    const files = new Map<string, PublicationFile>();
    for (const seed of ["a", "b"]) {
      const input = sc900BankFixture();
      input.expectedCapture.receiptSha256 = seed.repeat(64);
      const release = prepareSc900Release(input);
      const plan = buildSc900StaticPlan(input, sc900BankReview(release));
      const stage = await stageSc900Publication(plan, { workspaceRoot: root });
      for (const file of plan.files) files.set(file.path, { kind: "source", path: resolve(stage.directory, file.path) });
    }
    const media = await mediaFromApprovedSc900Files(files);
    assert.equal(media.length, 2, "same bytes in two retained release paths are both required");
    assert.equal(media[0]!.sha256, media[1]!.sha256);
    assert.notEqual(media[0]!.name, media[1]!.name);
    assert.ok(media.every((item) => item.name.startsWith("published/sc900/r_")));
    const missing = new Map(files);
    const asset = [...files.keys()].find((path) => path.includes("/media/"))!;
    missing.delete(asset);
    await assert.rejects(mediaFromApprovedSc900Files(missing), /lacks original/);
    const file = files.get(asset)!;
    assert.equal(file.kind, "source");
    if (file.kind !== "source") throw new Error("Expected original binary.");
    await link(file.path, resolve(root, "duplicate-hardlink.png"));
    await assert.rejects(mediaFromApprovedSc900Files(files), /hard links/);
    await rm(resolve(root, "duplicate-hardlink.png"));
    await writeFile(file.path, "synthetic corrupted media");
    await assert.rejects(mediaFromApprovedSc900Files(files), /original files|original bytes/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
