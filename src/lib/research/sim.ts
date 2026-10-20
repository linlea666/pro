import type { Candle } from "../types.ts";
import type { Swing } from "../ta/structure.ts";

/**
 * One trade, bar by bar, under an exit rule. Conservative on purpose: a bar
 * that reaches both the stop and the target counts as stopped, a gap through
 * the stop fills at the open, and the trailing stop only moves at a bar's close
 * (so it is never used on the bar that set it).
 */

export type ExitPolicy =
  /** stop and a 2R target, closed after `maxBars` */
  | "fixed2r"
  /** trail behind each newly confirmed swing (low for longs, high for shorts) plus the sweep buffer */
  | "structure"
  /** trail 3 ATR behind the best price since entry */
  | "chandelier"
  /** move the stop to breakeven at +1R, then trail 3 ATR */
  | "be_chandelier"
  /** a beginner's habit: take profit at +0.5R */
  | "take05r"
  /** half off at +2R, the rest trailed behind new structure points */
  | "scale2r";

export const POLICY_NAME: Record<ExitPolicy, string> = {
  fixed2r: "固定 2R 止盈",
  structure: "跟着新的结构点移动认错位",
  chandelier: "3 倍 ATR 吊灯止损",
  be_chandelier: "到 1R 先保本，再 3 倍 ATR 吊灯",
  take05r: "赚 0.5R 就走",
  scale2r: "2R 先平一半，其余跟着结构移动",
};

export interface SimContext {
  c: Candle[];
  atr: number[];
  /** swings of this timeframe, in the order they were confirmed */
  swings: Swing[];
  /** sweep buffer for structure trailing, ATR */
  buf: number;
  costPct: number;
  maxBars: number;
  /** extra slippage on stop exits, % of price (fast markets fill stops worse); default 0 */
  stopSlipPct?: number;
  /**
   * bars whose high / low trigger the stop, index-aligned with `c` (the mark price, as exchanges use);
   * a missing bar falls back to `c`. Fills, targets and trailing stay on `c`.
   */
  trigger?: (Candle | undefined)[];
}

export interface SimResult {
  /** net result in R (risk = distance from entry to the initial stop) */
  r: number;
  /** net result, % of the entry price */
  pct: number;
  bars: number;
  /** best excursion in R before the exit */
  mfe: number;
  /** worst excursion against the trade in R, up to and including the exit bar */
  mae: number;
  exit: "stop" | "target" | "time";
}

/**
 * Simulate a trade entered at the close of bar `i` (or at `entryPx` during bar `i`, a filled limit order
 * whose bar has already been checked against the stop); null when the data ends first or the stop is on
 * the wrong side.
 */
export function simulate(ctx: SimContext, i: number, dir: 1 | -1, stop0: number, policy: ExitPolicy, entryPx?: number): SimResult | null {
  const { c, atr, swings, buf, costPct, maxBars, stopSlipPct = 0 } = ctx;
  const E = entryPx ?? c[i].c;
  const R = (E - stop0) * dir;
  if (!(R > 0) || i + 1 >= c.length) return null;
  const costPx = (costPct / 100) * E;
  const target = policy === "fixed2r" ? E + dir * 2 * R : policy === "take05r" ? E + dir * 0.5 * R : null;
  // scale2r: half the position is closed at +2R; `banked` is that half's result in price
  const half = policy === "scale2r" ? E + dir * 2 * R : null;
  let banked: number | null = null;
  let stop = stop0, best = E, mfe = 0, mae = 0;
  // first swing confirmed after the entry bar
  let k = 0;
  while (k < swings.length && swings[k].confirmedAt <= i) k++;
  const end = Math.min(c.length - 1, i + maxBars);
  for (let j = i + 1; j <= end; j++) {
    const b = c[j];
    const tb = ctx.trigger?.[j] ?? b;
    mae = Math.max(mae, ((E - (dir > 0 ? b.l : b.h)) * dir) / R);
    let exitPx: number | null = null, why: SimResult["exit"] = "stop";
    if (dir > 0 ? tb.l <= stop : tb.h >= stop) exitPx = (dir > 0 ? Math.min(stop, b.o) : Math.max(stop, b.o)) * (1 - (dir * stopSlipPct) / 100);
    else if (target != null && (dir > 0 ? b.h >= target : b.l <= target)) {
      exitPx = target;
      why = "target";
    }
    if (exitPx != null) return result(exitPx, j, why);
    if (half != null && banked == null && (dir > 0 ? b.h >= half : b.l <= half)) banked = half;
    best = dir > 0 ? Math.max(best, b.h) : Math.min(best, b.l);
    mfe = Math.max(mfe, ((best - E) * dir) / R);
    // trailing, from this bar's close on
    if (policy === "be_chandelier" && mfe >= 1) stop = dir > 0 ? Math.max(stop, E + costPx) : Math.min(stop, E - costPx);
    if (policy === "chandelier" || (policy === "be_chandelier" && mfe >= 1)) {
      const trail = best - dir * 3 * atr[j];
      stop = dir > 0 ? Math.max(stop, trail) : Math.min(stop, trail);
    }
    while (k < swings.length && swings[k].confirmedAt <= j) {
      const s = swings[k++];
      if ((policy !== "structure" && policy !== "scale2r") || s.kind !== (dir > 0 ? "low" : "high")) continue;
      const level = s.price - dir * buf * atr[j];
      // only ever tighten, and never past the price
      if ((level - stop) * dir > 0 && (b.c - level) * dir > 0) stop = level;
    }
    if (j === i + maxBars) return result(b.c, j, "time");
  }
  return null;

  function result(px: number, j: number, exit: SimResult["exit"]): SimResult {
    const gross = banked == null ? dir * (px - E) : 0.5 * dir * (banked - E) + 0.5 * dir * (px - E);
    const net = gross - costPx;
    return { r: net / R, pct: (net / E) * 100, bars: j - i, mfe, mae, exit };
  }
}

/**
 * The furthest the price went in the trade's favour (R) before the initial stop was touched, within
 * `maxBars` after bar `i`. A bar that touches the stop does not count: which came first is unknown.
 */
export function runUp(ctx: SimContext, i: number, dir: 1 | -1, stop0: number, entryPx?: number): number {
  const { c, maxBars } = ctx;
  const E = entryPx ?? c[i].c;
  const R = (E - stop0) * dir;
  let best = 0;
  if (!(R > 0)) return best;
  for (let k = i + 1; k < c.length && k <= i + maxBars; k++) {
    const tb = ctx.trigger?.[k] ?? c[k];
    if (dir > 0 ? tb.l <= stop0 : tb.h >= stop0) break;
    best = Math.max(best, ((dir > 0 ? c[k].h - E : E - c[k].l)) / R);
  }
  return best;
}
