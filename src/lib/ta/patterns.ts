import type { Candle, Timeframe } from "../types.ts";
import { TF_SECONDS } from "../types.ts";
import { flippedPivots } from "./defend.ts";
import { prevPeriodHL } from "./levels.ts";
import { alignHigher } from "./plan.ts";
import { bufferAtr, intactPivots, PIVOT_K } from "./risk.ts";
import type { StructureState } from "./structure.ts";

/**
 * Naked-K patterns (price action): five classic shapes on one timeframe's closed bars, each with the close that
 * confirms it, the pattern's extreme, the stop beyond it and where it sits — with or against the structure, at a
 * key level or in the middle. Measured in E20 (src/lib/research/patterns.ts); the page will use the same rules.
 *
 * Definitions are for longs; shorts are the exact mirror image.
 * - pin (长影线): a bar with a long lower wick at the lowest low of the last 6 bars; buy the first close above its
 *   high within 3 bars, unless a close below its low comes first.
 * - engulf (吞没): a down bar, then an up bar whose body covers it, the pair at the lowest low of the last 6 bars;
 *   buy the first close above the pair's high within 3 bars, unless a close below their low comes first.
 * - inside (孕线突破): a wide mother bar, then 1–3 bars inside it; the first close outside the mother within 3 bars
 *   is the entry, long above its high (stop under its low), short below its low.
 * - fake2b (假突破 2B): the first bar to trade below the last confirmed swing low, then a close back above it
 *   within that bar and the next two; void on a close 0.8 ATR below first.
 * - retest (突破回踩): the first close 0.1 ATR above the last confirmed swing high, then bars coming back to within
 *   0.25 ATR of it in the next 10; buy the first close above the latest such bar's high within 3 bars of it.
 *
 * The stop is the pattern's extreme X minus the p80 sweep buffer × ATR at the entry bar; a risk outside 0.3–8 ATR
 * is not traded (as plan.ts). Pure functions, no IO; given bars up to t, nothing after t is read.
 */

export type PatternKind = "pin" | "engulf" | "inside" | "fake2b" | "retest";
export const PATTERNS: PatternKind[] = ["pin", "engulf", "inside", "fake2b", "retest"];
export const PATTERN_NAME: Record<PatternKind, string> = {
  pin: "长影线",
  engulf: "吞没",
  inside: "孕线突破",
  fake2b: "假突破 2B",
  retest: "突破回踩",
};
/** the patterns whose location is classified; 2B and the retest sit on a swing point by definition */
export const LOCATED: PatternKind[] = ["pin", "engulf", "inside"];

/** with the structure on the pattern's bar, against it, or a range */
export type PaTrend = "with" | "against" | "range";
export const TREND_NAME: Record<PaTrend, string> = { with: "顺势", against: "逆势", range: "区间" };
export type PaLoc = "key" | "mid";
export const LOC_NAME: Record<PaLoc, string> = { key: "关键位", mid: "中间" };

/** The thresholds, recorded in the report as `rules` (the page hides the numbers when they differ). */
export const PA_RULES = {
  /** ① range ≥ this × ATR */
  pinRangeAtr: 0.5,
  /** ① lower wick ≥ this share of the range and close ≥ pinClose of the way up it: the rejection thresholds of ta/defend.ts */
  pinWick: 0.5,
  pinClose: 2 / 3,
  /** ①②: the extreme is the lowest of the pattern and the bars before it, back to s − extremeBars */
  extremeBars: 5,
  /** ①②③: the confirming close must come within this many bars after the pattern */
  confirmBars: 3,
  /** ② the engulfing body ≥ this × ATR */
  engulfBodyAtr: 0.3,
  /** ③ the mother's range ≥ this × ATR, followed by 1 … maxInside inside bars */
  motherAtr: 0.8,
  maxInside: 3,
  /** ④ the close back above the swing within the break bar and this many after; void on a close voidAtr below it */
  reclaimBars: 2,
  voidAtr: 0.8,
  /** ⑤ the breakout close is breakAtr beyond the swing; a bar within retestAtr of it is a retest, within retestBars;
   * the entry within retestConfirm bars of the latest retest; over on a close voidAtr back below */
  breakAtr: 0.1,
  retestAtr: 0.25,
  retestBars: 10,
  retestConfirm: 3,
  /** ①②③: a support within this × ATR of the extreme makes it a key level */
  keyAtr: 0.5,
  /** the stop buffer's sweep-depth quantile, and the risk allowed (ATR) */
  stopQ: 80,
  minRiskAtr: 0.3,
  maxRiskAtr: 8,
};

/** A support (dir 1) or resistance (dir −1) level known at a bar's close. */
export interface PaLevel {
  price: number;
  /** pivot: an intact swing point of this timeframe; flip: a broken one from the other side; higher: an intact
   * swing of a higher timeframe; period: the previous day / week / month */
  kind: "pivot" | "flip" | "higher" | "period";
  /** the bar of this timeframe the swing was made on (pivot, flip) */
  i?: number;
}
export type PaLevelSource = (s: number, dir: 1 | -1) => PaLevel[];

export interface PaInput {
  tf: Timeframe;
  /** closed bars */
  c: Candle[];
  atr: number[];
  ss: StructureState[];
  /** the levels for the key-level test (paLevelSource); without it nothing is at a key level */
  levels?: PaLevelSource;
  /** the stop's sweep buffer, ATR (default: bufferAtr(null, PA_RULES.stopQ)) */
  buf?: number;
}

export interface PaSetup {
  kind: PatternKind;
  dir: 1 | -1;
  /** first bar of the pattern (pin: the pin; engulf: the down bar; inside: the mother; fake2b / retest: the break) */
  start: number;
  /** the bar the classification is made on, with it and earlier bars only (pin, engulf: the pattern's last bar;
   * inside: the last inside bar; fake2b: the bar before the break; retest: the bar before the entry) */
  s: number;
  /** entered: the confirming close came; waiting: still possible at the last bar; void: invalidated first;
   * expired: the window passed */
  status: "entered" | "waiting" | "void" | "expired";
  /** entry bar (entered only): the entry is its close */
  e: number | null;
  /** the price a close must get beyond to enter (above it for longs) */
  trigger: number;
  /** the pattern's extreme X */
  extreme: number;
  entry: number | null;
  /** X − dir × buf × ATR at the entry bar (waiting: at the last bar) */
  stop: number;
  /** the risk in ATR (waiting: from the trigger) */
  riskAtr: number;
  /** the risk is within minRiskAtr … maxRiskAtr: the trade is taken */
  ok: boolean;
  trend: PaTrend;
  /** at a key level or in the middle; null until located (only entered and waiting setups are) */
  loc: PaLoc | null;
}

/** The higher timeframes whose intact swings count as key levels, and the previous periods, by timeframe. */
export const PA_HIGHER: Partial<Record<Timeframe, Timeframe[]>> = { "15m": ["4h", "1d"], "1h": ["4h", "1d"], "4h": ["1d"], "1d": ["1w"] };
export const PA_PERIODS: Partial<Record<Timeframe, ("day" | "week" | "month")[]>> = { "15m": ["day", "week", "month"], "1h": ["day", "week", "month"], "4h": ["day", "week", "month"], "1d": ["week", "month"] };

export interface PaFrame {
  tf: Timeframe;
  c: Candle[];
  atr: number[];
}

/**
 * The levels known at the close of each bar of `c`, cached by bar and side (each call scans a few hundred bars,
 * so it is only asked on the bars a pattern needs): this timeframe's intact swing points and the broken ones from
 * the other side (resistance turned support), the higher timeframes' intact swing points (only bars closed by
 * then, as alignHigher gives them), and the previous day / week / month from `daily` (for 1d, `c` itself).
 */
export function paLevelSource(tf: Timeframe, c: Candle[], atr: number[], higher: PaFrame[], daily: Candle[] | null): PaLevelSource {
  const K = PIVOT_K[tf];
  const sec = TF_SECONDS[tf];
  const periods = PA_PERIODS[tf] ?? [];
  const idx = higher.map((f) => alignHigher(c, tf, f.c, f.tf));
  const dIdx = daily ? alignHigher(c, tf, daily, "1d") : null;
  const own = new Map<number, PaLevel[]>();
  const high = higher.map(() => new Map<number, PaLevel[]>());
  const period = new Map<string, PaLevel[]>();
  return (s, dir) => {
    const key = 2 * s + (dir > 0 ? 1 : 0);
    let v = own.get(key);
    if (v) return v;
    const side = dir > 0 ? "low" : "high";
    v = [];
    for (const p of intactPivots(c, atr, s, K, side)) v.push({ price: p.price, kind: "pivot", i: p.i });
    for (const p of flippedPivots(c, atr, s, K, dir > 0 ? "high" : "low")) v.push({ price: p.price, kind: "flip", i: p.i });
    higher.forEach((f, n) => {
      const k = idx[n][s];
      if (k < 0) return;
      const hk = 2 * k + (dir > 0 ? 1 : 0);
      let x = high[n].get(hk);
      if (!x) {
        x = intactPivots(f.c, f.atr, k, PIVOT_K[f.tf], side, 300).map((p) => ({ price: p.price, kind: "higher" as const }));
        high[n].set(hk, x);
      }
      v!.push(...x);
    });
    if (daily && dIdx) {
      const endSec = c[s].t + sec;
      const jd = dIdx[s];
      const pk = `${dir}|${jd}|${Math.floor(endSec / 86400)}`;
      let x = period.get(pk);
      if (!x) {
        x = [];
        const upTo = daily.slice(Math.max(0, jd - 70), jd + 1);
        for (const p of periods) {
          const hl = prevPeriodHL(upTo, endSec, p);
          if (hl) x.push({ price: dir > 0 ? hl.l : hl.h, kind: "period" });
        }
        period.set(pk, x);
      }
      v.push(...x);
    }
    own.set(key, v);
    return v;
  };
}

/** The structure on bar s against the trade's direction. */
export function trendOf(s: StructureState | undefined, dir: 1 | -1): PaTrend {
  const st = s?.state ?? "range";
  return st === "range" ? "range" : (st === "up") === dir > 0 ? "with" : "against";
}

/**
 * At a key level: a support (resistance for shorts) within keyAtr × ATR of the extreme, known at bar s. The
 * pattern's own bars are not a level for themselves (a swing point on them is only known because of the pattern).
 * 2B and the retest are at a swing point by definition.
 */
export function locateSetup(inp: PaInput, x: PaSetup): PaLoc {
  if (!LOCATED.includes(x.kind)) return "key";
  if (!inp.levels) return "mid";
  const A = inp.atr[x.s];
  if (!(A > 0)) return "mid";
  for (const L of inp.levels(x.s, x.dir)) {
    if (L.i != null && L.i >= x.start) continue;
    if (Math.abs(x.extreme - L.price) <= PA_RULES.keyAtr * A) return "key";
  }
  return "mid";
}

/**
 * Every setup recognised on a bar in [from, to) (pin, engulf: the pattern's last bar; inside: the mother; fake2b,
 * retest: the break bar). The result does not depend on `from` / `to`, so the history can be scanned in chunks.
 * `locate` (default true) classifies the location of entered and waiting setups; otherwise `loc` stays null and
 * locateSetup can be called for the ones needed.
 */
export function findPatterns(inp: PaInput, opts: { from?: number; to?: number; kinds?: PatternKind[]; locate?: boolean } = {}): PaSetup[] {
  const { c, atr, ss } = inp;
  const n = c.length;
  const R = PA_RULES;
  const buf = inp.buf ?? bufferAtr(null, R.stopQ);
  const kinds = opts.kinds ?? PATTERNS;
  const from = Math.max(R.extremeBars + 1, opts.from ?? 0);
  const to = Math.min(n, opts.to ?? n);
  const last = n - 1;
  const out: PaSetup[] = [];
  const lowOf = (j: number, dir: 1 | -1) => (dir > 0 ? c[j].l : c[j].h);
  const highOf = (j: number, dir: 1 | -1) => (dir > 0 ? c[j].h : c[j].l);
  /** the extreme of bars a..b (lowest low for longs) */
  const extremeOf = (a: number, b: number, dir: 1 | -1) => {
    let x = lowOf(a, dir);
    for (let j = a + 1; j <= b; j++) if ((lowOf(j, dir) - x) * dir < 0) x = lowOf(j, dir);
    return x;
  };

  const push = (kind: PatternKind, dir: 1 | -1, start: number, s: number, X: number, trigger: number, status: PaSetup["status"], e: number | null) => {
    const at = e ?? last;
    const A = atr[at];
    if (!(A > 0)) return;
    const stop = X - dir * buf * A;
    const entry = e != null ? c[e].c : null;
    const riskAtr = (((entry ?? trigger) - stop) * dir) / A;
    out.push({
      kind,
      dir,
      start,
      s,
      status,
      e,
      trigger,
      extreme: X,
      entry,
      stop,
      riskAtr,
      ok: riskAtr >= R.minRiskAtr && riskAtr <= R.maxRiskAtr,
      trend: trendOf(ss[s], dir),
      loc: null,
    });
  };

  /**
   * ①②: the first close beyond `trigger` in bars s + 1 … s + confirmBars, unless a close beyond X (against the
   * trade) comes first.
   */
  const confirm = (kind: PatternKind, dir: 1 | -1, start: number, s: number, X: number, trigger: number) => {
    const end = s + R.confirmBars;
    for (let j = s + 1; j <= Math.min(end, last); j++) {
      if ((c[j].c - trigger) * dir > 0) return push(kind, dir, start, s, X, trigger, "entered", j);
      if ((c[j].c - X) * dir < 0) return push(kind, dir, start, s, X, trigger, "void", null);
    }
    push(kind, dir, start, s, X, trigger, end > last ? "waiting" : "expired", null);
  };

  // ① long wick
  if (kinds.includes("pin")) {
    for (let s = from; s < to; s++) {
      const x = c[s], A = atr[s];
      const range = x.h - x.l;
      if (!(A > 0) || !(range >= R.pinRangeAtr * A)) continue;
      for (const dir of [1, -1] as const) {
        const wick = dir > 0 ? Math.min(x.o, x.c) - x.l : x.h - Math.max(x.o, x.c);
        const close = dir > 0 ? x.c - x.l : x.h - x.c;
        // the rejection thresholds of ta/defend.ts (findDefends), not shared to leave that module untouched
        if (!(wick >= R.pinWick * range && close >= R.pinClose * range)) continue;
        if ((extremeOf(s - R.extremeBars, s - 1, dir) - lowOf(s, dir)) * dir < 0) continue;
        confirm("pin", dir, s, s, lowOf(s, dir), highOf(s, dir));
      }
    }
  }

  // ② engulfing
  if (kinds.includes("engulf")) {
    for (let s = Math.max(from, R.extremeBars + 1); s < to; s++) {
      const p = c[s - 1], x = c[s], A = atr[s];
      if (!(A > 0) || !(Math.abs(x.c - x.o) >= R.engulfBodyAtr * A)) continue;
      for (const dir of [1, -1] as const) {
        // a bar against the trade, then one with it whose body covers the first one's
        if (!((p.c - p.o) * dir < 0 && (x.c - x.o) * dir > 0)) continue;
        if (!((x.o - p.c) * dir <= 0 && (x.c - p.o) * dir >= 0)) continue;
        const X = extremeOf(s - 1, s, dir);
        if ((extremeOf(s - R.extremeBars, s - 2, dir) - X) * dir < 0) continue;
        const trigger = dir > 0 ? Math.max(p.h, x.h) : Math.min(p.l, x.l);
        confirm("engulf", dir, s - 1, s, X, trigger);
      }
    }
  }

  // ③ inside-bar breakout
  if (kinds.includes("inside")) {
    const inside = (j: number, m: number) => c[j].h <= c[m].h && c[j].l >= c[m].l;
    for (let m = Math.max(from, 1); m < to; m++) {
      const A = atr[m];
      if (!(A > 0) || !(c[m].h - c[m].l >= R.motherAtr * A)) continue;
      // nested inside bars count once, on the outermost mother
      if (inside(m, m - 1)) continue;
      let run = 0;
      while (run < R.maxInside && m + run + 1 <= last && inside(m + run + 1, m)) run++;
      if (!run) continue;
      const s = m + run;
      const hi = c[m].h, lo = c[m].l;
      const end = s + R.confirmBars;
      let done = false;
      for (let j = s + 1; j <= Math.min(end, last) && !done; j++) {
        if (c[j].c > hi) push("inside", 1, m, s, lo, hi, "entered", j);
        else if (c[j].c < lo) push("inside", -1, m, s, hi, lo, "entered", j);
        else continue;
        done = true;
      }
      if (done) continue;
      // the run may still grow while the data ends inside it: then nothing is known yet beyond "waiting"
      const status = end > last ? "waiting" : "expired";
      push("inside", 1, m, s, lo, hi, status, null);
      push("inside", -1, m, s, hi, lo, status, null);
    }
  }

  // ④ false break (2B) and ⑤ breakout-retest: the first bar beyond a confirmed swing, once per swing
  const firstHit = new Map<string, number>();
  /**
   * The first bar after the swing's confirmation that `hit` is true for, given that it is true for bar `b`: the
   * swing is the last one of its kind at the close of every bar in between, so this is the bar the pattern starts on.
   */
  const first = (tag: string, sw: { i: number; confirmedAt: number }, b: number, hit: (j: number) => boolean) => {
    const k = `${tag}|${sw.i}`;
    let j = firstHit.get(k);
    if (j == null) {
      j = sw.confirmedAt + 1;
      while (j < b && !hit(j)) j++;
      firstHit.set(k, j);
    }
    return j;
  };

  if (kinds.includes("fake2b")) {
    for (let b = Math.max(from, 1); b < to; b++) {
      for (const dir of [1, -1] as const) {
        const P = dir > 0 ? ss[b - 1]?.lastLow : ss[b - 1]?.lastHigh;
        const through = (j: number) => (lowOf(j, dir) - P!.price) * dir < 0;
        if (!P || !through(b) || first(`2b${dir}`, P, b, through) !== b) continue;
        // the close back above the swing (the break bar itself included), void on a close voidAtr below it first
        const end = b + R.reclaimBars;
        let status: PaSetup["status"] | null = null, j = b;
        for (; j <= Math.min(end, last); j++) {
          if ((c[j].c - P.price) * dir > 0) {
            status = "entered";
            break;
          }
          if ((c[j].c - (P.price - dir * R.voidAtr * atr[j])) * dir < 0) {
            status = "void";
            break;
          }
        }
        if (!status) status = end > last ? "waiting" : "expired";
        const X = extremeOf(b, Math.min(j, end, last), dir);
        push("fake2b", dir, b, b - 1, X, P.price, status, status === "entered" ? j : null);
      }
    }
  }

  if (kinds.includes("retest")) {
    for (let b = Math.max(from, 1); b < to; b++) {
      for (const dir of [1, -1] as const) {
        const H = dir > 0 ? ss[b - 1]?.lastHigh : ss[b - 1]?.lastLow;
        const beyond = (j: number) => (c[j].c - (H!.price + dir * R.breakAtr * atr[j])) * dir > 0;
        if (!H || !beyond(b) || first(`rt${dir}`, H, b, beyond) !== b) continue;
        // retests: bars back within retestAtr of the swing; the entry: a close above the latest one's high within
        // retestConfirm bars of it; over on a close voidAtr back below the swing or after retestBars
        const end = b + R.retestBars;
        let firstR = -1, lastR = -1, status: PaSetup["status"] | null = null, j = b + 1;
        for (; j <= Math.min(end, last); j++) {
          if ((c[j].c - (H.price - dir * R.voidAtr * atr[j])) * dir < 0) {
            status = "void";
            break;
          }
          if (lastR >= 0 && j - lastR <= R.retestConfirm && (c[j].c - highOf(lastR, dir)) * dir > 0) {
            status = "entered";
            break;
          }
          if ((lowOf(j, dir) - (H.price + dir * R.retestAtr * atr[j])) * dir <= 0) {
            if (firstR < 0) firstR = j;
            lastR = j;
          }
        }
        const X = (to: number) => (firstR >= 0 ? extremeOf(firstR, to, dir) : lowOf(b, dir));
        if (status === "entered") push("retest", dir, b, j - 1, X(j - 1), highOf(lastR, dir), "entered", j);
        else if (status === "void") push("retest", dir, b, b, X(j), H.price, "void", null);
        else if (end <= last) push("retest", dir, b, b, X(end), H.price, "expired", null);
        // still open: only reported once there is a retest bar's high to buy above
        else if (lastR >= 0 && last - lastR < R.retestConfirm) push("retest", dir, b, last, X(last), highOf(lastR, dir), "waiting", null);
      }
    }
  }

  if (opts.locate !== false) for (const x of out) if (x.status === "entered" || x.status === "waiting") x.loc = locateSetup(inp, x);
  return out.sort((a, b) => a.start - b.start || a.dir - b.dir);
}
