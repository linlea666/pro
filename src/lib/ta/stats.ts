import type { Candle } from "../types.ts";

/**
 * "以前灵不灵": forward-return statistics for a signal on this exact
 * symbol and timeframe, compared against the base rate of the market.
 *
 * Honest by construction:
 * - samples never overlap: a signal within `horizon` bars of the previous one is skipped;
 * - every move is counted after a round-trip trading cost;
 * - the win rate carries a 95% interval, and a label needs a significance test,
 *   not just "a bit better than random" (random signals would pass that ~25% of the time);
 * - a page shows dozens of these at once, so `labelStats` corrects for multiple testing.
 */

export type Reliability = "证据较强" | "证据弱" | "证据不足" | "历史上不利";

export interface StatsOptions {
  /** fewer non-overlapping samples than this → "证据不足" */
  minSamples: number;
  /** round-trip cost, % of price */
  costPct: number;
  /** significance level for the (corrected) test */
  alpha: number;
}

export const DEFAULT_STATS_OPTIONS: StatsOptions = { minSamples: 30, costPct: 0.15, alpha: 0.05 };

export interface SignalStats {
  key: string;
  name: string;
  side: "bull" | "bear";
  horizon: number;
  samples: number;
  /** % of samples where price moved the signal's way by more than the cost after `horizon` bars */
  winRate: number | null;
  /** 95% Wilson interval of the win rate */
  winLo: number | null;
  winHi: number | null;
  /** mean move in the signal's direction after cost, % */
  avgReturn: number | null;
  /** same measure for every bar — what you'd get by picking a random moment */
  baseWinRate: number;
  /** two-sided p-value of "win rate differs from the base rate" (normal approximation) */
  pValue: number | null;
  reliability: Reliability;
}

/** Standard normal CDF (Abramowitz–Stegun 7.1.26). */
export function normCdf(z: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

/** 95% Wilson score interval for k successes in n trials, as percentages. */
export function wilson(k: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 100];
  const p = k / n, z2 = z * z;
  const centre = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
  return [Math.max(0, centre - half) * 100, Math.min(1, centre + half) * 100];
}

function label(s: Pick<SignalStats, "samples" | "winRate" | "baseWinRate" | "avgReturn">, significant: boolean, minSamples: number): Reliability {
  if (s.samples < minSamples || s.winRate == null) return "证据不足";
  if (!significant) return "证据弱";
  return s.winRate > s.baseWinRate && (s.avgReturn ?? 0) > 0 ? "证据较强" : s.winRate < s.baseWinRate ? "历史上不利" : "证据弱";
}

export function forwardStats(
  c: Candle[],
  key: string,
  name: string,
  side: "bull" | "bear",
  indices: number[],
  horizon: number,
  opts: StatsOptions = DEFAULT_STATS_OPTIONS,
): SignalStats {
  const n = c.length;
  const dir = side === "bull" ? 1 : -1;
  const cost = opts.costPct;
  let wins = 0, total = 0, sum = 0;
  let lastUsed = -Infinity;
  for (const i of indices) {
    if (i + horizon >= n || i - lastUsed < horizon) continue;
    lastUsed = i;
    const r = ((c[i + horizon].c - c[i].c) / c[i].c) * 100 * dir - cost;
    total++;
    sum += r;
    if (r > 0) wins++;
  }
  let baseWins = 0, baseTotal = 0;
  for (let i = 0; i + horizon < n; i++) {
    baseTotal++;
    if (((c[i + horizon].c - c[i].c) / c[i].c) * 100 * dir - cost > 0) baseWins++;
  }
  const p0 = baseTotal ? baseWins / baseTotal : 0.5;
  const winRate = total ? (wins / total) * 100 : null;
  let pValue: number | null = null;
  if (total > 0) {
    const sd = Math.sqrt(total * p0 * (1 - p0));
    pValue = sd > 0 ? 2 * (1 - normCdf(Math.abs(wins - total * p0) / sd)) : wins === total * p0 ? 1 : 0;
  }
  const [lo, hi] = total ? wilson(wins, total) : [0, 100];
  const out: SignalStats = {
    key,
    name,
    side,
    horizon,
    samples: total,
    winRate: winRate === null ? null : Math.round(winRate),
    winLo: total ? Math.round(lo) : null,
    winHi: total ? Math.round(hi) : null,
    avgReturn: total ? Math.round((sum / total) * 100) / 100 : null,
    baseWinRate: Math.round(p0 * 100),
    pValue: pValue === null ? null : Math.round(pValue * 10000) / 10000,
    reliability: "证据不足",
  };
  // standalone label (uncorrected); labelStats re-labels a whole page together
  out.reliability = label({ ...out, winRate }, pValue !== null && pValue <= opts.alpha, opts.minSamples);
  return out;
}

/**
 * Benjamini–Hochberg over a set of statistics shown together: only results that
 * survive the false-discovery-rate correction keep a strong or adverse label.
 * Mutates and returns the given objects.
 */
export function labelStats<T extends Pick<SignalStats, "samples" | "winRate" | "baseWinRate" | "avgReturn" | "pValue" | "reliability">>(
  list: T[],
  opts: StatsOptions = DEFAULT_STATS_OPTIONS,
): T[] {
  const tested = list.filter((s) => s.samples >= opts.minSamples && s.pValue != null);
  const sorted = [...tested].sort((a, b) => a.pValue! - b.pValue!);
  const m = sorted.length;
  let cutoff = -1;
  sorted.forEach((s, k) => {
    if (s.pValue! <= ((k + 1) / m) * opts.alpha) cutoff = k;
  });
  const significant = new Set(sorted.slice(0, cutoff + 1));
  for (const s of list) s.reliability = label(s, significant.has(s), opts.minSamples);
  return list;
}
