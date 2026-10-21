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
 * Pure functions, no IO: the research and the live page (src/lib/watch.ts) share them. Everything is known at a
 * bar's close; the caller passes only bars closed by then.
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

/** The level's name on its side, e.g. "上周低点" / "上周高点". */
export function keyLevelName(kind: KeyLevelKind, dir: 1 | -1): string {
  const x = dir > 0 ? "低点" : "高点";
  return kind === "swing1d" ? `日线摆动${x}` : kind === "swing4h" ? `4 小时摆动${x}` : `${KEY_LEVEL_NAME[kind]}${x}`;
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
 * The levels worth watching, nearest first: only those at least `minAtr` (FROM_ATR) × `atr` beyond `ref` (below
 * it for lows: price comes from above), and levels within MERGE_ATR × `atr` of each other merged into one, the
 * kind higher in KEY_LEVEL_ORDER kept (the nearest of one kind first).
 */
export function pickLevels<T extends KeyLevel>(cands: T[], dir: 1 | -1, ref: number, atr: number, minAtr = FROM_ATR): T[] {
  if (!(atr > 0)) return [];
  const far = cands.filter((x) => (ref - x.price) * dir >= minAtr * atr);
  far.sort((a, b) => KEY_LEVEL_ORDER.indexOf(a.kind) - KEY_LEVEL_ORDER.indexOf(b.kind) || (b.price - a.price) * dir);
  const kept: T[] = [];
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

// ---------------------------------------------------------------- events: the research and the page

/** Candidate levels on one side known at the close of 15-minute bar `j` (keyLevelCandidates, not merged). */
export type LevelSource = (j: number, dir: 1 | -1) => KeyLevel[];

/**
 * The candidates at every 15-minute bar's close, cached: the calendar and daily part changes with the daily bar
 * and the UTC day, the 4-hour part with the 4-hour bar. `idx1` / `idx4`: per 15-minute bar, the last daily /
 * 4-hour bar closed by its close (−1: none), as alignHigher gives them.
 */
export function levelSource(c: Candle[], daily: Candle[], atr1d: number[], idx1: number[], c4h: Candle[], atr4h: number[], idx4: number[]): LevelSource {
  const dailyCache = new Map<string, KeyLevel[]>();
  const h4Cache = new Map<string, KeyLevel[]>();
  return (j, dir) => {
    const endSec = c[j].t + 900;
    const f: KeyFrames = { daily, atr1d, j1: idx1[j], c4h, atr4h, j4: idx4[j], endSec };
    const dk = `${dir}|${f.j1}|${Math.floor(endSec / 86400)}`;
    let d = dailyCache.get(dk);
    if (!d) {
      d = keyLevelCandidates({ ...f, j4: -1 }, dir);
      dailyCache.set(dk, d);
    }
    const hk = `${dir}|${f.j4}`;
    let four = h4Cache.get(hk);
    if (!four) {
      four = f.j4 >= 0 ? keyLevelCandidates({ ...f, daily: [], j1: -1 }, dir) : [];
      h4Cache.set(hk, four);
    }
    return d.concat(four);
  };
}

/** The 15-minute chart with what the events need from the hour chart, all index-aligned with `c`. */
export interface WatchInput {
  /** 15-minute bars, closed */
  c: Candle[];
  /** the hour chart's ATR known at each 15-minute bar's close (NaN before the first hour bar): the unit of everything */
  atr: number[];
  /** the 15-minute structure */
  ss: StructureState[];
  /** hour bars, their structure, and per 15-minute bar the last hour bar closed by its close (−1: none) */
  h: Candle[];
  hss: StructureState[];
  hIdx: number[];
  levels: LevelSource;
}

/**
 * The key level bar `k` touched after coming from above (for lows): levels known before bar `k` traded, at least
 * FROM_ATR beyond the close FROM_BARS bars earlier, merged; the nearest one reached, or null.
 */
export function touchAt(w: WatchInput, k: number, dir: 1 | -1): KeyLevel | null {
  const { c } = w;
  // known at the close of bar k − 1, i.e. before bar k trades: the touching bar never defines its own level
  const cands = w.levels(k - 1, dir);
  // nothing reached: skip the filtering
  if (!cands.some((x) => (dir > 0 ? c[k].l <= x.price : c[k].h >= x.price))) return null;
  return touchedLevel(c[k], pickLevels(cands, dir, c[k - FROM_BARS].c, w.atr[k - 1]), dir);
}

/**
 * The deepest key level bar `k` reached after coming from above (the same levels as touchAt): the level being
 * tested when one bar runs through several. Null when it reached none.
 */
export function deepestTouched(w: WatchInput, k: number, dir: 1 | -1): KeyLevel | null {
  const { c } = w;
  const cands = w.levels(k - 1, dir);
  if (!cands.some((x) => (dir > 0 ? c[k].l <= x.price : c[k].h >= x.price))) return null;
  let best: KeyLevel | null = null;
  for (const x of pickLevels(cands, dir, c[k - FROM_BARS].c, w.atr[k - 1])) if ((dir > 0 ? c[k].l <= x.price : c[k].h >= x.price) && (!best || (x.price - best.price) * dir < 0)) best = x;
  return best;
}

export interface EventStart {
  k0: number;
  dir: 1 | -1;
  level: KeyLevel;
}

/**
 * The research's events: bars `from` … `to` − 1, both directions, the first touch of a level and then none in
 * that direction for `cooldown` bars. In bar order (longs before shorts within a bar).
 */
export function scanEvents(w: WatchInput, from: number, to: number, cooldown: number): EventStart[] {
  const out: EventStart[] = [];
  const next = new Map<number, number>();
  for (let k = from; k < to; k++) {
    for (const dir of [1, -1] as const) {
      if (k < (next.get(dir) ?? 0)) continue;
      const level = touchAt(w, k, dir);
      if (!level) continue;
      next.set(dir, k + cooldown);
      out.push({ k0: k, dir, level });
    }
  }
  return out;
}

/** Bar `k` closes together with an hour bar. */
export const hourClosed = (w: WatchInput, k: number) => w.hIdx[k] >= 0 && w.h[w.hIdx[k]].t + 3600 === w.c[k].t + 900;

/**
 * The four entries of E19 on one event: A at the level on the touch, B the first close back beyond it within
 * `reclaimBars`, C the 15-minute turn and C1 the hour chart's (on its close) within `window` bars.
 */
export function eventTriggers(w: WatchInput, e: EventStart, window: number, reclaimBars: number): Record<"A" | "B" | "C" | "C1", Trigger | null> {
  const { c } = w;
  const { k0: k, dir } = e;
  const L = e.level.price;
  const ext = dir > 0 ? Math.min(L, c[k].l) : Math.max(L, c[k].h);
  return {
    A: { i: k, extreme: ext, extremeI: k, extremeT: c[k].t },
    B: firstReclaim(c, k, L, dir, reclaimBars),
    C: firstTurn(c, k, dir, window, (j, tX) => turnAt(w.ss[j], dir, tX)),
    C1: firstTurn(c, k, dir, window, (j, tX) => hourClosed(w, j) && turnAt(w.hss[w.hIdx[j]], dir, tX)),
  };
}

// ---------------------------------------------------------------- the live state of one side

/** The page's settings (EngineParams.watch). */
export interface WatchRules {
  /** "near": a level within this many hour ATR */
  nearAtr: number;
  /** an event is watched for this many 15-minute bars after the touch (288 = 3 days) */
  windowBars: number;
}

/** an event ends once a close is this many hour ATR beyond the level the trade's way */
export const END_ATR = 3;
/** a new extreme within this many bars: still falling */
export const FRESH_BARS = 4;
/** a close this many hour ATR beyond the level: through it */
export const BEYOND_ATR = 0.1;

/**
 * far: nothing going on; near: a level within `nearAtr`; falling (别接): touched and still going, a close through
 * the level or a new extreme within FRESH_BARS; watching (观察): touched, stalled, not turned; turned (已转强):
 * the 15-minute turn after the newest extreme, not undone since.
 */
export type WatchStateName = "far" | "near" | "falling" | "watching" | "turned";

export interface WatchLevel {
  price: number;
  kind: KeyLevelKind;
  name: string;
}

export interface WatchTurn {
  /** open time of the bar at whose close the chart turned; the close is the entry */
  t: number;
  entry: number;
  /** beyond `extreme` plus the p80 sweep buffer (hour ATR at the turn) */
  stop: number;
  extreme: number;
}

export interface WatchEvent {
  /** open time of the touching bar, and 15-minute bars since */
  startT: number;
  bars: number;
  /** the newest extreme since the touch (lowest low, for longs) and its bar's open time */
  extreme: number;
  extremeT: number;
  /** the last 15-minute swing on the other side made after the extreme (the bounce high, for longs), or null */
  bounce: number | null;
  /** 1, plus one for every turn undone by a new extreme */
  attempt: number;
  /** every new extreme since the touch (the first is the touching bar); bars extending one another count as one */
  newExtremes: { t: number; price: number }[];
  /** the extreme went through the level and the last close is back beyond it */
  reclaimed: boolean;
  turn: WatchTurn | null;
  /** the hour chart (its last closed bar) has turned after the extreme too */
  hourTurned: boolean;
  /** where the stop would go now: beyond the newest extreme plus the sweep buffer */
  stop: number;
}

export interface WatchSide {
  dir: 1 | -1;
  /** open time of the 15-minute bar the state is at (its close) */
  t: number;
  state: WatchStateName;
  /** the event's level (the deepest touched since it began), else the nearest level on this side (null: none) */
  level: WatchLevel | null;
  /** (level − close) / hour ATR: negative below the close */
  distAtr: number | null;
  event: WatchEvent | null;
  atr1h: number;
}

const r2 = (x: number) => Math.round(x * 100) / 100;

interface Followed {
  k0: number;
  level: KeyLevel;
  x: number;
  xi: number;
  attempt: number;
  newExtremes: { t: number; price: number }[];
  turn: WatchTurn | null;
  /** the bar whose close ended the event (−1: still going at n) */
  endedAt: number;
}

/** One event from its touch at `k0` to bar `n` (the caller stops it at the window), or to the close that ended it. */
function follow(w: WatchInput & { buf: number }, dir: 1 | -1, k0: number, level: KeyLevel, n: number): Followed {
  const { c, atr } = w;
  const e: Followed = { k0, level, x: dir > 0 ? c[k0].l : c[k0].h, xi: k0, attempt: 1, newExtremes: [], turn: null, endedAt: -1 };
  e.newExtremes.push({ t: c[k0].t, price: e.x });
  for (let k = k0; k <= n; k++) {
    // falling on to (or through) a deeper key level: that level is the one being tested now (the event goes on)
    const deeper = deepestTouched(w, k, dir);
    if (deeper && (deeper.price - e.level.price) * dir < 0) e.level = deeper;
    if (k === k0) continue;
    const v = dir > 0 ? c[k].l : c[k].h;
    if ((v - e.x) * dir < 0) {
      // bars extending one another are one new extreme
      if (e.xi === k - 1) e.newExtremes[e.newExtremes.length - 1] = { t: c[k].t, price: v };
      else e.newExtremes.push({ t: c[k].t, price: v });
      e.x = v;
      e.xi = k;
      // a turn undone: wait for the next one after this extreme
      if (e.turn) {
        e.turn = null;
        e.attempt++;
      }
    }
    if (!e.turn && turnAt(w.ss[k], dir, c[e.xi].t)) e.turn = { t: c[k].t, entry: c[k].c, stop: stopBeyond(e.x, dir, w.buf, atr[k]), extreme: e.x };
    if ((c[k].c - e.level.price) * dir >= END_ATR * atr[k]) {
      e.endedAt = k;
      break;
    }
  }
  return e;
}

/**
 * One side (dir 1: longs at lows; −1: shorts at highs) at the close of bar `n`, from bars ≤ n only. A touch
 * starts an event; from it the running extreme, the turns and their failures are followed bar by bar (the turn
 * is the research's C entry). When price reaches a deeper key level (on the touching bar or later, coming from
 * above it), that level is the one shown and measured against. An event ends `windowBars` bars after its touch,
 * or at a close END_ATR beyond the level the trade's way; touches while it runs belong to it, and the next touch
 * after its end starts a new one. The walk starts two windows back (an event running before that has ended by
 * then): one pass, O(windowBars) per call.
 */
export function watchState(w: WatchInput & { buf: number; rules: WatchRules }, dir: 1 | -1, n = w.c.length - 1): WatchSide {
  const { c, atr } = w;
  const a = atr[n];
  const close = c[n].c;
  const out: WatchSide = { dir, t: c[n].t, state: "far", level: null, distAtr: null, event: null, atr1h: a };
  if (!(a > 0)) return out;
  const win = w.rules.windowBars;
  let ev: Followed | null = null;
  for (let k = Math.max(FROM_BARS, 1, n - 2 * win + 1); k <= n; k++) {
    const lv = touchAt(w, k, dir);
    if (!lv) continue;
    const e = follow(w, dir, k, lv, Math.min(n, k + win - 1));
    // ended by a move away: the next touch after that close; by the window: from the bar after it
    if (e.endedAt >= 0) k = e.endedAt;
    else if (k + win - 1 < n) k = k + win - 1;
    else {
      ev = e;
      break;
    }
  }
  if (!ev) {
    const near = pickLevels(w.levels(n, dir), dir, close, a, 0)[0];
    if (!near) return out;
    const d = (near.price - close) / a;
    return { ...out, state: Math.abs(d) <= w.rules.nearAtr ? "near" : "far", level: { ...near, name: keyLevelName(near.kind, dir) }, distAtr: r2(d) };
  }

  const { k0, x, xi, turn } = ev;
  const L = ev.level.price;
  const other = dir > 0 ? w.ss[n].lastHigh : w.ss[n].lastLow;
  const j = w.hIdx[n];
  const beyond = (L - close) * dir > BEYOND_ATR * a;
  const fresh = xi > n - FRESH_BARS;
  return {
    ...out,
    state: turn ? "turned" : beyond || fresh ? "falling" : "watching",
    level: { ...ev.level, name: keyLevelName(ev.level.kind, dir) },
    distAtr: r2((L - close) / a),
    event: {
      startT: c[k0].t,
      bars: n - k0,
      extreme: x,
      extremeT: c[xi].t,
      bounce: other && other.t > c[xi].t ? other.price : null,
      attempt: ev.attempt,
      newExtremes: ev.newExtremes,
      reclaimed: (x - L) * dir < 0 && (close - L) * dir > 0,
      turn,
      hourTurned: j >= 0 && turnAt(w.hss[j], dir, c[xi].t),
      stop: stopBeyond(x, dir, w.buf, a),
    },
  };
}
