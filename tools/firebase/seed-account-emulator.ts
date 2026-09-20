import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { loadCurrentStudyTarget } from "../learning/cloud-target.js";
import { readTopicMap } from "../topics/data.js";
import { STUDY_TOPICS_PATH } from "../../src/domain/cloud.js";

if (process.env.FIRESTORE_EMULATOR_HOST !== "127.0.0.1:8080" ||
    process.env.FIREBASE_AUTH_EMULATOR_HOST !== "127.0.0.1:9099") {
  throw new Error("This fixture seeder may only use the two local emulators.");
}
const app = initializeApp({ projectId: "study-az104" }, "study-account-emulator-fixtures");
const firestore = getFirestore(app);
const target = [...await loadCurrentStudyTarget()];
target.push([STUDY_TOPICS_PATH, await readTopicMap()]);
for (let offset = 0; offset < target.length; offset += 400) {
  const batch = firestore.batch();
  for (const [path, data] of target.slice(offset, offset + 400)) batch.set(firestore.doc(path), data);
  await batch.commit();
}
for (const name of ["alice", "bob"]) {
  await getAuth(app).createUser({
    uid: `${name}-local-fixture`, email: `${name}@example.test`, emailVerified: true,
    password: "local-emulator-only", displayName: `Local ${name}`,
  });
}
console.log(JSON.stringify({ emulatorOnly: true, studyDocuments: target.length, syntheticUsers: 2 }));
