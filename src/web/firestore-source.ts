import {
  collection, doc, documentId, getDocFromServer, getDocsFromServer,
  limit, orderBy, query, startAfter, where, type QueryDocumentSnapshot,
} from "firebase/firestore";
import { STUDY_CURRENT_BANK_PATH, STUDY_DATA_ROOT, STUDY_LEARNING_PATH, STUDY_TOPICS_PATH } from "../domain/cloud.js";
import { getFirebaseClients } from "./firebase-client.js";
import type { StudyCloudReader } from "./firestore-repository.js";

export function createStudyCloudReader(uid: string): StudyCloudReader {
  const authorize = () => {
    const clients = getFirebaseClients();
    if (!uid || clients.auth.currentUser?.uid !== uid) throw new Error("Sign in to load the Firestore question bank.");
    return clients.firestore;
  };
  return {
    async document(path) {
      if (!path.startsWith(`${STUDY_DATA_ROOT}/`) && ![STUDY_TOPICS_PATH, STUDY_CURRENT_BANK_PATH, STUDY_LEARNING_PATH].includes(path) &&
          !/^studyReleases\/r_[a-f0-9]{64}\/(?:catalogs\/az104|questions\/q_[a-f0-9]{64})$/.test(path) &&
          !/^studyExplanations\/r_[a-f0-9]{64}\/questions\/q_[a-f0-9]{64}$/.test(path)) {
        throw new Error("Unapproved study document path.");
      }
      const snapshot = await getDocFromServer(doc(authorize(), path));
      if (!snapshot.exists()) throw new Error("The Firestore study document is missing.");
      return snapshot.data();
    },
    async comments(questionId, expectedCount) {
      if (!Number.isSafeInteger(expectedCount) || expectedCount < 0 || expectedCount > 7994) {
        throw new Error("Invalid expected discussion size.");
      }
      const comments: unknown[] = [];
      let after: QueryDocumentSnapshot | undefined;
      while (comments.length < expectedCount) {
        const pageSize = Math.min(100, expectedCount - comments.length);
        const constraints = [where("questionId", "==", questionId), orderBy(documentId()), limit(pageSize)];
        const page = await getDocsFromServer(query(
          collection(authorize(), `${STUDY_DATA_ROOT}/comments`),
          ...constraints, ...(after ? [startAfter(after)] : []),
        ));
        if (page.empty) throw new Error("The Firestore discussion ended before all retained comments were loaded.");
        comments.push(...page.docs.map((snapshot) => snapshot.data()));
        after = page.docs.at(-1);
      }
      return comments;
    },
  };
}
