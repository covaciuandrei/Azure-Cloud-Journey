import { Sc900ManifestSchema } from "../domain/sc900Bank.js";
import { examBaseUrl } from "../domain/exams.js";

export async function loadSc900Manifest(appBase: string, fetcher: typeof fetch = fetch) {
  const response = await fetcher(new URL("manifest.json", examBaseUrl(appBase, "sc900")).href, {
    cache: "no-store", credentials: "same-origin", redirect: "error",
  });
  if (!response.ok) throw new Error(`SC-900 manifest request failed (HTTP ${response.status}).`);
  const text = await response.text();
  if (new TextEncoder().encode(text).length > 4 * 1024 * 1024) {
    throw new Error("SC-900 manifest exceeds the 4 MiB limit.");
  }
  return Sc900ManifestSchema.parse(JSON.parse(text));
}
