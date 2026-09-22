import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

// This suite loads the plain classic public/offline-worker.js source and runs
// it as-is (no transpilation, no mocks of its internal functions) against a
// fake ServiceWorkerGlobalScope: fake CacheStorage, fake Clients, and a fake
// same-origin fetch "server". Everything is driven through the worker's real
// public surface: install/activate/message/fetch events.

const ORIGIN = "https://study-az104.example";
const MANIFEST_PATH = "/data/offline-manifest.json";
const PROTOCOL = "az104-offline-v1";
const SC900_PROTOCOL = "sc900-offline-v1";
const WORKER_SOURCE = readFileSync(new URL("../public/offline-worker.js", import.meta.url), "utf8");

function sha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function hex(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

// ---------------------------------------------------------------------------
// Fixture: a full-count, synthetic manifest (604 questions / 7994 comments /
// 784 images) plus one legacy release, so production coverage validation is
// exercised without any test bypass.
// ---------------------------------------------------------------------------

interface ManifestObject {
  schemaVersion: 1;
  examId?: "az104" | "sc900";
  buildId: string;
  releaseId: string;
  learningReleaseId?: string;
  counts: { questions: number; comments: number; images: number };
  files: Array<Record<string, unknown>>;
}

function buildSc900Fixture(seed = "sc900"): Fixture {
  const releaseId = `r_${hex(seed)}`;
  const questionId = `q_${hex(`${seed}-question`)}`;
  const files = new Map<string, Buffer>();
  const entries: Array<Record<string, unknown>> = [];
  const root = "/exams/sc900";
  const add = (path: string, value: string, properties: Record<string, unknown>) => {
    const bytes = Buffer.from(value);
    files.set(path, bytes);
    entries.push({ url: path, sha256: sha256Hex(bytes), bytes: bytes.length, ...properties });
  };
  add("/index.html", `<html>${seed}</html>`, { kind: "shell" });
  add(`/assets/index-${hex(seed)}.js`, `console.log("${seed}");`, { kind: "shell" });
  add(`${root}/manifest.json`, JSON.stringify({ examId: "sc900", releaseId, captureLedgerDigest: hex(`capture-${seed}`) }), { kind: "data" });
  add(`${root}/availability.json`, JSON.stringify({
    schemaVersion: 1, examId: "sc900", activated: true, kind: "approved-source",
    bankReleaseId: releaseId, courseReleaseId: `c_${hex(seed)}`, sourceCaptureDigest: hex(`capture-${seed}`),
    approvedBy: "synthetic fixture coordinator", approvedAt: "2026-09-22T00:00:00Z",
  }), { kind: "data" });
  const coursePath = `${root}/course/releases/c_${hex(seed)}/sc900.json`;
  const courseContent = JSON.stringify({ examId: "sc900", seed });
  add(`${root}/course/current.json`, JSON.stringify({
    schemaVersion: 3, id: "sc900", active: true, releaseId: `c_${hex(seed)}`,
    url: coursePath.slice(1), sha256: sha256Hex(Buffer.from(courseContent)),
  }), { kind: "data" });
  add(coursePath, courseContent, { kind: "data" });
  add(`${root}/content/${releaseId}/catalog.json`, JSON.stringify({ releaseId }), { kind: "data", releaseId, part: "catalog" });
  add(`${root}/content/${releaseId}/questions/${questionId}.json`, JSON.stringify({ questionId }), {
    kind: "data", releaseId, questionId, part: "question",
  });
  for (const part of ["topics", "eligibility", "learning-manifest"]) {
    add(`${root}/content/${releaseId}/${part === "learning-manifest" ? "learning/manifest" : part}.json`,
      JSON.stringify({ examId: "sc900", part }), { kind: "data", releaseId, part });
  }
  add(`${root}/content/${releaseId}/learning/questions/${questionId}.json`, JSON.stringify({ questionId, teaching: seed }), {
    kind: "data", releaseId, questionId, part: "explanation",
  });
  const manifest: ManifestObject = {
    schemaVersion: 1, examId: "sc900", buildId: hex(`build-${seed}`), releaseId, learningReleaseId: releaseId,
    counts: { questions: 1, comments: 0, images: 0 }, files: entries,
  };
  files.set(`${root}/offline-manifest.json`, Buffer.from(JSON.stringify(manifest)));
  return { manifest, files, releaseId, legacyReleaseId: "", questionIds: [questionId], legacyQuestionIds: [], imageShas: [] };
}

interface Fixture {
  manifest: ManifestObject;
  files: Map<string, Buffer>; // pathname -> bytes, includes the descriptor itself
  releaseId: string;
  legacyReleaseId: string;
  questionIds: string[];
  legacyQuestionIds: string[];
  imageShas: string[];
}

function buildFixture(seed = "current", courseId: "networking" | "az104" = "networking"): Fixture {
  const files = new Map<string, Buffer>();
  const manifestFiles: Array<Record<string, unknown>> = [];
  const releaseId = `r_${hex(`release-${seed}`)}`;
  const legacyReleaseId = `r_${hex(`legacy-${seed}`)}`;

  function addFile(path: string, buffer: Buffer, props: Record<string, unknown>) {
    files.set(path, buffer);
    manifestFiles.push({ url: path, sha256: sha256Hex(buffer), bytes: buffer.length, ...props });
  }

  addFile("/index.html", Buffer.from(`<html>${seed}</html>`), { kind: "shell" });
  addFile("/favicon.svg", Buffer.from("<svg/>"), { kind: "shell" });
  addFile("/offline-worker.js", Buffer.from(`/* worker ${seed} */`), { kind: "shell" });
  addFile("/assets/index-abc123.js", Buffer.from(`console.log("${seed}");`), { kind: "shell" });
  addFile("/data/manifest.json", Buffer.from(JSON.stringify({ releaseId })), { kind: "data" });
  addFile("/data/topics.json", Buffer.from(JSON.stringify({ version: seed })), { kind: "data" });
  addFile("/data/learning.json", Buffer.from(JSON.stringify({ releaseId })), { kind: "data" });
  addFile("/data/course.json", Buffer.from(JSON.stringify({ releaseId: `c_${hex(seed)}` })), { kind: "data" });
  addFile(`/courses/c_${hex(seed)}/${courseId}.json`, Buffer.from(JSON.stringify({ fixture: `${courseId}-course`, seed })), { kind: "data" });
  addFile(`/content/${releaseId}/catalog.json`, Buffer.from(JSON.stringify({ releaseId, questions: 604 })), {
    kind: "data", releaseId, part: "catalog",
  });

  const questionIds: string[] = [];
  for (let i = 0; i < 604; i++) {
    const id = `q_${hex(`${seed}-question-${i}`)}`;
    questionIds.push(id);
    addFile(`/content/${releaseId}/questions/${id}.json`, Buffer.from(JSON.stringify({ id, number: i })), {
      kind: "data", releaseId, questionId: id, part: "question",
    });
  }
  addFile(`/teaching/${releaseId}/questions/${questionIds[0]}.json`, Buffer.from(JSON.stringify({ teaching: seed })), {
    kind: "data", releaseId, questionId: questionIds[0], part: "explanation",
  });
  // Two discussions summing to exactly 7994 comments; every discussion belongs
  // to one of the 604 question entries above.
  addFile(`/content/${releaseId}/discussions/${questionIds[0]}.json`, Buffer.from(JSON.stringify({ comments: 7993 })), {
    kind: "data", releaseId, questionId: questionIds[0], part: "discussion", commentCount: 7993,
  });
  addFile(`/content/${releaseId}/discussions/${questionIds[1]}.json`, Buffer.from(JSON.stringify({ comments: 1 })), {
    kind: "data", releaseId, questionId: questionIds[1], part: "discussion", commentCount: 1,
  });

  const imageShas: string[] = [];
  for (let i = 0; i < 784; i++) {
    const buffer = Buffer.from([0x01, (i >> 16) & 0xff, (i >> 8) & 0xff, i & 0xff, seed.charCodeAt(0) || 0]);
    const sha = sha256Hex(buffer);
    imageShas.push(sha);
    addFile(`/content/${releaseId}/media/${sha}.png`, buffer, { kind: "image", releaseId });
  }

  // A small legacy release: only reachable through explicit legacyRefs.
  addFile(`/content/${legacyReleaseId}/catalog.json`, Buffer.from(JSON.stringify({ releaseId: legacyReleaseId })), {
    kind: "data", releaseId: legacyReleaseId, part: "catalog",
  });
  const legacyQuestionIds: string[] = [];
  for (let i = 0; i < 3; i++) {
    const id = `q_${hex(`${seed}-legacy-question-${i}`)}`;
    legacyQuestionIds.push(id);
    addFile(`/content/${legacyReleaseId}/questions/${id}.json`, Buffer.from(JSON.stringify({ id })), {
      kind: "data", releaseId: legacyReleaseId, questionId: id, part: "question",
    });
  }

  manifestFiles.sort((a, b) => (a.url as string).localeCompare(b.url as string));
  const base = { schemaVersion: 1 as const, releaseId, counts: { questions: 604, comments: 7994, images: 784 }, files: manifestFiles };
  const buildId = sha256Hex(Buffer.from(JSON.stringify(base)));
  const manifest: ManifestObject = { schemaVersion: 1, buildId, releaseId, counts: base.counts, files: manifestFiles };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  files.set(MANIFEST_PATH, manifestBytes);

  return { manifest, files, releaseId, legacyReleaseId, questionIds, legacyQuestionIds, imageShas };
}

// ---------------------------------------------------------------------------
// Fake CacheStorage (a minimal in-memory stand-in for the real Cache API)
// ---------------------------------------------------------------------------

interface FakeCache {
  match(request: unknown): Promise<Response | undefined>;
  put(request: unknown, response: unknown): Promise<void>;
  delete(request: unknown): Promise<boolean>;
  keys(): Promise<Array<{ url: string }>>;
}

function requestUrl(request: unknown): string {
  return typeof request === "string" ? request : (request as { url: string }).url;
}

function createCacheStorage() {
  const stores = new Map<string, Map<string, Response>>();
  function makeCache(name: string): FakeCache {
    return {
      async match(request: unknown) {
        const url = requestUrl(request);
        const store = stores.get(name);
        const found = store && store.get(url);
        return found ? found.clone() : undefined;
      },
      async put(request: unknown, response?: unknown) {
        const url = requestUrl(request);
        if (!stores.has(name)) stores.set(name, new Map());
        stores.get(name)!.set(url, (response as Response).clone());
      },
      async delete(request: unknown) {
        const url = requestUrl(request);
        const store = stores.get(name);
        return store ? store.delete(url) : false;
      },
      async keys() {
        const store = stores.get(name);
        return store ? Array.from(store.keys(), (url) => ({ url })) : [];
      },
    };
  }
  return {
    async open(name: string) {
      if (!stores.has(name)) stores.set(name, new Map());
      return makeCache(name);
    },
    async has(name: string) { return stores.has(name); },
    async delete(name: string) { return stores.delete(name); },
    async keys() { return Array.from(stores.keys()); },
    __stores: stores,
  };
}
type FakeCacheStorage = ReturnType<typeof createCacheStorage>;

// ---------------------------------------------------------------------------
// Fake same-origin "server" fetch
// ---------------------------------------------------------------------------

interface Gate { promise: Promise<void>; release: () => void; }
function createGate(): Gate {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

interface FakeServer {
  offline: boolean;
  fetchLog: string[];
  blockGate: Gate | null;
  hangAfter?: number;
  hangCount: number;
}

function createServer(): FakeServer {
  return { offline: false, fetchLog: [], blockGate: null, hangCount: 0 };
}

function createFakeFetch(filesMap: Map<string, Buffer>, server: FakeServer) {
  return async function fakeFetch(input: unknown): Promise<Response> {
    const raw = typeof input === "string" ? input : (input as { url: string }).url;
    const pathname = new URL(raw, ORIGIN).pathname;
    if (server.offline) throw new TypeError("network request failed");
    if (pathname !== MANIFEST_PATH && pathname !== "/exams/sc900/offline-manifest.json") {
      server.fetchLog.push(pathname);
      if (server.blockGate) await server.blockGate.promise;
      if (server.hangAfter !== undefined) {
        server.hangCount += 1;
        if (server.hangCount > server.hangAfter) return new Promise<Response>(() => {});
      }
    }
    const bytes = filesMap.get(pathname);
    if (bytes === undefined) return new Response(null, { status: 404 });
    return new Response(new Uint8Array(bytes), { status: 200 });
  };
}

// ---------------------------------------------------------------------------
// Worker harness: runs the real classic script against fakes.
// ---------------------------------------------------------------------------

type Listener = (event: any) => void;

function createWorker(cacheStorage: FakeCacheStorage, fetchImpl: (input: unknown) => Promise<Response>) {
  const listeners: Record<string, Listener[]> = Object.create(null);
  const windowClients: Array<{ received: unknown[]; postMessage: (m: unknown) => void }> = [];
  const fakeSelf = {
    location: new URL(`${ORIGIN}/`),
    addEventListener(type: string, handler: Listener) {
      (listeners[type] ??= []).push(handler);
    },
    skipWaiting: async () => {},
    clients: {
      claim: async () => {},
      matchAll: async () => windowClients.slice(),
    },
    caches: cacheStorage,
  };
  globalThis.self = fakeSelf as unknown as typeof globalThis.self;
  globalThis.fetch = fetchImpl as unknown as typeof fetch;
  vm.runInThisContext(WORKER_SOURCE, { filename: "public/offline-worker.js" });

  function dispatch(type: string, event: any): Promise<unknown> {
    globalThis.self = fakeSelf as unknown as typeof globalThis.self;
    globalThis.fetch = fetchImpl as unknown as typeof fetch;
    const handlers = (listeners[type] || []).slice();
    for (const handler of handlers) handler(event);
    return Promise.all(event._waits || []);
  }

  function makeClient() {
    const client = { received: [] as unknown[], postMessage(message: unknown) { client.received.push(message); } };
    windowClients.push(client);
    return client;
  }

  async function status(id = "status", examId: "az104" | "sc900" = "az104"): Promise<any> {
    const client = makeClient();
    await dispatch("message", { data: { protocol: examId === "sc900" ? SC900_PROTOCOL : PROTOCOL, id, type: "STATUS", examId }, source: client, _waits: [], waitUntil(p: Promise<unknown>) { this._waits.push(p); } });
    return (client.received[0] as any).state;
  }

  async function download(id: string, legacyRefs?: unknown): Promise<{ event: any; client: ReturnType<typeof makeClient> }> {
    const client = makeClient();
    const data: Record<string, unknown> = { protocol: PROTOCOL, id, type: "DOWNLOAD" };
    if (legacyRefs !== undefined) data.legacyRefs = legacyRefs;
    const event = { data, source: client, _waits: [] as Promise<unknown>[], waitUntil(p: Promise<unknown>) { this._waits.push(p); } };
    const wait = dispatch("message", event);
    return { event: { ...event, wait }, client };
  }

  // Note: does NOT await completion (mirrors `download`) so callers can act
  // (e.g. release a fetch gate) while the RPC's own event.waitUntil is still
  // pending, then await `wait` themselves.
  async function rpc(type: string, id: string, extra?: Record<string, unknown>): Promise<{ client: ReturnType<typeof makeClient>; wait: Promise<unknown> }> {
    const client = makeClient();
    const data = { protocol: extra?.examId === "sc900" ? SC900_PROTOCOL : PROTOCOL, id, type, ...extra };
    const event = { data, source: client, _waits: [] as Promise<unknown>[], waitUntil(p: Promise<unknown>) { this._waits.push(p); } };
    const wait = dispatch("message", event);
    return { client, wait };
  }

  async function fetchRequest(pathname: string, init: { headers?: Record<string, string>; method?: string; mode?: string } = {}): Promise<{ responded: boolean; response: Response | undefined }> {
    const request = {
      method: init.method ?? "GET",
      url: new URL(pathname, ORIGIN).href,
      mode: init.mode ?? "same-origin",
      headers: new Headers(init.headers ?? {}),
    };
    const event: any = {
      request, _waits: [], _responded: false, _response: undefined,
      waitUntil(p: Promise<unknown>) { this._waits.push(p); },
      respondWith(p: unknown) { this._responded = true; this._response = Promise.resolve(p); },
    };
    await dispatch("fetch", event);
    const response = event._responded ? await event._response : undefined;
    return { responded: event._responded, response };
  }

  async function crossOriginFetch(url: string): Promise<{ responded: boolean }> {
    const request = { method: "GET", url, mode: "same-origin", headers: new Headers() };
    const event: any = {
      request, _waits: [], _responded: false,
      waitUntil(p: Promise<unknown>) { this._waits.push(p); },
      respondWith() { this._responded = true; },
    };
    await dispatch("fetch", event);
    return { responded: event._responded };
  }

  return { dispatch, status, download, rpc, fetchRequest, crossOriginFetch, windowClients, makeClient };
}
type Worker = ReturnType<typeof createWorker>;

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// crypto.subtle.digest() (and other async work) may resolve via the libuv
// event loop rather than a plain microtask, so waiting for a condition needs
// repeated macrotask turns rather than a fixed number of microtask flushes.
async function waitFor(condition: () => boolean | Promise<boolean>, tries = 5000): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (await condition()) return;
    await flush();
  }
  throw new Error("waitFor: condition was not met in time");
}

// Waits until a polled value stops changing across several consecutive
// flushes. Used to detect "every concurrent lane is now stuck" rather than
// "at least one lane became stuck", since bounded concurrency means several
// lanes can still be legitimately mid-flight when a single counter first
// crosses a threshold.
async function waitForStable(getValue: () => number, stableChecks = 25, tries = 5000): Promise<number> {
  let last = getValue();
  let stable = 0;
  for (let i = 0; i < tries; i++) {
    await flush();
    const current = getValue();
    if (current === last) {
      stable += 1;
      if (stable >= stableChecks) return current;
    } else {
      stable = 0;
      last = current;
    }
  }
  throw new Error("waitForStable: value did not stabilize in time");
}

async function bytesOf(response: Response | undefined): Promise<Buffer> {
  if (!response) throw new Error("No response");
  return Buffer.from(await response.arrayBuffer());
}

test("already-open legacy AZ-104 clients ignore every SC-900 state and unscoped commands remain AZ-104-only", async () => {
  const az104 = buildFixture("legacy-protocol");
  const sc900 = buildSc900Fixture("legacy-client-sc-first");
  const updated = buildSc900Fixture("legacy-client-sc-update");
  const files = new Map(az104.files);
  const storage = createCacheStorage();
  const worker = createWorker(storage, createFakeFetch(files, createServer()));
  await (await worker.download("legacy-az-download")).event.wait;
  const legacy = worker.makeClient();
  await worker.dispatch("message", {
    data: { protocol: PROTOCOL, id: "legacy-registration", type: "STATUS" },
    source: legacy, _waits: [], waitUntil(p: Promise<unknown>) { this._waits.push(p); },
  });
  const delivered = legacy.received as Array<{
    protocol: string; type: string; examId?: string;
    state: { ready: boolean; buildId: string | null; releaseId: string | null };
  }>;
  // This is the old hook's filter, intentionally unaware of examId.
  const understoodByOldClient = () => delivered.filter((message) =>
    message.protocol === PROTOCOL && (message.type === "STATE" || message.type === "RESULT"));
  assert.equal(understoodByOldClient()[0]?.state.buildId, az104.manifest.buildId);
  delivered.length = 0;
  for (const fixture of [sc900, updated]) {
    for (const [path, bytes] of fixture.files) files.set(path, bytes);
    const request = await worker.rpc("DOWNLOAD", `download-${fixture.manifest.buildId}`, { examId: "sc900" });
    await request.wait;
    const result = request.client.received.find((message) =>
      (message as { type: string }).type === "RESULT") as { protocol: string; examId: string };
    assert.equal(result.protocol, SC900_PROTOCOL);
    assert.equal(result.examId, "sc900");
    assert.equal((await worker.status()).buildId, az104.manifest.buildId);
    assert.equal(understoodByOldClient().length, 0);
  }
  await (await worker.rpc("REMOVE", "remove-sc", { examId: "sc900" })).wait;
  assert.equal((await worker.status()).buildId, az104.manifest.buildId);
  assert.equal((await worker.status("sc-after-remove", "sc900")).ready, false);
  assert.ok(delivered.some((message) => message.type === "STATE"));
  assert.ok(delivered.every((message) => message.protocol === SC900_PROTOCOL && message.examId === "sc900"));
  assert.equal(understoodByOldClient().length, 0);
  await (await worker.rpc("DOWNLOAD", "sc-again", { examId: "sc900" })).wait;
  await (await worker.rpc("REMOVE", "legacy-unscoped-remove")).wait;
  assert.equal((await worker.status()).ready, false);
  assert.equal((await worker.status("sc-retained", "sc900")).ready, true);
  assert.ok(understoodByOldClient().every((message) => message.state.ready === false && message.state.releaseId === null));
  delivered.length = 0;
  await (await worker.rpc("REMOVE_ALL", "explicit-all-clear", { examId: "sc900" })).wait;
  assert.equal((await worker.status("sc-cleared", "sc900")).ready, false);
  assert.ok(understoodByOldClient().length > 0);
  assert.ok(understoodByOldClient().every((message) => message.state.ready === false && message.state.buildId === null));
});

test("SC-900 updates retain AZ-104 active pointers, shell assets and media across activation", async () => {
  const az104 = buildFixture("az-retained");
  const first = buildSc900Fixture("sc-first");
  const second = buildSc900Fixture("sc-second");
  const sharedSha = az104.imageShas[0]!;
  const sharedBytes = az104.files.get(`/content/${az104.releaseId}/media/${sharedSha}.png`)!;
  const sharedPath = `/exams/sc900/content/${first.releaseId}/media/${sharedSha}.png`;
  first.manifest.counts.images = 1;
  first.manifest.files.push({ url: sharedPath, kind: "image", releaseId: first.releaseId, sha256: sharedSha, bytes: sharedBytes.length });
  first.files.set(sharedPath, sharedBytes);
  first.files.set("/exams/sc900/offline-manifest.json", Buffer.from(JSON.stringify(first.manifest)));
  const files = new Map([...az104.files, ...first.files]);
  for (const [path, bytes] of az104.files) if (!path.startsWith("/exams/")) files.set(path, bytes);
  const storage = createCacheStorage();
  const server = createServer();
  const fetcher = createFakeFetch(files, server);
  const worker = createWorker(storage, fetcher);
  await (await worker.download("az-initial")).event.wait;
  const azState = await worker.status();
  const azCacheNames = (await storage.keys()).filter((name) => name.startsWith("az104-offline-"));
  const azPointer = await bytesOf(await (await storage.open("az104-offline-meta")).match(`${ORIGIN}/__az104_offline_meta__/active.json`));
  for (const [path, bytes] of first.files) files.set(path, bytes);
  await (await worker.rpc("DOWNLOAD", "sc-first", { examId: "sc900" })).wait;
  assert.equal((await worker.status("sc-state", "sc900")).buildId, first.manifest.buildId);
  for (const [path, bytes] of second.files) files.set(path, bytes);
  await (await worker.rpc("DOWNLOAD", "sc-second", { examId: "sc900" })).wait;
  assert.equal((await worker.status("sc-state", "sc900")).buildId, second.manifest.buildId);
  assert.equal((await (await storage.open("sc900-offline-media")).keys()).length, 0);
  assert.equal((await (await storage.open("az104-offline-media")).keys()).length, az104.manifest.counts.images);
  assert.deepEqual((await storage.keys()).filter((name) => name.startsWith("az104-offline-")), azCacheNames);
  assert.deepEqual(await bytesOf(await (await storage.open("az104-offline-meta")).match(`${ORIGIN}/__az104_offline_meta__/active.json`)), azPointer);
  const restarted = createWorker(storage, fetcher);
  await restarted.dispatch("activate", { _waits: [], waitUntil(p: Promise<unknown>) { this._waits.push(p); } });
  server.offline = true;
  const navigation = await restarted.fetchRequest("/", { mode: "navigate" });
  assert.deepEqual(await bytesOf(navigation.response), second.files.get("/index.html"));
  assert.equal((await restarted.status()).buildId, azState.buildId);
  assert.equal((await restarted.status("sc-state", "sc900")).buildId, second.manifest.buildId);
  for (const path of [
    "/data/manifest.json", "/assets/index-abc123.js",
    `/content/${az104.releaseId}/questions/${az104.questionIds[0]}.json`,
    `/content/${az104.releaseId}/media/${az104.imageShas[0]}.png`,
  ]) {
    const hit = await restarted.fetchRequest(path, { headers: { "X-AZ104-Offline": "1" } });
    assert.deepEqual(await bytesOf(hit.response), az104.files.get(path));
  }
  const scPath = `/exams/sc900/content/${second.releaseId}/questions/${second.questionIds[0]}.json`;
  assert.deepEqual(await bytesOf((await restarted.fetchRequest(scPath, {
    headers: { "X-Study-Offline": "1", "X-Study-Exam": "sc900" },
  })).response), second.files.get(scPath));
  assert.deepEqual(await bytesOf((await restarted.fetchRequest("/exams/sc900/availability.json", {
    headers: { "X-Study-Offline": "1", "X-Study-Exam": "sc900" },
  })).response), second.files.get("/exams/sc900/availability.json"));
  for (const path of [
    `/exams/sc900/content/${second.releaseId}/topics.json`,
    `/exams/sc900/content/${second.releaseId}/eligibility.json`,
    `/exams/sc900/content/${second.releaseId}/learning/manifest.json`,
    `/exams/sc900/content/${second.releaseId}/learning/questions/${second.questionIds[0]}.json`,
  ]) {
    assert.deepEqual(await bytesOf((await restarted.fetchRequest(path, {
      headers: { "X-Study-Offline": "1", "X-Study-Exam": "sc900" },
    })).response), second.files.get(path));
  }
  const missingOld = await restarted.fetchRequest(`/exams/sc900/content/${first.releaseId}/questions/${first.questionIds[0]}.json`, {
    headers: { "X-Study-Offline": "1" },
  });
  assert.equal(missingOld.response?.status, 503);
  const foreign = await restarted.fetchRequest("/data/manifest.json", { headers: { "X-Study-Offline": "1", "X-Study-Exam": "sc900" } });
  assert.equal(foreign.response?.status, 503);
  const unknown = await restarted.fetchRequest(scPath, { headers: { "X-Study-Offline": "1", "X-Study-Exam": "unknown" } });
  assert.equal(unknown.response?.status, 503);
});

test("per-exam remove leaves the other package intact and REMOVE_ALL clears only exam-owned caches", async () => {
  const az104 = buildFixture("az-remove");
  const sc900 = buildSc900Fixture("sc-remove");
  const storage = createCacheStorage();
  // Matching shell URLs must contain the expected bytes for the current package.
  const files = new Map(az104.files);
  const fetcher = createFakeFetch(files, createServer());
  const current = createWorker(storage, fetcher);
  await (await current.download("az")).event.wait;
  for (const [path, bytes] of sc900.files) files.set(path, bytes);
  await (await current.rpc("DOWNLOAD", "sc", { examId: "sc900" })).wait;
  assert.equal((await current.status()).ready, true);
  assert.equal((await current.status("sc", "sc900")).ready, true);
  await (await current.rpc("REMOVE", "remove-sc", { examId: "sc900" })).wait;
  assert.equal((await current.status()).ready, true);
  assert.equal((await current.status("sc", "sc900")).ready, false);
  await (await current.rpc("DOWNLOAD", "sc-again", { examId: "sc900" })).wait;
  await storage.open("account-cache");
  await (await current.rpc("REMOVE_ALL", "clear", { examId: "sc900" })).wait;
  assert.deepEqual((await storage.keys()).filter((name) => /^(az104|sc900)-offline-(data-|media)/.test(name)), []);
  assert.equal(await storage.has("account-cache"), true);
  assert.equal((await current.status()).ready, false);
  assert.equal((await current.status("sc", "sc900")).ready, false);
});

test("SC-900 fails closed without its manifest and refuses foreign manifests and paths", async () => {
  const sc900 = buildSc900Fixture("sc-reject");
  const manifestPath = "/exams/sc900/offline-manifest.json";
  const root = `/exams/sc900/course/releases/c_${hex("sc-reject")}`;
  const invalidFiles = [
    { url: "/data/manifest.json", bytes: 1 },
    { url: `/content/${sc900.releaseId}/catalog.json`, bytes: 1 },
    { url: `${root}/az104.json`, bytes: 1 },
    { url: `${root}/../sc900.json`, bytes: 1 },
    { url: `${root}/%2e%2e/sc900.json`, bytes: 1 },
    { url: `${root}\\sc900.json`, bytes: 1 },
    { url: `${root}/sc900.json?auth=secret`, bytes: 1 },
    { url: `${root}/sc900.json#fragment`, bytes: 1 },
    { url: `https://example.test${root}/sc900.json`, bytes: 1 },
    { url: `//example.test${root}/sc900.json`, bytes: 1 },
    { url: `${root}/sc900.json`, bytes: 4 * 1024 * 1024 + 1 },
    { url: "/exams/sc900/course/current.json", bytes: 4 * 1024 * 1024 + 1 },
    { url: "/exams/sc900/availability.json", bytes: 8_001 },
  ];
  const candidates = [
    null,
    { ...sc900.manifest, examId: undefined },
    { ...sc900.manifest, examId: "az104" },
    { ...sc900.manifest, files: sc900.manifest.files.filter((file) => file.url !== "/exams/sc900/availability.json") },
    ...invalidFiles.map((file) => ({
      ...sc900.manifest, files: [...sc900.manifest.files, { kind: "data", sha256: hex("bad"), ...file }],
    })),
  ];
  for (const candidate of candidates) {
    const files = new Map(sc900.files);
    if (candidate) files.set(manifestPath, Buffer.from(JSON.stringify(candidate)));
    else files.delete(manifestPath);
    const server = createServer();
    const worker = createWorker(createCacheStorage(), createFakeFetch(files, server));
    const request = await worker.rpc("DOWNLOAD", "rejected", { examId: "sc900" });
    await request.wait;
    assert.equal(typeof (request.client.received[0] as { error?: string }).error, "string");
    assert.equal((await worker.status("sc", "sc900")).ready, false);
    assert.deepEqual(server.fetchLog, []);
  }
});

test("unknown exam commands cannot start a download or delete an installed package", async () => {
  const storage = createCacheStorage();
  await storage.open("az104-offline-media");
  const worker = createWorker(storage, createFakeFetch(new Map(), createServer()));
  for (const type of ["DOWNLOAD", "REMOVE", "REMOVE_ALL"]) {
    const request = await worker.rpc(type, type, { examId: "../az104" });
    await request.wait;
    assert.match((request.client.received[0] as { error: string }).error, /Unknown offline exam/);
    assert.equal(await storage.has("az104-offline-media"), true);
  }
});

test("SC-900 downloads fail closed on inactive, synthetic or mismatched activation records", async () => {
  const fixture = buildSc900Fixture("sc-activation");
  const path = "/exams/sc900/availability.json";
  const valid = JSON.parse(fixture.files.get(path)!.toString("utf8")) as Record<string, unknown>;
  for (const record of [
    { schemaVersion: 1, examId: "sc900", activated: false },
    { ...valid, kind: "original-synthetic-demo" },
    { ...valid, bankReleaseId: `r_${hex("another-bank")}` },
    { ...valid, courseReleaseId: `c_${hex("another-course")}` },
    { ...valid, sourceCaptureDigest: hex("another-capture") },
    { ...valid, approvedBy: " " },
    { ...valid, approvedAt: "not-a-date" },
    { ...valid, extra: "unapproved metadata" },
  ]) {
    const files = new Map(fixture.files);
    const bytes = Buffer.from(JSON.stringify(record));
    const manifest = structuredClone(fixture.manifest);
    const entry = manifest.files.find((file) => file.url === path)!;
    Object.assign(entry, { sha256: sha256Hex(bytes), bytes: bytes.length });
    files.set(path, bytes);
    files.set("/exams/sc900/offline-manifest.json", Buffer.from(JSON.stringify(manifest)));
    const worker = createWorker(createCacheStorage(), createFakeFetch(files, createServer()));
    await (await worker.rpc("DOWNLOAD", "activation", { examId: "sc900" })).wait;
    const state = await worker.status("sc", "sc900");
    assert.equal(state.ready, false);
    assert.match(state.error, /availability|activation/);
  }
});

test("SC-900 saved snapshots retain their own topics, teaching and exclusive images", async () => {
  const current = buildSc900Fixture("sc-current-saved");
  const archived = buildSc900Fixture("sc-archived-saved");
  const root = `/exams/sc900/content/${archived.releaseId}`;
  for (const entry of archived.manifest.files.filter((file) => String(file.url).startsWith(root))) {
    current.manifest.files.push(entry);
    current.files.set(String(entry.url), archived.files.get(String(entry.url))!);
  }
  const image = Buffer.from("synthetic archived-only image");
  const imageSha = sha256Hex(image);
  const imagePath = `${root}/media/${imageSha}.png`;
  current.files.set(imagePath, image);
  current.manifest.files.push({
    url: imagePath, sha256: imageSha, bytes: image.length, kind: "image",
    releaseId: archived.releaseId, questionIds: archived.questionIds,
  });
  current.manifest.counts.images = 1;
  current.files.set("/exams/sc900/offline-manifest.json", Buffer.from(JSON.stringify(current.manifest)));
  const server = createServer();
  const storage = createCacheStorage();
  const fetcher = createFakeFetch(current.files, server);
  const worker = createWorker(storage, fetcher);
  await (await worker.rpc("DOWNLOAD", "sc-current-only", { examId: "sc900" })).wait;
  assert.equal((await worker.status("sc-current", "sc900")).ready, true);
  assert.equal((await worker.fetchRequest(imagePath, { headers: { "X-AZ104-Offline": "1" } })).response?.status, 503);
  await (await worker.rpc("DOWNLOAD", "sc-with-saved", {
    examId: "sc900", legacyRefs: [{ releaseId: archived.releaseId, questionIds: archived.questionIds }],
  })).wait;
  server.offline = true;
  const restarted = createWorker(storage, fetcher);
  assert.equal((await restarted.status("sc-saved", "sc900")).ready, true);
  for (const path of [
    `${root}/topics.json`, `${root}/eligibility.json`, `${root}/learning/manifest.json`,
    `${root}/learning/questions/${archived.questionIds[0]}.json`, imagePath,
  ]) {
    assert.deepEqual(await bytesOf((await restarted.fetchRequest(path, {
      headers: { "X-AZ104-Offline": "1" },
    })).response), current.files.get(path));
  }
});

test("SC-900 descriptor and course downloads cancel oversized streams at the 4 MiB bound", async () => {
  const fixture = buildSc900Fixture("sc-stream");
  const descriptorPath = "/exams/sc900/offline-manifest.json";
  const coursePath = fixture.manifest.files.find((file) => String(file.url).includes("/course/releases/c_"))!.url as string;
  for (const path of [descriptorPath, coursePath]) {
    const files = new Map(fixture.files);
    const manifest = structuredClone(fixture.manifest);
    if (path === coursePath) manifest.files.find((file) => file.url === path)!.bytes = 4 * 1024 * 1024;
    files.set(descriptorPath, Buffer.from(JSON.stringify(manifest)));
    const fetcher = createFakeFetch(files, createServer());
    let cancelled = 0;
    let pulled = 0;
    const worker = createWorker(createCacheStorage(), async (input) => {
      const url = typeof input === "string" ? input : (input as { url: string }).url;
      if (new URL(url, ORIGIN).pathname !== path) return fetcher(input);
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) { pulled++; controller.enqueue(new Uint8Array(1024 * 1024)); },
        cancel() { cancelled++; },
      }));
    });
    const request = await worker.rpc("DOWNLOAD", "oversized", { examId: "sc900" });
    await request.wait;
    assert.equal((await worker.status("sc", "sc900")).ready, false);
    assert.equal(cancelled, path === descriptorPath ? 1 : 3);
    assert.ok(pulled <= (path === descriptorPath ? 6 : 18));
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("install/activate skip waiting and claim clients without error", async () => {
  const fixture = buildFixture("lifecycle");
  const server = createServer();
  const cacheStorage = createCacheStorage();
  const worker = createWorker(cacheStorage, createFakeFetch(fixture.files, server));
  await worker.dispatch("install", { _waits: [], waitUntil(p: Promise<unknown>) { this._waits.push(p); } });
  await worker.dispatch("activate", { _waits: [], waitUntil(p: Promise<unknown>) { this._waits.push(p); } });
  const state = await worker.status();
  assert.equal(state.status, "empty");
  assert.equal(state.ready, false);
});

test("excludes private, auth, API and traversal-adjacent same-origin paths from interception", async () => {
  const fixture = buildFixture("exclude");
  const server = createServer();
  const cacheStorage = createCacheStorage();
  const worker = createWorker(cacheStorage, createFakeFetch(fixture.files, server));
  const excluded = ["/__/firebase/init.json", "/api/session", "/auth/callback", "/users/alice", "/private/secret", "/.data/dump.json"];
  for (const path of excluded) {
    const result = await worker.fetchRequest(path);
    assert.equal(result.responded, false, `${path} must not be intercepted`);
  }
  // Non-GET requests to an otherwise cacheable path are never intercepted.
  const post = await worker.fetchRequest("/index.html", { method: "POST" });
  assert.equal(post.responded, false);
  // Cross-origin requests are never intercepted.
  const crossOrigin = await worker.crossOriginFetch("https://evil.example/index.html");
  assert.equal(crossOrigin.responded, false);
});

test("valid selection downloads the current release plus only the requested legacy questions, deduplicating images", async () => {
  const fixture = buildFixture("select");
  const server = createServer();
  const cacheStorage = createCacheStorage();
  const worker = createWorker(cacheStorage, createFakeFetch(fixture.files, server));
  const legacyRefs = [{ releaseId: fixture.legacyReleaseId, questionIds: [fixture.legacyQuestionIds[0]] }];
  const { event } = await worker.download("d1", legacyRefs);
  await event.wait;

  const state = await worker.status();
  assert.equal(state.status, "ready");
  assert.equal(state.ready, true);
  assert.equal(state.buildId, fixture.manifest.buildId);
  assert.equal(state.releaseId, fixture.releaseId);

  // Every image fetched exactly once (784 unique shas, no re-fetching).
  const imagePaths = server.fetchLog.filter((path) => path.includes("/media/"));
  assert.equal(imagePaths.length, 784);
  assert.equal(new Set(imagePaths).size, 784);

  // Only the referenced legacy question (not the other two) was fetched.
  const legacyQuestionFetches = server.fetchLog.filter((path) => path.startsWith(`/content/${fixture.legacyReleaseId}/questions/`));
  assert.equal(legacyQuestionFetches.length, 1);
  assert.ok(legacyQuestionFetches[0]!.includes(fixture.legacyQuestionIds[0]!));

  // The legacy catalog was fetched (required to resolve the reference) but no
  // unrequested legacy question was.
  assert.ok(server.fetchLog.includes(`/content/${fixture.legacyReleaseId}/catalog.json`));
  assert.equal(server.fetchLog.filter((path) => path.includes(fixture.legacyQuestionIds[1]!)).length, 0);

  // All 604 current-release questions were fetched.
  const currentQuestionFetches = server.fetchLog.filter((path) => path.startsWith(`/content/${fixture.releaseId}/questions/`));
  assert.equal(currentQuestionFetches.length, 604);
  assert.ok(server.fetchLog.includes("/data/course.json"));
  assert.ok(server.fetchLog.includes(`/courses/c_${hex("select")}/networking.json`));
  const lesson = await worker.fetchRequest(`/courses/c_${hex("select")}/networking.json`, { headers: { "X-AZ104-Offline": "1" } });
  assert.equal(lesson.response?.status, 200);
});

test("legacy networking and full AZ-104 course paths serve verified cache-only bytes across worker restarts", async () => {
  for (const courseId of ["networking", "az104"] as const) {
    const seed = `course-${courseId}`;
    const fixture = buildFixture(seed, courseId);
    const coursePath = `/courses/c_${hex(seed)}/${courseId}.json`;
    const server = createServer();
    const storage = createCacheStorage();
    const fetcher = createFakeFetch(fixture.files, server);
    let networkCalls = 0;
    const countedFetch = (input: unknown) => { networkCalls++; return fetcher(input); };
    const worker = createWorker(storage, countedFetch);
    await (await worker.download(seed)).event.wait;
    assert.equal((await worker.status()).ready, true);
    const callsAfterDownload = networkCalls;
    const restarted = createWorker(storage, countedFetch);
    for (const offline of [false, true]) {
      server.offline = offline;
      for (const path of [coursePath, "/data/course.json"]) {
        const response = (await restarted.fetchRequest(path, { headers: { "X-AZ104-Offline": "1" } })).response;
        assert.equal(response?.status, 200);
        assert.deepEqual(await bytesOf(response), fixture.files.get(path));
      }
      for (const path of [
        `/courses/c_${hex("missing-course")}/${courseId}.json`,
        `/courses/c_${hex(seed)}/foreign.json`,
        `/courses/c_${hex(seed)}/${courseId === "az104" ? "networking" : "az104"}.json`,
      ]) {
        const response = (await restarted.fetchRequest(path, { headers: { "X-AZ104-Offline": "1" } })).response;
        assert.equal(response?.status, 503);
      }
      assert.equal(networkCalls, callsAfterDownload, "cache-only hits and misses must never reach the network");
    }
  }
});

test("course manifests reject foreign filenames, traversal and over-4-MiB declarations before downloading files", async () => {
  const fixture = buildFixture("course-allowlist");
  const root = `/courses/c_${hex("course-allowlist")}`;
  const invalid = [
    ...[
      `${root}/foreign.json`, `${root}/az104.json.bak`, `${root}/../az104.json`,
      `${root}/nested/az104.json`, `${root}/./az104.json`, `${root}/%2e%2e/az104.json`,
      `${root}\\az104.json`, `${root}/az104.json?download=1`, `${root}/az104.json#course`,
      `https://example.test${root}/az104.json`, `//example.test${root}/az104.json`,
      "/courses/c_bad/az104.json",
    ].map((url) => ({ url, bytes: 10 })),
    ...["networking", "az104"].map((name) => ({ url: `${root}/${name}.json`, bytes: 4 * 1024 * 1024 + 1 })),
  ];
  for (const entry of invalid) {
    const files = new Map(fixture.files);
    files.set(MANIFEST_PATH, Buffer.from(JSON.stringify({
      ...fixture.manifest,
      files: [...fixture.manifest.files, { kind: "data", sha256: hex("rejected-course"), ...entry }],
    })));
    const server = createServer();
    const worker = createWorker(createCacheStorage(), createFakeFetch(files, server));
    const { event, client } = await worker.download("reject-course");
    await event.wait;
    assert.match((client.received[0] as { error: string }).error, /unsafe|allowed|limit/, entry.url);
    assert.equal((await worker.status()).ready, false);
    assert.deepEqual(server.fetchLog, [], "invalid descriptors must not start any file downloads");
  }
});

test("both course downloads stop oversized response streams at the declared 4-MiB bound", async () => {
  for (const courseId of ["networking", "az104"] as const) {
    const fixture = buildFixture(`course-stream-${courseId}`, courseId);
    const coursePath = fixture.manifest.files.find((file) => String(file.url).startsWith("/courses/"))!.url as string;
    fixture.manifest.files.find((file) => file.url === coursePath)!.bytes = 4 * 1024 * 1024;
    fixture.files.set(MANIFEST_PATH, Buffer.from(JSON.stringify(fixture.manifest)));
    const fetcher = createFakeFetch(fixture.files, createServer());
    let cancelled = 0;
    let pulled = 0;
    const worker = createWorker(createCacheStorage(), async (input) => {
      if (new URL(typeof input === "string" ? input : (input as { url: string }).url, ORIGIN).pathname !== coursePath) {
        return fetcher(input);
      }
      let chunks = 0;
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled++;
          controller.enqueue(new Uint8Array(1024 * 1024));
          if (++chunks === 10) controller.close();
        },
        cancel() { cancelled++; },
      }));
    });
    await (await worker.download("oversized-stream")).event.wait;
    const state = await worker.status();
    assert.equal(state.ready, false);
    assert.match(state.error, /size mismatch/);
    assert.equal(cancelled, 3, "each bounded retry must cancel the oversized stream");
    assert.ok(pulled < 30, "the worker must not buffer all ten chunks on each retry");
  }
});

test("an unknown legacy reference fails visibly instead of silently downloading nothing", async () => {
  const fixture = buildFixture("unknown-ref");
  const server = createServer();
  const cacheStorage = createCacheStorage();
  const worker = createWorker(cacheStorage, createFakeFetch(fixture.files, server));
  const bogusQuestionId = `q_${hex("does-not-exist")}`;
  const { event, client } = await worker.download("d1", [{ releaseId: fixture.legacyReleaseId, questionIds: [bogusQuestionId] }]);
  await event.wait;
  const result = client.received[0] as any;
  assert.equal(typeof result.error, "string");
  assert.match(result.error, /unavailable/);
  const state = await worker.status();
  assert.equal(state.status, "empty");
});

test("reduced current banks omit retired media and lessons unless an old session references them", async () => {
  for (const withHistory of [false, true]) {
    const fixture = buildFixture(`retirement-${withHistory}`);
    const retiredId = fixture.questionIds.at(-1)!;
    const oldPath = `/content/${fixture.releaseId}/questions/${retiredId}.json`;
    const oldFile = fixture.manifest.files.find((file) => file.url === oldPath)!;
    fixture.manifest.files = fixture.manifest.files.filter((file) => file !== oldFile);
    const archivePath = `/content/${fixture.legacyReleaseId}/questions/${retiredId}.json`;
    fixture.manifest.files.push({ ...oldFile, releaseId: fixture.legacyReleaseId, url: archivePath });
    fixture.files.set(archivePath, fixture.files.get(oldPath)!);
    fixture.manifest.counts.questions = 603;
    fixture.manifest.learningReleaseId = fixture.releaseId;
    const lessonPath = `/teaching/${fixture.releaseId}/questions/${retiredId}.json`;
    const lessonBytes = Buffer.from(JSON.stringify({ retired: true }));
    fixture.files.set(lessonPath, lessonBytes);
    fixture.manifest.files.push({ kind: "data", releaseId: fixture.releaseId, questionId: retiredId,
      part: "explanation", url: lessonPath, bytes: lessonBytes.length, sha256: sha256Hex(lessonBytes) });
    const images = fixture.manifest.files.filter((file) => file.kind === "image");
    images.forEach((file, index) => { file.questionIds = [index === 0 ? retiredId : fixture.questionIds[0]!]; });
    const policyBytes = Buffer.from(JSON.stringify({ fixture: "current-only" }));
    fixture.files.set("/data/eligibility.json", policyBytes);
    fixture.manifest.files.push({ kind: "data", url: "/data/eligibility.json",
      bytes: policyBytes.length, sha256: sha256Hex(policyBytes) });
    fixture.files.set(MANIFEST_PATH, Buffer.from(JSON.stringify(fixture.manifest)));
    const server = createServer();
    const worker = createWorker(createCacheStorage(), createFakeFetch(fixture.files, server));
    const { event } = await worker.download("retired", withHistory
      ? [{ releaseId: fixture.legacyReleaseId, questionIds: [retiredId] }] : []);
    await event.wait;
    assert.equal((await worker.status()).ready, true);
    assert.equal(server.fetchLog.includes(oldPath), false);
    assert.equal(server.fetchLog.includes(archivePath), withHistory);
    assert.equal(server.fetchLog.includes(lessonPath), withHistory);
    assert.equal(server.fetchLog.includes(images[0]!.url as string), withHistory);
    assert.ok(server.fetchLog.includes("/data/eligibility.json"));
    const cached = await worker.fetchRequest(lessonPath, { headers: { "X-AZ104-Offline": "1" } });
    assert.equal(cached.response?.status, withHistory ? 200 : 503);
  }
});

test("a manifest that fails the production count contract is rejected, not silently accepted", async () => {
  const fixture = buildFixture("bad-manifest");
  const badFiles = new Map(fixture.files);
  const badManifest = { ...fixture.manifest, counts: { ...(fixture.manifest.counts as object), images: 783 } };
  badFiles.set(MANIFEST_PATH, Buffer.from(JSON.stringify(badManifest)));
  const server = createServer();
  const cacheStorage = createCacheStorage();
  const worker = createWorker(cacheStorage, createFakeFetch(badFiles, server));
  const { event, client } = await worker.download("d1");
  await event.wait;
  const result = client.received[0] as any;
  assert.equal(typeof result.error, "string");
  const state = await worker.status();
  assert.equal(state.status, "empty");
  assert.equal(state.ready, false);
});

test("a corrupted file fails hash verification and never gets published as ready", async () => {
  const fixture = buildFixture("corrupt");
  const corruptFiles = new Map(fixture.files);
  const targetPath = `/content/${fixture.releaseId}/questions/${fixture.questionIds[10]}.json`;
  const original = fixture.files.get(targetPath)!;
  // Flip one byte so the length (and therefore the size check) still matches
  // the manifest, isolating this test to the hash-verification path.
  const tampered = Buffer.from(original);
  tampered[0] = (tampered[0]! ^ 0xff) as number;
  corruptFiles.set(targetPath, tampered);
  const server = createServer();
  const cacheStorage = createCacheStorage();
  const worker = createWorker(cacheStorage, createFakeFetch(corruptFiles, server));
  const { event } = await worker.download("d1");
  await event.wait;

  const state = await worker.status();
  assert.equal(state.status, "error");
  assert.equal(state.ready, false);
  assert.equal(state.buildId, null);
  assert.match(state.error, /hash mismatch/);

  // The unverifiable staging data cache is left behind (nothing was ever
  // promoted to active), but a completely fresh worker instance sharing the
  // same durable CacheStorage must independently agree that nothing is ready.
  assert.equal(await cacheStorage.has(`az104-offline-data-${fixture.manifest.buildId}`), true);
  const freshProbe = createWorker(cacheStorage, createFakeFetch(corruptFiles, server));
  const freshState = await freshProbe.status();
  assert.equal(freshState.ready, false);
  assert.equal(freshState.buildId, null);
});

test("cancelling an in-flight update preserves the previously installed active copy", async () => {
  const first = buildFixture("cancel2-first");
  const second = buildFixture("cancel2-second");
  const merged = new Map(first.files);
  for (const [path, bytes] of second.files) merged.set(path, bytes);
  // `merged` overwrites shared shell paths and the manifest path with the
  // second build's content; that's the "new deployment" being downloaded
  // while `first` remains the active, previously installed build.

  const server = createServer();
  const cacheStorage = createCacheStorage();
  const worker = createWorker(cacheStorage, createFakeFetch(first.files, server));
  const { event: installEvent } = await worker.download("install-1");
  await installEvent.wait;
  assert.equal((await worker.status()).buildId, first.manifest.buildId);

  // Point subsequent fetches at the merged map (so DOWNLOAD now sees the
  // second manifest) and gate every file fetch so we can cancel mid-flight.
  const worker2 = createWorker(cacheStorage, createFakeFetch(merged, server));
  server.blockGate = createGate();
  const { event: updateEvent } = await worker2.download("update-1");
  await waitFor(async () => (await worker2.status()).status === "downloading");
  const midState = await worker2.status();
  assert.equal(midState.buildId, first.manifest.buildId, "ready build must still be the old one mid-download");

  const { wait: cancelWait } = await worker2.rpc("CANCEL", "cancel-1");
  await flush(); // let the CANCEL handler set controller.cancelled before we unblock fetches
  server.blockGate.release();
  await Promise.all([updateEvent.wait, cancelWait]);

  const finalState = await worker2.status();
  assert.equal(finalState.status, "ready");
  assert.equal(finalState.buildId, first.manifest.buildId, "cancel must preserve the old active build");
  assert.equal(finalState.ready, true);

  // The cancelled job's own staging cache must have been removed.
  assert.equal(await cacheStorage.has(`az104-offline-data-${second.manifest.buildId}`), false);
  // The old active data cache must still be present.
  assert.equal(await cacheStorage.has(`az104-offline-data-${first.manifest.buildId}`), true);
});

test("an interrupted download resumes without re-fetching already-validated files", async () => {
  const fixture = buildFixture("resume");
  const server = createServer();
  const cacheStorage = createCacheStorage();
  const worker1 = createWorker(cacheStorage, createFakeFetch(fixture.files, server));

  server.hangAfter = 40; // let 40 fetches complete, then every further fetch hangs forever
  const { event } = await worker1.download("d1");
  void event.wait.catch(() => {}); // never resolves in this phase; intentionally not awaited to completion
  // Wait until every concurrent lane has made its final (permanently hung)
  // fetch call and hangCount has genuinely stopped growing, not just until
  // the first lane crosses the threshold (other lanes can still be mid-flight
  // on earlier, non-hanging entries).
  await waitForStable(() => server.hangCount);

  const pausedProbe = createWorker(cacheStorage, createFakeFetch(fixture.files, server));
  const pausedState = await pausedProbe.status();
  assert.equal(pausedState.status, "paused", "a fresh worker instance with no in-memory job must report paused");
  assert.equal(pausedState.ready, false);

  // Snapshot exactly which real paths were already hash-verified and cached
  // before the "restart" (some in-flight-but-abandoned fetch attempts may
  // exist too, but only genuinely cached entries must never be re-fetched).
  const dataCache = await cacheStorage.open(`az104-offline-data-${fixture.manifest.buildId}`);
  const mediaCache = await cacheStorage.open("az104-offline-media");
  const cachedDataPaths = new Set((await dataCache.keys()).map((k) => new URL(k.url).pathname));
  const cachedMediaKeys = new Set((await mediaCache.keys()).map((k) => new URL(k.url).pathname));
  assert.ok(cachedDataPaths.size + cachedMediaKeys.size > 0, "at least some files must have been cached before the simulated restart");

  // "Restart": a brand new worker instance (fresh in-memory state) sharing
  // the same durable CacheStorage, with the hang lifted.
  delete server.hangAfter;
  server.blockGate = null;
  const beforeResumeLog = server.fetchLog.length;
  const worker2 = createWorker(cacheStorage, createFakeFetch(fixture.files, server));
  const { event: resumeEvent } = await worker2.download("d2");
  await resumeEvent.wait;

  const finalState = await worker2.status();
  assert.equal(finalState.status, "ready");
  assert.equal(finalState.buildId, fixture.manifest.buildId);

  const afterResumeLog = server.fetchLog.slice(beforeResumeLog);
  const mediaPathRe = /\/media\/([a-f0-9]{64})\.(png|jpg|gif|webp)$/;
  const reFetchedAlreadyCached = afterResumeLog.filter((path) => {
    if (cachedDataPaths.has(path)) return true;
    const media = mediaPathRe.exec(path);
    return Boolean(media && cachedMediaKeys.has(`/offline-assets/${media[1]}.${media[2]}`));
  });
  assert.deepEqual(reFetchedAlreadyCached, [], "resume must never re-fetch a file that was already hash-verified and cached");
  assert.ok(afterResumeLog.length < fixture.manifest.files.length, "resume must skip at least the already-cached files");
});

test("cache-only requests (X-AZ104-Offline) serve verified downloads without ever touching the network, and report unavailable on miss", async () => {
  const fixture = buildFixture("cache-only");
  const server = createServer();
  const cacheStorage = createCacheStorage();
  const worker = createWorker(cacheStorage, createFakeFetch(fixture.files, server));
  const { event } = await worker.download("d1");
  await event.wait;

  const questionPath = `/content/${fixture.releaseId}/questions/${fixture.questionIds[42]}.json`;
  const beforeLog = server.fetchLog.length;
  const hit = await worker.fetchRequest(questionPath, { headers: { "X-AZ104-Offline": "1" } });
  assert.equal(hit.responded, true);
  assert.deepEqual(await bytesOf(hit.response), fixture.files.get(questionPath));
  assert.equal(server.fetchLog.length, beforeLog, "cache-only hits must never call fetch");

  const missPath = `/content/${fixture.releaseId}/questions/${fixture.legacyQuestionIds[0]}.json`; // never downloaded
  const miss = await worker.fetchRequest(missPath, { headers: { "X-AZ104-Offline": "1" } });
  assert.equal(miss.responded, true);
  assert.equal(miss.response!.status, 503);
  const body = JSON.parse(await miss.response!.text());
  assert.equal(body.error, "offline-unavailable");
  assert.equal(server.fetchLog.length, beforeLog, "cache-only misses must never call fetch either");

  // Known immutable assets are served cache-first even without the header,
  // and without touching the network.
  const plain = await worker.fetchRequest(questionPath);
  assert.equal(plain.responded, true);
  assert.deepEqual(await bytesOf(plain.response), fixture.files.get(questionPath));
  assert.equal(server.fetchLog.length, beforeLog);

  // The offline manifest descriptor itself (stored separately, not as a
  // self-hashed file entry) is also servable offline.
  const manifestHit = await worker.fetchRequest(MANIFEST_PATH, { headers: { "X-AZ104-Offline": "1" } });
  assert.equal(manifestHit.responded, true);
  assert.deepEqual(await bytesOf(manifestHit.response), fixture.files.get(MANIFEST_PATH));
});

test("navigation is network-first with a verified /index.html fallback when offline", async () => {
  const fixture = buildFixture("nav");
  const server = createServer();
  const cacheStorage = createCacheStorage();
  const worker = createWorker(cacheStorage, createFakeFetch(fixture.files, server));
  const { event } = await worker.download("d1");
  await event.wait;

  server.offline = true;
  const result = await worker.fetchRequest("/practice/some-deep-route", { mode: "navigate" });
  assert.equal(result.responded, true);
  assert.deepEqual(await bytesOf(result.response), fixture.files.get("/index.html"));
});

test("REMOVE deletes only this app's own caches, leaving unrelated caches untouched", async () => {
  const fixture = buildFixture("remove");
  const server = createServer();
  const cacheStorage = createCacheStorage();
  const worker = createWorker(cacheStorage, createFakeFetch(fixture.files, server));
  const { event } = await worker.download("d1");
  await event.wait;
  assert.equal((await worker.status()).ready, true);

  const unrelatedCache = await cacheStorage.open("some-other-extensions-cache");
  await unrelatedCache.put(`${ORIGIN}/unrelated-entry`, new Response("keep-me"));

  const { wait: removeWait } = await worker.rpc("REMOVE", "remove-1");
  await removeWait;

  // Check cache names *before* any further STATUS call, since re-opening the
  // metadata cache to look for persisted state (a normal, harmless Cache API
  // read) would otherwise transparently recreate it empty.
  const names = await cacheStorage.keys();
  const ownedNames = names.filter((name) => name.startsWith("az104-offline-"));
  assert.deepEqual(ownedNames, [], "REMOVE must delete every one of this app's own caches outright");
  assert.ok(names.includes("some-other-extensions-cache"));
  const kept = await unrelatedCache.match(`${ORIGIN}/unrelated-entry`);
  assert.equal(await kept!.text(), "keep-me");

  const state = await worker.status();
  assert.equal(state.status, "empty");
  assert.equal(state.ready, false);
  assert.equal(state.buildId, null);
});

test("malformed own-protocol commands error visibly instead of silently succeeding", async () => {
  const fixture = buildFixture("malformed");
  const server = createServer();
  const cacheStorage = createCacheStorage();
  const worker = createWorker(cacheStorage, createFakeFetch(fixture.files, server));

  const { client, wait } = await worker.rpc("BOGUS-TYPE", "m1");
  await wait;
  assert.equal(client.received.length, 1);
  assert.equal(typeof (client.received[0] as any).error, "string");

  // Messages that are not our protocol are ignored entirely (no reply at all).
  const otherClient = worker.makeClient();
  await worker.dispatch("message", {
    data: { type: "STATUS" }, source: otherClient, _waits: [], waitUntil(p: Promise<unknown>) { this._waits.push(p); },
  });
  assert.equal(otherClient.received.length, 0);
});

test("STATUS detects browser cache eviction instead of falsely reporting ready", async () => {
  const fixture = buildFixture("eviction");
  const server = createServer();
  const cacheStorage = createCacheStorage();
  const worker = createWorker(cacheStorage, createFakeFetch(fixture.files, server));
  const { event } = await worker.download("d1");
  await event.wait;
  assert.equal((await worker.status()).ready, true);

  // Simulate the browser evicting the data cache under storage pressure.
  await cacheStorage.delete(`az104-offline-data-${fixture.manifest.buildId}`);
  const state = await worker.status();
  assert.equal(state.ready, false);
  assert.equal(state.status, "empty");
});

test("completion broadcasts ready without needing a later STATUS request", async () => {
  const fixture = buildFixture("completion-broadcast");
  const worker = createWorker(createCacheStorage(), createFakeFetch(fixture.files, createServer()));
  const { event, client } = await worker.download("finish");
  await event.wait;
  const last = client.received.at(-1) as { type: string; state: { status: string; ready: boolean } };
  assert.equal(last.type, "STATE");
  assert.equal(last.state.status, "ready");
  assert.equal(last.state.ready, true);
});

test("simultaneous starts reserve one job before the manifest request completes", async () => {
  const fixture = buildFixture("single-job");
  const server = createServer();
  const gate = createGate();
  const fetchBase = createFakeFetch(fixture.files, server);
  let manifestRequests = 0;
  const worker = createWorker(createCacheStorage(), async (input) => {
    if (new URL(requestUrl(input), ORIGIN).pathname === MANIFEST_PATH) {
      manifestRequests++;
      await gate.promise;
    }
    return fetchBase(input);
  });
  const first = await worker.download("first");
  const second = await worker.download("second");
  await flush();
  gate.release();
  await Promise.all([first.event.wait, second.event.wait]);
  assert.equal(manifestRequests, 1);
  assert.equal(server.fetchLog.filter((path) => path.includes("/media/")).length, 784);
});

test("a same-build update repairs corrupted cached bytes instead of trusting a matching cache key", async () => {
  const fixture = buildFixture("cached-corruption");
  const server = createServer();
  const storage = createCacheStorage();
  const worker = createWorker(storage, createFakeFetch(fixture.files, server));
  await (await worker.download("first")).event.wait;
  const path = `/content/${fixture.releaseId}/questions/${fixture.questionIds[0]}.json`;
  await (await storage.open(`az104-offline-data-${fixture.manifest.buildId}`)).put(`${ORIGIN}${path}`, new Response("corrupt"));
  const start = server.fetchLog.length;
  await (await worker.download("repair")).event.wait;
  assert.deepEqual(server.fetchLog.slice(start), [path]);
  server.offline = true;
  assert.deepEqual(await bytesOf((await worker.fetchRequest(path)).response), fixture.files.get(path));
});

test("an unrelated extra cache entry cannot mask an evicted required question", async () => {
  const fixture = buildFixture("masked-eviction");
  const storage = createCacheStorage();
  const worker = createWorker(storage, createFakeFetch(fixture.files, createServer()));
  await (await worker.download("first")).event.wait;
  const cache = await storage.open(`az104-offline-data-${fixture.manifest.buildId}`);
  await cache.delete(`${ORIGIN}/content/${fixture.releaseId}/questions/${fixture.questionIds[0]}.json`);
  await cache.put(`${ORIGIN}/unexpected`, new Response("not a required file"));
  assert.equal((await worker.status()).ready, false);
});

test("a failed descriptor write cannot replace the prior active package", async () => {
  const first = buildFixture("atomic-first");
  const next = buildFixture("atomic-next");
  const storage = createCacheStorage();
  const server = createServer();
  await (await createWorker(storage, createFakeFetch(first.files, server)).download("first")).event.wait;
  const open = storage.open.bind(storage);
  storage.open = async (name: string) => {
    const cache = await open(name);
    const put = cache.put.bind(cache);
    return {
      ...cache,
      async put(request: unknown, response: unknown) {
        if (name === `az104-offline-data-${next.manifest.buildId}` &&
            new URL(requestUrl(request), ORIGIN).pathname === MANIFEST_PATH) {
          throw new Error("Simulated descriptor write failure");
        }
        return put(request, response);
      },
    };
  };
  const worker = createWorker(storage, createFakeFetch(next.files, server));
  await (await worker.download("update")).event.wait;
  const state = await worker.status();
  assert.equal(state.ready, true);
  assert.equal(state.buildId, first.manifest.buildId);
  assert.equal(state.status, "error");
  const descriptor = await worker.fetchRequest(MANIFEST_PATH, { headers: { "X-AZ104-Offline": "1" } });
  assert.deepEqual(await bytesOf(descriptor.response), first.files.get(MANIFEST_PATH));
});

test("online manifests are refreshed while explicit cache-only reads stay pinned", async () => {
  const first = buildFixture("manifest-old");
  const next = buildFixture("manifest-new");
  const storage = createCacheStorage();
  const server = createServer();
  await (await createWorker(storage, createFakeFetch(first.files, server)).download("first")).event.wait;
  const worker = createWorker(storage, createFakeFetch(next.files, server));
  assert.deepEqual(await bytesOf((await worker.fetchRequest(MANIFEST_PATH)).response), next.files.get(MANIFEST_PATH));
  assert.deepEqual(await bytesOf((await worker.fetchRequest("/data/manifest.json")).response), next.files.get("/data/manifest.json"));
  assert.deepEqual(await bytesOf((await worker.fetchRequest("/data/topics.json")).response), next.files.get("/data/topics.json"));
  assert.deepEqual(await bytesOf((await worker.fetchRequest("/data/topics.json",
    { headers: { "X-AZ104-Offline": "1" } })).response), first.files.get("/data/topics.json"));
  assert.deepEqual(await bytesOf((await worker.fetchRequest("/data/manifest.json",
    { headers: { "X-AZ104-Offline": "1" } })).response), first.files.get("/data/manifest.json"));
});

test("cached HTML retains security headers without retaining a stale content-encoding", async () => {
  const fixture = buildFixture("security-headers");
  const server = createServer();
  const fetchBase = createFakeFetch(fixture.files, server);
  const worker = createWorker(createCacheStorage(), async (input) => {
    const response = await fetchBase(input);
    if (new URL(requestUrl(input), ORIGIN).pathname === "/index.html") {
      response.headers.set("Content-Security-Policy", "default-src 'self'");
      response.headers.set("X-Content-Type-Options", "nosniff");
      response.headers.set("Content-Encoding", "gzip");
    }
    return response;
  });
  await (await worker.download("headers")).event.wait;
  server.offline = true;
  const response = (await worker.fetchRequest("/", { mode: "navigate" })).response!;
  assert.equal(response.headers.get("content-security-policy"), "default-src 'self'");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("content-encoding"), null);
});
