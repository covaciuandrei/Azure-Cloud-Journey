/*
 * AZ-104 offline download service worker.
 *
 * Plain classic script (no imports, no build step). Registered by the app at
 * scope "/" so it can serve a verified, same-origin snapshot of the app shell,
 * the current release's questions/discussions/media, and any explicitly
 * requested legacy saved-session data while the browser is offline.
 *
 * Contracts implemented here (see src/domain/offline.ts for the shared shape
 * that the manifest generator and the page also honor):
 *  - RPC protocol "az104-offline-v1" over postMessage: STATUS / DOWNLOAD /
 *    CANCEL / REMOVE, replying with a RESULT and broadcasting STATE.
 *  - Manifest contract at /data/offline-manifest.json.
 *  - Cache-only serving for requests carrying "X-AZ104-Offline: 1".
 *  - Network-first navigation with a verified /index.html fallback.
 *  - Cache-first serving of known, hash-verified immutable files.
 */

(function () {
  "use strict";

  var PROTOCOL = "az104-offline-v1";
  var MANIFEST_URL = "/data/offline-manifest.json";
  var OWN_PREFIX = "az104-offline-";
  var META_CACHE = OWN_PREFIX + "meta";
  var MEDIA_CACHE = OWN_PREFIX + "media";
  var DATA_CACHE_PREFIX = OWN_PREFIX + "data-";
  var META_ACTIVE_PATH = "/__az104_offline_meta__/active.json";
  var META_JOB_PATH = "/__az104_offline_meta__/job.json";
  var EXCLUDED_PREFIXES = ["/__/", "/api/", "/auth/", "/users/", "/private/", "/.data/"];
  var CONCURRENCY = 5;
  var BROADCAST_EVERY = 10;
  var PERSIST_EVERY = 25;
  var MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
  var MAX_FILES = 10000;
  var MAX_FILE_BYTES = 16 * 1024 * 1024;
  var MAX_COURSE_BYTES = 4 * 1024 * 1024;
  var MAX_TOTAL_BYTES = 256 * 1024 * 1024;
  var MAX_LEGACY_RELEASES = 20;
  var MAX_LEGACY_QUESTIONS = 606;
  var RETRY_ATTEMPTS = 3;

  var SHA_RE = /^[a-f0-9]{64}$/;
  var RELEASE_RE = /^r_[a-f0-9]{64}$/;
  var QUESTION_RE = /^q_[a-f0-9]{64}$/;
  var SHELL_ASSET_RE = /^\/assets\/[a-zA-Z0-9_.-]+-[a-zA-Z0-9_-]+\.(js|css)$/;
  var MEDIA_PATH_RE = /^\/content\/r_[a-f0-9]{64}\/media\/([a-f0-9]{64})\.(png|jpg|gif|webp)$/;
  var SYNTHETIC_MEDIA_RE = /^\/offline-assets\/([a-f0-9]{64})\.(png|jpg|gif|webp)$/;
  var COURSE_PATH_RE = /^\/courses\/c_[a-f0-9]{64}\/(?:networking|az104)\.json$/;

  // ---------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------

  function isPlainObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  function fail(message) {
    throw new Error(message);
  }

  function extOf(url) {
    var match = /\.([a-zA-Z0-9]+)$/.exec(url);
    return match ? match[1].toLowerCase() : "";
  }

  function mediaKeyPath(sha256, ext) {
    return "/offline-assets/" + sha256 + "." + ext;
  }

  function contentTypeFor(kind, url) {
    var ext = extOf(url);
    if (kind === "image") {
      var images = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
      return images[ext] || "application/octet-stream";
    }
    if (ext === "html") return "text/html; charset=utf-8";
    if (ext === "js") return "text/javascript; charset=utf-8";
    if (ext === "css") return "text/css; charset=utf-8";
    if (ext === "svg") return "image/svg+xml";
    if (ext === "json") return "application/json; charset=utf-8";
    return "application/octet-stream";
  }

  function toHex(digest) {
    var bytes = new Uint8Array(digest);
    var hex = "";
    for (var i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
    return hex;
  }

  function isExcludedPath(pathname) {
    for (var i = 0; i < EXCLUDED_PREFIXES.length; i++) {
      if (pathname.indexOf(EXCLUDED_PREFIXES[i]) === 0) return true;
    }
    return false;
  }

  function metaRequest(path) {
    return new Request(new URL(path, self.location.origin).href);
  }

  function boundedResponseBytes(response, maximum, message) {
    if (!response.body) return Promise.resolve(new ArrayBuffer(0));
    var reader = response.body.getReader();
    var chunks = [];
    var length = 0;
    function next() {
      return reader.read().then(function (result) {
        if (result.done) {
          var bytes = new Uint8Array(length);
          var offset = 0;
          chunks.forEach(function (chunk) { bytes.set(chunk, offset); offset += chunk.byteLength; });
          return bytes.buffer;
        }
        length += result.value.byteLength;
        if (length > maximum) {
          // A cloned cache response can wait for its other branch to cancel.
          reader.cancel().catch(function (error) { console.warn("Could not cancel oversized offline response.", error); });
          throw new RangeError(message);
        }
        chunks.push(result.value);
        return next();
      });
    }
    return next().finally(function () { reader.releaseLock(); });
  }

  // ---------------------------------------------------------------------
  // Manifest contract validation (mirrors src/domain/offline.ts, re-implemented
  // in plain JS because this worker has no import/build step available).
  // ---------------------------------------------------------------------

  function expectedUrlFor(file) {
    if (file.kind === "shell") {
      var expected;
      if (["/index.html", "/favicon.svg", "/offline-worker.js"].indexOf(file.url) !== -1 || SHELL_ASSET_RE.test(file.url)) {
        expected = file.url;
      }
      if (file.releaseId || file.questionId || file.part || file.commentCount !== undefined) expected = undefined;
      return expected;
    }
    if (file.kind === "image") {
      if (file.releaseId && !file.questionId && !file.part && file.commentCount === undefined &&
          new RegExp("^/content/" + file.releaseId + "/media/" + file.sha256 + "\\.(png|jpg|gif|webp)$").test(file.url)) {
        return file.url;
      }
      return undefined;
    }
    // kind === "data"
    if (!file.releaseId) {
      if (!file.part && !file.questionId && file.commentCount === undefined &&
          (["/data/manifest.json", "/data/topics.json", "/data/learning.json", "/data/eligibility.json", "/data/course.json"].indexOf(file.url) !== -1 ||
            COURSE_PATH_RE.test(file.url))) return file.url;
      return undefined;
    }
    if (file.part === "catalog" && !file.questionId && file.commentCount === undefined) {
      return "/content/" + file.releaseId + "/catalog.json";
    }
    if (file.questionId && file.part === "question" && file.commentCount === undefined) {
      return "/content/" + file.releaseId + "/questions/" + file.questionId + ".json";
    }
    if (file.questionId && file.part === "discussion" && file.commentCount !== undefined) {
      return "/content/" + file.releaseId + "/discussions/" + file.questionId + ".json";
    }
    if (file.questionId && file.part === "explanation" && file.commentCount === undefined) {
      return "/teaching/" + file.releaseId + "/questions/" + file.questionId + ".json";
    }
    return undefined;
  }

  function validateFile(file) {
    if (!isPlainObject(file)) fail("Offline manifest file entry is invalid.");
    var allowed = ["url", "sha256", "bytes", "kind", "releaseId", "questionId", "questionIds", "part", "commentCount"];
    var keys = Object.keys(file);
    for (var i = 0; i < keys.length; i++) {
      if (allowed.indexOf(keys[i]) === -1) fail("Offline manifest file entry has an unexpected field.");
    }
    if (typeof file.url !== "string" || !file.url) fail("Offline manifest file is missing a URL.");
    if (!file.url.startsWith("/") || file.url.indexOf("..") !== -1 || file.url.indexOf("%") !== -1 ||
        file.url.indexOf("\\") !== -1 || file.url.indexOf("?") !== -1 || file.url.indexOf("#") !== -1 ||
        file.url.indexOf("//") === 0 || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(file.url)) {
      fail("Offline manifest file path is unsafe.");
    }
    if (typeof file.sha256 !== "string" || !SHA_RE.test(file.sha256)) fail("Offline manifest file has an invalid hash.");
    if (!Number.isInteger(file.bytes) || file.bytes <= 0 || file.bytes > MAX_FILE_BYTES) {
      fail("Offline manifest file size is invalid.");
    }
    if (COURSE_PATH_RE.test(file.url) && file.bytes > MAX_COURSE_BYTES) {
      fail("Course content exceeds the 4 MiB offline limit.");
    }
    if (["shell", "data", "image"].indexOf(file.kind) === -1) fail("Offline manifest file kind is invalid.");
    if (file.releaseId !== undefined && (typeof file.releaseId !== "string" || !RELEASE_RE.test(file.releaseId))) {
      fail("Offline manifest file release id is invalid.");
    }
    if (file.questionId !== undefined && (typeof file.questionId !== "string" || !QUESTION_RE.test(file.questionId))) {
      fail("Offline manifest file question id is invalid.");
    }
    if (file.questionIds !== undefined) {
      if (file.kind !== "image" || !Array.isArray(file.questionIds) ||
          file.questionIds.length < 1 || file.questionIds.length > MAX_LEGACY_QUESTIONS ||
          new Set(file.questionIds).size !== file.questionIds.length ||
          file.questionIds.some(function (id) { return typeof id !== "string" || !QUESTION_RE.test(id); })) {
        fail("Offline image question owners are invalid.");
      }
    }
    if (file.part !== undefined && ["catalog", "question", "discussion", "explanation"].indexOf(file.part) === -1) {
      fail("Offline manifest file part is invalid.");
    }
    if (file.commentCount !== undefined && (!Number.isInteger(file.commentCount) || file.commentCount <= 0)) {
      fail("Offline manifest comment count is invalid.");
    }
    var expected = expectedUrlFor(file);
    if (!expected || expected !== file.url) fail("Offline manifest file is outside the allowed download set.");
  }

  function validateManifestObject(candidate) {
    if (!isPlainObject(candidate)) fail("Offline manifest is invalid.");
    var allowedTop = ["schemaVersion", "buildId", "releaseId", "learningReleaseId", "counts", "files"];
    var topKeys = Object.keys(candidate);
    for (var i = 0; i < topKeys.length; i++) {
      if (allowedTop.indexOf(topKeys[i]) === -1) fail("Offline manifest has an unexpected field.");
    }
    if (candidate.schemaVersion !== 1) fail("Offline manifest schema version is unsupported.");
    if (typeof candidate.buildId !== "string" || !SHA_RE.test(candidate.buildId)) fail("Offline manifest build id is invalid.");
    if (typeof candidate.releaseId !== "string" || !RELEASE_RE.test(candidate.releaseId)) fail("Offline manifest release id is invalid.");
    if (candidate.learningReleaseId !== undefined &&
        (typeof candidate.learningReleaseId !== "string" || !RELEASE_RE.test(candidate.learningReleaseId))) {
      fail("Offline teaching release id is invalid.");
    }
    if (!isPlainObject(candidate.counts) || Object.keys(candidate.counts).length !== 3 ||
        !Number.isInteger(candidate.counts.questions) || candidate.counts.questions < 1 || candidate.counts.questions > 604 ||
        !Number.isInteger(candidate.counts.comments) || candidate.counts.comments < 0 || candidate.counts.comments > 7994 ||
        !Number.isInteger(candidate.counts.images) || candidate.counts.images < 1 || candidate.counts.images > 784) {
      fail("Offline manifest counts do not match the expected release.");
    }
    if (!Array.isArray(candidate.files) || candidate.files.length < 1 || candidate.files.length > MAX_FILES) {
      fail("Offline manifest file list is invalid.");
    }
    var urls = Object.create(null);
    var allQuestionKeys = Object.create(null);
    var allQuestionIds = Object.create(null);
    var totalBytes = 0;
    var hasIndex = false;
    var hasShellScript = false;
    var manifestJsonCount = 0;
    var imageCount = 0;
    var imageHashes = Object.create(null);
    var uniqueImageHashes = 0;
    var imagesOutsideCurrent = false;
    var currentQuestionCount = 0;
    var currentCommentSum = 0;
    var currentCatalogCount = 0;
    var i2;
    for (i2 = 0; i2 < candidate.files.length; i2++) {
      var file = candidate.files[i2];
      validateFile(file);
      if (urls[file.url]) fail("Offline manifest has a duplicate file URL.");
      urls[file.url] = true;
      totalBytes += file.bytes;
      if (file.url === "/index.html") hasIndex = true;
      if (file.kind === "shell" && file.url.indexOf("/assets/") === 0 && file.url.endsWith(".js")) hasShellScript = true;
      if (file.url === "/data/manifest.json") manifestJsonCount++;
      if (file.kind === "image") {
        imageCount++;
        if (!imageHashes[file.sha256]) { imageHashes[file.sha256] = true; uniqueImageHashes++; }
        if (file.releaseId !== candidate.releaseId) imagesOutsideCurrent = true;
      }
      if (file.part === "question") {
        allQuestionKeys[file.releaseId + "/" + file.questionId] = true;
        allQuestionIds[file.questionId] = true;
      }
      if (file.releaseId === candidate.releaseId) {
        if (file.part === "question") currentQuestionCount++;
        if (file.part === "discussion") currentCommentSum += file.commentCount || 0;
        if (file.part === "catalog") currentCatalogCount++;
      }
    }
    if (totalBytes > MAX_TOTAL_BYTES) fail("Offline manifest total size is too large.");
    if (imageCount !== candidate.counts.images) fail("Offline manifest image coverage is incomplete.");
    if (uniqueImageHashes !== candidate.counts.images) fail("Offline manifest has duplicate images.");
    if (imagesOutsideCurrent) fail("Offline manifest images must belong to the current release.");
    if (currentQuestionCount !== candidate.counts.questions) fail("Offline manifest question coverage is incomplete.");
    if (currentCommentSum !== candidate.counts.comments) fail("Offline manifest comment coverage is incomplete.");
    if (currentCatalogCount !== 1) fail("Offline manifest is missing the current catalog.");
    if (!hasIndex) fail("Offline manifest is missing the application shell.");
    if (!hasShellScript) fail("Offline manifest is missing a compiled application script.");
    if (manifestJsonCount !== 1) fail("Offline manifest is missing the public data manifest.");
    for (i2 = 0; i2 < candidate.files.length; i2++) {
      var discussion = candidate.files[i2];
      if (discussion.part === "discussion" && !allQuestionKeys[discussion.releaseId + "/" + discussion.questionId]) {
        fail("Offline manifest has a discussion without a matching question.");
      }
      if (discussion.questionIds && discussion.questionIds.some(function (id) { return !allQuestionIds[id]; })) {
        fail("Offline image references an unknown question.");
      }
    }
  }

  function validateLegacyRefs(legacyRefsRaw) {
    if (legacyRefsRaw === undefined || legacyRefsRaw === null) return [];
    if (!Array.isArray(legacyRefsRaw) || legacyRefsRaw.length > MAX_LEGACY_RELEASES) {
      fail("The requested saved sessions are invalid.");
    }
    for (var i = 0; i < legacyRefsRaw.length; i++) {
      var ref = legacyRefsRaw[i];
      if (!isPlainObject(ref)) fail("The requested saved sessions are invalid.");
      var keys = Object.keys(ref);
      if (keys.length !== 2 || keys.indexOf("releaseId") === -1 || keys.indexOf("questionIds") === -1) {
        fail("The requested saved sessions are invalid.");
      }
      if (typeof ref.releaseId !== "string" || !RELEASE_RE.test(ref.releaseId)) fail("The requested saved sessions are invalid.");
      if (!Array.isArray(ref.questionIds) || ref.questionIds.length > MAX_LEGACY_QUESTIONS) {
        fail("The requested saved sessions are invalid.");
      }
      for (var j = 0; j < ref.questionIds.length; j++) {
        if (typeof ref.questionIds[j] !== "string" || !QUESTION_RE.test(ref.questionIds[j])) {
          fail("The requested saved sessions are invalid.");
        }
      }
    }
    return legacyRefsRaw;
  }

  function selectFiles(manifest, legacyRefs) {
    var selected = Object.create(null);
    var neededIds = Object.create(null);
    manifest.files.forEach(function (file) {
      if (file.part === "question" && file.releaseId === manifest.releaseId) neededIds[file.questionId] = true;
    });
    for (var i = 0; i < legacyRefs.length; i++) {
      var ref = legacyRefs[i];
      var set = selected[ref.releaseId] || {};
      for (var j = 0; j < ref.questionIds.length; j++) {
        set[ref.questionIds[j]] = true;
        neededIds[ref.questionIds[j]] = true;
      }
      selected[ref.releaseId] = set;
    }
    var releaseIds = Object.keys(selected);
    for (var r = 0; r < releaseIds.length; r++) {
      var releaseId = releaseIds[r];
      var hasCatalog = manifest.files.some(function (f) { return f.releaseId === releaseId && f.part === "catalog"; });
      if (!hasCatalog) fail("A saved session's snapshot is unavailable for download.");
      var ids = Object.keys(selected[releaseId]);
      for (var q = 0; q < ids.length; q++) {
        var id = ids[q];
        var hasQuestion = manifest.files.some(function (f) {
          return f.releaseId === releaseId && f.questionId === id && f.part === "question";
        });
        if (!hasQuestion) fail("A saved question is unavailable for download.");
      }
    }
    return manifest.files.filter(function (file) {
      if (file.kind === "image") return !file.questionIds || file.questionIds.some(function (id) { return neededIds[id]; });
      if (file.part === "explanation" && manifest.learningReleaseId) {
        return file.releaseId === manifest.learningReleaseId && Boolean(neededIds[file.questionId]);
      }
      if (file.kind === "shell") return true;
      if (!file.releaseId) return true;
      if (file.releaseId === manifest.releaseId) return true;
      var set = selected[file.releaseId];
      if (!set) return false;
      return file.part === "catalog" || Boolean(set[file.questionId]);
    });
  }

  function buildPlan(files) {
    return files.map(function (file) {
      var ext = extOf(file.url);
      var isImage = file.kind === "image";
      return {
        url: file.url,
        sha256: file.sha256,
        bytes: file.bytes,
        kind: file.kind,
        cacheKey: isImage ? mediaKeyPath(file.sha256, ext) : file.url,
      };
    });
  }

  // ---------------------------------------------------------------------
  // Cache Storage helpers
  // ---------------------------------------------------------------------

  function openMeta() { return self.caches.open(META_CACHE); }
  function openMedia() { return self.caches.open(MEDIA_CACHE); }
  function openData(name) { return self.caches.open(name); }

  function readMetaJson(path) {
    return openMeta().then(function (cache) { return cache.match(metaRequest(path)); }).then(function (match) {
      if (!match) return null;
      return match.json().catch(function () { throw new Error("Offline metadata could not be read. Remove the download and try again."); });
    });
  }

  function writeMetaJson(path, value) {
    return openMeta().then(function (cache) {
      return cache.put(metaRequest(path), new Response(JSON.stringify(value), {
        status: 200, headers: { "content-type": "application/json; charset=utf-8" },
      }));
    });
  }

  function deleteMetaKey(path) {
    return openMeta().then(function (cache) { return cache.delete(metaRequest(path)); });
  }

  function storeManifestDescriptor(cacheName, rawBytes) {
    return openData(cacheName).then(function (cache) {
      return cache.put(metaRequest(MANIFEST_URL), new Response(rawBytes, {
        status: 200, headers: { "content-type": "application/json; charset=utf-8" },
      }));
    });
  }

  // ---------------------------------------------------------------------
  // Active (installed, complete) package index
  // ---------------------------------------------------------------------

  var activeIndexCache = null;

  function loadActiveIndex(forceReload) {
    if (activeIndexCache && !forceReload) return Promise.resolve(activeIndexCache);
    return readMetaJson(META_ACTIVE_PATH).then(function (meta) {
      if (!meta) { activeIndexCache = null; return null; }
      var filesByUrl = Object.create(null);
      var mediaBySha = Object.create(null);
      for (var i = 0; i < meta.files.length; i++) {
        var file = meta.files[i];
        if (file.kind === "image") mediaBySha[file.sha256] = { ext: extOf(file.url) };
        else filesByUrl[file.url] = file;
      }
      activeIndexCache = {
        buildId: meta.buildId, releaseId: meta.releaseId, updatedAt: meta.updatedAt,
        totalFiles: meta.totalFiles, totalBytes: meta.totalBytes, dataCacheName: meta.dataCacheName,
        files: meta.files, filesByUrl: filesByUrl, mediaBySha: mediaBySha,
      };
      return activeIndexCache;
    });
  }

  function verifyActiveIntegrity(index) {
    return self.caches.has(index.dataCacheName).then(function (hasData) {
      if (!hasData) return false;
      return openData(index.dataCacheName).then(function (dataCache) {
        return dataCache.keys().then(function (keys) {
          var presentData = Object.create(null);
          for (var k = 0; k < keys.length; k++) presentData[new URL(keys[k].url).pathname] = true;
          var expectedPaths = Object.keys(index.filesByUrl).concat([MANIFEST_URL]);
          if (expectedPaths.some(function (path) { return !presentData[path]; })) return false;
          var shas = Object.keys(index.mediaBySha);
          if (shas.length === 0) return true;
          return self.caches.has(MEDIA_CACHE).then(function (hasMedia) {
            if (!hasMedia) return false;
            return openMedia().then(function (mediaCache) {
              return mediaCache.keys().then(function (mediaKeys) {
                var present = Object.create(null);
                for (var i = 0; i < mediaKeys.length; i++) present[new URL(mediaKeys[i].url).pathname] = true;
                for (var s = 0; s < shas.length; s++) {
                  var sha = shas[s];
                  if (!present[mediaKeyPath(sha, index.mediaBySha[sha].ext)]) return false;
                }
                return true;
              });
            });
          });
        });
      });
    });
  }

  function clearActiveMeta() {
    activeIndexCache = null;
    return deleteMetaKey(META_ACTIVE_PATH);
  }

  function sweepOrphanMedia(activeMeta) {
    return self.caches.has(MEDIA_CACHE).then(function (hasMedia) {
      if (!hasMedia) return;
      return openMedia().then(function (mediaCache) {
        return mediaCache.keys().then(function (keys) {
          var keep = Object.create(null);
          if (activeMeta) {
            for (var i = 0; i < activeMeta.files.length; i++) {
              var file = activeMeta.files[i];
              if (file.kind === "image") keep[mediaKeyPath(file.sha256, extOf(file.url))] = true;
            }
          }
          var deletions = [];
          for (var k = 0; k < keys.length; k++) {
            var pathname = new URL(keys[k].url).pathname;
            if (!keep[pathname]) deletions.push(mediaCache.delete(keys[k]));
          }
          return Promise.all(deletions);
        });
      });
    });
  }

  function lookupActiveCacheResponse(pathname) {
    return loadActiveIndex(false).then(function (index) {
      if (!index) return undefined;
      if (pathname === MANIFEST_URL) {
        return openData(index.dataCacheName).then(function (cache) { return cache.match(metaRequest(MANIFEST_URL)); });
      }
      var media = MEDIA_PATH_RE.exec(pathname) || SYNTHETIC_MEDIA_RE.exec(pathname);
      if (media) {
        var sha = media[1];
        var ext = media[2];
        var info = index.mediaBySha[sha];
        if (!info || info.ext !== ext) return undefined;
        return openMedia().then(function (cache) { return cache.match(metaRequest(mediaKeyPath(sha, ext))); });
      }
      var file = index.filesByUrl[pathname];
      if (!file) return undefined;
      return openData(index.dataCacheName).then(function (cache) { return cache.match(metaRequest(pathname)); });
    });
  }

  // ---------------------------------------------------------------------
  // State reporting
  // ---------------------------------------------------------------------

  function emptyState() {
    return {
      status: "empty", ready: false, buildId: null, releaseId: null,
      totalFiles: 0, completedFiles: 0, totalBytes: 0, completedBytes: 0,
      downloadBytes: 0, error: null, updatedAt: null,
    };
  }

  function buildState(status, activeSnapshot, job) {
    if (job) {
      return {
        status: status,
        ready: Boolean(activeSnapshot),
        buildId: activeSnapshot ? activeSnapshot.buildId : null,
        releaseId: activeSnapshot ? activeSnapshot.releaseId : null,
        totalFiles: job.totalFiles, completedFiles: job.completedFiles,
        totalBytes: job.totalBytes, completedBytes: job.completedBytes,
        downloadBytes: job.downloadBytes,
        error: status === "error" ? (job.error || "The offline download failed.") : null,
        updatedAt: job.updatedAt,
      };
    }
    return {
      status: status,
      ready: Boolean(activeSnapshot),
      buildId: activeSnapshot ? activeSnapshot.buildId : null,
      releaseId: activeSnapshot ? activeSnapshot.releaseId : null,
      totalFiles: activeSnapshot ? activeSnapshot.totalFiles : 0,
      completedFiles: activeSnapshot ? activeSnapshot.totalFiles : 0,
      totalBytes: activeSnapshot ? activeSnapshot.totalBytes : 0,
      completedBytes: activeSnapshot ? activeSnapshot.totalBytes : 0,
      downloadBytes: 0, error: null,
      updatedAt: activeSnapshot ? activeSnapshot.updatedAt : null,
    };
  }

  function computeStatus() {
    return loadActiveIndex(false).then(function (index) {
      if (!index) return { activeSnapshot: null };
      return verifyActiveIntegrity(index).then(function (ok) {
        if (ok) return { activeSnapshot: index };
        return clearActiveMeta().then(function () { return { activeSnapshot: null }; });
      });
    }).then(function (result) {
      var activeSnapshot = result.activeSnapshot;
      if (currentJob) return buildState("downloading", activeSnapshot, currentJob.state);
      return readMetaJson(META_JOB_PATH).then(function (persisted) {
        if (persisted) {
          if (persisted.status === "error") return buildState("error", activeSnapshot, persisted);
          return buildState("paused", activeSnapshot, persisted);
        }
        if (activeSnapshot) return buildState("ready", activeSnapshot, null);
        return emptyState();
      });
    });
  }

  // ---------------------------------------------------------------------
  // Download job lifecycle
  // ---------------------------------------------------------------------

  var currentJob = null; // { controller, state, plan, priorActive, rawManifestBytes, promise }
  var removing = false;

  function cachedHeaders(response, entry) {
    var headers = { "content-type": contentTypeFor(entry.kind, entry.url) };
    ["content-security-policy", "referrer-policy", "x-content-type-options", "x-frame-options"].forEach(function (name) {
      var value = response.headers.get(name);
      if (value) headers[name] = value;
    });
    return headers;
  }

  function progressState(job) {
    return {
      status: "downloading",
      ready: job.priorActive.ready, buildId: job.priorActive.buildId, releaseId: job.priorActive.releaseId,
      totalFiles: job.state.totalFiles, completedFiles: job.state.completedFiles,
      totalBytes: job.state.totalBytes, completedBytes: job.state.completedBytes,
      downloadBytes: job.state.downloadBytes, error: null, updatedAt: job.state.updatedAt,
    };
  }

  function errorState(job) {
    var state = progressState(job);
    state.status = "error";
    state.error = job.state.error;
    return state;
  }

  function persistJob(job) {
    return writeMetaJson(META_JOB_PATH, {
      status: job.state.status, error: job.state.error,
      buildId: job.state.buildId, releaseId: job.state.releaseId, dataCacheName: job.state.dataCacheName,
      totalFiles: job.state.totalFiles, totalBytes: job.state.totalBytes,
      completedFiles: job.state.completedFiles, completedBytes: job.state.completedBytes,
      downloadBytes: job.state.downloadBytes,
      startedAt: job.state.startedAt, updatedAt: job.state.updatedAt,
    });
  }

  function broadcast(state) {
    return self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        list[i].postMessage({ protocol: PROTOCOL, type: "STATE", state: state });
      }
    });
  }

  function fetchAndValidateManifest(signal) {
    return Promise.resolve().then(function () {
      return fetch(MANIFEST_URL, { cache: "no-store", redirect: "error", credentials: "omit", signal: signal });
    }).catch(function () {
      throw new Error("The offline manifest could not be reached.");
    }).then(function (response) {
      if (!response.ok) throw new Error("This app build does not provide an offline download.");
      return boundedResponseBytes(response, MAX_MANIFEST_BYTES, "Offline manifest is too large.");
    }).then(function (buffer) {
      if (buffer.byteLength > MAX_MANIFEST_BYTES) throw new Error("Offline manifest is too large.");
      var candidate;
      try { candidate = JSON.parse(new TextDecoder().decode(buffer)); }
      catch (parseError) { throw new Error("Offline manifest is not valid JSON."); }
      validateManifestObject(candidate);
      return { manifest: candidate, rawBytes: buffer };
    });
  }

  function fetchAndVerify(job, entry) {
    var attempt = 0;
    var headers;
    function tryOnce() {
      attempt++;
      if (job.controller.cancelled) return Promise.reject(new Error("The offline download was cancelled."));
      return fetch(entry.url, { cache: "no-store", redirect: "error", credentials: "omit", signal: job.controller.signal }).then(function (response) {
        if (!response.ok) throw new Error("Offline download failed for " + entry.url + " (HTTP " + response.status + ").");
        headers = cachedHeaders(response, entry);
        return boundedResponseBytes(response, entry.bytes, "Offline download size mismatch for " + entry.url + ".");
      }).then(function (buffer) {
        if (buffer.byteLength !== entry.bytes) throw new Error("Offline download size mismatch for " + entry.url + ".");
        return crypto.subtle.digest("SHA-256", buffer).then(function (digest) {
          if (toHex(digest) !== entry.sha256) throw new Error("Offline download hash mismatch for " + entry.url + ".");
          return { buffer: buffer, headers: headers };
        });
      }).catch(function (error) {
        if (attempt >= RETRY_ATTEMPTS || job.controller.cancelled) throw error;
        return tryOnce();
      });
    }
    return tryOnce();
  }

  function processEntry(job, entry) {
    var cacheName = entry.kind === "image" ? MEDIA_CACHE : job.state.dataCacheName;
    function verifiedBytes(response) {
      if (!response) return Promise.resolve(null);
      return boundedResponseBytes(response, entry.bytes, "Cached offline file exceeds its size limit.").then(function (buffer) {
        if (buffer.byteLength !== entry.bytes) return null;
        return crypto.subtle.digest("SHA-256", buffer).then(function (digest) {
          return toHex(digest) === entry.sha256 ? { buffer: buffer, headers: cachedHeaders(response, entry) } : null;
        });
      }).catch(function (error) {
        if (error instanceof RangeError) return null;
        throw error;
      });
    }
    return openData(cacheName).then(function (cache) {
      var key = metaRequest(entry.cacheKey);
      return cache.match(key).then(verifiedBytes).then(function (existing) {
        if (existing) return null;
        var previous = job.activeSource && entry.kind !== "image" && job.activeSource.dataCacheName !== cacheName
          ? openData(job.activeSource.dataCacheName).then(function (old) { return old.match(key); }).then(verifiedBytes)
          : Promise.resolve(null);
        return previous.then(function (reused) {
          if (reused) return { payload: reused, downloaded: false };
          return fetchAndVerify(job, entry).then(function (payload) { return { payload: payload, downloaded: true }; });
        }).then(function (result) {
          if (job.controller.cancelled) throw new Error("The offline download was cancelled.");
          var response = new Response(result.payload.buffer, { status: 200, headers: result.payload.headers });
          return cache.put(key, response).then(function () { if (result.downloaded) job.state.downloadBytes += entry.bytes; });
        });
      });
    }).then(function () {
      job.state.completedFiles += 1;
      job.state.completedBytes += entry.bytes;
      job.state.updatedAt = Date.now();
      job.sinceBroadcast += 1;
      job.sincePersist += 1;
      if (job.controller.cancelled) return null;
      var work = [];
      if (job.sinceBroadcast >= BROADCAST_EVERY) { job.sinceBroadcast = 0; work.push(broadcast(progressState(job))); }
      if (job.sincePersist >= PERSIST_EVERY) { job.sincePersist = 0; work.push(persistJob(job)); }
      return Promise.all(work);
    });
  }

  function finalizeCancelled(job) {
    return Promise.all([readMetaJson(META_ACTIVE_PATH), readMetaJson(META_JOB_PATH)]).then(function (records) {
      var active = records[0];
      var name = job.state.dataCacheName || (records[1] && records[1].dataCacheName);
      var deleteStaging = typeof name === "string" && name.indexOf(DATA_CACHE_PREFIX) === 0 &&
          (!active || active.dataCacheName !== name)
        ? self.caches.delete(name)
        : Promise.resolve();
      return deleteStaging.then(function () { return deleteMetaKey(META_JOB_PATH); })
        .then(function () { return sweepOrphanMedia(active); });
    });
  }

  function finalizeSuccess(job) {
    if (job.controller.cancelled) return finalizeCancelled(job);
    var activeMeta = {
      buildId: job.state.buildId, releaseId: job.state.releaseId, updatedAt: Date.now(),
      totalFiles: job.state.totalFiles, totalBytes: job.state.totalBytes, dataCacheName: job.state.dataCacheName,
      files: job.plan.map(function (f) { return { url: f.url, sha256: f.sha256, bytes: f.bytes, kind: f.kind }; }),
    };
    return storeManifestDescriptor(job.state.dataCacheName, job.rawManifestBytes)
      .then(function () {
        if (job.controller.cancelled) return finalizeCancelled(job).then(function () { return false; });
        job.committing = true;
        return writeMetaJson(META_ACTIVE_PATH, activeMeta).then(function () { return true; });
      })
      .then(function (committed) {
        if (!committed) return;
        activeIndexCache = null;
        return deleteMetaKey(META_JOB_PATH).then(function () { return self.caches.keys(); }).then(function (names) {
          return Promise.all(names.filter(function (name) {
            return name.indexOf(DATA_CACHE_PREFIX) === 0 && name !== activeMeta.dataCacheName;
          }).map(function (name) { return self.caches.delete(name); }));
        }).then(function () { return sweepOrphanMedia(activeMeta); });
      });
  }

  function runJob(job) {
    var concurrency = Math.max(1, Math.min(CONCURRENCY, job.plan.length || 1));
    var index = 0;
    function pullNext() { return index < job.plan.length ? job.plan[index++] : null; }
    function worker() {
      if (job.controller.cancelled || job.state.status === "error") return Promise.resolve();
      var entry = pullNext();
      if (!entry) return Promise.resolve();
      return processEntry(job, entry).then(worker, function (error) {
        if (job.state.status !== "error") {
          job.state.status = "error";
          job.state.error = error instanceof Error ? error.message : "The offline download failed.";
          job.state.updatedAt = Date.now();
          return persistJob(job).then(function () { return broadcast(errorState(job)); });
        }
        return null;
      });
    }
    var workers = [];
    for (var i = 0; i < concurrency; i++) workers.push(worker());
    return Promise.all(workers).then(function () {
      if (job.controller.cancelled) return finalizeCancelled(job);
      if (job.state.status === "error") return null;
      return finalizeSuccess(job);
    });
  }

  function handleDownload(legacyRefsRaw, respond) {
    var legacyRefs = validateLegacyRefs(legacyRefsRaw);
    if (removing) throw new Error("The previous offline copy is being removed. Try again when removal finishes.");
    if (currentJob) return computeStatus().then(respond);
    var abort = new AbortController();
    var job = {
      controller: { cancelled: false, signal: abort.signal, abort: function () { abort.abort(); } },
      plan: [], rawManifestBytes: null, priorActive: emptyState(), activeSource: null,
      sinceBroadcast: 0, sincePersist: 0, promise: null, committing: false,
      state: {
        buildId: null, releaseId: null, dataCacheName: null, totalFiles: 0, totalBytes: 0,
        completedFiles: 0, completedBytes: 0, downloadBytes: 0,
        error: null, status: "downloading", startedAt: Date.now(), updatedAt: Date.now(),
      },
    };
    var acknowledged = false;
    function acknowledge(state) { if (!acknowledged) { acknowledged = true; respond(state); } }
    currentJob = job;
    job.promise = Promise.resolve().then(function () { return fetchAndValidateManifest(abort.signal); }).then(function (result) {
      var manifest = result.manifest;
      var files = selectFiles(manifest, legacyRefs);
      var plan = buildPlan(files);
      return Promise.all([loadActiveIndex(true), readMetaJson(META_JOB_PATH)]).then(async function (saved) {
        var active = saved[0];
        if (active && !(await verifyActiveIntegrity(active))) {
          await clearActiveMeta();
          active = null;
        }
        var interrupted = saved[1];
        var dataCacheName = DATA_CACHE_PREFIX + manifest.buildId;
        if (interrupted && interrupted.buildId === manifest.buildId &&
            typeof interrupted.dataCacheName === "string" && interrupted.dataCacheName.indexOf(DATA_CACHE_PREFIX + manifest.buildId) === 0 &&
            (!active || interrupted.dataCacheName !== active.dataCacheName)) {
          dataCacheName = interrupted.dataCacheName;
        } else if (active && active.dataCacheName === dataCacheName) {
          dataCacheName += "-stage-" + Date.now();
        }
        var totalBytes = 0;
        for (var i = 0; i < plan.length; i++) totalBytes += plan[i].bytes;
        job.plan = plan;
        job.rawManifestBytes = result.rawBytes;
        job.activeSource = active;
        job.priorActive = buildState(active ? "ready" : "empty", active, null);
        Object.assign(job.state, {
          buildId: manifest.buildId, releaseId: manifest.releaseId, dataCacheName: dataCacheName,
          totalFiles: plan.length, totalBytes: totalBytes,
        });
        if (job.controller.cancelled) return finalizeCancelled(job);
        return persistJob(job).then(function () {
          var initialState = progressState(job);
          acknowledge(initialState);
          return broadcast(initialState);
        }).then(function () {
          return runJob(job);
        });
      });
    }).catch(function (error) {
      if (job.controller.cancelled && !job.committing) return finalizeCancelled(job);
      if (!acknowledged) throw error;
      job.state.status = "error";
      job.state.error = error instanceof Error ? error.message : "The offline download failed.";
      return persistJob(job);
    }).then(function () {
      currentJob = null;
      return computeStatus().then(function (state) { acknowledge(state); return broadcast(state); });
    }, function (error) {
      currentJob = null;
      throw error;
    });
    return job.promise;
  }

  function cancelJob() {
    if (currentJob) {
      if (!currentJob.committing) { currentJob.controller.cancelled = true; currentJob.controller.abort(); }
      return currentJob.promise.then(function () {
        return computeStatus().then(function (state) { return broadcast(state).then(function () { return state; }); });
      });
    }
    return readMetaJson(META_JOB_PATH).then(function (persisted) {
      if (!persisted) return computeStatus();
      return readMetaJson(META_ACTIVE_PATH).then(function (active) {
        var deleteStaging = typeof persisted.dataCacheName === "string" &&
            persisted.dataCacheName.indexOf(DATA_CACHE_PREFIX) === 0 &&
            (!active || active.dataCacheName !== persisted.dataCacheName)
          ? self.caches.delete(persisted.dataCacheName)
          : Promise.resolve();
        return deleteStaging.then(function () { return deleteMetaKey(META_JOB_PATH); })
          .then(function () { return sweepOrphanMedia(active); })
          .then(function () { return computeStatus(); });
      });
    }).then(function (state) { return broadcast(state).then(function () { return state; }); });
  }

  function removeAll() {
    removing = true;
    var wait;
    if (currentJob) {
      if (!currentJob.committing) { currentJob.controller.cancelled = true; currentJob.controller.abort(); }
      wait = currentJob.promise;
    } else {
      wait = Promise.resolve();
    }
    return wait.then(function () { return self.caches.keys(); }).then(function (names) {
      var deletions = [];
      for (var i = 0; i < names.length; i++) {
        if (names[i].indexOf(OWN_PREFIX) === 0) deletions.push(self.caches.delete(names[i]));
      }
      return Promise.all(deletions);
    }).then(function () {
      activeIndexCache = null;
      var state = emptyState();
      return broadcast(state).then(function () { return state; });
    }).finally(function () { removing = false; });
  }

  // ---------------------------------------------------------------------
  // RPC message handling
  // ---------------------------------------------------------------------

  self.addEventListener("message", function (event) {
    var data = event.data;
    if (!data || typeof data !== "object" || data.protocol !== PROTOCOL) return;
    var source = event.source;
    var id = typeof data.id === "string" ? data.id : undefined;
    function respond(state, error) {
      if (!source || typeof source.postMessage !== "function") return;
      var message = { protocol: PROTOCOL, type: "RESULT", id: id, state: state };
      if (error) message.error = error;
      source.postMessage(message);
    }
    var task = Promise.resolve().then(function () {
      if (typeof id !== "string" || !id) throw new Error("The offline request is missing an id.");
      if (["STATUS", "DOWNLOAD", "CANCEL", "REMOVE"].indexOf(data.type) === -1) {
        throw new Error("Unknown offline request.");
      }
      if (data.type === "DOWNLOAD") return handleDownload(data.legacyRefs, respond);
      if (data.type === "STATUS") return computeStatus().then(respond);
      if (data.type === "CANCEL") return cancelJob().then(function (state) { respond(state); });
      return removeAll().then(function (state) { respond(state); });
    }).catch(function (error) {
      var message = error instanceof Error ? error.message : "The offline request failed.";
      return computeStatus().catch(function () { return emptyState(); }).then(function (state) {
        respond(state, message);
      });
    });
    event.waitUntil(task);
  });

  // ---------------------------------------------------------------------
  // Install / activate lifecycle
  // ---------------------------------------------------------------------

  self.addEventListener("install", function (event) {
    event.waitUntil(self.skipWaiting());
  });

  self.addEventListener("activate", function (event) {
    event.waitUntil(self.clients.claim().then(function () {
      activeIndexCache = null;
      return Promise.all([readMetaJson(META_ACTIVE_PATH), readMetaJson(META_JOB_PATH)]).then(function (results) {
        var active = results[0];
        var job = results[1];
        var keep = { };
        keep[META_CACHE] = true;
        keep[MEDIA_CACHE] = true;
        if (active) keep[active.dataCacheName] = true;
        if (job) keep[job.dataCacheName] = true;
        return self.caches.keys().then(function (names) {
          var deletions = [];
          for (var i = 0; i < names.length; i++) {
            if (names[i].indexOf(OWN_PREFIX) === 0 && !keep[names[i]]) deletions.push(self.caches.delete(names[i]));
          }
          return Promise.all(deletions);
        });
      });
    }));
  });

  // ---------------------------------------------------------------------
  // Fetch handling
  // ---------------------------------------------------------------------

  function unavailableResponse(pathname) {
    return new Response(JSON.stringify({ error: "offline-unavailable", path: pathname }), {
      status: 503, headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  function handleOfflineOnly(pathname) {
    return lookupActiveCacheResponse(pathname).then(function (hit) {
      return hit || unavailableResponse(pathname);
    });
  }

  function handleKnownAsset(request, pathname) {
    return lookupActiveCacheResponse(pathname).then(function (hit) {
      return hit || fetch(request);
    });
  }

  function handleNavigation(request) {
    return fetch(request).catch(function (error) {
      return lookupActiveCacheResponse("/index.html").then(function (hit) {
        if (hit) return hit;
        throw error;
      });
    });
  }

  self.addEventListener("fetch", function (event) {
    var request = event.request;
    if (request.method !== "GET") return;
    var url;
    try { url = new URL(request.url); } catch (error) { return; }
    if (url.origin !== self.location.origin) return;
    if (isExcludedPath(url.pathname)) return;
    var offlineOnly = request.headers.get("X-AZ104-Offline") === "1";
    if (offlineOnly) { event.respondWith(handleOfflineOnly(url.pathname)); return; }
    if (request.mode === "navigate") { event.respondWith(handleNavigation(request)); return; }
    if (url.pathname === MANIFEST_URL || url.pathname === "/data/manifest.json" ||
        url.pathname === "/data/topics.json" || url.pathname === "/data/learning.json" ||
        url.pathname === "/data/eligibility.json" || url.pathname === "/data/course.json") {
      event.respondWith(fetch(request).catch(function () { return handleOfflineOnly(url.pathname); }));
      return;
    }
    event.respondWith(handleKnownAsset(request, url.pathname));
  });
})();
