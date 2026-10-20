import type { Candle } from "../types.ts";

/**
 * Market structure: the swing highs and lows a trader would draw, and what they
 * say about the trend. Everything is known at the close of each bar:
 *
 * - A swing is confirmed once price has reversed `mult` × ATR from it (an ATR
 *   zigzag), so a fast rally's lows count too, unlike fixed K-bar fractals.
 * - Up: the last two highs and the last two lows are both higher; down: both lower;
 *   otherwise a range (or a trend in transition).
 * - The protective swing is the last low of an uptrend (the last high of a downtrend).
 *   Only closes count against it, with the two thresholds measured in E9: 0.1 ATR
 *   beyond = pierced (about 3 in 10 recover), 0.8 ATR beyond = broken (about 9 in 10
 *   were real breaks). Wicks never change the state.
 */

export const PIERCE_ATR = 0.1;
export const BREAK_ATR = 0.8;
export const DEFAULT_SWING_ATR = 2;

export interface Swing {
  /** bar of the extreme */
  i: number;
  t: number;
  price: number;
  kind: "high" | "low";
  /** bar at whose close the swing became known */
  confirmedAt: number;
  /** against the previous swing of the same kind */
  label: "HH" | "LH" | "HL" | "LL" | "EQ" | null;
}

/**
 * Swings confirmed causally (ATR zigzag). On the bar that sets a new extreme the
 * opposite reversal is not tested: a single wide bar would otherwise produce a
 * high and a low on the same bar without knowing which came first.
 */
export function swings(c: Candle[], atr: number[], mult = DEFAULT_SWING_ATR): Swing[] {
  const out: Swing[] = [];
  if (c.length < 3) return out;
  const th = (i: number) => (Number.isFinite(atr[i]) ? atr[i] : c[i].c * 0.01) * mult;
  const push = (i: number, kind: "high" | "low", at: number) => {
    const price = kind === "high" ? c[i].h : c[i].l;
    const prev = [...out].reverse().find((s) => s.kind === kind);
    let label: Swing["label"] = null;
    if (prev) {
      const tol = 0.1 * (Number.isFinite(atr[i]) ? atr[i] : 0);
      label = Math.abs(price - prev.price) <= tol ? "EQ" : kind === "high" ? (price > prev.price ? "HH" : "LH") : price > prev.price ? "HL" : "LL";
    }
    out.push({ i, t: c[i].t, price, kind, confirmedAt: at, label });
  };
  let dir: 1 | -1 | 0 = 0;
  let hi = 0, lo = 0;
  for (let i = 1; i < c.length; i++) {
    const newHigh = c[i].h >= c[hi].h;
    const newLow = c[i].l <= c[lo].l;
    if (newHigh) hi = i;
    if (newLow) lo = i;
    if (dir === 0) {
      if (c[hi].h - c[lo].l >= th(i) && hi !== lo) {
        if (hi > lo) {
          push(lo, "low", i);
          dir = 1;
        } else {
          push(hi, "high", i);
          dir = -1;
        }
      }
    } else if (dir === 1) {
      if (!newHigh && c[hi].h - c[i].l >= th(i)) {
        push(hi, "high", i);
        dir = -1;
        lo = i;
      }
    } else if (!newLow && c[i].h - c[lo].l >= th(i)) {
      push(lo, "low", i);
      dir = 1;
      hi = i;
    }
  }
  return out;
}

export type TrendState = "up" | "down" | "range";
export type Breach = "none" | "pierced" | "broken";

export interface StructureState {
  state: TrendState;
  /** the protective swing's status (none for a range) */
  breach: Breach;
  /** last low of an uptrend / last high of a downtrend */
  protective: Swing | null;
  lastHigh: Swing | null;
  lastLow: Swing | null;
  prevHigh: Swing | null;
  prevLow: Swing | null;
  /** consecutive higher highs (uptrend) or lower lows (downtrend) at the end of the sequence */
  legs: number;
  /** bar where the current sequence started (its first swing) */
  since: number | null;
  /** the close is beyond the last swing high (+1) / low (−1) by at least 0.1 ATR */
  beyond: 1 | -1 | 0;
}

const EMPTY: StructureState = { state: "range", breach: "none", protective: null, lastHigh: null, lastLow: null, prevHigh: null, prevLow: null, legs: 0, since: null, beyond: 0 };

/** The structure at the close of every bar (index-aligned with `c`). */
export function structureSeries(c: Candle[], atr: number[], mult = DEFAULT_SWING_ATR): StructureState[] {
  const all = swings(c, atr, mult);
  const out: StructureState[] = new Array(c.length);
  const highs: Swing[] = [], lows: Swing[] = [];
  let k = 0;
  let deepest = 0; // deepest close beyond the current protective swing since it was confirmed, in ATR
  let protKey: Swing | null = null;
  for (let t = 0; t < c.length; t++) {
    while (k < all.length && all[k].confirmedAt === t) {
      (all[k].kind === "high" ? highs : lows).push(all[k]);
      k++;
    }
    const H2 = highs[highs.length - 1] ?? null, H1 = highs[highs.length - 2] ?? null;
    const L2 = lows[lows.length - 1] ?? null, L1 = lows[lows.length - 2] ?? null;
    if (!H2 || !L2) {
      out[t] = EMPTY;
      continue;
    }
    let state: TrendState = "range";
    if (H1 && L1) {
      if (H2.price > H1.price && L2.price > L1.price) state = "up";
      else if (H2.price < H1.price && L2.price < L1.price) state = "down";
    }
    const a = Number.isFinite(atr[t]) ? atr[t] : c[t].c * 0.01;
    const protective = state === "up" ? L2 : state === "down" ? H2 : null;
    if (protective !== protKey) {
      protKey = protective;
      deepest = 0;
    }
    let breach: Breach = "none";
    if (protective) {
      const sg = state === "up" ? -1 : 1; // which way is "beyond" the protective swing
      const depth = ((c[t].c - protective.price) * sg) / a;
      deepest = Math.max(deepest, depth);
      breach = deepest >= BREAK_ATR ? "broken" : depth >= PIERCE_ATR ? "pierced" : "none";
    }
    // how many swings in a row keep the trend going, counted back from the latest
    let legs = 0, since: number | null = null;
    if (state !== "range") {
      const better = (x: Swing, y: Swing) => (state === "up" ? x.price > y.price : x.price < y.price);
      const seq = state === "up" ? highs : lows;
      for (let j = seq.length - 1; j > 0 && better(seq[j], seq[j - 1]); j--) {
        legs++;
        since = seq[j - 1].i;
      }
    }
    const beyond: 1 | -1 | 0 = c[t].c > H2.price + PIERCE_ATR * a ? 1 : c[t].c < L2.price - PIERCE_ATR * a ? -1 : 0;
    out[t] = { state, breach, protective, lastHigh: H2, lastLow: L2, prevHigh: H1, prevLow: L1, legs, since, beyond };
  }
  return out;
}

export interface StructureView {
  state: TrendState;
  breach: Breach;
  /** a plain-language label, e.g. "上升趋势" or "上升结构被破坏（转折中）" */
  label: string;
  /** one sentence on where price is within the structure */
  position: string;
  protective: { price: number; t: number; distAtr: number } | null;
  lastHigh: { price: number; t: number; label: Swing["label"] } | null;
  lastLow: { price: number; t: number; label: Swing["label"] } | null;
  legs: number;
  /** bars since the current sequence started */
  ageBars: number | null;
  /** how much of the last leg has been given back, 0–1 (null when price is beyond it) */
  retracement: number | null;
  beyond: 1 | -1 | 0;
  /** the most recent swings, oldest first, for the chart and the price ladder */
  swings: { t: number; price: number; kind: "high" | "low"; label: Swing["label"] }[];
}

const fmt = (p: number) => (p >= 1000 ? Math.round(p).toLocaleString("en-US") : p >= 1 ? p.toFixed(2) : p.toPrecision(4));

/** What the structure at the last bar says, for the page. */
export function describeStructure(c: Candle[], atr: number[], series: StructureState[], allSwings: Swing[], t = c.length - 1): StructureView {
  const s = series[t];
  const a = Number.isFinite(atr[t]) ? atr[t] : c[t].c * 0.01;
  const close = c[t].c;
  const known = allSwings.filter((x) => x.confirmedAt <= t);
  const sw = known.slice(-8).map((x) => ({ t: x.t, price: x.price, kind: x.kind, label: x.label }));
  const H = s.lastHigh, L = s.lastLow;
  let label = "结构还不清楚";
  let position = "";
  let retracement: number | null = null;
  if (H && L) {
    const legWord = (n: number, up: boolean) => (n >= 2 ? `，已连续 ${n} 次${up ? "创出更高的高点" : "跌出更低的低点"}` : "");
    if (s.state === "up") {
      label = s.breach === "broken" ? "上升结构被破坏（转折中）" : s.breach === "pierced" ? "上升趋势·保护位被刺穿" : "上升趋势";
      const span = H.price - L.price;
      if (close < H.price && span > 0 && H.i > L.i) retracement = Math.max(0, (H.price - close) / span);
      position =
        s.breach === "broken"
          ? `收盘跌破了上升趋势的保护低点 ${fmt(L.price)}（超过 0.8 倍 ATR），历史上这样的跌破约 9 成是真跌破`
          : s.beyond === 1
            ? `收盘站上前高 ${fmt(H.price)}，上升延续${legWord(s.legs, true)}`
            : `保护低点 ${fmt(L.price)}，离现价 ${((close - L.price) / a).toFixed(1)} 倍 ATR${retracement != null ? `；从高点 ${fmt(H.price)} 回调了上一段的 ${Math.round(retracement * 100)}%` : ""}${legWord(s.legs, true)}`;
    } else if (s.state === "down") {
      label = s.breach === "broken" ? "下降结构被破坏（转折中）" : s.breach === "pierced" ? "下降趋势·保护位被刺穿" : "下降趋势";
      const span = H.price - L.price;
      if (close > L.price && span > 0 && L.i > H.i) retracement = Math.max(0, (close - L.price) / span);
      position =
        s.breach === "broken"
          ? `收盘站上了下降趋势的保护高点 ${fmt(H.price)}（超过 0.8 倍 ATR），历史上这样的突破约 9 成是真突破`
          : s.beyond === -1
            ? `收盘跌破前低 ${fmt(L.price)}，下跌延续${legWord(s.legs, false)}`
            : `保护高点 ${fmt(H.price)}，离现价 ${((H.price - close) / a).toFixed(1)} 倍 ATR${retracement != null ? `；从低点 ${fmt(L.price)} 反弹了上一段的 ${Math.round(retracement * 100)}%` : ""}${legWord(s.legs, false)}`;
    } else {
      const top = Math.max(H.price, s.prevHigh?.price ?? H.price), bottom = Math.min(L.price, s.prevLow?.price ?? L.price);
      if (H.label === "LH" && s.beyond === -1) {
        // a lower high, then the last higher low gives way: the classic end of an uptrend
        label = "上升结构被打破（转向下跌中）";
        position = `先出现更低的高点 ${fmt(H.price)}，再收盘跌破前低 ${fmt(L.price)}`;
      } else if (L.label === "HL" && s.beyond === 1) {
        label = "下降结构被打破（转向上涨中）";
        position = `先出现更高的低点 ${fmt(L.price)}，再收盘站上前高 ${fmt(H.price)}`;
      } else {
        label = "区间 / 转折中";
        position =
          s.beyond === 1
            ? `收盘站上最近的摆动高点 ${fmt(H.price)}，在试图向上脱离区间`
            : s.beyond === -1
              ? `收盘跌破最近的摆动低点 ${fmt(L.price)}，在试图向下脱离区间`
              : `高低点方向不一致，在 ${fmt(bottom)}–${fmt(top)} 之间来回`;
      }
    }
  }
  const p = s.protective;
  return {
    state: s.state,
    breach: s.breach,
    label,
    position,
    protective: p ? { price: p.price, t: p.t, distAtr: Math.round((Math.abs(close - p.price) / a) * 10) / 10 } : null,
    lastHigh: H ? { price: H.price, t: H.t, label: H.label } : null,
    lastLow: L ? { price: L.price, t: L.t, label: L.label } : null,
    legs: s.legs,
    ageBars: s.since == null ? null : t - s.since,
    retracement: retracement == null ? null : Math.round(retracement * 100) / 100,
    beyond: s.beyond,
    swings: sw,
  };
}

/**
 * The direction a timeframe's structure points to, used as the filter for the
 * timeframe below: an intact trend, or a range being left on a close (a broken
 * trend, or a range going nowhere, is no direction).
 */
export function structureDirection(s: StructureState): 1 | -1 | 0 {
  if (s.state === "up") return s.breach === "broken" ? 0 : 1;
  if (s.state === "down") return s.breach === "broken" ? 0 : -1;
  return s.beyond;
}
