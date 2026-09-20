import { z } from "zod";
import {
  assertDiscussionThreads,
  CleanCatalogSchema as CatalogSchema,
  CleanDiscussionSchema as DiscussionSchema,
  CleanDocumentSchema as DocumentSchema,
  CleanManifestSchema as ManifestSchema,
  CleanQuestionSchema,
  mediaExtension,
} from "../domain/cleanBank.js";
import type {
  StudyCatalog,
  StudyDiscussion,
  StudyDocument,
  StudyManifest,
  StudyRepository,
} from "./types.js";

const releaseId = z.string().regex(/^r_[a-f0-9]{64}$/);
const questionId = z.string().regex(/^q_[a-f0-9]{64}$/);
const relativePath = z.string().min(1).refine((value) =>
  !value.startsWith("/") && !value.includes("\\") && !value.includes("?") &&
  !value.includes("#") && value.split("/").every((part) =>
    part !== "" && part !== "." && part !== ".."), "Unsafe relative data path");

function normalizedBase(value: string): URL {
  let base: URL;
  try {
    base = new URL(value);
  } catch {
    throw new Error(`Invalid study data base URL: ${value}`);
  }
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password ||
      base.search || base.hash) {
    throw new Error("Study data base URL must be an HTTP(S) URL without credentials, query, or hash");
  }
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  return base;
}

export function createStudyRepository(
  baseUrl: string,
  fetcher: typeof fetch = fetch,
): StudyRepository {
  const base = normalizedBase(baseUrl);
  const basePath = base.pathname;
  let manifestValue: StudyManifest | undefined;
  let manifestPromise: Promise<StudyManifest> | undefined;
  const catalogs = new Map<string, StudyCatalog>();
  const catalogPromises = new Map<string, Promise<StudyCatalog>>();
  const documentVersions = new WeakMap<StudyDocument["question"], string>();
  const questionPromises = new Map<string, Promise<StudyDocument>>();
  const discussionPromises = new Map<string, Promise<StudyDiscussion>>();

  const safeUrl = (path: string): URL => {
    const parsed = relativePath.safeParse(path);
    if (!parsed.success) throw new Error(`Unsafe study data path: ${path}`);
    const url = new URL(path, base);
    if (url.origin !== base.origin || !url.pathname.startsWith(basePath) ||
        !["http:", "https:"].includes(url.protocol)) {
      throw new Error(`Study data URL escapes its same-origin base: ${path}`);
    }
    return url;
  };

  const readJson = async (url: URL, label: string): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetcher(url.href, {
        redirect: "error", credentials: "same-origin", cache: "no-store",
      });
    } catch (error) {
      throw new Error(`${label} request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) throw new Error(`${label} request failed with HTTP ${response.status}`);
    try {
      return await response.json();
    } catch (error) {
      throw new Error(`${label} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const loadManifest = (): Promise<StudyManifest> => {
    if (manifestValue) return Promise.resolve(manifestValue);
    if (manifestPromise) return manifestPromise;
    const pending = (async () => {
      const value = ManifestSchema.parse(
        await readJson(safeUrl("data/manifest.json"), "Study manifest"),
      ) as StudyManifest;
      const expectedRoot = `content/${value.releaseId}/`;
      if (value.catalogUrl !== `${expectedRoot}catalog.json` ||
          value.questionBaseUrl !== `${expectedRoot}questions/` ||
          value.discussionBaseUrl !== `${expectedRoot}discussions/` ||
          value.mediaBaseUrl !== `${expectedRoot}media/`) {
        throw new Error("Study manifest paths do not match its release");
      }
      for (const path of [
        value.catalogUrl,
        `${value.questionBaseUrl}placeholder.json`,
        `${value.discussionBaseUrl}placeholder.json`,
        `${value.mediaBaseUrl}placeholder.png`,
      ]) safeUrl(path);
      manifestValue = value;
      return value;
    })();
    manifestPromise = pending;
    pending.catch(() => {
      if (manifestPromise === pending) manifestPromise = undefined;
    });
    return pending;
  };

  const loadCatalog = async (requestedRelease?: string): Promise<StudyCatalog> => {
    if (requestedRelease !== undefined && !releaseId.safeParse(requestedRelease).success) {
      throw new Error("Invalid saved study snapshot release ID");
    }
    const manifest = await loadManifest();
    const version = requestedRelease ?? manifest.releaseId;
    const cached = catalogs.get(version);
    if (cached) return cached;
    const inFlight = catalogPromises.get(version);
    if (inFlight) return inFlight;
    const pending = (async () => {
      const value = CatalogSchema.parse(
        await readJson(safeUrl(`content/${version}/catalog.json`), "Study catalog"),
      ) as StudyCatalog;
      if (value.releaseId !== version ||
          (version === manifest.releaseId && value.sourceRevision !== manifest.sourceRevision)) {
        throw new Error("Study catalog release/source revision does not match the manifest");
      }
      if ((version === manifest.releaseId && JSON.stringify(value.counts) !== JSON.stringify(manifest.counts)) ||
          value.questions.length !== value.counts.questions ||
          new Set(value.questions.map((question) => question.id)).size !== value.questions.length ||
          value.questions.reduce((sum, question) => sum + question.commentCount, 0) !==
            value.counts.comments ||
          value.questions.filter((question) => question.grading === "automatic").length !==
            value.counts.automatic ||
          value.questions.filter((question) => question.grading === "manual").length !==
            value.counts.manual) {
        throw new Error("Study catalog counts or question IDs are inconsistent");
      }
      const sourceNumbers = value.questions.flatMap((question) => question.sourceNumbers ?? [question.number]);
      if (value.questions.some((question) => question.sourceNumbers &&
          !question.sourceNumbers.includes(question.number)) ||
          new Set(sourceNumbers).size !== sourceNumbers.length ||
          sourceNumbers.length !== (value.counts.sourceQuestions ?? value.counts.questions)) {
        throw new Error("Study catalog source-number aliases are inconsistent");
      }
      catalogs.set(version, value);
      return value;
    })();
    catalogPromises.set(version, pending);
    pending.catch(() => {
      if (catalogPromises.get(version) === pending) catalogPromises.delete(version);
    });
    return pending;
  };

  const knownQuestion = async (id: string, requestedRelease?: string) => {
    if (!questionId.safeParse(id).success) throw new Error(`Invalid question ID: ${id}`);
    const catalog = await loadCatalog(requestedRelease);
    const summary = catalog.questions.find((question) => question.id === id);
    if (!summary) throw new Error(`Unknown question ID: ${id}`);
    return { summary, version: catalog.releaseId };
  };

  const loadQuestion = async (id: string, requestedRelease?: string): Promise<StudyDocument> => {
    const { summary, version } = await knownQuestion(id, requestedRelease);
    const key = `${version}/${id}`;
    const cached = questionPromises.get(key);
    if (cached) return cached;
    const pending = (async () => {
      const value = DocumentSchema.parse(await readJson(
        safeUrl(`content/${version}/questions/${id}.json`),
        `Question ${id}`,
      )) as StudyDocument;
      if (value.releaseId !== version || value.question.id !== id ||
          value.answers.id !== id || value.answers.questionId !== id ||
          value.question.sourceRevision !== value.answers.sourceRevision ||
          value.question.commentCount !== summary.commentCount ||
          value.question.readiness.grading !== summary.grading ||
          value.answers.provisional !== summary.provisional ||
          value.discussionEnabled !== summary.discussionEnabled ||
          JSON.stringify(value.question.sources.map((source) => source.questionNumber).sort((a, b) => a - b)) !==
            JSON.stringify([...(summary.sourceNumbers ?? [summary.number])].sort((a, b) => a - b))) {
        throw new Error(`Question ${id} does not match its catalog/release metadata`);
      }
      documentVersions.set(value.question, version);
      return value;
    })();
    questionPromises.set(key, pending);
    pending.catch(() => {
      if (questionPromises.get(key) === pending) questionPromises.delete(key);
    });
    return pending;
  };

  const loadDiscussion = async (id: string, requestedRelease?: string): Promise<StudyDiscussion> => {
    const { summary, version } = await knownQuestion(id, requestedRelease);
    if (!summary.discussionEnabled || summary.commentCount === 0) {
      return { schemaVersion: 1, releaseId: version, questionId: id, comments: [] };
    }
    const key = `${version}/${id}`;
    const cached = discussionPromises.get(key);
    if (cached) return cached;
    const pending = (async () => {
      const value = DiscussionSchema.parse(await readJson(
        safeUrl(`content/${version}/discussions/${id}.json`),
        `Discussion ${id}`,
      )) as StudyDiscussion;
      if (value.releaseId !== version || value.questionId !== id ||
          value.comments.length !== summary.commentCount ||
          value.comments.some((comment) => !(summary.sourceNumbers ?? [summary.number])
            .includes(Number(comment.sourceOccurrenceId.slice(-6))))) {
        throw new Error(`Discussion ${id} does not match its catalog/release/thread metadata`);
      }
      assertDiscussionThreads(value);
      return value;
    })();
    discussionPromises.set(key, pending);
    pending.catch(() => {
      if (discussionPromises.get(key) === pending) discussionPromises.delete(key);
    });
    return pending;
  };

  return {
    loadCatalog,
    loadQuestion,
    async loadQuestions(ids, requestedRelease) {
      if (new Set(ids).size !== ids.length) throw new Error("Duplicate question IDs are not allowed");
      const catalog = await loadCatalog(requestedRelease);
      const known = new Set(catalog.questions.map((question) => question.id));
      for (const id of ids) {
        if (!questionId.safeParse(id).success || !known.has(id)) {
          throw new Error(`Unknown question ID: ${id}`);
        }
      }
      const results = new Array<StudyDocument>(ids.length);
      let next = 0;
      const worker = async () => {
        while (next < ids.length) {
          const index = next++;
          results[index] = await loadQuestion(ids[index]!, catalog.releaseId);
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, ids.length) }, worker));
      return results;
    },
    loadDiscussion,
    mediaUrl(question, assetId, requestedRelease) {
      if (!manifestValue) {
        throw new Error("loadCatalog() must complete before resolving media URLs");
      }
      const version = requestedRelease ?? documentVersions.get(question) ?? manifestValue.releaseId;
      const catalog = catalogs.get(version);
      if (!catalog?.questions.some((summary) => summary.id === question.id)) {
        throw new Error(`Unknown question ID: ${question.id}`);
      }
      const loadedVersion = documentVersions.get(question);
      if (loadedVersion && loadedVersion !== version) {
        throw new Error(`Question ${question.id} belongs to another loaded snapshot`);
      }
      const parsedQuestion = CleanQuestionSchema.parse(question);
      const asset = parsedQuestion.media.find((candidate) => candidate.id === assetId);
      if (!asset) throw new Error(`Question ${question.id} has no media asset ${assetId}`);
      const extension = mediaExtension(asset.contentType);
      if (asset.objectPath !==
          `published/az104/${version}/assets/${asset.id}.${extension}`) {
        throw new Error(`Question ${question.id} media asset ${assetId} does not match the active release`);
      }
      return safeUrl(`content/${version}/media/${asset.id}.${extension}`).href;
    },
  };
}
