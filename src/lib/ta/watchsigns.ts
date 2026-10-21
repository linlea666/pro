import type { Candle } from "../types.ts";
import { netTakerFlow, oiFlush, type OiSeries } from "./defend.ts";
import { relVolume } from "./plan.ts";
import type { StructureState } from "./structure.ts";
import { turnAt } from "./watch.ts";

/**
 * The seven signs at a low that E19b weighed (src/lib/research/watch.ts), shared with the live page: the
 * research reads them at the 15-minute turn, the page at the latest closed bar. None of them passed; the page
 * shows each with what the research found. Shorts at highs are the mirror image.
 */

export type SignKey = "rsi" | "flow" | "spot" | "climax" | "oi" | "funding" | "hour";
export const SIGNS: SignKey[] = ["rsi", "flow", "spot", "climax", "oi", "funding", "hour"];
/** as the research report names them */
export const SIGN_NAME: Record<SignKey, string> = {
  rsi: "动能衰竭（价格新低，RSI 没有新低）",
  flow: "主动成交背离（新低途中主动买入占多）",
  spot: "现货承接（现货主动买入、合约主动卖出）",
  climax: "放量后缩量（新低那根放量，更高的低点缩量）",
  oi: "持仓量骤降（多头被洗出）",
  funding: "资金费率在反方向拥挤",
  hour: "1 小时也已转强",
};
/** short names for the page */
export const SIGN_SHORT: Record<SignKey, string> = {
  rsi: "动能衰竭",
  flow: "主动成交背离",
  spot: "现货承接",
  climax: "放量后缩量",
  oi: "持仓量骤降",
  funding: "资金费率拥挤",
  hour: "1 小时也已转强",
};

export interface SignData {
  /** 15-minute bars (with taker volume where known), their open times, structure and RSI(14) of the closes */
  c: Candle[];
  times: number[];
  ss: StructureState[];
  rsi: number[];
  /** spot 15-minute bars and their open times (empty: none) */
  spot: Candle[];
  spotTimes: number[];
  oi: OiSeries | null;
  /** the hour chart's structure and, per 15-minute bar, its last closed hour bar */
  hss: StructureState[];
  hIdx: number[];
  /** funding crowded against `dir` at `at` (fundingFuel), null: unknown */
  funding: (dir: 1 | -1, at: number) => boolean | null;
}

/**
 * The signs with the newest extreme at bar `e` (price `extreme`), read at the close of bar `i`; null: the data
 * is missing. "放量后缩量" needs a higher low after the extreme: before there is one it is false.
 */
export function signsAt(d: SignData, e: number, i: number, extreme: number, dir: 1 | -1): Record<SignKey, boolean | null> {
  const { c, times, ss, rsi } = d;
  const prev = dir > 0 ? ss[e - 1].lastLow : ss[e - 1].lastHigh;
  let rsiDiv: boolean | null = null, flow: boolean | null = null;
  if (prev) {
    if (Number.isFinite(rsi[e]) && Number.isFinite(rsi[prev.i])) rsiDiv = (extreme - prev.price) * dir < 0 && (rsi[e] - rsi[prev.i]) * dir > 0;
    const f = netTakerFlow(c, times, prev.t + 900, c[e].t + 900);
    flow = f == null ? null : f * dir > 0;
  }
  let spotBuy: boolean | null = null;
  if (d.spot.length && e >= 15) {
    const from = c[e - 15].t, to = c[e].t + 900;
    const s = netTakerFlow(d.spot, d.spotTimes, from, to), f = netTakerFlow(c, times, from, to);
    spotBuy = s == null || f == null ? null : s * dir > 0 && f * dir < 0;
  }
  const hl = dir > 0 ? ss[i].lastLow : ss[i].lastHigh;
  const climax = hl ? hl.i > e && relVolume(c, e) >= 2 && relVolume(c, hl.i) < 1 : null;
  const j = d.hIdx[i];
  return {
    rsi: rsiDiv,
    flow,
    spot: spotBuy,
    climax,
    oi: d.oi ? oiFlush(d.oi, c[e].t - 4 * 3600, c[e].t + 900) : null,
    funding: d.funding(dir, c[i].t + 900),
    hour: j >= 0 ? turnAt(d.hss[j], dir, c[e].t) : null,
  };
}
