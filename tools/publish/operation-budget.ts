import { readFile } from "node:fs/promises";
import { z } from "zod";
import { readOptionalData, writeData } from "../review/data.js";
import { workspacePath } from "../ingest/normalize-shared.js";
import { FileWriteBudget, pacificQuotaDay } from "./quota.js";
import type { FirestoreUsage } from "./usage.js";

export const SAFE_READ_LIMIT = 45_000;
export const SAFE_DELETE_LIMIT = 18_000;
export const SAFE_WRITE_LIMIT = 18_000;

const schema = z.object({
  schemaVersion: z.literal(1),
  days: z.record(z.string(), z.object({
    reservedReads: z.number().int().nonnegative(),
    reservedDeletes: z.number().int().nonnegative(),
  }).strict()),
}).strict();

export class OperationBudget {
  public reservedThisRun = 0;
  private constructor(
    public readonly kind: "reads" | "deletes",
    public readonly day: string,
    public readonly baseline: number,
    public readonly limit: number,
    private readonly ownedBefore: number,
    private readonly workspace: string,
    private readonly clock: () => Date,
  ) {}

  public static async open(
    kind: "reads" | "deletes", observed: number, workspace = process.cwd(),
    clock = () => new Date(),
  ): Promise<OperationBudget> {
    if (!Number.isSafeInteger(observed) || observed < 0) throw new Error("Invalid observed operation usage.");
    const day = pacificQuotaDay(clock());
    const journal = await readOptionalData(".data/operation-journal.json", schema, workspace);
    const owned = journal?.days[day]?.[kind === "reads" ? "reservedReads" : "reservedDeletes"] ?? 0;
    return new OperationBudget(kind, day, Math.max(observed, owned),
      kind === "reads" ? SAFE_READ_LIMIT : SAFE_DELETE_LIMIT, owned, workspace, clock);
  }

  public remaining(): number {
    if (pacificQuotaDay(this.clock()) !== this.day) return 0;
    return Math.max(0, this.limit - this.baseline - this.reservedThisRun);
  }

  public async reserve(count: number): Promise<void> {
    if (!Number.isSafeInteger(count) || count < 0) throw new Error("Invalid operation reservation.");
    if (count === 0) return;
    if (count > this.remaining()) throw new Error(`Quota pause: insufficient ${this.kind} headroom on Pacific ${this.day}.`);
    const journal = await readOptionalData(".data/operation-journal.json", schema, this.workspace) ??
      { schemaVersion: 1 as const, days: {} };
    const key = this.kind === "reads" ? "reservedReads" : "reservedDeletes";
    const current = journal.days[this.day] ?? { reservedReads: 0, reservedDeletes: 0 };
    const expected = this.reservedThisRun === 0 ? this.ownedBefore : this.baseline + this.reservedThisRun;
    if (current[key] !== expected) {
      throw new Error("Operation journal changed concurrently; stop before making more requests.");
    }
    this.reservedThisRun += count;
    journal.days[this.day] = { ...current, [key]: this.baseline + this.reservedThisRun };
    await writeData(".data/operation-journal.json", journal, this.workspace);
  }
}

export async function writeBudgetForUsage(usage: FirestoreUsage, workspace = process.cwd()) {
  if (usage.pacificDay !== pacificQuotaDay(new Date()) ||
      Date.now() - Date.parse(usage.checkedAt) > 5 * 60_000 ||
      !Number.isSafeInteger(usage.writes) || usage.writes < 0) {
    throw new Error("Fresh valid usage from the current Pacific quota day is required.");
  }
  let own = 0;
  try {
    const value = JSON.parse(await readFile(workspacePath(workspace, ".data/upload-journal.json"), "utf8")) as {
      days: Record<string, { reservedWrites: number }>;
    };
    own = value.days[usage.pacificDay]?.reservedWrites ?? 0;
  } catch (error) {
    if (!(error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
  }
  const extraObserved = Math.max(0, usage.writes - own);
  return FileWriteBudget.open(workspace, Math.max(0, SAFE_WRITE_LIMIT - extraObserved), SAFE_WRITE_LIMIT);
}

export function assertPlannedHeadroom(
  planned: { reads: number; writes: number; deletes: number },
  available: { reads: number; writes: number; deletes: number },
): void {
  for (const kind of ["reads", "writes", "deletes"] as const) {
    if (!Number.isSafeInteger(planned[kind]) || planned[kind] < 0 ||
        !Number.isSafeInteger(available[kind]) || available[kind] < 0) {
      throw new Error("Operation counts must be nonnegative safe integers.");
    }
    if (planned[kind] > available[kind]) throw new Error(`Quota pause: planned ${planned[kind]} ${kind}, only ${available[kind]} available.`);
  }
}
