import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import {
  ApprovedCommentsSchema, assertDiscussionThreads, CleanCatalogSchema, CleanDiscussionSchema,
  CleanDocumentSchema, CleanManifestSchema, CleanReleaseIdSchema, commentIdentity, mediaExtension,
  type CleanCatalog, type CleanDiscussion, type CleanDocument, type CleanManifest,
} from "../../src/domain/cleanBank.js";

export const BANK_DIRECTORY = ".data/clean-bank";
export const APPROVED_RELEASE = "r_b7f94b0d9dd9319c1d661c638cd9786be97dc83cb204871357c79639bb9fb5f2";
export const BANK_RELEASES = [
  "r_61ae993f4534c2d7b370d43a31ccc51c025bac080f0459df307f4d3ecaa7f296",
  "r_9aaa4444ba3d7256be593d30c5d42f9037474fc87eabfe9b7cd7b66169fef962",
  "r_a9395133bc8c09b325679031232f0e6a2cfa3c5a079410de465f9fec48f66d81",
  APPROVED_RELEASE,
] as const;
export const hash = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
export const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

export function childPath(root: string, path: string): string {
  const result = resolve(root, path);
  const local = relative(root, result);
  if (!local || local === ".." || local.startsWith(`..${sep}`)) throw new Error(`Unsafe child path: ${path}`);
  return result;
}

export async function assertSafeDirectory(workspace: string, directory: string): Promise<void> {
  const target = childPath(workspace, directory);
  let current = workspace;
  for (const segment of relative(workspace, target).split(sep)) {
    current = resolve(current, segment);
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Unsafe directory: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export async function regularFiles(root: string): Promise<string[]> {
  if (!(await lstat(root)).isDirectory() || (await lstat(root)).isSymbolicLink()) {
    throw new Error(`Not a regular directory: ${root}`);
  }
  const result: string[] = [];
  const walk = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Symlink not allowed: ${path}`);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) result.push(relative(root, path));
      else throw new Error(`Not a regular file: ${path}`);
    }
  };
  await walk(root);
  return result.sort();
}

export async function readJson(path: string): Promise<unknown> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Not a regular JSON file: ${path}`);
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

export interface CleanRelease {
  catalog: CleanCatalog;
  documents: CleanDocument[];
  discussions: CleanDiscussion[];
}
export interface CleanBank {
  directory: string;
  manifest: CleanManifest;
  releases: CleanRelease[];
  files: string[];
}

function imagesIn(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((item) => imagesIn(item, found));
  else if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    if (object.type === "image" && typeof object.assetId === "string") found.add(object.assetId);
    for (const child of Object.values(object)) imagesIn(child, found);
  }
  return found;
}

export async function loadCleanBank(workspaceRoot = process.cwd(), directory = BANK_DIRECTORY): Promise<CleanBank> {
  const workspace = resolve(workspaceRoot);
  await assertSafeDirectory(workspace, directory);
  const root = childPath(workspace, directory);
  const files = await regularFiles(root);
  const expected = new Set(["data/manifest.json", "data/approved-comments.json"]);
  const manifest = CleanManifestSchema.parse(await readJson(resolve(root, "data/manifest.json")));
  if (manifest.releaseId !== APPROVED_RELEASE || manifest.counts.questions !== 604 ||
      manifest.counts.comments !== 7994 || manifest.counts.images !== 784 ||
      manifest.counts.automatic !== 396 || manifest.counts.manual !== 208) {
    throw new Error("Frozen bank does not match the approved release/counts");
  }
  const approval = ApprovedCommentsSchema.parse(await readJson(resolve(root, "data/approved-comments.json")));
  const approved = new Set(approval.comments.map(commentIdentity));
  if (approved.size !== 7994 || approval.comments.length !== 7994 ||
      new Set(approval.comments.map((comment) => comment.id)).size !== 7994 ||
      manifest.approvedCommentsDigest !== hash(JSON.stringify([...approved].sort()))) {
    throw new Error("Frozen approval identities/digest do not reconcile");
  }
  const releases: CleanRelease[] = [];
  const releaseNames = await readdir(resolve(root, "content"));
  if (JSON.stringify(releaseNames.sort()) !== JSON.stringify([...BANK_RELEASES].sort())) {
    throw new Error("Frozen bank must preserve all four historical releases");
  }
  const canonicalComments = new Map<string, string>();
  for (const releaseId of [manifest.releaseId, ...releaseNames.filter((id) => id !== manifest.releaseId).sort()]) {
    CleanReleaseIdSchema.parse(releaseId);
    const base = `content/${releaseId}`;
    const catalog = CleanCatalogSchema.parse(await readJson(resolve(root, base, "catalog.json")));
    expected.add(`${base}/catalog.json`);
    if (catalog.releaseId !== releaseId || catalog.questions.length !== catalog.counts.questions ||
        new Set(catalog.questions.map((question) => question.id)).size !== catalog.questions.length ||
        catalog.questions.reduce((sum, question) => sum + question.commentCount, 0) !== catalog.counts.comments ||
        catalog.questions.filter((question) => question.grading === "automatic").length !== catalog.counts.automatic) {
      throw new Error(`Invalid catalog counts or IDs: ${releaseId}`);
    }
    if (releaseId === manifest.releaseId && (catalog.sourceRevision !== manifest.sourceRevision ||
        JSON.stringify(catalog.counts) !== JSON.stringify(manifest.counts))) {
      throw new Error("Current catalog does not match the frozen manifest");
    }
    const sources = catalog.questions.flatMap((summary) => summary.sourceNumbers ?? [summary.number]);
    if (sources.length !== 606 || new Set(sources).size !== 606 ||
        sources.some((number) => number < 1 || number > 606)) {
      throw new Error(`Missing/duplicate source aliases: ${releaseId}`);
    }
    const seen = new Set<string>();
    const media = new Map<string, CleanDocument["question"]["media"][number]>();
    const documents: CleanDocument[] = [];
    const discussions: CleanDiscussion[] = [];
    for (const summary of catalog.questions) {
      const documentPath = `${base}/questions/${summary.id}.json`;
      const discussionPath = `${base}/discussions/${summary.id}.json`;
      expected.add(documentPath);
      expected.add(discussionPath);
      const document = CleanDocumentSchema.parse(await readJson(resolve(root, documentPath)));
      const discussion = CleanDiscussionSchema.parse(await readJson(resolve(root, discussionPath)));
      const numbers = document.question.sources.map((source) => source.questionNumber).sort((a, b) => a - b);
      if (document.releaseId !== releaseId || document.question.id !== summary.id ||
          document.question.commentCount !== summary.commentCount ||
          document.question.readiness.grading !== summary.grading || document.question.kind !== summary.kind ||
          document.answers.provisional !== summary.provisional ||
          summary.discussionEnabled !== document.discussionEnabled ||
          summary.hasImages !== (document.question.media.length > 0) || !numbers.includes(summary.number) ||
          JSON.stringify(numbers) !== JSON.stringify([...(summary.sourceNumbers ?? [summary.number])].sort((a, b) => a - b)) ||
          discussion.releaseId !== releaseId || discussion.questionId !== summary.id ||
          discussion.comments.length !== summary.commentCount) {
        throw new Error(`Catalog/document/discussion mismatch: ${releaseId}/${summary.id}`);
      }
      assertDiscussionThreads(discussion);
      for (const comment of discussion.comments) {
        const key = commentIdentity(comment);
        if (!approved.has(key) || seen.has(key) ||
            !document.question.sourceOccurrenceIds.includes(comment.sourceOccurrenceId)) {
          throw new Error(`Unapproved/duplicate/misplaced comment: ${key}`);
        }
        seen.add(key);
        const { questionId: _questionId, parentId: _parentId, rootId: _rootId,
          childIds: _childIds, treePath: _treePath, ...material } = comment;
        const serialized = JSON.stringify(material);
        if (releaseId === manifest.releaseId) canonicalComments.set(key, serialized);
        else if (canonicalComments.get(key) !== serialized) {
          throw new Error(`Legacy comment content differs from the frozen approved record: ${key}`);
        }
      }
      const knownMedia = new Set(document.question.media.map((asset) => asset.id));
      const required = imagesIn([document, discussion]);
      for (const id of [
        ...document.question.assetIds, ...required,
        ...document.answers.originalAnswers.flatMap((answer) => answer.answerAssetIds),
        ...[document.answers.effectiveAnswer.value, ...document.answers.originalAnswers.map((answer) => answer.value)]
          .flatMap((value) => value.kind === "manual" ? value.sourceAnswerAssetIds : []),
      ]) {
        if (!knownMedia.has(id)) throw new Error(`Missing referenced image ${id} on ${summary.id}`);
      }
      for (const asset of document.question.media) {
        const previous = media.get(asset.id);
        if (previous && (previous.contentType !== asset.contentType || previous.byteLength !== asset.byteLength ||
            previous.width !== asset.width || previous.height !== asset.height)) {
          throw new Error(`Conflicting image metadata: ${asset.id}`);
        }
        media.set(asset.id, asset);
      }
      documents.push(document);
      discussions.push(discussion);
    }
    if (seen.size !== approved.size || [...approved].some((key) => !seen.has(key)) ||
        seen.size !== catalog.counts.comments || media.size !== catalog.counts.images) {
      throw new Error(`Release is missing approved comments/images: ${releaseId}`);
    }
    for (const asset of media.values()) {
      const path = `${base}/media/${asset.id}.${mediaExtension(asset.contentType)}`;
      expected.add(path);
      const bytes = await readFile(resolve(root, path));
      if (bytes.length !== asset.byteLength || hash(bytes) !== asset.id) {
        throw new Error(`Image failed hash/length verification: ${path}`);
      }
    }
    releases.push({ catalog, documents, discussions });
  }
  if (files.length !== expected.size || files.some((path) => !expected.has(path))) {
    throw new Error("Frozen bank contains unexpected files or is incomplete");
  }
  return { directory: root, manifest, releases, files };
}
