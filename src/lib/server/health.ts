/**
 * In-memory data-source statistics (per hour, last 24h). Hourly summaries are
 * also written to the log table by the job runner so they survive restarts.
 */

export interface SourceStat {
  ok: number;
  fail: number;
  totalMs: number;
  lastOkAt: number | null;
  lastFailAt: number | null;
  lastError: string | null;
}

const empty = (): SourceStat => ({ ok: 0, fail: 0, totalMs: 0, lastOkAt: null, lastFailAt: null, lastError: null });

type Bucket = { hour: number; sources: Record<string, SourceStat> };
const g = globalThis as unknown as { __slHealth?: { buckets: Bucket[]; startedAt: number } };
const state = (g.__slHealth ??= { buckets: [], startedAt: Date.now() });

const hourOf = (t: number) => Math.floor(t / 3600_000);

export function recordSource(source: string, ok: boolean, ms: number, error?: string) {
  const now = Date.now();
  const h = hourOf(now);
  let b = state.buckets[state.buckets.length - 1];
  if (!b || b.hour !== h) {
    b = { hour: h, sources: {} };
    state.buckets.push(b);
    while (state.buckets.length > 24) state.buckets.shift();
  }
  const s = (b.sources[source] ??= empty());
  if (ok) {
    s.ok++;
    s.lastOkAt = now;
  } else {
    s.fail++;
    s.lastFailAt = now;
    s.lastError = error?.slice(0, 300) ?? null;
  }
  s.totalMs += ms;
}

/** Aggregate over the last `hours` hours. */
export function sourceSummary(hours = 24): Record<string, SourceStat & { avgMs: number; successRate: number | null }> {
  const minHour = hourOf(Date.now()) - hours + 1;
  const out: Record<string, SourceStat> = {};
  for (const b of state.buckets) {
    if (b.hour < minHour) continue;
    for (const [name, s] of Object.entries(b.sources)) {
      const o = (out[name] ??= empty());
      o.ok += s.ok;
      o.fail += s.fail;
      o.totalMs += s.totalMs;
      if (s.lastOkAt && (!o.lastOkAt || s.lastOkAt > o.lastOkAt)) o.lastOkAt = s.lastOkAt;
      if (s.lastFailAt && (!o.lastFailAt || s.lastFailAt > o.lastFailAt)) {
        o.lastFailAt = s.lastFailAt;
        o.lastError = s.lastError;
      }
    }
  }
  return Object.fromEntries(
    Object.entries(out).map(([k, s]) => {
      const n = s.ok + s.fail;
      return [k, { ...s, avgMs: n ? Math.round(s.totalMs / n) : 0, successRate: n ? Math.round((s.ok / n) * 1000) / 10 : null }];
    }),
  );
}

export const startedAt = () => state.startedAt;
