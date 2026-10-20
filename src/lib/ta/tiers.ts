import { TF_LABEL, type Candle, type Timeframe } from "../types.ts";
import { prevPeriodHL } from "./levels.ts";
import { intactPivots, PIVOT_K } from "./risk.ts";
import type { StructureState, Swing } from "./structure.ts";

/**
 * Lines of defence for a position, nearest first (the v1.3 defence-level rule), described only — none of them
 * is claimed to hold (E16: levels do not run further than random prices before they fail):
 * - near: the first swing point of the entry timeframe, not broken on a close, at least 0.5 ATR from the price;
 * - mid: beyond it, the next such point tested at least twice that is also a labelled structure point
 *   (HH / HL / LH / LL), or the previous week's low (high), whichever is nearer;
 * - far: the higher timeframe's protective swing (its break ends that structure), else the previous month's
 *   low (high); always beyond the mid line.
 * A line that cannot be found is left out rather than made up.
 */

export interface DefenseLine {
  tier: "near" | "mid" | "far";
  price: number;
  label: string;
  tf: Timeframe;
  /** distance from the price, ATR of the entry timeframe */
  distAtr: number;
}

export interface TierInput {
  tf: Timeframe;
  /** closed bars of the entry timeframe, their ATR and zigzag swings */
  c: Candle[];
  atr: number[];
  sw: Swing[];
  /** the higher timeframe and its structure at its last closed bar */
  higherTf: Timeframe;
  higher: StructureState | null;
  /** daily bars, for the previous week and month */
  daily: Candle[];
  /** end of the last closed bar (Unix seconds) */
  endSec: number;
  live: number;
}

export function defenseTiers(a: TierInput, dir: 1 | -1): DefenseLine[] {
  const n = a.c.length - 1;
  const A = a.atr[n];
  if (n < 50 || !(A > 0)) return [];
  const side = dir > 0 ? "low" : "high";
  const lo = dir > 0 ? "低" : "高";
  const dist = (p: number) => ((a.live - p) * dir) / A;
  const line = (tier: DefenseLine["tier"], price: number, label: string, tf: Timeframe): DefenseLine => ({ tier, price, label, tf, distAtr: Math.round(dist(price) * 10) / 10 });
  // intact swing points on the defended side, nearest first
  const pivots = intactPivots(a.c, a.atr, n, PIVOT_K[a.tf], side, 400)
    .filter((p) => dist(p.price) > 0)
    .sort((x, y) => dist(x.price) - dist(y.price));
  const out: DefenseLine[] = [];
  const near = pivots.find((p) => dist(p.price) >= 0.5);
  if (!near) return out;
  out.push(line("near", near.price, `近防线 · ${TF_LABEL[a.tf]}摆动${lo}点`, a.tf));
  // mid: a structure point tested twice or more, or the previous week's extreme, beyond the near line
  const labelled = (i: number) => a.sw.find((s) => s.i === i && s.kind === side && s.label && s.label !== "EQ")?.label ?? null;
  const tested = pivots.find((p) => dist(p.price) > dist(near.price) && p.tests >= 2 && labelled(p.i));
  const week = prevPeriodHL(a.daily, a.endSec, "week");
  const weekPx = week ? (dir > 0 ? week.l : week.h) : null;
  const mids = [
    ...(tested ? [{ price: tested.price, label: `中防线 · ${TF_LABEL[a.tf]} ${labelled(tested.i)} ${lo}点` }] : []),
    ...(weekPx != null && dist(weekPx) > dist(near.price) ? [{ price: weekPx, label: `中防线 · 上周最${lo}` }] : []),
  ].sort((x, y) => dist(x.price) - dist(y.price));
  const mid = mids[0] ?? null;
  if (mid) out.push(line("mid", mid.price, mid.label, a.tf));
  // far: the higher timeframe's protective swing, else the previous month's extreme
  const beyond = mid ? dist(mid.price) : dist(near.price);
  const h = a.higher;
  const trend = dir > 0 ? "up" : "down";
  const prot = h && h.state === trend && h.breach !== "broken" ? h.protective : null;
  if (prot && dist(prot.price) > beyond) {
    out.push(line("far", prot.price, `远防线 · ${TF_LABEL[a.higherTf]}保护位（${dir > 0 ? "跌破" : "突破"}就结束${TF_LABEL[a.higherTf]}${dir > 0 ? "上升" : "下降"}结构）`, a.higherTf));
  } else {
    const month = prevPeriodHL(a.daily, a.endSec, "month");
    const px = month ? (dir > 0 ? month.l : month.h) : null;
    if (px != null && dist(px) > beyond) out.push(line("far", px, `远防线 · 上月最${lo}`, "1d"));
  }
  return out;
}
