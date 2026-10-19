import type { Candle } from "../types.ts";

/**
 * "以前灵不灵": forward-return statistics for a signal on this exact
 * symbol and timeframe, compared against the base rate of the market.
 */

export interface SignalStats {
  key: string;
  name: string;
  side: "bull" | "bear";
  horizon: number;
  samples: number;
  /** % of samples where price moved in the signal's direction after `horizon` bars */
  winRate: number | null;
  /** mean move in the signal's direction, % */
  avgReturn: number | null;
  /** same measure for every bar — what you'd get by picking a random moment */
  baseWinRate: number;
  /** verdict for beginners */
  reliability: "靠谱" | "一般" | "不靠谱" | "样本不足";
}

export function forwardStats(
  c: Candle[],
  key: string,
  name: string,
  side: "bull" | "bear",
  indices: number[],
  horizon: number,
): SignalStats {
  const n = c.length;
  const dir = side === "bull" ? 1 : -1;
  let wins = 0, total = 0, sum = 0;
  // de-duplicate signals that fire on consecutive bars
  let lastUsed = -Infinity;
  for (const i of indices) {
    if (i + horizon >= n || i - lastUsed < Math.max(2, Math.floor(horizon / 2))) continue;
    lastUsed = i;
    const r = ((c[i + horizon].c - c[i].c) / c[i].c) * 100 * dir;
    total++;
    sum += r;
    if (r > 0) wins++;
  }
  let baseWins = 0, baseTotal = 0;
  for (let i = 0; i + horizon < n; i++) {
    baseTotal++;
    if ((c[i + horizon].c - c[i].c) * dir > 0) baseWins++;
  }
  const baseWinRate = baseTotal ? (baseWins / baseTotal) * 100 : 50;
  const winRate = total ? (wins / total) * 100 : null;
  let reliability: SignalStats["reliability"] = "样本不足";
  if (total >= 8 && winRate !== null) {
    const edge = winRate - baseWinRate;
    reliability = edge >= 8 && sum > 0 ? "靠谱" : edge >= 0 ? "一般" : "不靠谱";
  }
  return {
    key,
    name,
    side,
    horizon,
    samples: total,
    winRate: winRate === null ? null : Math.round(winRate),
    avgReturn: total ? Math.round((sum / total) * 100) / 100 : null,
    baseWinRate: Math.round(baseWinRate),
    reliability,
  };
}
