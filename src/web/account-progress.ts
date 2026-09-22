import {
  collection,
  doc,
  getDocFromServer,
  getDocsFromServer,
  limit,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
} from "firebase/firestore";
import { getFirebaseClients } from "./firebase-client.js";
import {
  createAccountProgressService,
  validateAccountUid,
  validateProgressExamId,
  type AccountProgress,
} from "./account/progress-service.js";
import type { PracticeAttempt } from "./engine.js";
import type { ExamId } from "../domain/exams.js";

export {
  ProgressConflictError,
  ProgressIdentityError,
  ProgressValidationError,
  type AccountProgress,
} from "./account/progress-service.js";

function progressService() {
  const { auth, firestore } = getFirebaseClients();
  return createAccountProgressService({
    currentUser: () => auth.currentUser,
    async readDocument(path) {
      const snapshot = await getDocFromServer(doc(firestore, path));
      return snapshot.exists() ? { id: snapshot.id, data: snapshot.data() } : null;
    },
    async readHistory(path, count) {
      const snapshots = await getDocsFromServer(
        query(collection(firestore, path), orderBy("finishedAt", "desc"), limit(count)),
      );
      return snapshots.docs.map((snapshot) => ({ id: snapshot.id, data: snapshot.data() }));
    },
    transaction: (operation) => runTransaction(firestore, async (transaction) => operation({
      async get(path) {
        const snapshot = await transaction.get(doc(firestore, path));
        return snapshot.exists() ? { id: snapshot.id, data: snapshot.data() } : null;
      },
      set: (path, data) => { transaction.set(doc(firestore, path), data); },
    })),
    newRevision: () => crypto.randomUUID(),
    serverTimestamp,
  });
}

export async function loadAccountProgress(uid: string, examId: ExamId = "az104"): Promise<AccountProgress> {
  validateAccountUid(uid);
  validateProgressExamId(examId);
  return progressService().loadAccountProgress(uid, examId);
}

export async function saveAccountAttempt(
  uid: string,
  attempt: PracticeAttempt,
  expectedRevision: string | null,
  examId: ExamId = "az104",
): Promise<{ revision: string }> {
  validateAccountUid(uid);
  validateProgressExamId(examId);
  return progressService().saveAccountAttempt(uid, attempt, expectedRevision, examId);
}
