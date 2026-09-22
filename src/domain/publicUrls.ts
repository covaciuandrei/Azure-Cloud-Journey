import { SafeUrlSchema } from "./schemas.js";

const credentialParameters = new Set([
  "sig", "signature", "token", "accesstoken", "refreshtoken", "idtoken",
  "apikey", "key", "secret", "clientsecret", "password", "passwd",
  "credential", "credentials", "authorization", "auth", "code",
  "sastoken", "sharedaccesssignature", "subscriptionkey", "session",
  "sessionid", "jwt", "jwttoken", "bearer",
]);

function credentialParameter(name: string): boolean {
  let decoded = name;
  for (let index = 0; index < 3 && decoded.includes("%"); index++) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch { return true; }
  }
  const key = decoded.toLowerCase().replace(/[^a-z0-9]/g, "");
  return decoded.includes("%") || credentialParameters.has(key) ||
    key.startsWith("xamz") || key.startsWith("xgoog");
}

export function isCredentialFreeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password &&
      ![...url.searchParams.entries(), ...new URLSearchParams(url.hash.slice(1)).entries()]
        .some(([name, value]) => value.length > 0 && credentialParameter(name));
  } catch { return false; }
}

export const PublicHttpUrlSchema = SafeUrlSchema.refine(isCredentialFreeUrl,
  "Credential-bearing URLs cannot be published.");

/** Also catches literal URLs inside rich text without logging or rewriting their values. */
export function assertNoCredentialUrls(value: unknown): void {
  const visited = new WeakSet<object>();
  const visit = (item: unknown): void => {
    if (typeof item === "string") {
      for (const candidate of item.match(/https?:\/\/[^\s<>"']+/gi) ?? []) {
        if (URL.canParse(candidate) && !isCredentialFreeUrl(candidate)) {
          throw new Error("Credential-bearing URLs cannot be published.");
        }
      }
    } else if (typeof item === "object" && item !== null && !visited.has(item)) {
      visited.add(item);
      if (Array.isArray(item)) item.forEach(visit);
      else if (Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null) {
        Object.values(item).forEach(visit);
      }
    }
  };
  visit(value);
}
