import { access, readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { applicationDefault } from "firebase-admin/app";

export const projectId = "study-az104";
export const projectNumber = "237261733668";
export function approvedAdministrativeAccount(environment: NodeJS.ProcessEnv = process.env): string {
  const email = environment.AZURE_CLOUD_JOURNEY_ADMIN_EMAIL?.trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("Set AZURE_CLOUD_JOURNEY_ADMIN_EMAIL to the explicitly approved Firebase administrator.");
  }
  return email;
}

interface Project {
  projectNumber?: string;
  projectId?: string;
}

interface BillingInfo {
  billingEnabled?: boolean;
  billingAccountName?: string;
}

interface Database {
  name: string;
  locationId: string;
  type: string;
  databaseEdition: string;
  freeTier?: boolean;
  pointInTimeRecoveryEnablement: string;
  deleteProtectionState: string;
}

interface DefaultBucket {
  location: string;
  bucket?: { name: string };
}

interface Budget {
  name: string;
  budgetFilter?: {
    projects?: string[];
    calendarPeriod?: string;
    services?: string[];
    subaccounts?: string[];
    resourceAncestors?: string[];
    labels?: Record<string, string[]>;
    creditTypes?: string[];
    creditTypesTreatment?: string;
  };
  amount?: { specifiedAmount?: { currencyCode?: string; units?: string; nanos?: number } };
  thresholdRules?: Array<{ thresholdPercent?: number; spendBasis?: string }>;
  notificationsRule?: {
    disableDefaultIamRecipients?: boolean;
    enableProjectLevelRecipients?: boolean;
  };
}

export function matchesProjectBudget(budget: Budget): boolean {
  const filter = budget.budgetFilter;
  const amount = budget.amount?.specifiedAmount;
  const thresholds = budget.thresholdRules;
  const notifications = budget.notificationsRule;
  return filter?.projects?.length === 1 &&
    filter.projects[0] === `projects/${projectNumber}` &&
    filter.calendarPeriod === "MONTH" &&
    !filter.services?.length &&
    !filter.subaccounts?.length &&
    !filter.resourceAncestors?.length &&
    Object.keys(filter.labels ?? {}).length === 0 &&
    !filter.creditTypes?.length &&
    (!filter.creditTypesTreatment || filter.creditTypesTreatment === "INCLUDE_ALL_CREDITS") &&
    amount?.currencyCode === "USD" && amount.units === "1" && !amount.nanos &&
    thresholds?.length === 3 &&
    [0.5, 0.9, 1].every((percent) => thresholds.some((rule) =>
      rule.thresholdPercent === percent && rule.spendBasis === "CURRENT_SPEND")) &&
    notifications?.disableDefaultIamRecipients !== true &&
    notifications?.enableProjectLevelRecipients === true;
}

export async function inspectFirebaseControls() {
  const administrativeAccount = approvedAdministrativeAccount();
  const credentialPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!credentialPath || !isAbsolute(credentialPath)) {
    throw new Error("Set GOOGLE_APPLICATION_CREDENTIALS to the isolated user OAuth ADC file.");
  }
  await access(credentialPath);
  if (process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_STORAGE_EMULATOR_HOST) {
    throw new Error("Cloud preflight must not run with emulator environment variables.");
  }

  const { access_token: token } = await applicationDefault().getAccessToken();
  const authorization = { Authorization: `Bearer ${token}` };
  const identityResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: authorization,
    signal: AbortSignal.timeout(30_000),
  });
  const identity = await identityResponse.json() as { email?: string; email_verified?: boolean };
  if (
    !identityResponse.ok ||
    identity.email !== administrativeAccount ||
    identity.email_verified !== true
  ) {
    throw new Error("The ADC identity is not the approved study account.");
  }

  const blockers: string[] = [];
  async function read<T>(url: string): Promise<T | undefined> {
    const response = await fetch(url, {
      headers: { ...authorization, "x-goog-user-project": projectId },
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.json() as T & { error?: { message?: string } };
    if (response.status === 404) return undefined;
    if (!response.ok) {
      throw new Error(`Google API ${response.status}: ${body.error?.message ?? response.statusText}`);
    }
    return body;
  }

  async function rulesMatch(releaseId: string, localFile: string) {
    const release = await read<{ name: string; rulesetName: string }>(
      `https://firebaserules.googleapis.com/v1/projects/${projectId}/releases/${releaseId}`,
    );
    if (!release) return { deployed: false, matchesLocal: false };
    const ruleset = await read<{ source?: { files?: Array<{ name: string; content: string }> } }>(
      `https://firebaserules.googleapis.com/v1/${release.rulesetName}`,
    );
    const source = await readFile(new URL(`../../${localFile}`, import.meta.url), "utf8");
    const files = ruleset?.source?.files;
    return {
      deployed: true,
      matchesLocal: files?.length === 1 && files[0]?.content === source,
      releaseName: release.name,
      rulesetName: release.rulesetName,
    };
  }

  const project = await read<Project>(`https://firebase.googleapis.com/v1beta1/projects/${projectId}`);
  if (project?.projectNumber !== projectNumber || project.projectId !== projectId) {
    throw new Error("The Firebase project identity does not match the approved project.");
  }
  const billing = await read<BillingInfo>(
    `https://cloudbilling.googleapis.com/v1/projects/${projectId}/billingInfo`,
  );
  if (billing?.billingEnabled !== true || !billing.billingAccountName) {
    blockers.push("The project has no enabled, linked billing account.");
  }
  const database = await read<Database>(
    `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)`,
  );
  if (!database || database.type !== "FIRESTORE_NATIVE") {
    blockers.push("The default Firestore Native database is missing.");
  }
  const firestoreRules = await rulesMatch("cloud.firestore", "firestore.rules");
  if (!firestoreRules.matchesLocal) blockers.push("The deployed Firestore rules do not match.");

  const defaultBucket = await read<DefaultBucket>(
    `https://firebasestorage.googleapis.com/v1beta/projects/${projectId}/defaultBucket`,
  );
  const bucketName = defaultBucket?.bucket?.name.split("/").at(-1);
  const storageRules = bucketName
    ? await rulesMatch(`firebase.storage/${bucketName}`, "storage.rules")
    : { deployed: false, matchesLocal: false };
  if (!bucketName) blockers.push("The default Firebase Storage bucket is missing.");
  if (!storageRules.matchesLocal) blockers.push("The Storage rules have not been verified deployed.");

  let matchingBudget: Budget | undefined;
  if (billing?.billingEnabled === true && billing.billingAccountName) {
    let pageToken = "";
    do {
      const result = await read<{ budgets?: Budget[]; nextPageToken?: string }>(
        `https://billingbudgets.googleapis.com/v1/${billing.billingAccountName}/budgets?pageSize=100` +
        (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""),
      );
      matchingBudget ??= result?.budgets?.find(matchesProjectBudget);
      pageToken = result?.nextPageToken ?? "";
    } while (pageToken && !matchingBudget);
  }
  if (!matchingBudget) {
    blockers.push(
      "A verified project-only $1 USD monthly budget with 50%, 90%, and 100% current-spend " +
      "alerts and billing/project recipient notifications is required on the linked account.",
    );
  }

  return {
    checkedAt: new Date().toISOString(),
    projectId,
    projectNumber,
    administrativeAccount,
    cloudControlsReady: blockers.length === 0,
    blockers,
    billing: {
      enabled: billing?.billingEnabled === true,
      accountName: billing?.billingAccountName || null,
    },
    firestore: {
      name: database?.name ?? null,
      location: database?.locationId ?? null,
      type: database?.type ?? null,
      edition: database?.databaseEdition ?? null,
      freeTier: database?.freeTier ?? null,
      pointInTimeRecovery: database?.pointInTimeRecoveryEnablement ?? null,
      deleteProtection: database?.deleteProtectionState ?? null,
      rules: firestoreRules,
    },
    storage: {
      bucketName: bucketName ?? null,
      location: defaultBucket?.location ?? null,
      rules: storageRules,
    },
    budget: {
      name: matchingBudget?.name ?? null,
      verified: Boolean(matchingBudget),
      isHardSpendingCap: false,
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await inspectFirebaseControls();
    console.log(JSON.stringify(result, null, 2));
    if (!result.cloudControlsReady) process.exitCode = 2;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Firebase preflight failed.");
    process.exitCode = 1;
  }
}
