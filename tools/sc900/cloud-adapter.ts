import { randomUUID } from "node:crypto";
import { z } from "zod";
import { byteSha256 } from "./canonical.js";
import {
  CLOUD_BUCKET, CLOUD_PROJECT, EMULATOR_BUCKET, EMULATOR_PROJECT, METADATA_PATHS,
  type CloudDocument, type CloudObject, type Sc900CloudPlan,
} from "./cloud-plan.js";

export interface RemoteDocument { data: Record<string, unknown>; updateTime: string }
export interface RemoteObject {
  name: string; generation: string; size: string; contentType: string; cacheControl?: string | undefined;
  metadata?: Record<string, string> | undefined; acl?: Array<{ entity?: string | undefined }> | undefined;
  timeDeleted?: string | undefined; softDeleteTime?: string | undefined; contentSha256: string;
}
export interface Sc900CloudAdapter {
  readonly target: Sc900CloudPlan["target"];
  readonly projectId: string;
  readonly bucket: string;
  getDocument(path: string): Promise<RemoteDocument | null>;
  createDocument(operation: CloudDocument): Promise<void>;
  switchMetadata(operations: CloudDocument[], previous: Array<RemoteDocument | null>): Promise<void>;
  getObject(operation: CloudObject): Promise<RemoteObject | null>;
  createObject(operation: CloudObject, bytes: Uint8Array, uniformAccess: boolean): Promise<void>;
}

export function emulatorOrigin(host: string | undefined): string {
  if (!host || !/^(127\.0\.0\.1|localhost):[1-9]\d{0,4}$/.test(host) || Number(host.split(":")[1]) > 65535) {
    throw new Error("SC900 emulators require an explicit exact loopback host and valid port.");
  }
  return `http://${host}`;
}

type FirestoreValue =
  | { nullValue: null } | { booleanValue: boolean } | { integerValue: string } | { doubleValue: number }
  | { stringValue: string } | { arrayValue: { values: FirestoreValue[] } }
  | { mapValue: { fields: Record<string, FirestoreValue> } };
function encode(value: unknown): FirestoreValue {
  if (value === null) return { nullValue: null };
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number" && Number.isFinite(value)) {
    return Number.isSafeInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (Array.isArray(value)) {
    if (value.some(Array.isArray)) throw new Error("Nested arrays must use the SC900 JSON envelope.");
    return { arrayValue: { values: value.map(encode) } };
  }
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return { mapValue: { fields: Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, encode(entry)])) } };
  }
  throw new Error("Unsupported Firestore value.");
}
function decode(value: unknown): unknown {
  if (!value || typeof value !== "object") throw new Error("Invalid Firestore response value.");
  if ("nullValue" in value) return null;
  if ("stringValue" in value && typeof value.stringValue === "string") return value.stringValue;
  if ("booleanValue" in value && typeof value.booleanValue === "boolean") return value.booleanValue;
  if ("integerValue" in value && typeof value.integerValue === "string") {
    const number = Number(value.integerValue);
    if (Number.isSafeInteger(number)) return number;
  }
  if ("doubleValue" in value && typeof value.doubleValue === "number" && Number.isFinite(value.doubleValue)) return value.doubleValue;
  if ("arrayValue" in value) {
    const array = z.object({ values: z.array(z.unknown()).optional() }).parse(value.arrayValue);
    return (array.values ?? []).map(decode);
  }
  if ("mapValue" in value) return decodeFields(z.object({ fields: z.record(z.string(), z.unknown()).optional() }).parse(value.mapValue).fields ?? {});
  throw new Error("Unsupported Firestore response value.");
}
function decodeFields(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, decode(value)]));
}
function documentPath(path: string): void {
  if (!/^sc900ImportRuns\/[a-f0-9]{64}(?:\/(?:catalogs\/sc900|questions\/q_[a-f0-9]{64}|comments\/c_[a-f0-9]{64}|explanations\/q_[a-f0-9]{64}))?$/.test(path) &&
      !/^studyBanks\/sc900\/releases\/r_[a-f0-9]{64}\/(?:catalogs\/sc900|questions\/q_[a-f0-9]{64}|comments\/c_[a-f0-9]{64}|explanations\/q_[a-f0-9]{64})$/.test(path) &&
      !(METADATA_PATHS as readonly string[]).includes(path)) throw new Error("Out-of-scope SC900 Firestore path.");
}
function objectOperation(operation: CloudObject): void {
  if (!/^published\/sc900\/r_[a-f0-9]{64}\/assets\/[a-f0-9]{64}\.(png|jpg|gif|webp)$/.test(operation.name) ||
      !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(operation.contentType) ||
      !Number.isSafeInteger(operation.byteLength) || operation.byteLength < 1 || operation.byteLength > 8 * 1024 * 1024 ||
      !/^[a-f0-9]{64}$/.test(operation.sha256)) {
    throw new Error("Invalid SC900 Storage object scope or byte bound.");
  }
}

export async function boundedResponse(response: Response, maximum: number): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
    await response.body?.cancel();
    throw new Error("Cloud response exceeds its byte limit.");
  }
  if (!response.body) throw new Error("Cloud response has no body.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maximum) { await reader.cancel(); throw new Error("Cloud response exceeds its byte limit."); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

/** One fetch per request, no hidden SDK retries, auto-redirects, overwrite or delete API. */
export function createSc900RestAdapter(options:
  | { target: "emulator"; firestoreHost: string; storageHost: string; fetcher?: typeof fetch; signal?: AbortSignal }
  | { target: "production"; getAccessToken: () => Promise<string>; fetcher?: typeof fetch; signal?: AbortSignal }
): Sc900CloudAdapter {
  z.enum(["production", "emulator"]).parse(options.target);
  if (options.target === "production" && typeof options.getAccessToken !== "function") {
    throw new Error("Production transport requires an explicit verified credential provider.");
  }
  const production = options.target === "production";
  const projectId = production ? CLOUD_PROJECT : EMULATOR_PROJECT;
  const bucket = production ? CLOUD_BUCKET : EMULATOR_BUCKET;
  const firestore = options.target === "emulator" ? emulatorOrigin(options.firestoreHost) : "https://firestore.googleapis.com";
  const storage = options.target === "emulator" ? emulatorOrigin(options.storageHost) : "https://storage.googleapis.com";
  const fetcher = options.fetcher ?? fetch;
  const database = `projects/${projectId}/databases/(default)`;
  const request = async (url: string, init: RequestInit = {}, maximum = 2 * 1024 * 1024, missingAllowed = false) => {
    options.signal?.throwIfAborted();
    if (![firestore, storage].includes(new URL(url).origin)) throw new Error("Unexpected cloud endpoint.");
    const token = options.target === "production" ? await options.getAccessToken() : "owner";
    if (!token) throw new Error("Cloud access token unavailable.");
    const response = await fetcher(url, {
      ...init, redirect: "error", signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
      headers: { "Authorization": `Bearer ${token}`, "x-goog-user-project": projectId, ...init.headers },
    });
    if (missingAllowed && response.status === 404) { await response.body?.cancel(); return null; }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`SC900 cloud request failed (HTTP ${response.status}); no automatic retry or overwrite was attempted.`);
    }
    return boundedResponse(response, maximum);
  };
  const readJson = async (url: string, init?: RequestInit, missingAllowed = false): Promise<unknown> => {
    const bytes = await request(url, init, 2 * 1024 * 1024, missingAllowed);
    return bytes === null ? null : JSON.parse(new TextDecoder().decode(bytes));
  };
  const fields = (data: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(data).map(([key, value]) => [key, encode(value)]));
  const commit = async (writes: object[]) => {
    await readJson(`${firestore}/v1/${database}/documents:commit`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ writes }),
    });
  };
  return {
    target: options.target, projectId, bucket,
    async getDocument(path) {
      documentPath(path);
      const value = await readJson(`${firestore}/v1/${database}/documents/${path}`, undefined, true);
      if (value === null) return null;
      const document = z.object({ name: z.string(), fields: z.record(z.string(), z.unknown()), updateTime: z.iso.datetime() }).parse(value);
      if (document.name !== `${database}/documents/${path}`) throw new Error("Firestore returned a different document.");
      return { data: decodeFields(document.fields), updateTime: document.updateTime };
    },
    async createDocument(operation) {
      documentPath(operation.path);
      if ((METADATA_PATHS as readonly string[]).includes(operation.path)) throw new Error("Metadata requires an atomic compare-and-swap.");
      await commit([{ update: { name: `${database}/documents/${operation.path}`, fields: fields(operation.data) },
        currentDocument: { exists: false } }]);
    },
    async switchMetadata(operations, previous) {
      if (operations.length !== 3 || previous.length !== 3 ||
          !operations.every((operation, index) => operation.path === METADATA_PATHS[index])) {
        throw new Error("Only the complete SC900 metadata trio can be switched atomically.");
      }
      await commit(operations.map((operation, index) => ({
        update: { name: `${database}/documents/${operation.path}`, fields: fields(operation.data) },
        currentDocument: previous[index] ? { updateTime: previous[index]!.updateTime } : { exists: false },
      })));
    },
    async getObject(operation) {
      objectOperation(operation);
      const encoded = encodeURIComponent(operation.name);
      const raw = await readJson(`${storage}/storage/v1/b/${bucket}/o/${encoded}?projection=full`, undefined, true);
      if (raw === null) return null;
      const metadata = z.object({
        name: z.string(), generation: z.string().regex(/^\d+$/), size: z.string().regex(/^\d+$/), contentType: z.string(),
        cacheControl: z.string().optional(), metadata: z.record(z.string(), z.string()).optional(),
        acl: z.array(z.object({ entity: z.string().optional() }).passthrough()).optional(),
        timeDeleted: z.string().optional(), softDeleteTime: z.string().optional(),
      }).parse(raw);
      if (Number(metadata.size) !== operation.byteLength) throw new Error("Existing cloud image has a conflicting size.");
      const bytes = await request(`${storage}/storage/v1/b/${bucket}/o/${encoded}?alt=media&generation=${metadata.generation}`,
        undefined, operation.byteLength);
      if (!bytes || bytes.length !== operation.byteLength) throw new Error("Cloud image verification is incomplete.");
      return { ...metadata, contentSha256: byteSha256(bytes) };
    },
    async createObject(operation, bytes, uniformAccess) {
      objectOperation(operation);
      if (bytes.length !== operation.byteLength || byteSha256(bytes) !== operation.sha256) {
        throw new Error("Storage upload does not match its approved path and original bytes.");
      }
      const boundary = `sc900-${randomUUID()}`;
      const metadata = { name: operation.name, contentType: operation.contentType,
        cacheControl: "private,no-store", metadata: { sha256: operation.sha256 } };
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${operation.contentType}\r\n\r\n`),
        Buffer.from(bytes), Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      await readJson(`${storage}/upload/storage/v1/b/${bucket}/o?uploadType=multipart&ifGenerationMatch=0${uniformAccess ? "" : "&predefinedAcl=private"}`, {
        method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body,
      });
    },
  };
}
