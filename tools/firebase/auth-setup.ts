import { applicationDefault } from "firebase-admin/app";
import { inspectFirebaseControls, projectId } from "./preflight.js";
import { isMain, writeData } from "../review/data.js";
import { inspectFirestoreUsage } from "../publish/usage.js";

export async function inspectAuthentication() {
  const controls = await inspectFirebaseControls();
  if (!controls.cloudControlsReady) throw new Error(`Firebase controls are not ready: ${controls.blockers.join("; ")}`);
  const { access_token } = await applicationDefault().getAccessToken();
  async function get(path: string): Promise<{
    exists: boolean; error?: string; name?: string | null; enabled?: boolean | null;
    authorizedDomains?: string[]; emailEnabled?: boolean; anonymousEnabled?: boolean;
  }> {
    const fields = path === "config"
      ? "name,authorizedDomains,signIn(email(enabled),anonymous(enabled))" : "name,enabled";
    const response = await fetch(`https://identitytoolkit.googleapis.com/admin/v2/projects/${projectId}/${path}?fields=${encodeURIComponent(fields)}`, {
      headers: { Authorization: `Bearer ${access_token}`, "x-goog-user-project": projectId },
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.json() as {
      name?: string; authorizedDomains?: string[]; enabled?: boolean;
      signIn?: { email?: { enabled?: boolean }; anonymous?: { enabled?: boolean } };
      error?: { status?: string; message?: string };
    };
    if (response.status === 404) return { exists: false, error: body.error?.status ?? "NOT_FOUND" };
    if (!response.ok) throw new Error(`Auth configuration ${response.status}: ${body.error?.message ?? response.statusText}`);
    return {
      exists: true, name: body.name ?? null, enabled: body.enabled ?? null,
      authorizedDomains: body.authorizedDomains ?? [], emailEnabled: body.signIn?.email?.enabled ?? false,
      anonymousEnabled: body.signIn?.anonymous?.enabled ?? false,
    };
  }
  const config = await get("config");
  const google = await get("defaultSupportedIdpConfigs/google.com");
  const usage = await inspectFirestoreUsage();
  const report = { checkedAt: new Date().toISOString(), projectId, administrativeAccount: controls.administrativeAccount, config, google, firestoreUsage: usage };
  await writeData(".data/auth-rollout/inspection.json", report);
  return report;
}

export async function configureAuthenticationDomains() {
  const before = await inspectAuthentication();
  const currentDomains = before.config.authorizedDomains;
  if (!before.config.exists || !before.google.exists || !before.google.enabled || !currentDomains) {
    throw new Error("Initialize Firebase Authentication and enable Google before setting authorized domains.");
  }
  const authorizedDomains = [...new Set([
    ...currentDomains,
    "study-az104.web.app", "study-az104.firebaseapp.com", "localhost", "127.0.0.1",
  ])];
  if (authorizedDomains.length !== currentDomains.length) {
    const { access_token } = await applicationDefault().getAccessToken();
    const response = await fetch(`https://identitytoolkit.googleapis.com/admin/v2/projects/${projectId}/config?updateMask=authorizedDomains&fields=name,authorizedDomains`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${access_token}`, "x-goog-user-project": projectId, "Content-Type": "application/json" },
      body: JSON.stringify({ authorizedDomains }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Authorized-domain update failed: HTTP ${response.status}`);
  }
  const after = await inspectAuthentication();
  if (!after.config.exists || authorizedDomains.some((domain) => !after.config.authorizedDomains?.includes(domain))) {
    throw new Error("Authorized domains were not preserved and configured correctly.");
  }
  return after;
}

if (isMain(import.meta.url)) console.log(JSON.stringify(
  process.argv[2] === "configure-domains" ? await configureAuthenticationDomains() : await inspectAuthentication(),
  null, 2,
));
