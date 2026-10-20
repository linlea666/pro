import { DEFAULT_ENGINE_PARAMS, type EngineParams } from "../params.ts";
import type { Candle, Timeframe } from "../types.ts";
import { TF_SECONDS } from "../types.ts";
import { fmt, protectiveExtreme, relVolume, stopOption, type DefendPlan, type StopOption } from "./plan.ts";
import { intactPivots, PIVOT_K, type Calibration } from "./risk.ts";
import type { StructureState } from "./structure.ts";

/**
 * Defending a level: price comes to a level that has held (or to a broken one from the other
 * side, or makes a fresh extreme), pokes through or gets rejected, and stops going further — the trade is taken with the
 * stop just beyond that extreme. Whether price has really stalled there is the hard part;
 * three pieces of evidence, each answering a different question, are recorded for it:
 *
 * - flow (taker volume): did sellers stop pushing? Net taker buying between the previous
 *   low and an equal-or-lower new low (CVD divergence), or a heavy, seller-dominated sweep
 *   bar that still closed back (absorption).
 * - open interest: was it a flush? Open interest falling hard into the low means positions
 *   were closed or liquidated, not new shorts piling in.
 * - lower timeframe turn: the hour chart made a higher low after the extreme and closed above
 *   its last swing high.
 *
 * Each is true / false, or null when the data is missing (older bars without taker volume,
 * hours before the open-interest history). The research weighs them (src/lib/research/defend.ts);
 * this file only describes, with the same code for the page and the research.
 * Longs below; shorts are the mirror image.
 */

/**
 * The rule's settings (EngineParams.defend, defaults = the definitions fixed before the research ran):
 * stallBars — bars after the extreme within which the stall has to show; freshBars — a fresh extreme is the
 * lowest low (highest high) of this many bars; reachAtr — how far short of a level the extreme may stop and
 * still count as reaching it; minNearAtr — the lower-timeframe stop is never closer than this many ATR of the
 * main timeframe.
 */
export type DefendRules = EngineParams["defend"];
/** hours of hour bars needed before the hour chart's structure is trusted */
export const LOWER_WARMUP = 300;
/** bars after the stall within which waiting for the hour chart to turn may end */
const CONFIRM_BARS = 6;

export type DefendShape = "sweep" | "rejection";

export interface DefendEvent {
  /** bar at whose close the stall shows: the entry */
  i: number;
  t: number;
  dir: 1 | -1;
  /** "sweep": traded through the level and closed back; "rejection": a long wick away from the extreme */
  shape: DefendShape;
  /**
   * pivot: a swing low (high) that had held; flip: a swing high (low) broken upward (downward) and now
   * retested from the other side; fresh: a new 50-bar extreme with no level under it
   */
  levelKind: "pivot" | "flip" | "fresh";
  level: number;
  /** times the level had been tested before (pivot levels) */
  tests: number;
  /** bar of the extreme and its price */
  e: number;
  extreme: number;
  /** stop just beyond the extreme, from the hour chart (null without hour bars) */
  near: number | null;
  /** stop beyond the main timeframe's protective swing plus the sweep buffer */
  far: number;
  flow: boolean | null;
  oi: boolean | null;
  turn: boolean | null;
  /**
   * the entry when waiting for the hour chart to turn: the bar (this one or up to CONFIRM_BARS later, before any
   * new extreme) by whose close it has, with the stops there; null if it did not, or without hour bars.
   * Looks ahead of `i`: for the research and for "wait for it" on the page, never for the entry at `i`.
   */
  confirm: { i: number; near: number | null; far: number } | null;
  /** higher timeframe direction at entry */
  filter: 1 | -1 | 0;
  /** the extreme sits on equal lows (highs) */
  equal: boolean;
  relVol: number;
}

/** Hour bars and their structure, for the near stop and the turn. */
export interface LowerFrame {
  c: Candle[];
  atr: number[];
  ss: StructureState[];
  /** sweep buffer (ATR of the hour chart), the calibrated p80 */
  buf: number;
}

/** Open interest by the hour, oldest first. */
export interface OiSeries {
  t: number[];
  oi: number[];
}

export interface DefendArgs {
  tf: Timeframe;
  c: Candle[];
  atr: number[];
  ss: StructureState[];
  filterAt: (i: number) => 1 | -1 | 0;
  /** sweep buffer (ATR) behind the main timeframe's protective swing: the calibrated p80 */
  buf: number;
  lower: LowerFrame | null;
  oi: OiSeries | null;
  from: number;
  rules?: DefendRules;
}

/** Index of the last element of a sorted array at or before `x` (−1 if none). */
export function lastAtOrBefore(arr: number[], x: number): number {
  let lo = 0, hi = arr.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= x) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/**
 * Net taker buying (base coin) of the bars opening in [from, to); null when the bars do not reach back to
 * `from` or any of them lacks taker volume.
 */
export function netTakerFlow(c: Candle[], times: number[], from: number, to: number): number | null {
  if (!times.length || times[0] > from) return null;
  let k = lastAtOrBefore(times, from - 1) + 1;
  let sum = 0, n = 0;
  for (; k < c.length && c[k].t < to; k++) {
    if (c[k].tbv == null) return null;
    sum += 2 * c[k].tbv! - c[k].v;
    n++;
  }
  return n ? sum : null;
}

/**
 * Open interest fell hard around the sweep: its change from `from` to `end` (4 hours before the extreme bar
 * to its close) is below minus the 80th percentile of the absolute changes over windows of the same length
 * in the 30 days before.
 */
export function oiFlush(oi: OiSeries, from: number, end: number): boolean | null {
  const at = (t: number) => {
    const k = lastAtOrBefore(oi.t, t);
    return k >= 0 && t - oi.t[k] <= 2 * 3600 ? oi.oi[k] : null;
  };
  const span = end - from;
  const now = at(end), before = at(from);
  if (now == null || before == null || !(span > 0)) return null;
  const changes: number[] = [];
  for (let t = end - 30 * 86400; t <= from - span; t += 4 * 3600) {
    const a = at(t), b = at(t + span);
    if (a != null && b != null) changes.push(Math.abs(b / a - 1));
  }
  if (changes.length < 60) return null;
  changes.sort((x, y) => x - y);
  return now / before - 1 <= -changes[Math.floor(changes.length * 0.8)];
}

/**
 * The hour chart turned in `dir` between the extreme and `end`: a higher low (lower high) made after the
 * extreme, then a close beyond the last swing on the other side.
 */
function turned(lower: LowerFrame, times: number[], dir: 1 | -1, extremeT: number, end: number): boolean {
  const last = lastAtOrBefore(times, end - TF_SECONDS["1h"]);
  for (let k = lastAtOrBefore(times, extremeT) + 1; k >= 0 && k <= last; k++) {
    const s = lower.ss[k];
    const sw = dir > 0 ? s.lastLow : s.lastHigh;
    if (sw && sw.t > extremeT && sw.label === (dir > 0 ? "HL" : "LH") && s.beyond === dir) return true;
  }
  return false;
}

/**
 * Stop from the hour chart for a trade in `dir` entered at `entry` at time `end`: beyond its protective extreme
 * (and beyond `extreme`, the low being defended, when given) plus the hour chart's sweep buffer, at least
 * `minAtr` of the main timeframe's ATR from the entry.
 */
export function nearStop(lower: LowerFrame, times: number[], dir: 1 | -1, end: number, entry: number, mainAtr: number, extreme?: number, minAtr = DEFAULT_ENGINE_PARAMS.defend.minNearAtr): number | null {
  const k = lastAtOrBefore(times, end - TF_SECONDS["1h"]);
  if (k < 0) return null;
  const s = lower.ss[k];
  if (!(dir > 0 ? s.lastLow : s.lastHigh) || !(lower.atr[k] > 0)) return null;
  let anchor = protectiveExtreme(lower.c, s, dir, k);
  if (extreme != null) anchor = dir > 0 ? Math.min(anchor, extreme) : Math.max(anchor, extreme);
  const stop = anchor - dir * lower.buf * lower.atr[k];
  const min = entry - dir * minAtr * mainAtr;
  return dir > 0 ? Math.min(stop, min) : Math.max(stop, min);
}

/**
 * Swing highs (side "high") broken upward — a close more than 0.8 ATR above — and not closed back below by
 * more than 0.8 ATR since, known at the close of bar `t`, within `look` bars: resistance turned support
 * (and the mirror image for lows). `tests` counts nothing here and stays 0.
 */
export function flippedPivots(c: Candle[], atr: number[], t: number, K: number, side: "high" | "low", look = 300): { i: number; price: number }[] {
  const sg = side === "high" ? 1 : -1;
  const out: { i: number; price: number }[] = [];
  for (let i = Math.max(K, t - look); i <= t - K; i++) {
    let ok = true;
    for (let j = i - K; j <= i + K && ok; j++) if (j !== i && (side === "high" ? c[j].h > c[i].h : c[j].l < c[i].l)) ok = false;
    if (!ok) continue;
    const L = side === "high" ? c[i].h : c[i].l;
    let flipped = false;
    for (let j = i + K + 1; j <= t; j++) {
      const a = atr[j] || atr[t];
      const beyond = ((c[j].c - L) * sg) / a;
      if (!flipped && beyond > 0.8) flipped = true;
      else if (flipped && beyond < -0.8) {
        flipped = false;
        break;
      }
    }
    if (flipped) out.push({ i, price: L });
  }
  return out;
}

/** Defended levels on closed bars, both directions; the same direction is not repeated within 6 bars. */
export function findDefends(a: DefendArgs): DefendEvent[] {
  const { tf, c, atr, ss, filterAt, buf, lower, oi, from, rules = DEFAULT_ENGINE_PARAMS.defend } = a;
  const sec = TF_SECONDS[tf];
  const out: DefendEvent[] = [];
  const lastAt = new Map<number, number>();
  const lowerTimes = lower ? lower.c.map((x) => x.t) : [];
  const mainTimes = c.map((x) => x.t);
  const K = PIVOT_K[tf];
  for (let i = Math.max(rules.freshBars + 5, from); i < c.length; i++) {
    const A = atr[i];
    if (!(A > 0)) continue;
    for (const dir of [1, -1] as const) {
      if (i - (lastAt.get(dir) ?? -1e9) < 6) continue;
      const lowOf = (k: number) => (dir > 0 ? c[k].l : c[k].h);
      const beyond = (x: number, y: number) => (x - y) * dir < 0; // x further out than y
      // the extreme: one of the last `stallBars` bars, not exceeded since and the most extreme of the 5 bars before it
      let e = -1;
      for (let k = i - 1; k >= i - rules.stallBars; k--) {
        let ok = true;
        for (let j = k - 5; j <= i && ok; j++) if (j !== k && !beyond(lowOf(k), lowOf(j)) && lowOf(j) !== lowOf(k)) ok = false;
        // ties: the earlier bar is the extreme
        for (let j = k - 5; j < k && ok; j++) if (lowOf(j) === lowOf(k)) ok = false;
        if (ok) {
          e = k;
          break;
        }
      }
      if (e < 0) continue;
      const x = c[e], Ae = atr[e];
      if (!(Ae > 0)) continue;
      const ext = lowOf(e);
      // the stall: no further extreme since (checked above) and a close back beyond the extreme bar's close
      if (!((c[i].c - x.c) * dir > 0)) continue;
      // only the first stall after an extreme
      let first = true;
      for (let j = e + 1; j < i && first; j++) if ((c[j].c - x.c) * dir > 0) first = false;
      if (!first) continue;

      // price action at the extreme
      const range = x.h - x.l;
      const wick = dir > 0 ? Math.min(x.o, x.c) - x.l : x.h - Math.max(x.o, x.c);
      const rejection = range > 0 && wick >= 0.5 * range && (dir > 0 ? x.c - x.l : x.h - x.c) >= (2 / 3) * range;
      // a held level the extreme reached: intact pivots on this side, or broken ones from the other side
      // (resistance turned support), known before the extreme bar; the nearest to the extreme wins
      let level: number | null = null, tests = 0, shape: DefendShape | null = null;
      let levelKind: DefendEvent["levelKind"] = "pivot";
      const held = [
        ...intactPivots(c, atr, e - 1, K, dir > 0 ? "low" : "high", 300).map((p) => ({ price: p.price, tests: p.tests, kind: "pivot" as const })),
        ...flippedPivots(c, atr, e - 1, K, dir > 0 ? "high" : "low", 300).map((p) => ({ price: p.price, tests: 0, kind: "flip" as const })),
      ];
      for (const p of held) {
        const into = (p.price - ext) * dir; // how far the extreme went beyond the level (ATR units below)
        if (into < -rules.reachAtr * Ae || into > 0.8 * Ae) continue;
        const swept = into > 0 && (x.c - p.price) * dir >= -0.1 * Ae;
        if (!swept && !rejection) continue;
        if (level == null || Math.abs(p.price - ext) < Math.abs(level - ext)) {
          level = p.price;
          tests = p.tests;
          shape = swept ? "sweep" : "rejection";
          levelKind = p.kind;
        }
      }
      if (level == null) {
        // a fresh extreme with nothing under it: only a rejection counts
        let fresh = rejection;
        for (let j = e - rules.freshBars + 1; j < e && fresh; j++) if (j >= 0 && !beyond(ext, lowOf(j))) fresh = false;
        if (!fresh) continue;
        level = ext;
        levelKind = "fresh";
        shape = "rejection";
      }

      // the hour chart only counts once its structure has warmed up (LOWER_WARMUP hours before the extreme)
      const low = lower && lowerTimes.length && lowerTimes[0] <= x.t - LOWER_WARMUP * 3600 ? lower : null;
      // stops for an entry at the close of bar k: far beyond the main timeframe's protective swing (never closer
      // than the near one), near beyond the hour chart's extreme; null when the risk is outside 0.3–8 ATR
      const stopsAt = (k: number): { near: number | null; far: number } | null => {
        const s = ss[k];
        if (!(dir > 0 ? s.lastLow : s.lastHigh) || !(atr[k] > 0)) return null;
        let far = protectiveExtreme(c, s, dir, k) - dir * buf * atr[k];
        const near = low ? nearStop(low, lowerTimes, dir, c[k].t + sec, c[k].c, atr[k], ext, rules.minNearAtr) : null;
        if (near != null && (far - near) * dir > 0) far = near;
        const risk = ((c[k].c - far) * dir) / atr[k];
        return risk >= 0.3 && risk <= 8 ? { near, far } : null;
      };
      const st = stopsAt(i);
      if (!st) continue;
      const { near, far } = st;

      // evidence
      let flow: boolean | null = null;
      if (x.tbv != null && x.v > 0) {
        // absorption: a heavy bar dominated by sellers (buyers for shorts) that still closed back
        const buyShare = x.tbv / x.v;
        const absorbed = relVolume(c, e) >= 2 && (dir > 0 ? buyShare < 0.45 : buyShare > 0.55);
        // divergence: price made an equal or further extreme than the previous swing on this side (known before
        // the extreme), but cumulative taker flow did not — takers were net buyers (sellers for shorts) from the
        // close of that swing's bar to the close of the extreme bar. Not applicable when the extreme stopped short of it.
        const prev = dir > 0 ? ss[e - 1].lastLow : ss[e - 1].lastHigh;
        let divergence: boolean | null | undefined;
        if (prev && (prev.price - ext) * dir >= -0.1 * Ae) {
          const sum = netTakerFlow(c, mainTimes, prev.t + sec, x.t + sec);
          divergence = sum == null ? null : sum * dir > 0;
        }
        flow = absorbed || divergence === true ? true : divergence === null ? null : false;
      }
      const oiE = oi ? oiFlush(oi, x.t - 4 * 3600, x.t + sec) : null;
      const turn = low ? turned(low, lowerTimes, dir, x.t, c[i].t + sec) : null;
      // waiting for the hour chart: the first close (this bar or up to CONFIRM_BARS later) by which it has turned,
      // with no new extreme in between
      let confirm: DefendEvent["confirm"] = null;
      if (low) {
        for (let k = i; k < c.length && k <= i + CONFIRM_BARS; k++) {
          if (k > i && beyond(lowOf(k), ext)) break;
          if (!turned(low, lowerTimes, dir, x.t, c[k].t + sec)) continue;
          const sk = stopsAt(k);
          if (sk) confirm = { i: k, near: sk.near, far: sk.far };
          break;
        }
      }
      const equal = intactPivots(c, atr, i, K, dir > 0 ? "low" : "high", 300).filter((p) => Math.abs(p.price - ext) <= 0.1 * A).length >= 2;
      lastAt.set(dir, i);
      out.push({ i, t: c[i].t, dir, shape: shape!, levelKind, level, tests, e, extreme: ext, near, far, flow, oi: oiE, turn, confirm, filter: filterAt(i), equal, relVol: relVolume(c, e) });
    }
  }
  return out;
}

// ---------------------------------------------------------------- for the page

/**
 * Whether the hour chart can be used at `end` (a close of the main timeframe): warmed up for LOWER_WARMUP hours,
 * and its bar ending at `end` is there — not a gap, not lagging behind the main chart.
 */
export function lowerReady(times: number[], end: number): boolean {
  if (!times.length || times[0] > end - LOWER_WARMUP * 3600) return false;
  const k = lastAtOrBefore(times, end - 3600);
  return k >= 0 && times[k] === end - 3600;
}

/** Did any bar after the entry bar `i` (the forming one included) reach `stop`? */
function touched(c: Candle[], i: number, forming: Candle | null, dir: 1 | -1, stop: number): boolean {
  const bars = forming ? [...c.slice(i + 1), forming] : c.slice(i + 1);
  return bars.some((x) => (dir > 0 ? x.l <= stop : x.h >= stop));
}

const NEAR_TOUCHED = (stop: number) => `近止损 ${fmt(stop)} 入场后已经被碰过：按近止损做的话，这笔已经出局`;

/**
 * The near stop of a plan entered at the close of bar `i`, placed as the research placed it (E18): beyond the hour
 * chart's protective extreme at that close plus its sweep buffer, at least `minAtr` of the main ATR at the entry.
 * Only when it is nearer than the far stop and no bar since has reached it; otherwise why not.
 */
export function planNearStop(o: {
  lower: LowerFrame;
  times: number[];
  tf: Timeframe;
  c: Candle[];
  atr: number[];
  i: number;
  dir: 1 | -1;
  far: number;
  forming: Candle | null;
  minAtr?: number;
}): { stop: number | null; note: string | null } {
  const end = o.c[o.i].t + TF_SECONDS[o.tf];
  if (!lowerReady(o.times, end)) return { stop: null, note: "入场那根收盘时没有可用的 1 小时数据，只有结构认错位一档" };
  const n = nearStop(o.lower, o.times, o.dir, end, o.c[o.i].c, o.atr[o.i], undefined, o.minAtr);
  if (n == null) return { stop: null, note: "1 小时上还没有可用的结构点，只有结构认错位一档" };
  if (!((n - o.far) * o.dir > 0)) return { stop: null, note: "1 小时的结构点并不比结构认错位近，只有一档止损" };
  if (touched(o.c, o.i, o.forming, o.dir, n)) return { stop: null, note: NEAR_TOUCHED(n) };
  return { stop: n, note: null };
}

/** What happened at the level, in words (no conclusion about whether it holds). */
function describe(e: DefendEvent, rules: DefendRules): string {
  const long = e.dir > 0;
  const lo = long ? "低" : "高";
  const wick = `长${long ? "下" : "上"}影线`;
  const intact = long ? "之前没被收盘跌破的低点" : "之前没被收盘突破的高点";
  const what =
    e.levelKind === "fresh"
      ? `创 ${rules.freshBars} 根新${lo} ${fmt(e.extreme)}，留下${wick}`
      : e.levelKind === "flip"
        ? `回踩被突破过的${long ? "高" : "低"}点 ${fmt(e.level)}（${long ? "阻力变支撑" : "支撑变阻力"}），${e.shape === "sweep" ? "扫过后收回" : `留下${wick}`}`
        : e.shape === "sweep"
          ? `扫过${intact} ${fmt(e.level)} 后收回`
          : `回到${intact} ${fmt(e.level)} 附近，留下${wick}`;
  return `${what}，之后第一次收盘拐${long ? "上" : "下"}`;
}

export interface LiveDefendInput extends Omit<DefendArgs, "from"> {
  /** the bar still forming (its wicks count against the stops) and the latest price */
  forming: Candle | null;
  livePrice: number;
  /** the main timeframe's calibration, for the chance noise touches a stop */
  cal: Calibration | null;
  costPct: number;
  funding: { rate: number; intervalH: number } | null;
}

/** bars scanned back from the last close, so the 6-bar de-duplication matches a scan of the whole history */
const LIVE_BACK = 40;

/**
 * A level defended on one of the last 3 closed bars, per side, still valid: no bar since reached the far stop,
 * the price is not beyond it and has not run half the risk yet. Against the higher timeframe means half size,
 * as for the other plans. The near stop is dropped (with the reason) when a bar since reached it or the hour
 * chart was not up to date at the entry.
 */
export function liveDefends(a: LiveDefendInput): { long: DefendPlan | null; short: DefendPlan | null } {
  const { c, atr, tf } = a;
  const n = c.length - 1;
  const sec = TF_SECONDS[tf];
  const rules = a.rules ?? DEFAULT_ENGINE_PARAMS.defend;
  const times = a.lower ? a.lower.c.map((x) => x.t) : [];
  const evs = n > LIVE_BACK ? findDefends({ ...a, from: n - LIVE_BACK }).filter((e) => e.i >= n - 2) : [];
  const pick = (dir: 1 | -1) => {
    const list = evs.filter((e) => e.dir === dir);
    for (let k = list.length - 1; k >= 0; k--) {
      const p = toPlan(list[k]);
      if (p) return p;
    }
    return null;
  };
  return { long: pick(1), short: pick(-1) };

  function toPlan(e: DefendEvent): DefendPlan | null {
    const dir = e.dir;
    const entry = c[e.i].c;
    const risk = (entry - e.far) * dir;
    if (touched(c, e.i, a.forming, dir, e.far) || (a.livePrice - e.far) * dir <= 0 || (a.livePrice - entry) * dir >= 0.5 * risk) return null;
    const opt = (stop: number): StopOption => stopOption({ entry, stop, dir, atr: atr[e.i], cal: a.cal, tf, costPct: a.costPct, funding: a.funding });
    const ready = !!a.lower && lowerReady(times, c[e.i].t + sec);
    let near: StopOption | null = null, nearNote: string | null = null;
    if (!a.lower) nearNote = "没有 1 小时数据，只有一档止损";
    else if (!ready || e.near == null) nearNote = "入场那根收盘时没有可用的 1 小时结构，只有一档止损";
    else if (!((e.near - e.far) * dir > 0)) nearNote = "1 小时的极点止损并不比结构认错位近，只有一档止损";
    else if (touched(c, e.i, a.forming, dir, e.near)) nearNote = NEAR_TOUCHED(e.near);
    else near = opt(e.near);
    const alignment = e.filter === dir ? "with" : e.filter === -dir ? "against" : "neutral";
    return {
      side: dir > 0 ? "long" : "short",
      shape: e.shape,
      levelKind: e.levelKind,
      level: e.level,
      extreme: e.extreme,
      text: describe(e, rules),
      entry,
      entryT: c[e.i].t,
      alignment,
      size: alignment === "against" ? "half" : "full",
      far: opt(e.far),
      near,
      nearNote,
      checks: { flow: e.flow, oi: e.oi, turn: ready ? e.turn : null },
      evidence: null,
      verdictText: null,
      stats: null,
    };
  }
}
