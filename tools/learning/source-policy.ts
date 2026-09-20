export function isApprovedDocumentationUrl(url: URL): boolean {
  if (url.protocol !== "https:" || url.username || url.password) return false;
  if (url.hostname === "microsoft.com" || url.hostname.endsWith(".microsoft.com")) return true;
  // Microsoft Learn redirects AzCopy command references to this official project wiki.
  return url.hostname === "github.com" &&
    /^\/Azure\/azure-storage-azcopy\/wiki\/azcopy_[a-z0-9_-]+\/?$/i.test(url.pathname);
}
