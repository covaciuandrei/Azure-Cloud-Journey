import { applicationDefault, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { z } from "zod";
import { STUDY_PROJECT } from "../../src/domain/cloud.js";
import { inspectFirebaseControls } from "../firebase/preflight.js";
import { digest } from "../ingest/normalize-shared.js";
import { readOptionalData, writeData } from "../review/data.js";
import { acquireUploadLock } from "../publish/quota.js";
import { inspectFirestoreUsage } from "../publish/usage.js";
import { assertPlannedHeadroom, OperationBudget, writeBudgetForUsage } from "../publish/operation-budget.js";
import { learningCloudTarget } from "./cloud-target.js";

const target = await learningCloudTarget();
if (process.argv.slice(2).some((argument) => !["--apply", "--eligibility"].includes(argument))) throw new Error("Usage: learning/sync.ts [--apply] [--eligibility]");
if (process.argv.includes("--eligibility") && !target.publication.eligibility) throw new Error("A reviewed active-bank policy is required.");
if (!process.argv.includes("--apply")) {
  console.log(JSON.stringify({ status: "planned", releaseId: target.publication.manifest.releaseId,
    immutableDocuments: target.immutable.size, pointerDocuments: target.pointers.size,
    maximumWrites: target.immutable.size + target.pointers.size,
    plannedReads: target.immutable.size * 2 + target.pointers.size * 2 }, null, 2));
} else {
  const unlock = await acquireUploadLock(process.cwd());
  try {
    const controls = await inspectFirebaseControls();
    if (!controls.cloudControlsReady) throw new Error(`Cloud safeguards block publication: ${controls.blockers.join("; ")}`);
    const usage = await inspectFirestoreUsage();
    const reads = await OperationBudget.open("reads", usage.reads);
    const writes = await writeBudgetForUsage(usage);
    assertPlannedHeadroom({
      reads: target.immutable.size * 2 + target.pointers.size * 2,
      writes: target.immutable.size + target.pointers.size, deletes: 0,
    }, { reads: reads.remaining(), writes: writes.remaining(), deletes: 0 });
    const database = getFirestore(initializeApp({ projectId: STUDY_PROJECT, credential: applicationDefault() }, "learning-content-sync"));
    const entries = [...target.immutable];
    let created = 0;
    for (let offset = 0; offset < entries.length; offset += 100) {
      const group = entries.slice(offset, offset + 100);
      await reads.reserve(group.length);
      const existing = await database.getAll(...group.map(([path]) => database.doc(path)));
      const batch = database.batch();
      let needed = 0;
      for (let index = 0; index < group.length; index++) {
        const [path, value] = group[index]!;
        const snapshot = existing[index]!;
        if (snapshot.exists) {
          if (digest(snapshot.data()) !== digest(value)) throw new Error(`${path}: immutable content conflict; preserved.`);
        } else {
          batch.create(database.doc(path), value);
          needed++;
        }
      }
      if (needed) {
        if (!(await writes.reserve(needed))) throw new Error("Quota pause before writing learning content.");
        await batch.commit();
        created += needed;
      }
    }
    for (let offset = 0; offset < entries.length; offset += 100) {
      const group = entries.slice(offset, offset + 100);
      await reads.reserve(group.length);
      const verified = await database.getAll(...group.map(([path]) => database.doc(path)));
      if (verified.some((snapshot, index) => !snapshot.exists || digest(snapshot.data()) !== digest(group[index]![1]))) {
        throw new Error("Learning content did not persist exactly; current release was not switched.");
      }
    }
    const previousReceipt = await readOptionalData(".data/learning/cloud-current.json", z.object({
      documents: z.record(z.string(), z.object({ digest: z.string(), seconds: z.number(), nanoseconds: z.number() }).strict()),
    }).passthrough());
    const pointers = [...target.pointers];
    await reads.reserve(pointers.length);
    const existing = await database.getAll(...pointers.map(([path]) => database.doc(path)));
    let update = false;
    for (let index = 0; index < pointers.length; index++) {
      const [path, value] = pointers[index]!;
      const snapshot = existing[index]!;
      if (!snapshot.exists) { update = true; continue; }
      if (digest(snapshot.data()) === digest(value)) continue;
      const receipt = previousReceipt?.documents[path];
      if (!receipt || digest(snapshot.data()) !== receipt.digest ||
          snapshot.updateTime?.seconds !== receipt.seconds || snapshot.updateTime.nanoseconds !== receipt.nanoseconds) {
        throw new Error(`${path}: current-release metadata changed outside this publisher; it was not overwritten.`);
      }
      update = true;
    }
    if (update) {
      if (!(await writes.reserve(pointers.length))) throw new Error("Quota pause before the atomic release switch.");
      const batch = database.batch();
      pointers.forEach(([path, value], index) => {
        const snapshot = existing[index]!;
        if (snapshot.exists) batch.update(database.doc(path), value, { lastUpdateTime: snapshot.updateTime! });
        else batch.create(database.doc(path), value);
      });
      await batch.commit();
    }
    await reads.reserve(pointers.length);
    const verified = await database.getAll(...pointers.map(([path]) => database.doc(path)));
    const documents: Record<string, { digest: string; seconds: number; nanoseconds: number }> = {};
    verified.forEach((snapshot, index) => {
      if (!snapshot.exists || !snapshot.updateTime || digest(snapshot.data()) !== digest(pointers[index]![1])) {
        throw new Error("The current learning release could not be verified.");
      }
      documents[snapshot.ref.path] = {
        digest: digest(snapshot.data()), seconds: snapshot.updateTime.seconds, nanoseconds: snapshot.updateTime.nanoseconds,
      };
    });
    const report = {
      status: "verified", projectId: STUDY_PROJECT, releaseId: target.publication.manifest.releaseId,
      created, pointersUpdated: update ? pointers.length : 0, reservedReads: reads.reservedThisRun,
      reservedWrites: writes.reservedThisRun, documents, checkedAt: new Date().toISOString(),
    };
    await writeData(".data/learning/cloud-current.json", report);
    if (process.argv.includes("--eligibility")) await writeData(".data/eligibility/rollout/cloud-sync.json", report);
    console.log(JSON.stringify(report, null, 2));
  } finally { await unlock(); }
}
