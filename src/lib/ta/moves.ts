import type { Candle } from "../types.ts";
import { MMR } from "./plan.ts";

/**
 * How big a move is, measured against the coin's own history: percentile ranks, how often a move of a size
 * happened, the biggest ones, and how often a day's wick would have reached a leveraged position's liquidation.
 * Description only: E19c found no provable direction after the biggest 24-hour moves, only that the next few
 * days swing more than usual. Shared by the 涨跌统计 page and its tests.
 */

/** Size buckets of the frequency table, in %: 0–1, 1–2, …, 10 and above. */
export const MOVE_EDGES = [0, 1, 2, 3, 5, 8, 10];
/** Leverage rows of the liquidation table. */
export const LEVERAGES = [3, 5, 10, 20, 50];
/** Days a position is held in the second column of the leverage table. */
export const HOLD_DAYS = 7;
/** Rank bands: below each bound (in %) the band name. */
export const BANDS: { below: number; name: MoveBand }[] = [
  { below: 50, name: "平常" },
  { below: 80, name: "偏大" },
  { below: 95, name: "大" },
  { below: 99, name: "很大" },
  { below: Infinity, name: "极端" },
];
export type MoveBand = "平常" | "偏大" | "大" | "很大" | "极端";

/** Fixed sentences the page may say about direction; nothing else on the page talks about it. */
export const MOVE_FACTS = {
  direction: "研究（E19c）：24 小时涨跌进入本币最大的 5% 之后，接下来 3 天往哪走，和平时随机的 3 天没有可证明的差别。",
  notSignal: "这一页只描述波动有多大、多常见，用来定止损距离、杠杆和仓位，不说明接下来往哪走。",
};

export interface Move {
  /** open time of the bar the move ends in (Unix seconds) */
  t: number;
  /** close against the close `k` bars earlier, % */
  pct: number;
}

/** Close-to-close changes over `k` bars, only where the bars are contiguous (`k * barSec` apart). */
export function changes(c: Candle[], k: number, barSec: number): Move[] {
  const out: Move[] = [];
  for (let i = k; i < c.length; i++) if (c[i].t - c[i - k].t === k * barSec && c[i - k].c > 0) out.push({ t: c[i].t, pct: (c[i].c / c[i - k].c - 1) * 100 });
  return out;
}

/** Each day's range against the previous close, %, for contiguous days. */
export function dailyRanges(d: Candle[]): Move[] {
  const out: Move[] = [];
  for (let i = 1; i < d.length; i++) if (d[i].t - d[i - 1].t === 86400 && d[i - 1].c > 0) out.push({ t: d[i].t, pct: ((d[i].h - d[i].l) / d[i - 1].c) * 100 });
  return out;
}

/** Ascending sizes |pct|. */
export const sortedAbs = (m: Move[]) => m.map((x) => Math.abs(x.pct)).sort((a, b) => a - b);

/** First index with value ≥ x in an ascending array. */
function lowerBound(arr: number[], x: number): number {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Share of the history smaller than x, % (one decimal); null without history. */
export function pctRank(sorted: number[], x: number): number | null {
  if (!sorted.length) return null;
  return Math.round((lowerBound(sorted, x) / sorted.length) * 1000) / 10;
}

/** Linear-interpolated quantile of an ascending array. */
export function quantile(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  const p = (sorted.length - 1) * q;
  const i = Math.floor(p);
  return i + 1 < sorted.length ? sorted[i] + (sorted[i + 1] - sorted[i]) * (p - i) : sorted[i];
}

export function bandOf(rank: number | null): MoveBand | null {
  if (rank == null) return null;
  return BANDS.find((b) => rank < b.below)!.name;
}

export interface Freq {
  n: number;
  /** share of all samples, % */
  share: number;
  /** on average one every this many seconds (samples × step / n); null when it never happened */
  everySec: number | null;
  /** the latest sample in it (bar open time) */
  last: number | null;
}

function freq(hits: Move[], total: number, stepSec: number): Freq {
  const n = hits.length;
  return {
    n,
    share: total ? Math.round((n / total) * 10000) / 100 : 0,
    everySec: n ? (total * stepSec) / n : null,
    last: n ? Math.max(...hits.map((x) => x.t)) : null,
  };
}

/** How often a move at least as big as x, in the same direction, happened. */
export function atLeast(m: Move[], x: number, stepSec: number): Freq {
  return freq(m.filter((y) => (x < 0 ? y.pct <= x : y.pct >= x)), m.length, stepSec);
}

export interface BucketRow {
  lo: number;
  /** null: open-ended */
  hi: number | null;
  down: Freq;
  up: Freq;
}

/** The frequency table: drops and rises by size bucket (a move of exactly 0 counts on neither side). */
export function bucketTable(m: Move[], stepSec: number, edges = MOVE_EDGES): BucketRow[] {
  return edges.map((lo, k) => {
    const hi = k + 1 < edges.length ? edges[k + 1] : null;
    const inside = (x: number) => x >= lo && (hi == null || x < hi);
    return {
      lo,
      hi,
      down: freq(m.filter((y) => y.pct < 0 && inside(-y.pct)), m.length, stepSec),
      up: freq(m.filter((y) => y.pct > 0 && inside(y.pct)), m.length, stepSec),
    };
  });
}

export interface Typical {
  n: number;
  from: number | null;
  /** quantiles of the size |pct| */
  p50: number | null;
  p90: number | null;
  p95: number | null;
  p99: number | null;
  maxDown: Move | null;
  maxUp: Move | null;
}

export function typical(m: Move[]): Typical {
  const s = sortedAbs(m);
  let maxDown: Move | null = null, maxUp: Move | null = null;
  for (const x of m) {
    if (x.pct < 0 && (!maxDown || x.pct < maxDown.pct)) maxDown = x;
    if (x.pct > 0 && (!maxUp || x.pct > maxUp.pct)) maxUp = x;
  }
  return { n: m.length, from: m.length ? m[0].t : null, p50: quantile(s, 0.5), p90: quantile(s, 0.9), p95: quantile(s, 0.95), p99: quantile(s, 0.99), maxDown, maxUp };
}

/** The `n` biggest moves in one direction, at least `gapSec` apart (so one crash counts once). */
export function topMoves(m: Move[], n: number, dir: 1 | -1, gapSec: number): Move[] {
  const sorted = m.filter((x) => x.pct * dir > 0).sort((a, b) => (b.pct - a.pct) * dir);
  const out: Move[] = [];
  for (const x of sorted) {
    if (out.length >= n) break;
    if (out.some((y) => Math.abs(y.t - x.t) < gapSec)) continue;
    out.push(x);
  }
  return out;
}

/** Close-to-close change from the bar at `t` to `k` bars later, %, for each k; null past the end. */
export function after(c: Candle[], t: number, ks: number[]): (number | null)[] {
  const i = c.findIndex((x) => x.t === t);
  return ks.map((k) => (i < 0 || i + k >= c.length ? null : (c[i + k].c / c[i].c - 1) * 100));
}

export interface LevSide {
  /** share of start days on which the wick reached the liquidation price within the hold, % */
  share: number;
  everySec: number | null;
  last: number | null;
}

export interface LevRow {
  lev: number;
  /** adverse move from the entry that liquidates, % */
  liqPct: number;
  /** opened at the day's open, within that UTC day */
  day: { long: LevSide; short: LevSide };
  /** opened at a day's open, held HOLD_DAYS days */
  week: { long: LevSide; short: LevSide };
}

/** Liquidation distance for an isolated position (fees and funding ignored), %. */
export const liqPct = (lev: number, mmr = MMR) => (1 / lev - mmr) * 100;

/**
 * For each leverage: how often a position opened at a UTC day's open would have been liquidated by the wick,
 * within that day and within HOLD_DAYS days. Wicks, not closes: the exchange liquidates on the price touched.
 */
export function leverageTable(d: Candle[], levs = LEVERAGES, hold = HOLD_DAYS, mmr = MMR): LevRow[] {
  // worst adverse excursion from each day's open: [down %, up %], over 1 day and over `hold` days
  const ex = (span: number) => {
    const out: { t: number; dn: number; up: number }[] = [];
    for (let i = 0; i + span <= d.length; i++) {
      if (d[i + span - 1].t - d[i].t !== (span - 1) * 86400 || !(d[i].o > 0)) continue;
      let lo = Infinity, hi = -Infinity;
      for (let j = i; j < i + span; j++) (lo = Math.min(lo, d[j].l)), (hi = Math.max(hi, d[j].h));
      out.push({ t: d[i].t, dn: (1 - lo / d[i].o) * 100, up: (hi / d[i].o - 1) * 100 });
    }
    return out;
  };
  const one = ex(1), many = ex(hold);
  const side = (rows: typeof one, liq: number, key: "dn" | "up"): LevSide => {
    const hits = rows.filter((r) => r[key] >= liq);
    return {
      share: rows.length ? Math.round((hits.length / rows.length) * 10000) / 100 : 0,
      everySec: hits.length ? (rows.length * 86400) / hits.length : null,
      last: hits.length ? hits[hits.length - 1].t : null,
    };
  };
  return levs.map((lev) => {
    const liq = liqPct(lev, mmr);
    return { lev, liqPct: Math.round(liq * 100) / 100, day: { long: side(one, liq, "dn"), short: side(one, liq, "up") }, week: { long: side(many, liq, "dn"), short: side(many, liq, "up") } };
  });
}

/** The worst (most negative) close-to-close change over `k` days, with the day it started from. */
export function worstSpan(d: Candle[], k: number): { pct: number; from: number; to: number } | null {
  let best: { pct: number; from: number; to: number } | null = null;
  for (let i = k; i < d.length; i++) {
    if (d[i].t - d[i - k].t !== k * 86400) continue;
    const pct = (d[i].c / d[i - k].c - 1) * 100;
    if (!best || pct < best.pct) best = { pct, from: d[i - k].t, to: d[i].t };
  }
  return best;
}

/**
 * After the days whose move was in the coin's biggest `tail` share in one direction, the average size of the
 * next `days` daily moves against the average size of every day: how much more the market swung afterwards.
 */
export function swingAfter(m: Move[], dir: 1 | -1, tail = 0.05, days = 3): { ratio: number; n: number } | null {
  if (m.length < 200) return null;
  const all = m.reduce((s, x) => s + Math.abs(x.pct), 0) / m.length;
  const side = m.filter((x) => x.pct * dir > 0).map((x) => Math.abs(x.pct)).sort((a, b) => a - b);
  const cut = quantile(side, 1 - tail);
  if (cut == null || !(all > 0)) return null;
  const after: number[] = [];
  let next = -1;
  for (let i = 0; i < m.length; i++) {
    if (i <= next || m[i].pct * dir <= 0 || Math.abs(m[i].pct) < cut) continue;
    if (i + days >= m.length || m[i + days].t - m[i].t !== days * 86400) continue;
    for (let j = 1; j <= days; j++) after.push(Math.abs(m[i + j].pct));
    next = i + days; // non-overlapping
  }
  if (!after.length) return null;
  return { ratio: Math.round((after.reduce((s, x) => s + x, 0) / after.length / all) * 100) / 100, n: after.length / days };
}
