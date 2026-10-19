import type { Candle } from "../types.ts";
import * as ta from "./core.ts";
import { diSpread, type IndicatorPanel } from "./indicators.ts";

/**
 * Trend strength score, −100 (strong downtrend) … +100 (strong uptrend).
 *
 * Direction comes from a weighted vote of trend indicators; conviction is
 * scaled by ADX so that a choppy market reads near zero even when the votes
 * happen to lean one way.
 */

const VOTES: Record<string, number> = {
  ema_cross: 1,
  golden_cross: 1.2,
  ma_stack: 1.3,
  price_sma200: 1,
  macd: 0.8,
  adx: 1.2,
  psar: 0.6,
  aroon: 0.7,
  ichimoku: 1,
  slope: 1,
};

export type TrendLabel = "强势上涨" | "温和上涨" | "震荡" | "温和下跌" | "强势下跌";

export interface TrendResult {
  score: number[];
  current: number;
  label: TrendLabel;
  adx: number;
  /** bars since score last crossed zero */
  barsInState: number;
  explain: string;
}

export function trendLabel(s: number): TrendLabel {
  if (s >= 45) return "强势上涨";
  if (s >= 15) return "温和上涨";
  if (s > -15) return "震荡";
  if (s > -45) return "温和下跌";
  return "强势下跌";
}

export function computeTrend(c: Candle[], panel: IndicatorPanel): TrendResult {
  const n = c.length;
  const dmi = ta.adx(c, 14);
  const { adx } = dmi;
  const total = Object.values(VOTES).reduce((s, v) => s + v, 0);
  const raw = new Array(n).fill(0);
  for (const [id, w] of Object.entries(VOTES)) {
    const b = panel.byId.get(id);
    if (!b) continue;
    for (let i = 0; i < n; i++) raw[i] += b[i] * w;
  }
  const score = raw.map((v, i) => {
    const a = Number.isNaN(adx[i]) ? 15 : adx[i];
    // strength (ADX) and dominance of one side (DI spread) both have to be there
    const conviction = Math.min(1, Math.max(0.25, (a - 10) / 25)) * Math.min(1, Math.max(0.3, diSpread(dmi, i) / 0.25));
    return (v / total) * 100 * conviction;
  });
  // light smoothing so the line doesn't flicker bar to bar
  const smooth = ta.ema(score, 3).map((v, i) => (Number.isNaN(v) ? score[i] : v));
  const current = Math.round(smooth[n - 1]);
  let barsInState = 0;
  const sign = Math.sign(trendLabel(current) === "震荡" ? 0 : current);
  for (let i = n - 1; i >= 0; i--) {
    const s = Math.sign(trendLabel(smooth[i]) === "震荡" ? 0 : smooth[i]);
    if (s !== sign) break;
    barsInState++;
  }
  const label = trendLabel(current);
  const a = adx[n - 1];
  const explain =
    label === "震荡"
      ? `${a < 20 ? `ADX 只有 ${a.toFixed(0)}，` : `ADX ${a.toFixed(0)} 但多空力量接近，`}没有明确方向。震荡市里追涨杀跌最容易亏钱。`
      : `${label}已持续 ${barsInState} 根 K 线，ADX ${a.toFixed(0)}${a > 25 && diSpread(dmi, n - 1) >= 0.1 ? "，趋势有力度" : "，力度一般"}。`;
  return { score: smooth.map((v) => Math.round(v * 10) / 10), current, label, adx: a, barsInState, explain };
}
