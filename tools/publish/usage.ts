import { applicationDefault } from "firebase-admin/app";
import { pacificQuotaDay } from "./quota.js";
import { UPLOAD_PROJECT_ID } from "./types.js";

export interface FirestoreUsage {
  checkedAt: string;
  pacificDay: string;
  periodStart: string;
  reads: number;
  writes: number;
  deletes: number;
}

export function pacificDayStart(now: Date): Date {
  const target = pacificQuotaDay(now);
  let low = Date.parse(`${target}T00:00:00Z`) - 12 * 3_600_000;
  let high = low + 36 * 3_600_000;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (pacificQuotaDay(new Date(middle)) < target) low = middle;
    else high = middle;
  }
  return new Date(high);
}

export async function inspectFirestoreUsage(now = new Date()): Promise<FirestoreUsage> {
  const { access_token } = await applicationDefault().getAccessToken();
  const start = pacificDayStart(now).toISOString();
  const totals = { reads: 0, writes: 0, deletes: 0 };
  for (const [kind, metric] of [
    ["reads", "read_count"], ["writes", "write_count"], ["deletes", "delete_count"],
  ] as const) {
    let pageToken = "";
    do {
      const url = new URL(`https://monitoring.googleapis.com/v3/projects/${UPLOAD_PROJECT_ID}/timeSeries`);
      url.searchParams.set("filter", `metric.type="firestore.googleapis.com/document/${metric}"`);
      url.searchParams.set("interval.startTime", start);
      url.searchParams.set("interval.endTime", now.toISOString());
      url.searchParams.set("aggregation.alignmentPeriod", "60s");
      url.searchParams.set("aggregation.perSeriesAligner", "ALIGN_SUM");
      url.searchParams.set("aggregation.crossSeriesReducer", "REDUCE_SUM");
      url.searchParams.set("pageSize", "100000");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${access_token}`, "x-goog-user-project": UPLOAD_PROJECT_ID },
        signal: AbortSignal.timeout(30_000),
      });
      const body = await response.json() as {
        timeSeries?: Array<{ points?: Array<{ value: { int64Value?: string; doubleValue?: number } }> }>;
        nextPageToken?: string;
        error?: { message?: string };
      };
      if (!response.ok) throw new Error(`Firestore usage inspection failed: ${response.status} ${body.error?.message ?? response.statusText}`);
      for (const series of body.timeSeries ?? []) {
        for (const point of series.points ?? []) {
          const count = Number(point.value.int64Value ?? point.value.doubleValue);
          if (!Number.isFinite(count) || count < 0) throw new Error("Firestore usage returned an invalid count.");
          totals[kind] += count;
        }
      }
      pageToken = body.nextPageToken ?? "";
    } while (pageToken);
  }
  return { checkedAt: now.toISOString(), pacificDay: pacificQuotaDay(now), periodStart: start, ...totals };
}
