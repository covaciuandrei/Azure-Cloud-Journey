export const UPLOAD_PROJECT_ID = "study-az104";
export const UPLOAD_PROJECT_NUMBER = "237261733668";
export const DEFAULT_DAILY_WRITE_BUDGET = 18_000;
export const DEFAULT_RUN_WRITE_LIMIT = 18_000;

export type UploadMode = "stage" | "publish";
export type PlanStatus = "planned" | "blocked";

export interface DocumentOperation {
  kind: "document";
  phase: "stage" | "comments" | "publication" | "catalog";
  path: string;
  sourcePath?: string;
  data?: unknown;
  contentHash: string;
  byteLength: number;
  questionId?: string;
}

export interface ObjectOperation {
  kind: "object";
  phase: "media" | "archive";
  path: string;
  sourcePath: string;
  sha256: string;
  byteLength: number;
  contentType: string;
  questionIds: string[];
}

export interface UploadPlan {
  schemaVersion: 1;
  projectId: typeof UPLOAD_PROJECT_ID;
  mode: UploadMode;
  status: PlanStatus;
  importId: string;
  releaseId: string | null;
  sourceRevision: string;
  createdAt: string;
  blockers: string[];
  warnings: string[];
  documents: DocumentOperation[];
  objects: ObjectOperation[];
  counts: {
    documents: number;
    objects: number;
    objectBytes: number;
    questions: number;
    answers: number;
    comments: number;
    occurrences: number;
    assets: number;
  };
}

export interface RemoteDocument {
  exists: boolean;
  data?: unknown;
}

export interface RemoteObject {
  exists: boolean;
  sha256?: string;
  byteLength?: number;
  contentType?: string;
  hasDownloadTokens?: boolean;
  anonymousAcl?: boolean;
}

export interface UploadAdapter {
  getDocument(path: string): Promise<RemoteDocument>;
  getDocuments?(paths: string[]): Promise<RemoteDocument[]>;
  createDocuments(operations: DocumentOperation[]): Promise<number>;
  getObject(path: string): Promise<RemoteObject>;
  createObject(operation: ObjectOperation, bytes: Uint8Array): Promise<boolean>;
}

export interface WriteBudget {
  readonly day: string;
  readonly dailyLimit: number;
  readonly runLimit: number;
  readonly usedBeforeRun: number;
  readonly reservedThisRun: number;
  readonly pauseReason: "run-limit" | "daily-limit" | "day-rollover" | null;
  remaining(): number;
  reserve(count: number): Promise<boolean>;
}

export interface ExecutionReport {
  projectId: typeof UPLOAD_PROJECT_ID;
  mode: UploadMode;
  status: "staged" | "published" | "paused" | "blocked";
  importId: string;
  releaseId: string | null;
  documents: { created: number; unchanged: number; remaining: number };
  objects: { created: number; unchanged: number; remaining: number; bytesCreated: number };
  writeBudget: {
    pacificDay: string;
    dailyLimit: number;
    runLimit: number;
    usedBeforeRun: number;
    reservedThisRun: number;
    remaining: number;
    pauseReason: WriteBudget["pauseReason"];
  };
  blockers: string[];
  resume: string | null;
}
