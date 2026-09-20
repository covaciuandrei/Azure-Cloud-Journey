import assert from "node:assert/strict";
import test from "node:test";
import { isApprovedDocumentationUrl } from "../tools/learning/source-policy.js";

test("documentation checks allow Microsoft sites and the official AzCopy command-reference migration", () => {
  for (const value of [
    "https://learn.microsoft.com/en-us/azure/storage/common/storage-sas-overview",
    "https://azure.microsoft.com/pricing/",
    "https://github.com/Azure/azure-storage-azcopy/wiki/azcopy_sync",
    "https://github.com/Azure/azure-storage-azcopy/wiki/azcopy_copy",
  ]) assert.equal(isApprovedDocumentationUrl(new URL(value)), true, value);
});

test("the AzCopy exception does not approve arbitrary GitHub pages or lookalike destinations", () => {
  for (const value of [
    "http://learn.microsoft.com/en-us/azure",
    "https://learn.microsoft.com.evil.example/azure",
    "https://github.com/another-owner/azure-storage-azcopy/wiki/azcopy_sync",
    "https://github.com/Azure/another-repo/wiki/azcopy_sync",
    "https://github.com/Azure/azure-storage-azcopy/issues/1",
    "https://github.com/Azure/azure-storage-azcopy/wiki/Home",
    "https://user:password@learn.microsoft.com/en-us/azure",
  ]) assert.equal(isApprovedDocumentationUrl(new URL(value)), false, value);
});
