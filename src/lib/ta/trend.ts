import type { Candle } from "../types.ts";
import * as ta from "./core.ts";
import { diSpread, type IndicatorPanel } from "./indicators.ts";
import { DEFAULT_ENGINE_PARAMS, type EngineParams } from "../params.ts";

/**
 * Trend strength score, −100 (strong downtrend) … +100 (strong uptrend).
 *
 * Direction comes from a weighted vote of trend indicators; conviction is
 * scaled by ADX so that a choppy market reads near zero even when the votes
 * happen to lean one way.
 */


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

export function trendLabel(s: number, tp: EngineParams["trend"] = DEFAULT_ENGINE_PARAMS.trend): TrendLabel {
  if (s >= tp.strong) return "强势上涨";
  if (s >= tp.mild) return "温和上涨";
  if (s > -tp.mild) return "震荡";
  if (s > -tp.strong) return "温和下跌";
  return "强势下跌";
}

export function computeTrend(c: Candle[], panel: IndicatorPanel, tp: EngineParams["trend"] = DEFAULT_ENGINE_PARAMS.trend): TrendResult {
  const n = c.length;
  const dmi = ta.adx(c, 14);
  const { adx } = dmi;
  // disabled indicators are absent from the panel and drop out of the total too
  const voters = Object.entries(tp.weights).filter(([id, w]) => w > 0 && panel.byId.has(id));
  const total = voters.reduce((s, [, w]) => s + w, 0) || 1;
  const raw = new Array(n).fill(0);
  for (const [id, w] of voters) {
    const b = panel.byId.get(id)!;
    for (let i = 0; i < n; i++) raw[i] += b[i] * w;
  }
  const score = raw.map((v, i) => {
    const a = Number.isNaN(adx[i]) ? 15 : adx[i];
    // strength (ADX) and dominance of one side (DI spread) both have to be there
    const conviction = Math.min(1, Math.max(0.25, (a - tp.adxFloor) / tp.adxSpan)) * Math.min(1, Math.max(0.3, diSpread(dmi, i) / tp.diFull));
    return (v / total) * 100 * conviction;
  });
  // light smoothing so the line doesn't flicker bar to bar
  const smooth = ta.ema(score, 3).map((v, i) => (Number.isNaN(v) ? score[i] : v));
  const current = Math.round(smooth[n - 1]);
  let barsInState = 0;
  const sign = Math.sign(trendLabel(current, tp) === "震荡" ? 0 : current);
  for (let i = n - 1; i >= 0; i--) {
    const s = Math.sign(trendLabel(smooth[i], tp) === "震荡" ? 0 : smooth[i]);
    if (s !== sign) break;
    barsInState++;
  }
  const label = trendLabel(current, tp);
  const a = adx[n - 1];
  const explain =
    label === "震荡"
      ? `${a < 20 ? `ADX 只有 ${a.toFixed(0)}，` : `ADX ${a.toFixed(0)} 但多空力量接近，`}没有明确方向。震荡市里追涨杀跌最容易亏钱。`
      : `${label}已持续 ${barsInState} 根 K 线，ADX ${a.toFixed(0)}${a > 25 && diSpread(dmi, n - 1) >= 0.1 ? "，趋势有力度" : "，力度一般"}。`;
  return { score: smooth.map((v) => Math.round(v * 10) / 10), current, label, adx: a, barsInState, explain };
}
