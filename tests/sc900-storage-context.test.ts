import assert from "node:assert/strict";
import { test } from "node:test";
import { createRunStorageContext, SC900_STORAGE_CONTEXT_MAX_AGE_MS } from "../tools/sc900/upload.js";
import { pacificQuotaDay } from "../tools/publish/quota.js";

const start = Date.parse("2026-09-22T12:00:00.000Z");
function verified(now: number, reservations = { requests: 0, async reserve(count: number) { this.requests += count; } }) {
  const checkedAt = new Date(now).toISOString();
  return { usage: { checkedAt, month: pacificQuotaDay(new Date(now)).slice(0, 7) },
    controls: { checkedAt }, cloud: { checkedAt },
    privacy: { safeForPrivateUploads: true }, reservations };
}

test("minute refreshes reuse the exact live verified Storage context and its increasing reservations", async () => {
  let now = start;
  let loads = 0;
  const journal = { requests: 7, async reserve(count: number) { this.requests += count; } };
  const get = createRunStorageContext(async () => { loads++; return verified(now, journal); }, () => now);
  const first = await get();
  await first.reservations.reserve(3);
  for (const elapsed of [60_000, 120_000, 179_999]) {
    now = start + elapsed;
    assert.equal(await get(), first);
    assert.equal((await get()).privacy, first.privacy);
    await (await get()).reservations.reserve(1);
  }
  assert.equal(loads, 1);
  assert.equal(journal.requests, 13);
  now = start + SC900_STORAGE_CONTEXT_MAX_AGE_MS;
  const refreshed = await get();
  assert.notEqual(refreshed, first);
  assert.equal(loads, 2);
  assert.equal(refreshed.reservations.requests, 13);
});

test("freshness starts at the oldest evidence, not when a slow inventory eventually finishes", async () => {
  let now = start;
  let loads = 0;
  const get = createRunStorageContext(async () => {
    loads++;
    const value = verified(now);
    value.usage.checkedAt = new Date(now - 30_000).toISOString();
    now += 60_000;
    return value;
  }, () => now);
  const first = await get();
  now = start + 149_999;
  assert.equal(await get(), first);
  now = start + 150_000;
  assert.notEqual(await get(), first);
  assert.equal(loads, 2);
  now = start;
  const tooSlow = createRunStorageContext(async () => {
    const value = verified(now);
    now += SC900_STORAGE_CONTEXT_MAX_AGE_MS;
    return value;
  }, () => now);
  await assert.rejects(tooSlow(), /expired/);
});

test("expiry reloads fail closed without reusing stale contexts or resetting journal counters", async () => {
  let now = start;
  let loads = 0;
  const journal = { requests: 21, async reserve(count: number) { this.requests += count; } };
  const get = createRunStorageContext(async () => {
    loads++;
    if (loads === 2) throw new Error("Synthetic privacy refresh failed");
    return verified(now, journal);
  }, () => now);
  await (await get()).reservations.reserve(5);
  now += 180_000;
  await assert.rejects(get(), /Synthetic privacy refresh failed/);
  assert.equal(journal.requests, 26);
  const next = await get();
  assert.equal(loads, 3);
  assert.equal(next.reservations, journal);
  assert.equal(next.reservations.requests, 26);
});

test("stale, future, invalid and cross-month evidence cannot be cached or returned", async () => {
  for (const evidence of ["usage", "controls", "cloud"] as const) {
    for (const checkedAt of ["invalid", new Date(start + 1).toISOString(), new Date(start - 180_000).toISOString()]) {
      const value = verified(start);
      value[evidence].checkedAt = checkedAt;
      await assert.rejects(createRunStorageContext(async () => value, () => start)(), /freshness evidence/);
    }
  }
  let now = Date.parse("2026-10-01T06:59:59.000Z");
  let loads = 0;
  const get = createRunStorageContext(async () => { loads++; return verified(now); }, () => now);
  assert.equal((await get()).usage.month, "2026-09");
  now += 1000;
  assert.equal((await get()).usage.month, "2026-10");
  assert.equal(loads, 2);
  now -= 1;
  await assert.rejects(get(), /moved backwards/);
  await assert.rejects(createRunStorageContext(async () => verified(start), () => NaN)(), /clock/);
});

test("each locked run has an independent cache and concurrent refreshes share one reservation instance", async () => {
  let loads = 0;
  let release: (() => void) | undefined;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const get = createRunStorageContext(async () => { loads++; await wait; return verified(start); }, () => start);
  const first = get();
  const second = get();
  assert.equal(first, second);
  assert.equal(loads, 1);
  release!();
  assert.equal(await first, await second);
  const anotherRun = createRunStorageContext(async () => { loads++; return verified(start); }, () => start);
  assert.notEqual(await anotherRun(), await first);
  assert.equal(loads, 2);
});
