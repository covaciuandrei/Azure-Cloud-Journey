import { applicationDefault, getApps, initializeApp, type App } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { canonicalJson } from "../ingest/normalize-shared.js";
import type { BucketPrivacyReport } from "./bucket-privacy.js";
import {
  UPLOAD_PROJECT_ID,
  type DocumentOperation,
  type ObjectOperation,
  type UploadAdapter,
} from "./types.js";

function uploadApp(bucketName?: string): App {
  const existing = getApps().find((app) => app.name === "az104-data-upload");
  if (existing && existing.options.projectId !== UPLOAD_PROJECT_ID) {
    throw new Error("The existing upload Admin app targets an unapproved Firebase project.");
  }
  return existing ?? initializeApp({
    credential: applicationDefault(),
    projectId: UPLOAD_PROJECT_ID,
    ...(bucketName ? { storageBucket: bucketName } : {}),
  }, "az104-data-upload");
}

function alreadyExists(error: unknown): boolean {
  if (error === null || typeof error !== "object" || !("code" in error)) return false;
  const code = String(error.code).toLowerCase();
  return code === "6" || code === "already-exists" || code === "already_exists";
}

export function createFirestoreDocumentAdapter(
  app = uploadApp(),
): Pick<UploadAdapter, "getDocument" | "getDocuments" | "createDocuments"> {
  if (app.options.projectId !== UPLOAD_PROJECT_ID) {
    throw new Error("The Firestore staging Admin app targets an unapproved Firebase project.");
  }
  const firestore = getFirestore(app);
  return {
    async getDocument(path) {
      const snapshot = await firestore.doc(path).get();
      return snapshot.exists ? { exists: true, data: snapshot.data() } : { exists: false };
    },
    async getDocuments(paths) {
      if (paths.length === 0) return [];
      const snapshots = await firestore.getAll(...paths.map((path) => firestore.doc(path)));
      return snapshots.map((snapshot) =>
        snapshot.exists ? { exists: true, data: snapshot.data() } : { exists: false });
    },
    async createDocuments(operations: DocumentOperation[]) {
      if (operations.length === 0) return 0;
      const commitCreates = async (items: DocumentOperation[]) => {
        const batch = firestore.batch();
        for (const operation of items) {
          batch.create(firestore.doc(operation.path), operation.data);
        }
        await batch.commit();
      };
      try {
        await commitCreates(operations);
        return operations.length;
      } catch (error) {
        if (!alreadyExists(error)) throw error;
        const references = operations.map((operation) => firestore.doc(operation.path));
        const snapshots = await firestore.getAll(...references);
        const remaining: DocumentOperation[] = [];
        for (let index = 0; index < operations.length; index++) {
          const operation = operations[index];
          const snapshot = snapshots[index];
          if (!operation || !snapshot) throw new Error("Invalid create-only operation group.");
          if (!snapshot.exists) {
            remaining.push(operation);
          } else if (canonicalJson(snapshot.data()) !== canonicalJson(operation.data)) {
            throw new Error(`${operation.path}: concurrent remote document conflict.`);
          }
        }
        if (remaining.length === 0) return 0;
        await commitCreates(remaining);
        return remaining.length;
      }
    },
  };
}

export function createFirebaseUploadAdapter(
  bucketName: string,
  privacy: BucketPrivacyReport,
): UploadAdapter {
  if (!bucketName) throw new Error("Verified default bucket name is required.");
  if (privacy.bucketName !== bucketName || !privacy.safeForPrivateUploads) {
    throw new Error("A verified private bucket report is required.");
  }
  const app = uploadApp(bucketName);
  const bucket = getStorage(app).bucket(bucketName);
  return {
    ...createFirestoreDocumentAdapter(app),
    async getObject(path) {
      const file = bucket.file(path);
      const [exists] = await file.exists();
      if (!exists) return { exists: false };
      const [metadata] = await file.getMetadata();
      const customMetadata = metadata.metadata;
      const downloadTokens = customMetadata?.firebaseStorageDownloadTokens;
      let anonymousAcl = false;
      if (!privacy.uniformBucketLevelAccess) {
        const [acl] = await file.acl.get();
        const entries = Array.isArray(acl) ? acl : [acl];
        anonymousAcl = entries.some((entry) =>
          entry.entity === "allUsers" || entry.entity === "allAuthenticatedUsers");
      }
      const byteLength = Number(metadata.size);
      return {
        exists: true,
        ...(metadata.metadata?.sha256 ? { sha256: String(metadata.metadata.sha256) } : {}),
        ...(Number.isSafeInteger(byteLength) ? { byteLength } : {}),
        ...(metadata.contentType ? { contentType: metadata.contentType } : {}),
        hasDownloadTokens:
          typeof downloadTokens === "string" ? downloadTokens.length > 0 : downloadTokens !== undefined,
        anonymousAcl,
      };
    },
    async createObject(operation: ObjectOperation, bytes: Uint8Array) {
      const file = bucket.file(operation.path);
      try {
        await file.save(Buffer.from(bytes), {
          resumable: false,
          preconditionOpts: { ifGenerationMatch: 0 },
          metadata: {
            contentType: operation.contentType,
            cacheControl: operation.phase === "media" && operation.path.startsWith("published/")
              ? "public,max-age=31536000,immutable"
              : "private,no-store",
            metadata: { sha256: operation.sha256 },
          },
          ...(!privacy.uniformBucketLevelAccess ? { predefinedAcl: "private" } : {}),
        });
        return true;
      } catch (error) {
        const code = error !== null && typeof error === "object" && "code" in error
          ? String(error.code)
          : "";
        if (code === "412") {
          const remote = await this.getObject(operation.path);
          if (remote.sha256 === operation.sha256 &&
              remote.byteLength === operation.byteLength &&
              remote.contentType === operation.contentType) return false;
        }
        throw error;
      }
    },
  };
}
