import type { Candle } from "../types.ts";
import { prevPeriodHL } from "./levels.ts";
import { intactPivots, PIVOT_K } from "./risk.ts";
import type { StructureState } from "./structure.ts";

/**
 * Watching a key level: price falls to a low that matters (the previous day / week / month low, or an intact
 * 4-hour / daily swing low) and the beginner's question is whether to catch it there. The rule measured in E19
 * (src/lib/research/watch.ts) is not to guess the bottom: wait until the 15-minute chart, after the newest low,
 * makes a higher low and then closes above its latest bounce high ("15 分钟转强"), with the stop beyond that
 * newest low. Shorts at highs are the mirror image.
 *
 * Pure functions, no IO: the research and (later) the live page share them. Everything is known at a bar's
 * close; the caller passes only bars closed by then.
 */

/** Key levels, in their order of preference when two sit within 0.25 ATR of each other. */
export type KeyLevelKind = "prevMonth" | "prevWeek" | "swing1d" | "prevDay" | "swing4h";
export const KEY_LEVEL_ORDER: KeyLevelKind[] = ["prevMonth", "prevWeek", "swing1d", "prevDay", "swing4h"];
export const KEY_LEVEL_NAME: Record<KeyLevelKind, string> = {
  prevMonth: "上月",
  prevWeek: "上周",
  swing1d: "日线摆动点",
  prevDay: "前一日",
  swing4h: "4 小时摆动点",
};

export interface KeyLevel {
  price: number;
  kind: KeyLevelKind;
}

/** levels closer than this many ATR (of the hour chart) are one level */
export const MERGE_ATR = 0.25;
/** price must have come from at least this many ATR away… */
export const FROM_ATR = 0.5;
/** …measured from the close this many 15-minute bars earlier */
export const FROM_BARS = 16;

export interface KeyFrames {
  /** daily bars; `j1` is the last one closed by `endSec` (−1: none) */
  daily: Candle[];
  atr1d: number[];
  j1: number;
  /** 4-hour bars; `j4` is the last one closed by `endSec` (−1: none) */
  c4h: Candle[];
  atr4h: number[];
  j4: number;
  /** the moment the levels are known at (a bar's close, Unix seconds) */
  endSec: number;
}

/**
 * Every candidate level on one side (lows for `dir` 1, highs for −1) known at `endSec`: the previous complete
 * UTC day, week and month, and the intact swing points of the 4-hour and daily charts (confirmed and never
 * closed through by more than 0.1 ATR, within 300 bars). Not filtered or merged.
 */
export function keyLevelCandidates(f: KeyFrames, dir: 1 | -1): KeyLevel[] {
  const out: KeyLevel[] = [];
  const side = dir > 0 ? "low" : "high";
  const upTo = f.daily.slice(0, f.j1 + 1);
  for (const [period, kind] of [
    ["month", "prevMonth"],
    ["week", "prevWeek"],
    ["day", "prevDay"],
  ] as const) {
    const p = prevPeriodHL(upTo, f.endSec, period);
    if (p) out.push({ price: dir > 0 ? p.l : p.h, kind });
  }
  if (f.j1 >= 0) for (const p of intactPivots(f.daily, f.atr1d, f.j1, PIVOT_K["1d"], side, 300)) out.push({ price: p.price, kind: "swing1d" });
  if (f.j4 >= 0) for (const p of intactPivots(f.c4h, f.atr4h, f.j4, PIVOT_K["4h"], side, 300)) out.push({ price: p.price, kind: "swing4h" });
  return out;
}

/**
 * The levels worth watching, nearest first: only those at least FROM_ATR × `atr` beyond `ref` (below it for
 * lows: price comes from above), and levels within MERGE_ATR × `atr` of each other merged into one, the kind
 * higher in KEY_LEVEL_ORDER kept (the nearest of one kind first).
 */
export function pickLevels(cands: KeyLevel[], dir: 1 | -1, ref: number, atr: number): KeyLevel[] {
  if (!(atr > 0)) return [];
  const far = cands.filter((x) => (ref - x.price) * dir >= FROM_ATR * atr);
  far.sort((a, b) => KEY_LEVEL_ORDER.indexOf(a.kind) - KEY_LEVEL_ORDER.indexOf(b.kind) || (b.price - a.price) * dir);
  const kept: KeyLevel[] = [];
  for (const x of far) if (!kept.some((k) => Math.abs(k.price - x.price) <= MERGE_ATR * atr)) kept.push(x);
  return kept.sort((a, b) => (b.price - a.price) * dir);
}

/** The key levels on one side known at `f.endSec`, filtered against `ref` and merged (see pickLevels). */
export function watchLevels(f: KeyFrames, dir: 1 | -1, ref: number, atr: number): KeyLevel[] {
  return pickLevels(keyLevelCandidates(f, dir), dir, ref, atr);
}

/** The level a bar reached (low at or below it, for lows): the nearest of those reached, or null. */
export function touchedLevel(bar: Candle, levels: KeyLevel[], dir: 1 | -1): KeyLevel | null {
  let best: KeyLevel | null = null;
  for (const x of levels) if ((dir > 0 ? bar.l <= x.price : bar.h >= x.price) && (!best || (x.price - best.price) * dir > 0)) best = x;
  return best;
}

/**
 * At this bar's close the chart has turned in `dir` after the extreme set at `extremeT` (bar open time): the
 * last swing on the defended side (the last low, for longs) was made after it and is a higher low (lower high),
 * and the close is beyond the last swing on the other side by at least 0.1 ATR.
 */
export function turnAt(s: StructureState, dir: 1 | -1, extremeT: number): boolean {
  const sw = dir > 0 ? s.lastLow : s.lastHigh;
  return !!sw && sw.t > extremeT && sw.label === (dir > 0 ? "HL" : "LH") && s.beyond === dir;
}

export interface Trigger {
  /** bar at whose close the entry is taken */
  i: number;
  /** the newest extreme by then (lowest low since the touch, for longs), its bar and that bar's open time */
  extreme: number;
  extremeI: number;
  extremeT: number;
}

/** Running extreme from bar `k0` to bar `k` (inclusive); the earliest bar wins a tie. */
function extremeUpTo(c: Candle[], k0: number, k: number, dir: 1 | -1): { x: number; i: number } {
  let x = dir > 0 ? c[k0].l : c[k0].h, i = k0;
  for (let j = k0 + 1; j <= k; j++) {
    const v = dir > 0 ? c[j].l : c[j].h;
    if ((v - x) * dir < 0) {
      x = v;
      i = j;
    }
  }
  return { x, i };
}

/**
 * Walks bars k0+1 … k0+window, tracking the newest extreme since the touch at `k0`; the first bar at whose close
 * `turned(k, extremeT)` holds, or null. `turned` must only read what is known at bar k's close.
 */
export function firstTurn(c: Candle[], k0: number, dir: 1 | -1, window: number, turned: (k: number, extremeT: number) => boolean): Trigger | null {
  let { x, i } = extremeUpTo(c, k0, k0, dir);
  for (let k = k0 + 1; k < c.length && k <= k0 + window; k++) {
    const v = dir > 0 ? c[k].l : c[k].h;
    if ((v - x) * dir < 0) {
      x = v;
      i = k;
    }
    if (turned(k, c[i].t)) return { i: k, extreme: x, extremeI: i, extremeT: c[i].t };
  }
  return null;
}

/**
 * Swept and reclaimed: the first bar in k0 … k0+bars that closes back beyond `level` (above it, for lows); the
 * touching bar itself only when it traded through the level, not merely to it.
 */
export function firstReclaim(c: Candle[], k0: number, level: number, dir: 1 | -1, bars = 16): Trigger | null {
  for (let k = k0; k < c.length && k <= k0 + bars; k++) {
    const back = (c[k].c - level) * dir > 0;
    const through = k > k0 || (dir > 0 ? c[k].l < level : c[k].h > level);
    if (back && through) {
      const { x, i } = extremeUpTo(c, k0, k, dir);
      return { i: k, extreme: x, extremeI: i, extremeT: c[i].t };
    }
  }
  return null;
}

/** Stop beyond the newest extreme plus the sweep buffer (ATR units of `atr`). */
export const stopBeyond = (extreme: number, dir: 1 | -1, buf: number, atr: number) => extreme - dir * buf * atr;
