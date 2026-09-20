import { applicationDefault } from "firebase-admin/app";
import { UPLOAD_PROJECT_ID, UPLOAD_PROJECT_NUMBER } from "./types.js";

interface JsonResponse {
  ok: boolean;
  status: number;
  statusText: string;
  json(): Promise<unknown>;
}

interface BucketPrivacyDependencies {
  getAccessToken?: () => Promise<string>;
  fetch?: (url: string, init: RequestInit) => Promise<JsonResponse>;
}

interface ApiError {
  error?: { message?: string };
}

interface BucketMetadata {
  name?: string;
  projectNumber?: string;
  iamConfiguration?: {
    uniformBucketLevelAccess?: { enabled?: boolean };
    publicAccessPrevention?: string;
  };
}

interface IamPolicy {
  bindings?: Array<{ role?: string; members?: string[] }>;
}

interface DefaultObjectAcl {
  items?: Array<{ entity?: string; role?: string }>;
  nextPageToken?: string;
}

function anonymousPrincipal(value: string | undefined): boolean {
  return value === "allUsers" || value === "allAuthenticatedUsers";
}

export interface BucketPrivacyReport {
  bucketName: string;
  safeForPrivateUploads: boolean;
  uniformBucketLevelAccess: boolean;
  publicAccessPrevention: string | null;
  anonymousIamBindings: Array<{ role: string; member: string }>;
  anonymousDefaultObjectAcls: Array<{ role: string; entity: string }>;
}

export async function inspectBucketPrivacy(
  bucketName: string,
  dependencies: BucketPrivacyDependencies = {},
): Promise<BucketPrivacyReport> {
  if (!/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(bucketName)) {
    throw new Error("Cloud preflight returned an invalid default bucket name.");
  }
  const token = await (dependencies.getAccessToken ?? (async () => {
    const result = await applicationDefault().getAccessToken();
    return result.access_token;
  }))();
  if (!token) throw new Error("Could not obtain credentials for the bucket privacy check.");
  const request = dependencies.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));
  const headers = {
    Authorization: `Bearer ${token}`,
    "x-goog-user-project": UPLOAD_PROJECT_ID,
  };
  const encoded = encodeURIComponent(bucketName);
  const read = async <T>(url: string): Promise<T> => {
    const response = await request(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.json() as T & ApiError;
    if (!response.ok) {
      throw new Error(
        `Bucket privacy check failed (${response.status}): ` +
        `${body.error?.message ?? response.statusText}`,
      );
    }
    return body;
  };

  const metadata = await read<BucketMetadata>(
    `https://storage.googleapis.com/storage/v1/b/${encoded}` +
    "?fields=name,projectNumber,iamConfiguration",
  );
  if (metadata.name !== bucketName || metadata.projectNumber !== UPLOAD_PROJECT_NUMBER) {
    throw new Error("Bucket privacy metadata did not identify the verified project default bucket.");
  }
  const iam = await read<IamPolicy>(
    `https://storage.googleapis.com/storage/v1/b/${encoded}/iam`,
  );
  const anonymousIamBindings = (iam.bindings ?? []).flatMap((binding) =>
    (binding.members ?? []).filter(anonymousPrincipal).map((member) => ({
      role: binding.role ?? "unknown",
      member,
    })));
  const uniformBucketLevelAccess =
    metadata.iamConfiguration?.uniformBucketLevelAccess?.enabled === true;
  const anonymousDefaultObjectAcls: Array<{ role: string; entity: string }> = [];
  if (!uniformBucketLevelAccess) {
    let pageToken = "";
    do {
      const acl = await read<DefaultObjectAcl>(
        `https://storage.googleapis.com/storage/v1/b/${encoded}/defaultObjectAcl` +
        `?maxResults=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`,
      );
      for (const item of acl.items ?? []) {
        if (anonymousPrincipal(item.entity)) {
          anonymousDefaultObjectAcls.push({
            role: item.role ?? "unknown",
            entity: item.entity ?? "unknown",
          });
        }
      }
      pageToken = acl.nextPageToken ?? "";
    } while (pageToken);
  }
  return {
    bucketName,
    safeForPrivateUploads:
      anonymousIamBindings.length === 0 && anonymousDefaultObjectAcls.length === 0,
    uniformBucketLevelAccess,
    publicAccessPrevention:
      metadata.iamConfiguration?.publicAccessPrevention ?? null,
    anonymousIamBindings,
    anonymousDefaultObjectAcls,
  };
}
