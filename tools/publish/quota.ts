import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { workspacePath } from "../ingest/normalize-shared.js";
import type { WriteBudget } from "./types.js";

const JournalSchema = z.object({
  schemaVersion: z.literal(1),
  days: z.record(z.string(), z.object({ reservedWrites: z.number().int().nonnegative() }).strict()),
}).strict();

export function pacificQuotaDay(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value;
  const year = part("year");
  const month = part("month");
  const day = part("day");
  if (!year || !month || !day) throw new Error("Could not determine the Pacific quota day.");
  return `${year}-${month}-${day}`;
}

export class MemoryWriteBudget implements WriteBudget {
  public reservedThisRun = 0;
  protected currentPauseReason: WriteBudget["pauseReason"] = null;

  public constructor(
    public readonly day: string,
    public readonly dailyLimit: number,
    public readonly runLimit: number,
    public readonly usedBeforeRun = 0,
  ) {
    if (!Number.isSafeInteger(dailyLimit) || dailyLimit < 0 ||
        !Number.isSafeInteger(runLimit) || runLimit < 0 ||
        !Number.isSafeInteger(usedBeforeRun) || usedBeforeRun < 0) {
      throw new Error("Write limits and usage must be non-negative safe integers.");
    }
  }

  public remaining(): number {
    return Math.max(0, Math.min(
      this.runLimit - this.reservedThisRun,
      this.dailyLimit - this.usedBeforeRun - this.reservedThisRun,
    ));
  }

  public get pauseReason(): WriteBudget["pauseReason"] {
    if (this.currentPauseReason) return this.currentPauseReason;
    const runRemaining = Math.max(0, this.runLimit - this.reservedThisRun);
    const dailyRemaining = Math.max(
      0,
      this.dailyLimit - this.usedBeforeRun - this.reservedThisRun,
    );
    if (Math.min(runRemaining, dailyRemaining) > 0) return null;
    return dailyRemaining <= runRemaining ? "daily-limit" : "run-limit";
  }

  public async reserve(count: number): Promise<boolean> {
    if (!Number.isSafeInteger(count) || count < 0) throw new Error("Write reservation must be a non-negative integer.");
    if (count > this.remaining()) {
      const runRemaining = Math.max(0, this.runLimit - this.reservedThisRun);
      const dailyRemaining = Math.max(
        0,
        this.dailyLimit - this.usedBeforeRun - this.reservedThisRun,
      );
      this.currentPauseReason = dailyRemaining <= runRemaining ? "daily-limit" : "run-limit";
      return false;
    }
    this.reservedThisRun += count;
    return true;
  }
}

export class FileWriteBudget extends MemoryWriteBudget {
  private constructor(
    day: string,
    dailyLimit: number,
    runLimit: number,
    usedBeforeRun: number,
    private readonly journalPath: string,
    private readonly clock: () => Date,
  ) {
    super(day, dailyLimit, runLimit, usedBeforeRun);
  }

  public static async open(
    workspace: string,
    dailyLimit: number,
    runLimit: number,
    clockOrNow?: Date | (() => Date),
    journalRelativePath = ".data/upload-journal.json",
  ): Promise<FileWriteBudget> {
    const clock = typeof clockOrNow === "function"
      ? clockOrNow
      : clockOrNow
        ? () => clockOrNow
        : () => new Date();
    const now = clock();
    const path = workspacePath(workspace, journalRelativePath);
    let used = 0;
    try {
      const journal = JournalSchema.parse(JSON.parse(await readFile(path, "utf8")));
      used = journal.days[pacificQuotaDay(now)]?.reservedWrites ?? 0;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    return new FileWriteBudget(pacificQuotaDay(now), dailyLimit, runLimit, used, path, clock);
  }

  private sameQuotaDay(): boolean {
    if (pacificQuotaDay(this.clock()) !== this.day) {
      this.currentPauseReason = "day-rollover";
      return false;
    }
    return true;
  }

  public override remaining(): number {
    return this.sameQuotaDay() ? super.remaining() : 0;
  }

  public override async reserve(count: number): Promise<boolean> {
    if (!this.sameQuotaDay()) return false;
    if (!(await super.reserve(count))) return false;
    let journal: z.infer<typeof JournalSchema> = { schemaVersion: 1, days: {} };
    try {
      journal = JournalSchema.parse(JSON.parse(await readFile(this.journalPath, "utf8")));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const current = journal.days[this.day]?.reservedWrites ?? 0;
    if (current !== this.usedBeforeRun + this.reservedThisRun - count) {
      throw new Error("Upload journal changed concurrently; stop and retry after inspecting the other run.");
    }
    journal.days[this.day] = { reservedWrites: current + count };
    await mkdir(dirname(this.journalPath), { recursive: true });
    const temporary = `${this.journalPath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(journal, null, 2)}\n`, { flag: "wx" });
    await rename(temporary, this.journalPath);
    return true;
  }
}

export async function acquireUploadLock(workspace: string): Promise<() => Promise<void>> {
  const path = workspacePath(workspace, ".data/upload.lock");
  await mkdir(dirname(path), { recursive: true });
  let handle;
  try {
    handle = await open(path, "wx");
    await handle.writeFile(`${process.pid}\n`);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new Error("Another local upload run holds .data/upload.lock.");
    }
    throw error;
  }
  return async () => {
    await handle.close();
    await import("node:fs/promises").then(({ unlink }) => unlink(path));
  };
}
