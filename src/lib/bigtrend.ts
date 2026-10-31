/**
 * 大趋势（周线、日线）按币和时刻算出来，给盯盘和裸 K 页用（计划页直接用自己的周线、日线帧）。只用已收盘的 K 线。
 * 只是描述：调用方取不到时（数据源失败）当作 null，不影响页面其余部分。
 */
import { cutoff, seriesAt } from "./analysis.ts";
import { closedThrough } from "./data/klines.ts";
import { DEFAULT_SWING_ATR, structureSeries, swings } from "./ta/structure.ts";
import { atrSeries } from "./ta/risk.ts";
import { bigTrendOf, type BigTrend } from "./ta/bigtrend.ts";

export async function bigTrendAt(coin: string, replayEnd: number | null, mult = DEFAULT_SWING_ATR): Promise<BigTrend | null> {
  const [w, d] = await Promise.all([seriesAt(coin, "1w", replayEnd), seriesAt(coin, "1d", replayEnd)]);
  const frame = (k: typeof w, tf: "1w" | "1d") => {
    const c = cutoff(k.candles, tf, replayEnd ?? closedThrough(k));
    const atr = atrSeries(c);
    return { c, atr, ss: structureSeries(c, atr, mult), sw: swings(c, atr, mult) };
  };
  return bigTrendOf({ w: frame(w, "1w"), d: frame(d, "1d") }, mult);
}
