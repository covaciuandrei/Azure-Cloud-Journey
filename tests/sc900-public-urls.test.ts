import assert from "node:assert/strict";
import { test } from "node:test";
import { assertNoCredentialUrls, PublicHttpUrlSchema } from "../src/domain/publicUrls.js";
import { sc900BankFixture } from "./sc900-bank-fixture.js";
import { prepareSc900Release } from "../tools/sc900/publication.js";

const marker = "SYNTHETIC-NOT-A-CREDENTIAL";
const unsafe = [
  `https://example.test/image.png?sv=synthetic&sig=${marker}`,
  `https://example.test/image.png?SIG=${marker}`,
  `https://example.test/image.png?%73%69%67=${marker}`,
  `https://example.test/image.png?%2573ig=${marker}`,
  `https://example.test/image.png?access_token=${marker}`,
  `https://example.test/image.png?X-Amz-Credential=${marker}`,
  `https://example.test/image.png?X-Goog-Signature=${marker}`,
  `https://example.test/image.png#id_token=${marker}`,
  `https://user:${marker}@example.test/image.png`,
];

test("public URL validation rejects signed and credential-bearing attribution without echoing values", () => {
  for (const url of unsafe) {
    const parsed = PublicHttpUrlSchema.safeParse(url);
    assert.equal(parsed.success, false);
    if (!parsed.success) assert.doesNotMatch(parsed.error.message, new RegExp(marker));
    assert.throws(() => assertNoCredentialUrls({ media: [{ sourceUrls: [url] }] }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /cannot be published/);
      assert.doesNotMatch(error.message, new RegExp(marker));
      return true;
    });
  }
});

test("credential guard covers rich links, tables, text and teaching references without stripping anything", () => {
  const link = { type: "link", text: "Synthetic reference", href: unsafe[0], marks: [] };
  for (const input of [
    { prompt: [{ type: "text", spans: [link] }] },
    { body: [{ type: "table", rows: [{ cells: [{ blocks: [{ type: "text", spans: [link] }] }] }] }] },
    { sources: [{ url: unsafe[0] }] },
    { code: `Original synthetic example: ${unsafe[0]}` },
  ]) {
    const original = structuredClone(input);
    assert.throws(() => assertNoCredentialUrls(input), /cannot be published/);
    assert.deepEqual(structuredClone(input), original);
  }
  const publicUrl = "https://learn.microsoft.com/en-us/azure/storage/blobs/?view=azure-java-stable&tabs=azure-cli#overview";
  assert.equal(PublicHttpUrlSchema.safeParse(publicUrl).success, true);
  assert.equal(PublicHttpUrlSchema.safeParse("https://learn.microsoft.com/en-us/security/#authorization").success, true);
  assert.doesNotThrow(() => assertNoCredentialUrls({ sourceUrls: [publicUrl] }));
});

test("SC900 publication rejects credential URLs before constructing release hashes or export bytes", () => {
  const media = sc900BankFixture();
  for (const document of media.documents) document.question.media[0]!.sourceUrls = [unsafe[0]!];
  const rich = sc900BankFixture();
  rich.documents[0]!.question.prompt.push({ type: "text", spans: [
    { type: "link", href: unsafe[0]!, text: "Synthetic unsafe reference", marks: [] },
  ] });
  const teaching = sc900BankFixture();
  teaching.learning.explanations[0]!.sources[0]!.url =
    `https://learn.microsoft.com/en-us/security/?token=${marker}`;
  for (const input of [media, rich, teaching]) {
    const original = structuredClone(input);
    assert.throws(() => prepareSc900Release(input), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "Credential-bearing URLs cannot be published.");
      assert.doesNotMatch(error.message, new RegExp(marker));
      return true;
    });
    assert.deepEqual(structuredClone(input), original);
  }
});
