import { applicationDefault, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { z } from "zod";
import { STUDY_PROJECT, STUDY_TOPICS_PATH } from "../../src/domain/cloud.js";
import { readTopicMap } from "./data.js";
import { digest } from "../ingest/normalize-shared.js";
import { readOptionalData, writeData } from "../review/data.js";
import { inspectFirebaseControls } from "../firebase/preflight.js";
import { inspectFirestoreUsage } from "../publish/usage.js";
import { OperationBudget, writeBudgetForUsage } from "../publish/operation-budget.js";
import { acquireUploadLock } from "../publish/quota.js";

const map = await readTopicMap();
const hash = digest(map);
const apply = process.argv.includes("--apply");
if (process.argv.slice(2).some((arg) => arg !== "--apply")) throw new Error("Usage: topics/sync.ts [--apply]");
if (!apply) {
  console.log(JSON.stringify({ status: "planned", path: STUDY_TOPICS_PATH, assignments: Object.keys(map.assignments).length,
    maximumWrites: 1, maximumReads: 2, digest: hash }, null, 2));
} else {
  const unlock = await acquireUploadLock(process.cwd());
  try {
    const controls = await inspectFirebaseControls();
    if (!controls.cloudControlsReady) throw new Error(`Cloud controls block topic sync: ${controls.blockers.join("; ")}`);
    const usage = await inspectFirestoreUsage();
    const reads = await OperationBudget.open("reads", usage.reads);
    const writes = await writeBudgetForUsage(usage);
    if (reads.remaining() < 2 || writes.remaining() < 1) throw new Error("Quota pause: topic sync does not fit today's remaining headroom.");
    const database = getFirestore(initializeApp({ projectId: STUDY_PROJECT, credential: applicationDefault() }, "topic-metadata-sync"));
    const ref = database.doc(STUDY_TOPICS_PATH);
    await reads.reserve(1);
    const existing = await ref.get();
    let changed = false;
    if (!existing.exists) {
      if (!(await writes.reserve(1))) throw new Error("Quota pause before creating topic metadata.");
      await ref.create(map);
      changed = true;
    } else if (digest(existing.data()) !== hash) {
      const receipt = await readOptionalData(".data/topics/cloud-receipt.json", z.object({
        digest: z.string(), updatedAt: z.string(),
      }).passthrough());
      if (!receipt || digest(existing.data()) !== receipt.digest || existing.updateTime?.toDate().toISOString() !== receipt.updatedAt) {
        throw new Error("Remote topic metadata differs from the last verified upload; it was not overwritten.");
      }
      if (!(await writes.reserve(1))) throw new Error("Quota pause before updating topic metadata.");
      await ref.update(map, { lastUpdateTime: existing.updateTime! });
      changed = true;
    }
    await reads.reserve(1);
    const verified = await ref.get();
    if (!verified.exists || digest(verified.data()) !== hash || !verified.updateTime) throw new Error("Topic metadata did not persist correctly.");
    const report = { status: "verified", projectId: STUDY_PROJECT, path: STUDY_TOPICS_PATH,
      assignments: Object.keys(map.assignments).length, digest: hash,
      updatedAt: verified.updateTime.toDate().toISOString(), changed, writes: changed ? 1 : 0, reservedReads: 2 };
    await writeData(".data/topics/cloud-receipt.json", report);
    console.log(JSON.stringify(report, null, 2));
  } finally { await unlock(); }
}
