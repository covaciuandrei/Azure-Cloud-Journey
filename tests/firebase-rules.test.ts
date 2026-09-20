import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, describe, it } from "node:test";
import { serverTimestamp, setLogLevel } from "firebase/firestore";
import { STUDY_CURRENT_BANK_PATH, STUDY_DATA_ROOT, STUDY_LEARNING_PATH, STUDY_TOPICS_PATH } from "../src/domain/cloud.js";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";

const projectId = "demo-az104-study";
const publicAsset = `published/az104/release-1/assets/${"a".repeat(64)}.png`;
const privateAsset = "private/az104/raw/page-1.json";
const stagingAsset = `staging/az104/release-1/assets/${"a".repeat(64)}.png`;
const protectedAssets = [
  privateAsset,
  stagingAsset,
  "published/az104/release-1/archives/page-1.json",
  "published/az104/release-1/assets/nested/raw.json",
  "published/another-exam/release-1/assets/image.png",
  "unrecognized/image.png",
];
const privateDocuments = [
  "importRuns/run-1",
  "sourceOccurrences/source-1",
  "reviewHistory/review-1",
  "questions/public/reviewHistory/review-1",
  "questions/public/comments/comment-1/private/metadata",
  "catalogs/another-exam",
  "unrecognized/document",
];
const emulatorHosts = {
  firestore: process.env.FIRESTORE_EMULATOR_HOST,
  storage: process.env.FIREBASE_STORAGE_EMULATOR_HOST,
};

function localEmulatorAddress(value: string): { host: string; port: number } {
  const url = new URL(`http://${value}`);
  assert.ok(
    ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname),
    "Rules tests may connect only to local emulators",
  );
  const port = Number(url.port);
  assert.ok(Number.isInteger(port) && port > 0, "An emulator port is required");
  return { host: url.hostname, port };
}

describe(
  "Firebase published-data boundaries",
  { skip: !emulatorHosts.firestore || !emulatorHosts.storage },
  () => {
    let environment: RulesTestEnvironment;

    before(async () => {
      setLogLevel("silent");
      environment = await initializeTestEnvironment({
        projectId,
        firestore: {
          ...localEmulatorAddress(emulatorHosts.firestore!),
          rules: await readFile(new URL("../firestore.rules", import.meta.url), "utf8"),
        },
        storage: {
          ...localEmulatorAddress(emulatorHosts.storage!),
          rules: await readFile(new URL("../storage.rules", import.meta.url), "utf8"),
        },
      });
      await environment.clearFirestore();
      await environment.clearStorage();
      await environment.withSecurityRulesDisabled(async (context) => {
        const firestore = context.firestore();
        const batch = firestore.batch();
        for (const collection of ["questions", "answerKeys"]) {
          batch.set(firestore.doc(`${collection}/public`), { published: true });
          batch.set(firestore.doc(`${collection}/draft`), { published: false });
          batch.set(firestore.doc(`${collection}/missing-flag`), { text: "private" });
          batch.set(firestore.doc(`${collection}/wrong-flag-type`), { published: "true" });
        }
        batch.set(firestore.doc("catalogs/az104"), { published: true });
        batch.set(firestore.doc("questions/public/comments/comment-1"), {
          text: "Visible because the parent is published",
          published: false,
        });
        batch.set(firestore.doc("questions/draft/comments/comment-1"), {
          published: true,
        });
        batch.set(firestore.doc("questions/orphan/comments/comment-1"), {
          published: true,
        });
        for (const path of privateDocuments) {
          batch.set(firestore.doc(path), { published: true });
        }
        await batch.commit();
        for (const path of [publicAsset, ...protectedAssets]) {
          await context.storage().ref(path).putString("synthetic test fixture", "raw");
        }
      });
    });

    after(async () => {
      if (environment) await environment.cleanup();
    });

    it("allows anonymous reads of published questions, keys, and the AZ-104 catalog", async () => {
      const firestore = environment.unauthenticatedContext().firestore();
      for (const path of ["questions/public", "answerKeys/public", "catalogs/az104"]) {
        const result = await assertSucceeds(firestore.doc(path).get());
        assert.equal(result.data()?.published, true);
      }
    });

    it("denies drafts and documents without a boolean true publication flag", async () => {
      const firestore = environment.unauthenticatedContext().firestore();
      for (const collection of ["questions", "answerKeys"]) {
        for (const id of ["draft", "missing-flag", "wrong-flag-type", "absent"]) {
          await assertFails(firestore.doc(`${collection}/${id}`).get());
        }
      }
    });

    it("requires published == true on public question and answer-key list queries", async () => {
      const firestore = environment.unauthenticatedContext().firestore();
      for (const path of ["questions", "answerKeys"]) {
        const collection = firestore.collection(path);
        const result = await assertSucceeds(collection.where("published", "==", true).get());
        assert.deepEqual(result.docs.map((document) => document.id), ["public"]);
        await assertFails(collection.get());
        await assertFails(collection.where("published", "==", false).get());
        await assertFails(collection.where("published", "in", [true, false]).get());
      }
    });

    it("allows comment reads and lists only for a published parent question", async () => {
      const firestore = environment.unauthenticatedContext().firestore();
      await assertSucceeds(firestore.doc("questions/public/comments/comment-1").get());
      const result = await assertSucceeds(
        firestore.collection("questions/public/comments").get(),
      );
      assert.equal(result.size, 1);
      for (const parent of ["draft", "orphan"]) {
        await assertFails(firestore.doc(`questions/${parent}/comments/comment-1`).get());
        await assertFails(firestore.collection(`questions/${parent}/comments`).get());
      }
      await assertFails(firestore.collectionGroup("comments").get());
    });

    it("revokes comment access when its parent is unpublished", async () => {
      await environment.withSecurityRulesDisabled(async (context) => {
        await context.firestore().doc("questions/revocable").set({ published: true });
        await context.firestore().doc("questions/revocable/comments/comment-1").set({
          text: "Publication is controlled by the parent",
        });
      });
      const firestore = environment.unauthenticatedContext().firestore();
      const comment = firestore.doc("questions/revocable/comments/comment-1");
      await assertSucceeds(comment.get({ source: "server" }));
      await environment.withSecurityRulesDisabled(async (context) => {
        await context.firestore().doc("questions/revocable").update({ published: false });
      });
      await assertFails(comment.get({ source: "server" }));
    });

    it("keeps an unpublished catalog private", async () => {
      await environment.withSecurityRulesDisabled(async (context) => {
        await context.firestore().doc("catalogs/az104").update({ published: false });
      });
      await assertFails(
        environment.unauthenticatedContext().firestore().doc("catalogs/az104").get(),
      );
      await environment.withSecurityRulesDisabled(async (context) => {
        await context.firestore().doc("catalogs/az104").update({ published: true });
      });
    });

    it("denies administrative and unspecified paths, including to admin-claim clients", async () => {
      for (const context of [
        environment.unauthenticatedContext(),
        environment.authenticatedContext("claimed-admin", { admin: true }),
      ]) {
        for (const path of [...privateDocuments, "questions/draft", "answerKeys/draft"]) {
          await assertFails(context.firestore().doc(path).get());
        }
      }
    });

    it("denies client study-content writes, regardless of authentication", async () => {
      for (const context of [
        environment.unauthenticatedContext(),
        environment.authenticatedContext("member"),
        environment.authenticatedContext("claimed-admin", { admin: true }),
      ]) {
        const firestore = context.firestore();
        for (const path of [
          "questions/new-question",
          "answerKeys/new-question",
          "questions/public/comments/new-comment",
          "importRuns/new-run",
        ]) {
          await assertFails(firestore.doc(path).set({ published: true }));
        }
        for (const path of [
          "questions/public",
          "questions/draft",
          "answerKeys/public",
          "catalogs/az104",
          "questions/public/comments/comment-1",
          ...privateDocuments,
        ]) {
          await assertFails(firestore.doc(path).update({ published: false }));
          await assertFails(firestore.doc(path).delete());
        }
      }
    });

    it("allows verified users to read only the clean study bank with bounded comment queries", async () => {
      await environment.withSecurityRulesDisabled(async (context) => {
        const batch = context.firestore().batch();
        for (const path of ["catalogs/az104", "questions/q-clean", "answers/q-clean", "comments/c-clean", "reviews/q-clean"]) {
          batch.set(context.firestore().doc(`${STUDY_DATA_ROOT}/${path}`), { questionId: "q-clean", published: false });
        }
        await batch.commit();
      });
      const member = environment.authenticatedContext("alice", { email_verified: true }).firestore();
      for (const path of ["catalogs/az104", "questions/q-clean", "answers/q-clean", "comments/c-clean"]) {
        await assertSucceeds(member.doc(`${STUDY_DATA_ROOT}/${path}`).get());
        await assertFails(environment.unauthenticatedContext().firestore().doc(`${STUDY_DATA_ROOT}/${path}`).get());
        await assertFails(environment.authenticatedContext("unverified", { email_verified: false })
          .firestore().doc(`${STUDY_DATA_ROOT}/${path}`).get());
        await assertFails(member.doc(`${STUDY_DATA_ROOT}/${path}`).set({ published: true }));
      }
      await assertSucceeds(member.collection(`${STUDY_DATA_ROOT}/comments`).where("questionId", "==", "q-clean").limit(100).get());
      await assertFails(member.collection(`${STUDY_DATA_ROOT}/comments`).get());
      await assertFails(member.collection(`${STUDY_DATA_ROOT}/comments`).limit(101).get());
      await assertFails(member.collection(`${STUDY_DATA_ROOT}/questions`).get());
      await assertFails(member.doc(`${STUDY_DATA_ROOT}/reviews/q-clean`).get());
      await assertFails(member.doc(STUDY_DATA_ROOT).get());
      await environment.withSecurityRulesDisabled((context) => context.firestore().doc(STUDY_TOPICS_PATH).set({ schemaVersion: 1 }));
      await assertSucceeds(member.doc(STUDY_TOPICS_PATH).get());
      await assertFails(environment.unauthenticatedContext().firestore().doc(STUDY_TOPICS_PATH).get());
      await assertFails(member.doc(STUDY_TOPICS_PATH).set({ changed: true }));
      await assertFails(member.collection("studyMetadata").get());
    });

    it("isolates account checkpoints/history and rejects malformed or cross-account writes", async () => {
      const alice = environment.authenticatedContext("alice", { email_verified: true }).firestore();
      const bob = environment.authenticatedContext("bob", { email_verified: true }).firestore();
      const anonymous = environment.unauthenticatedContext().firestore();
      const ids = Array.from({ length: 10 }, (_, i) => `q_${String(i).padStart(64, "a")}`);
      const emptyBucket = { correct: 0, incorrect: 0, unanswered: 0, total: 0 };
      const attempt = {
        schemaVersion: 1, id: "owned-session", releaseId: `r_${"a".repeat(64)}`, dataSource: "firebase",
        mode: "free", size: 10, questionIds: ids,
        optionOrders: Object.fromEntries(ids.map((id) => [id, []])),
        responses: Object.fromEntries(ids.map((id) => [id, { selectedIds: [], note: "", submitted: false, flagged: false, selfAssessment: null }])),
        currentIndex: 0, startedAt: 100, deadline: null, finishedAt: null, status: "active", score: null,
      };
      const activePath = "users/alice/state/active";
      const active = { schemaVersion: 1, revision: "revision-1", attempt, updatedAt: serverTimestamp() };
      await assertSucceeds(alice.doc(activePath).set(active));
      await assertSucceeds(alice.doc(activePath).get());
      await assertFails(bob.doc(activePath).get());
      await assertFails(anonymous.doc(activePath).get());
      await assertFails(bob.doc(activePath).set(active));
      await assertFails(alice.doc(activePath).set({ ...active, admin: true }));
      await assertFails(alice.doc(activePath).set({ ...active, updatedAt: 1 }));
      await assertFails(alice.doc(activePath).set({ ...active, attempt: { ...attempt, size: 11 } }));
      const completed = { ...attempt, status: "completed", finishedAt: 1000,
        score: { automatic: { correct: 0, incorrect: 0, unanswered: 10, total: 10 },
          provisional: emptyBucket, manual: emptyBucket, totalQuestions: 10 } };
      const history = { schemaVersion: 1, attempt: completed, finishedAt: 1000,
        updatedAt: serverTimestamp() };
      await assertSucceeds(alice.doc("users/alice/history/owned-session").set(history));
      await assertSucceeds(alice.collection("users/alice/history").orderBy("finishedAt", "desc").limit(20).get());
      await assertFails(alice.collection("users/alice/history").get());
      await assertFails(bob.collection("users/alice/history").limit(20).get());
      await assertFails(alice.doc("users/alice/history/wrong-id").set(history));
      await assertFails(alice.doc("users/alice/history/owned-session").delete());
      await assertFails(alice.doc("users/bob/history/owned-session").set(history));
      await assertFails(alice.doc("users/alice").set({ admin: true }));
    });

    it("keeps published teaching releases read-only and unavailable to anonymous clients", async () => {
      const release = `r_${"a".repeat(64)}`;
      const question = `q_${"b".repeat(64)}`;
      const paths = [
        STUDY_CURRENT_BANK_PATH, STUDY_LEARNING_PATH,
        `studyReleases/${release}/catalogs/az104`, `studyReleases/${release}/questions/${question}`,
        `studyExplanations/${release}/questions/${question}`,
      ];
      await environment.withSecurityRulesDisabled(async (context) => {
        const batch = context.firestore().batch();
        paths.forEach((path) => batch.set(context.firestore().doc(path), { fixture: true }));
        await batch.commit();
      });
      const member = environment.authenticatedContext("reader", { email_verified: true }).firestore();
      for (const path of paths) {
        await assertSucceeds(member.doc(path).get());
        await assertFails(environment.unauthenticatedContext().firestore().doc(path).get());
        await assertFails(member.doc(path).set({ fixture: false }));
        await assertFails(member.doc(path).delete());
      }
      await assertFails(member.collection(`studyExplanations/${release}/questions`).get());
      await assertFails(member.doc("studyExplanations/unapproved/questions/not-a-question").get());
    });

    it("allows anonymous published-asset metadata and token-free media reads", async () => {
      const storage = environment.unauthenticatedContext().storage();
      const metadata = await assertSucceeds(storage.ref(publicAsset).getMetadata());
      const url = `http://${emulatorHosts.storage}/v0/b/${metadata.bucket}/o/${encodeURIComponent(publicAsset)}?alt=media`;
      const response = await fetch(url);
      assert.equal(response.status, 200);
      assert.equal(await response.text(), "synthetic test fixture");
    });

    it("denies staged assets, private archives, and all other media paths", async () => {
      for (const context of [
        environment.unauthenticatedContext(),
        environment.authenticatedContext("claimed-admin", { admin: true }),
      ]) {
        for (const path of protectedAssets) {
          await assertFails(context.storage().ref(path).getMetadata());
          await assertFails(context.storage().ref(path).getDownloadURL());
        }
      }
      for (const path of [privateAsset, stagingAsset]) {
        const bucket = environment.unauthenticatedContext().storage().ref(path).bucket;
        const url = `http://${emulatorHosts.storage}/v0/b/${bucket}/o/${encodeURIComponent(path)}?alt=media`;
        const response = await fetch(url);
        assert.equal(response.status, 403);
      }
    });

    it("denies bucket and prefix listing; public assets are addressed by manifest", async () => {
      const storage = environment.unauthenticatedContext().storage();
      for (const path of ["", "published/az104/release-1/assets", "private/az104"]) {
        await assertFails(storage.ref(path).listAll());
      }
    });

    it("denies client asset creation, mutation, and deletion even with admin claims", async () => {
      for (const context of [
        environment.unauthenticatedContext(),
        environment.authenticatedContext("member"),
        environment.authenticatedContext("claimed-admin", { admin: true }),
      ]) {
        const storage = context.storage();
        await assertFails(
          Promise.resolve(storage.ref("published/az104/release-1/assets/new.png").putString("x")),
        );
        await assertFails(Promise.resolve(storage.ref("private/az104/new.json").putString("x")));
        for (const path of [publicAsset, privateAsset, stagingAsset]) {
          await assertFails(Promise.resolve(storage.ref(path).putString("replacement")));
          await assertFails(storage.ref(path).updateMetadata({ contentType: "text/plain" }));
          await assertFails(storage.ref(path).delete());
        }
      }
    });
  },
);
