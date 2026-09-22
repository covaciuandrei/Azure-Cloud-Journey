import {
  collection, doc, documentId, getDocFromServer, getDocsFromServer,
  limit, orderBy, query, startAfter, where, type QueryDocumentSnapshot,
} from "firebase/firestore";
import { STUDY_CURRENT_BANK_PATH, STUDY_DATA_ROOT, STUDY_LEARNING_PATH, STUDY_TOPICS_PATH } from "../domain/cloud.js";
import { getFirebaseClients } from "./firebase-client.js";
import type { StudyCloudReader } from "./firestore-repository.js";
import { ExamIdSchema, type ExamId } from "../domain/exams.js";
import { decodeSc900CloudEnvelope } from "../domain/sc900Cloud.js";

export function approvedStudyPath(path: string, examId: ExamId): boolean {
  ExamIdSchema.parse(examId);
  if (examId === "sc900") {
    return /^studyMetadata\/sc900(?:Topics|Bank|Learning)$/.test(path) ||
      /^studyBanks\/sc900\/releases\/r_[a-f0-9]{64}\/(?:catalogs\/sc900|questions\/q_[a-f0-9]{64}|explanations\/q_[a-f0-9]{64})$/.test(path);
  }
  return path.startsWith(`${STUDY_DATA_ROOT}/`) || [STUDY_TOPICS_PATH, STUDY_CURRENT_BANK_PATH, STUDY_LEARNING_PATH].includes(path) ||
    /^studyReleases\/r_[a-f0-9]{64}\/(?:catalogs\/az104|questions\/q_[a-f0-9]{64})$/.test(path) ||
    /^studyExplanations\/r_[a-f0-9]{64}\/questions\/q_[a-f0-9]{64}$/.test(path);
}

export function createStudyCloudReader(uid: string, examId: ExamId = "az104"): StudyCloudReader {
  ExamIdSchema.parse(examId);
  const authorize = () => {
    const clients = getFirebaseClients();
    if (!uid || clients.auth.currentUser?.uid !== uid) throw new Error("Sign in to load the Firestore question bank.");
    return clients.firestore;
  };
  return {
    async document(path) {
      if (!approvedStudyPath(path, examId)) {
        throw new Error("Unapproved study document path.");
      }
      const snapshot = await getDocFromServer(doc(authorize(), path));
      if (!snapshot.exists()) throw new Error("The Firestore study document is missing.");
      return examId === "sc900" && path.startsWith("studyBanks/")
        ? decodeSc900CloudEnvelope(snapshot.data()) : snapshot.data();
    },
    async comments(questionId, expectedCount, releaseId) {
      if (!/^q_[a-f0-9]{64}$/.test(questionId) ||
          !Number.isSafeInteger(expectedCount) || expectedCount < 0 || expectedCount > (examId === "az104" ? 7994 : 20_000)) {
        throw new Error("Invalid expected discussion size.");
      }
      if (examId === "sc900" && !/^r_[a-f0-9]{64}$/.test(releaseId ?? "")) {
        throw new Error("An explicit SC-900 release is required for discussion reads.");
      }
      const root = examId === "sc900" ? `studyBanks/sc900/releases/${releaseId}` : STUDY_DATA_ROOT;
      const comments: unknown[] = [];
      let after: QueryDocumentSnapshot | undefined;
      while (comments.length < expectedCount) {
        const pageSize = Math.min(100, expectedCount - comments.length);
        const constraints = [where("questionId", "==", questionId), orderBy(documentId()), limit(pageSize)];
        const page = await getDocsFromServer(query(
          collection(authorize(), `${root}/comments`),
          ...constraints, ...(after ? [startAfter(after)] : []),
        ));
        if (page.empty) throw new Error("The Firestore discussion ended before all retained comments were loaded.");
        comments.push(...await Promise.all(page.docs.map((snapshot) => examId === "sc900"
          ? decodeSc900CloudEnvelope(snapshot.data()) : snapshot.data())));
        after = page.docs.at(-1);
      }
      return comments;
    },
  };
}
