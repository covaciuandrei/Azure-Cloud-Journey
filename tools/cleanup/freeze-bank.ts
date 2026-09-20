import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ApprovedCommentsSchema, CLEAN_BANK_VERSION, CleanCatalogSchema, CleanCountsSchema,
  CleanDiscussionSchema, CleanDocumentSchema, CleanManifestSchema, CleanReleaseIdSchema,
  commentIdentity, mediaExtension, type CleanDocument,
} from "../../src/domain/cleanBank.js";
import {
  CommentSchema, PreparedAnswerSchema, PreparedQuestionSchema,
  type Comment, type PreparedAnswer, type PreparedQuestion,
} from "../../src/domain/index.js";
import {
  APPROVED_RELEASE, BANK_DIRECTORY, BANK_RELEASES, assertSafeDirectory,
  hash, json, loadCleanBank, readJson, regularFiles,
} from "../web/bank.js";
import { exportSnapshot } from "../web/export.js";

function fixedOptionOrder(question: PreparedQuestion): string[] {
  const source = question.sources[0]!;
  const optionIds = question.options.map((option) => option.id);
  const order = source.sourceOptionOrder.length
    ? source.sourceOptionOrder.map((label) => source.sourceLabelToOptionId[label])
    : optionIds;
  if (order.some((id) => !id || !optionIds.includes(id)) || order.length !== optionIds.length ||
      new Set(order).size !== optionIds.length) throw new Error(`Invalid source option order on ${question.id}`);
  return order as string[];
}

export function cleanDocument(
  releaseId: string, question: PreparedQuestion, answers: PreparedAnswer, commentCount: number,
): CleanDocument {
  return CleanDocumentSchema.parse({
    schemaVersion: 1,
    releaseId,
    question: {
      schemaVersion: 1, id: question.id, sourceRevision: question.sourceRevision,
      kind: question.kind, prompt: question.prompt,
      options: question.options.map(({ id, content }) => ({ id, content })),
      shuffle: { allowed: question.shuffle.allowed },
      fixedOptionOrder: fixedOptionOrder(question),
      sourceOccurrenceIds: question.sourceOccurrenceIds,
      assetIds: question.assetIds,
      commentCount,
      readiness: { grading: question.readiness.grading },
      media: question.media,
      sources: question.sources.map(({ questionNumber, pageNumber, url }) => ({ questionNumber, pageNumber, url })),
    },
    answers: {
      schemaVersion: 1, id: answers.id, questionId: answers.questionId, sourceRevision: answers.sourceRevision,
      originalAnswers: answers.originalAnswers.map((answer) => ({
        sourceOccurrenceId: answer.sourceOccurrenceId,
        value: answer.value,
        explanation: answer.explanation,
        answerAssetIds: answer.answerAssetIds,
        provenance: { source: answer.provenance.source, url: answer.provenance.url },
      })),
      effectiveAnswer: { value: answers.effectiveAnswer.value },
      provisional: answers.assessment.provisional ||
        ["unresolved", "outdated-or-defective"].includes(answers.assessment.status),
    },
    discussionEnabled: commentCount > 0,
  });
}

export function approvedThread(
  questionId: string, legacy: Comment[], approved: ReadonlyMap<string, Comment>,
): Comment[] {
  const originals = new Map(legacy.map((comment) => [comment.id, comment]));
  const retained = legacy.filter((comment) => approved.has(commentIdentity(comment)));
  const ids = new Set(retained.map((comment) => comment.id));
  const result = retained.map((comment) => {
    const material = approved.get(commentIdentity(comment))!;
    if (JSON.stringify(comment.body) !== JSON.stringify(material.body) ||
        comment.bodyText !== material.bodyText || comment.bodyTextContent !== material.bodyTextContent) {
      throw new Error(`Approved comment content changed: ${comment.id}`);
    }
    const visited = new Set([comment.id]);
    let parentId = comment.parentId;
    while (parentId !== null && !ids.has(parentId)) {
      if (visited.has(parentId)) throw new Error(`Comment ancestry cycle: ${comment.id}`);
      visited.add(parentId);
      const parent = originals.get(parentId);
      if (!parent || parent.sourceOccurrenceId !== comment.sourceOccurrenceId) {
        throw new Error(`Invalid original comment ancestry: ${comment.id}`);
      }
      parentId = parent.parentId;
    }
    return { ...material, questionId, parentId, childIds: [] as string[], rootId: comment.id, treePath: [] as number[] };
  });
  const byId = new Map(result.map((comment) => [comment.id, comment]));
  for (const comment of result) {
    if (comment.parentId !== null) {
      const parent = byId.get(comment.parentId);
      if (!parent || parent.sourceOccurrenceId !== comment.sourceOccurrenceId) {
        throw new Error(`Invalid retained parent: ${comment.id}`);
      }
      parent.childIds.push(comment.id);
    }
  }
  const visited = new Set<string>();
  const walk = (comment: Comment, rootId: string, treePath: number[]) => {
    if (visited.has(comment.id)) throw new Error(`Comment ancestry cycle: ${comment.id}`);
    visited.add(comment.id);
    comment.rootId = rootId;
    comment.treePath = treePath;
    comment.childIds.forEach((id, index) => walk(byId.get(id)!, rootId, [...treePath, index]));
  };
  result.filter((comment) => comment.parentId === null).forEach((comment, index) => walk(comment, comment.id, [index]));
  if (visited.size !== result.length) throw new Error(`Unrooted retained thread on ${questionId}`);
  return result;
}

export async function freezeBank(workspaceRoot = process.cwd()): Promise<void> {
  const workspace = resolve(workspaceRoot);
  const destination = resolve(workspace, BANK_DIRECTORY);
  await assertSafeDirectory(workspace, BANK_DIRECTORY);
  let frozen = false;
  try {
    await readFile(resolve(destination, "data/manifest.json"));
    frozen = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (frozen) {
    await loadCleanBank(workspace);
    await exportSnapshot({ workspaceRoot: workspace });
    return;
  }
  const source = resolve(workspace, "public");
  await assertSafeDirectory(workspace, "public");
  await regularFiles(resolve(source, "data"));
  await regularFiles(resolve(source, "content"));
  const manifest = await readJson(resolve(source, "data/manifest.json")) as {
    releaseId: string; sourceRevision: string; counts: unknown;
  };
  const originalCounts = CleanCountsSchema.parse(manifest.counts);
  if (manifest.releaseId !== APPROVED_RELEASE || originalCounts.comments !== 7994 ||
      originalCounts.questions !== 604 || originalCounts.images !== 784) {
    throw new Error("Refusing to freeze a different release or comment selection");
  }
  const decisions = await readJson(resolve(workspace, ".data/comment-quality-decisions.json")) as {
    releaseId: string; decisions: Array<{ retained: boolean; id: string; sourceOccurrenceId: string }>;
  };
  if (decisions.releaseId !== manifest.releaseId) throw new Error("Approval ledger belongs to another release");
  const approval = ApprovedCommentsSchema.parse({
    bankVersion: CLEAN_BANK_VERSION,
    comments: decisions.decisions.filter((entry) => entry.retained)
      .map(({ id, sourceOccurrenceId }) => ({ id, sourceOccurrenceId }))
      .sort((a, b) => commentIdentity(a).localeCompare(commentIdentity(b))),
  });
  const allowed = new Set(approval.comments.map(commentIdentity));
  if (allowed.size !== 7994 || approval.comments.length !== 7994 ||
      new Set(approval.comments.map((comment) => comment.id)).size !== 7994) {
    throw new Error("Expected exactly 7994 approved identities");
  }
  const approved = new Map<string, Comment>();
  for (const file of await readdir(resolve(source, "content", manifest.releaseId, "discussions"))) {
    const discussion = CleanDiscussionSchema.parse(await readJson(resolve(source, "content", manifest.releaseId, "discussions", file)));
    for (const raw of discussion.comments) {
      const comment = CommentSchema.parse(raw);
      const key = commentIdentity(comment);
      if (!allowed.has(key) || approved.has(key)) throw new Error(`Unexpected current comment: ${key}`);
      approved.set(key, comment);
    }
  }
  if (approved.size !== 7994) throw new Error("Current discussions do not match the exact approved ledger");
  const stagingRelative = `${BANK_DIRECTORY}.staging-${process.pid}`;
  const staging = resolve(workspace, stagingRelative);
  await mkdir(staging, { recursive: false });
  const write = async (path: string, value: unknown) => {
    const output = resolve(staging, path);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, json(value), { flag: "wx" });
  };
  try {
    await write("data/approved-comments.json", approval);
    let currentCounts = originalCounts;
    const releases = await readdir(resolve(source, "content"));
    if (JSON.stringify(releases.sort()) !== JSON.stringify([...BANK_RELEASES].sort())) {
      throw new Error("Expected all four historical release directories before freezing");
    }
    for (const releaseId of releases.sort()) {
      CleanReleaseIdSchema.parse(releaseId);
      const base = `content/${releaseId}`;
      const catalog = await readJson(resolve(source, base, "catalog.json")) as {
        schemaVersion: 1; releaseId: string; sourceRevision: string;
        counts: typeof originalCounts;
        questions: Array<{
          id: string; number: number; commentCount: number; omittedCommentCount: number;
          preview: string; searchText: string; sourceNumbers?: number[];
        }>;
      };
      if (catalog.releaseId !== releaseId) throw new Error("Legacy release identity mismatch");
      const counts = CleanCountsSchema.parse(catalog.counts);
      const summaries = [];
      const images = new Map<string, CleanDocument["question"]["media"][number]>();
      let commentCount = 0;
      for (const entry of catalog.questions) {
        const original = await readJson(resolve(source, base, "questions", `${entry.id}.json`)) as {
          releaseId: string; question: unknown; answers: unknown;
        };
        const question = PreparedQuestionSchema.parse(original.question);
        const answers = PreparedAnswerSchema.parse(original.answers);
        if (original.releaseId !== releaseId || question.id !== entry.id) throw new Error("Legacy question identity mismatch");
        const oldDiscussion = CleanDiscussionSchema.parse(await readJson(resolve(source, base, "discussions", `${entry.id}.json`)));
        if (oldDiscussion.questionId !== entry.id || oldDiscussion.releaseId !== releaseId) throw new Error("Legacy discussion identity mismatch");
        const comments = approvedThread(entry.id, oldDiscussion.comments, approved);
        const document = cleanDocument(releaseId, question, answers, comments.length);
        await write(`${base}/questions/${entry.id}.json`, document);
        await write(`${base}/discussions/${entry.id}.json`, {
          schemaVersion: 1, releaseId, questionId: entry.id, comments,
        });
        commentCount += comments.length;
        for (const media of question.media) images.set(media.id, media);
        summaries.push({
          id: entry.id, number: entry.number, kind: question.kind,
          grading: question.readiness.grading, provisional: document.answers.provisional,
          commentCount: comments.length,
          omittedCommentCount: entry.commentCount + entry.omittedCommentCount - comments.length,
          hasImages: question.media.length > 0,
          preview: entry.preview, searchText: entry.searchText,
          ...(entry.sourceNumbers ? { sourceNumbers: entry.sourceNumbers } : {}),
          discussionEnabled: comments.length > 0,
        });
      }
      const nextCounts = {
        ...counts, comments: commentCount, omittedComments: counts.omittedComments + counts.comments - commentCount,
      };
      if (releaseId === manifest.releaseId) currentCounts = nextCounts;
      await write(`${base}/catalog.json`, CleanCatalogSchema.parse({
        schemaVersion: 1, bankVersion: CLEAN_BANK_VERSION, releaseId,
        sourceRevision: catalog.sourceRevision, counts: nextCounts, questions: summaries,
      }));
      for (const asset of images.values()) {
        const name = `${asset.id}.${mediaExtension(asset.contentType)}`;
        const bytes = await readFile(resolve(source, "content", manifest.releaseId, "media", name));
        if (bytes.length !== asset.byteLength || hash(bytes) !== asset.id) throw new Error(`Image hash mismatch: ${name}`);
        const output = resolve(staging, base, "media", name);
        await mkdir(dirname(output), { recursive: true });
        await writeFile(output, bytes, { flag: "wx" });
      }
    }
    const base = `content/${manifest.releaseId}/`;
    await write("data/manifest.json", CleanManifestSchema.parse({
      schemaVersion: 1, bankVersion: CLEAN_BANK_VERSION,
      releaseId: manifest.releaseId, sourceRevision: manifest.sourceRevision,
      approvedCommentsDigest: hash(JSON.stringify([...allowed].sort())),
      catalogUrl: `${base}catalog.json`, questionBaseUrl: `${base}questions/`,
      discussionBaseUrl: `${base}discussions/`, mediaBaseUrl: `${base}media/`, counts: currentCounts,
    }));
    await loadCleanBank(workspace, stagingRelative);
    await rename(staging, destination);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  await exportSnapshot({ workspaceRoot: workspace });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length > 2) throw new Error("freeze-bank does not accept arguments");
  freezeBank().then(() => {
    console.log("Frozen and exported 7994 approved comments, all four historical releases, and 784 image identities.");
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
