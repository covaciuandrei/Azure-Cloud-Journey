import { applicationDefault } from "firebase-admin/app";
import { readFile } from "node:fs/promises";
import { inspectFirebaseControls, projectId } from "./preflight.js";
import { isMain, writeData } from "../review/data.js";
import { inspectFirestoreUsage } from "../publish/usage.js";
import { acquireUploadLock } from "../publish/quota.js";

export async function deployAccountRules(apply: boolean, feature: "accounts" | "topics" | "learning" = "accounts") {
  const unlock = await acquireUploadLock(process.cwd());
  try {
    const before = await inspectFirebaseControls();
    const unexpected = before.blockers.filter((item) => item !== "The deployed Firestore rules do not match.");
    if (unexpected.length) throw new Error(`Cloud controls block the rules update: ${unexpected.join("; ")}`);
    const usage = await inspectFirestoreUsage();
    if (usage.reads >= 45_000 || usage.writes >= 18_000 || usage.deletes >= 18_000) {
      throw new Error("Quota pause: the project has reached a conservative daily threshold.");
    }
    const content = await readFile("firestore.rules", "utf8");
    if (!apply || before.firestore.rules.matchesLocal) {
      return { status: apply ? "already-current" : "planned", projectId, sourceDataOperations: 0 };
    }
    const { access_token } = await applicationDefault().getAccessToken();
    async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
      const response = await fetch(`https://firebaserules.googleapis.com/v1/projects/${projectId}/${path}`, {
        method,
        headers: { Authorization: `Bearer ${access_token}`, "x-goog-user-project": projectId, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      });
      const result = await response.json() as T & { error?: { message?: string } };
      if (!response.ok) throw new Error(`Rules deployment failed: HTTP ${response.status} ${result.error?.message ?? ""}`);
      return result;
    }
    const release = await request<{ name: string; rulesetName: string }>("releases/cloud.firestore");
    if (release.rulesetName !== before.firestore.rules.rulesetName) throw new Error("Firestore rules changed after preflight.");
    const ruleset = await request<{ name: string }>("rulesets", "POST", {
      source: { files: [{ name: "firestore.rules", content }] },
    });
    if (!ruleset.name.startsWith(`projects/${projectId}/rulesets/`)) throw new Error("Unexpected ruleset project.");
    const current = await request<{ rulesetName: string }>("releases/cloud.firestore");
    if (current.rulesetName !== release.rulesetName) throw new Error("Firestore rules changed concurrently; release preserved.");
    await request("releases/cloud.firestore", "PATCH", {
      release: { name: release.name, rulesetName: ruleset.name },
      updateMask: "rulesetName",
    });
    const after = await inspectFirebaseControls();
    if (!after.cloudControlsReady || !after.firestore.rules.matchesLocal) throw new Error("Deployed rules did not match the intended source.");
    const report = {
      status: "deployed", projectId, checkedAt: new Date().toISOString(),
      previousRuleset: release.rulesetName, ruleset: ruleset.name, sourceDataOperations: 0,
      capabilities: ["verified-user read-only study bank", "UID-isolated checkpoints and history", "bounded history and discussion queries"],
    };
    const directory = feature === "learning" ? ".data/learning/rollout" : feature === "topics" ? ".data/topics" : ".data/auth-rollout";
    await writeData(`${directory}/rules-deployment.json`, report);
    return report;
  } finally { await unlock(); }
}

if (isMain(import.meta.url)) {
  if (process.argv[2] !== "rules" || process.argv.slice(3).some((arg) => !["--apply", "--topics", "--learning"].includes(arg))) {
    throw new Error("Usage: deploy-auth.ts rules [--apply] [--topics | --learning]");
  }
  if (process.argv.includes("--topics") && process.argv.includes("--learning")) throw new Error("Choose one release feature.");
  console.log(JSON.stringify(await deployAccountRules(process.argv.includes("--apply"),
    process.argv.includes("--learning") ? "learning" : process.argv.includes("--topics") ? "topics" : "accounts"), null, 2));
}
