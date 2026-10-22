/**
 * The 50-week moving average, described only (research E24, project files e24/).
 * Pure: the trend map feeds it closed weekly candles, the spot page every 7th daily close back from today.
 *
 * E24 (BTC, Coin Metrics daily, weekly closes 2013–2026-10): 24 crossings, close to half flipped back
 * within 4 weeks; after crossing above, no edge over same-era random weeks; after crossing below,
 * the next half year was weaker (0.67× of random, 40 / 60 weeks and 3-week confirmation 0.54–0.70×,
 * only 5–12 crossings); as a hold-above / cash-below filter the max drawdown fell from −83% to −65%,
 * but a 60-week line underperformed holding from 2018. Weeks below were followed by a higher price a
 * year later 80% of the time (median +59%). Nothing here reaches the "edge" bar, so the page only
 * says where price is, never "bull" or "bear".
 */

export const WEEK_LINE_LEN = 50;

export interface WeekLine {
  len: number;
  /** the average of the last `len` weekly closes */
  sma: number;
  close: number;
  above: boolean;
  /** consecutive weeks on this side, counting the latest */
  weeks: number;
  /** true when the history runs out before the side changes (weeks is then a lower bound) */
  weeksAtLeast: boolean;
  /** (close / sma − 1) in % */
  distPct: number;
}

/** `closes`: weekly closes, oldest first, the latest closed week last. Null under `len` weeks. */
export function weekLine(closes: number[], len: number = WEEK_LINE_LEN): WeekLine | null {
  const n = closes.length;
  if (n < len) return null;
  const sma: number[] = new Array(n).fill(NaN);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += closes[i];
    if (i >= len) sum -= closes[i - len];
    if (i >= len - 1) sma[i] = sum / len;
  }
  const L = n - 1;
  const above = closes[L] > sma[L];
  let weeks = 0;
  let i = L;
  for (; i >= len - 1 && closes[i] > sma[i] === above; i--) weeks++;
  return { len, sma: sma[L], close: closes[L], above, weeks, weeksAtLeast: i < len - 1, distPct: Math.round((closes[L] / sma[L] - 1) * 1000) / 10 };
}

/** "站上 50 周均线第 5 周（收盘比它高 7.1%）" */
export function weekLineText(w: WeekLine): string {
  const side = w.above ? "站上" : "跌破";
  const weeks = w.weeksAtLeast ? `至少 ${w.weeks} 周` : `第 ${w.weeks} 周`;
  return `${side} ${w.len} 周均线${weeks}（收盘比它${w.distPct >= 0 ? "高" : "低"} ${Math.abs(w.distPct).toFixed(1)}%）`;
}

/** What E24 found, for the pages (BTC history). */
export const WEEK_LINE_FACTS = {
  general: "比特币 2013 年以来周收盘穿越 50 周均线 24 次，将近一半在 4 周内又翻回去。站上之后没有可证明的优势；跌破之后的半年偏弱，但只有 12 次，够不上“有优势”。它描述长期趋势，不预测涨跌，不是牛熊分界线。",
  risk: "只在线上拿着、跌破就空仓，历史上最大回撤从 −83% 降到 −65%，但换成 60 周均线、从 2018 年算起反而跑输一直拿着。",
  spot: "跌破之后买入，一年后 80% 的时候价格更高（中位 +59%）：对囤币来说跌破不是卖出信号。",
} as const;
