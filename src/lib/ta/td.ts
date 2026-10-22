import type { Candle } from "../types.ts";
import { DEFAULT_ENGINE_PARAMS, type EngineParams } from "../params.ts";

/**
 * Tom DeMark's TD Sequential: Setup (9), TDST, Countdown (13) with the bar-13
 * qualifier, cancellation, and Risk Levels.
 *
 * Simplification: a new same-direction setup during an active countdown does
 * not recycle it; the countdown keeps running.
 *
 * Cancellation by TDST: by default a close beyond the latest same-side setup's TDST;
 * with `classicCancel`, DeMark's rule — the TDST of the setup that started this
 * countdown, crossed by a whole bar (low above resistance / high below support).
 */

export type TdSide = "buy" | "sell";

export interface TdEvent {
  i: number;
  t: number;
  side: TdSide;
  kind: "setup9" | "countdown13";
  /** setup: perfected; countdown: always true (only qualified 13s are emitted) */
  perfected: boolean;
  riskLevel: number;
  price: number;
}

export interface TdState {
  buySetup: number[];
  sellSetup: number[];
  buyCountdown: number[];
  sellCountdown: number[];
  events: TdEvent[];
  current: {
    /** side of the setup currently being counted (by close vs close 4 bars ago) */
    setupSide: TdSide | null;
    setupCount: number;
    /** close needed on next bar to keep counting */
    nextCloseNeeded: number | null;
    countdown: { side: TdSide; count: number; startedAt: number } | null;
    /** TDST resistance from the last buy setup, support from the last sell setup */
    tdstResistance: number | null;
    tdstSupport: number | null;
    lastSignal: (TdEvent & { barsAgo: number; invalidated: boolean; changePct: number }) | null;
    /** configured lengths (9 and 13 by default) */
    setupLength: number;
    countdownLength: number;
  };
}

export function computeTd(c: Candle[], tp: EngineParams["td"] = DEFAULT_ENGINE_PARAMS.td): TdState {
  // standard DeMark values: 9 / 4 / 13 / 2; the countdown qualifier compares with bar (length − 5), i.e. bar 8 of 13
  const SETUP = tp.setupLength, LB = tp.setupLookback, CD = tp.countdownLength, CLB = tp.countdownLookback;
  const QUAL = Math.max(1, CD - 5);
  const n = c.length;
  const buySetup = new Array(n).fill(0);
  const sellSetup = new Array(n).fill(0);
  const buyCountdown = new Array(n).fill(0);
  const sellCountdown = new Array(n).fill(0);
  const events: TdEvent[] = [];

  let tdstResistance: number | null = null;
  let tdstSupport: number | null = null;

  // countdown bookkeeping
  let bcd: { count: number; bar8Close: number; bars: number[]; start: number; tdst: number } | null = null;
  let scd: { count: number; bar8Close: number; bars: number[]; start: number; tdst: number } | null = null;
  let lastBuySetupHigh = NaN;
  let lastSellSetupLow = NaN;

  const trueHigh = (i: number) => Math.max(c[i].h, i > 0 ? c[i - 1].c : c[i].h);
  const trueLow = (i: number) => Math.min(c[i].l, i > 0 ? c[i - 1].c : c[i].l);

  for (let i = LB; i < n; i++) {
    // ---------------- setup
    if (c[i].c < c[i - LB].c) buySetup[i] = buySetup[i - 1] + 1;
    if (c[i].c > c[i - LB].c) sellSetup[i] = sellSetup[i - 1] + 1;

    // the first count needs a price flip
    if (buySetup[i] === 1 && !(c[i - 1].c >= c[i - LB - 1]?.c)) buySetup[i] = 0;
    if (sellSetup[i] === 1 && !(c[i - 1].c <= c[i - LB - 1]?.c)) sellSetup[i] = 0;

    if (buySetup[i] === SETUP) {
      const start = i - SETUP + 1;
      let hi = -Infinity, loIdx = start;
      for (let j = start; j <= i; j++) {
        hi = Math.max(hi, trueHigh(j));
        if (c[j].l < c[loIdx].l) loIdx = j;
      }
      tdstResistance = hi;
      lastBuySetupHigh = hi;
      const perfected = Math.min(c[i].l, c[i - 1].l) <= Math.min(c[i - 2].l, c[i - 3].l);
      events.push({ i, t: c[i].t, side: "buy", kind: "setup9", perfected, riskLevel: c[loIdx].l - (trueHigh(loIdx) - trueLow(loIdx)), price: c[i].c });
      // sell countdown is cancelled by an opposite setup
      scd = null;
      if (!bcd) bcd = { count: 0, bar8Close: NaN, bars: [], start: i, tdst: hi };
    }
    if (sellSetup[i] === SETUP) {
      const start = i - SETUP + 1;
      let lo = Infinity, hiIdx = start;
      for (let j = start; j <= i; j++) {
        lo = Math.min(lo, trueLow(j));
        if (c[j].h > c[hiIdx].h) hiIdx = j;
      }
      tdstSupport = lo;
      lastSellSetupLow = lo;
      const perfected = Math.max(c[i].h, c[i - 1].h) >= Math.max(c[i - 2].h, c[i - 3].h);
      events.push({ i, t: c[i].t, side: "sell", kind: "setup9", perfected, riskLevel: c[hiIdx].h + (trueHigh(hiIdx) - trueLow(hiIdx)), price: c[i].c });
      bcd = null;
      if (!scd) scd = { count: 0, bar8Close: NaN, bars: [], start: i, tdst: lo };
    }

    // ---------------- countdown
    if (bcd) {
      if (tp.classicCancel ? c[i].l > bcd.tdst : c[i].c > lastBuySetupHigh) bcd = null; // above TDST: cancelled
    }
    if (bcd && i >= CLB && c[i].c <= c[i - CLB].l) {
      const next = bcd.count + 1;
      if (next < CD) {
        bcd.count = next;
        bcd.bars.push(i);
        if (next === QUAL) bcd.bar8Close = c[i].c;
        buyCountdown[i] = next;
      } else if (c[i].l <= bcd.bar8Close) {
        bcd.bars.push(i);
        buyCountdown[i] = CD;
        let loIdx = bcd.bars[0];
        for (const j of bcd.bars) if (c[j].l < c[loIdx].l) loIdx = j;
        events.push({ i, t: c[i].t, side: "buy", kind: "countdown13", perfected: true, riskLevel: c[loIdx].l - (trueHigh(loIdx) - trueLow(loIdx)), price: c[i].c });
        bcd = null;
      }
      // else: deferred 13, keep waiting for a qualifying bar
    }
    if (scd) {
      if (tp.classicCancel ? c[i].h < scd.tdst : c[i].c < lastSellSetupLow) scd = null;
    }
    if (scd && i >= CLB && c[i].c >= c[i - CLB].h) {
      const next = scd.count + 1;
      if (next < CD) {
        scd.count = next;
        scd.bars.push(i);
        if (next === QUAL) scd.bar8Close = c[i].c;
        sellCountdown[i] = next;
      } else if (c[i].h >= scd.bar8Close) {
        scd.bars.push(i);
        sellCountdown[i] = CD;
        let hiIdx = scd.bars[0];
        for (const j of scd.bars) if (c[j].h > c[hiIdx].h) hiIdx = j;
        events.push({ i, t: c[i].t, side: "sell", kind: "countdown13", perfected: true, riskLevel: c[hiIdx].h + (trueHigh(hiIdx) - trueLow(hiIdx)), price: c[i].c });
        scd = null;
      }
    }
  }

  // ---------------- current state
  const L = n - 1;
  let setupSide: TdSide | null = null;
  let setupCount = 0;
  if (buySetup[L] > 0) {
    setupSide = "buy";
    setupCount = buySetup[L];
  } else if (sellSetup[L] > 0) {
    setupSide = "sell";
    setupCount = sellSetup[L];
  }
  // the next bar is compared with the close LB bars before it
  const nextCloseNeeded = setupSide && L + 1 - LB >= 0 ? c[L + 1 - LB].c : null;
  const countdown = bcd
    ? { side: "buy" as const, count: bcd.count, startedAt: bcd.start }
    : scd
      ? { side: "sell" as const, count: scd.count, startedAt: scd.start }
      : null;

  const ev = events[events.length - 1];
  let lastSignal: TdState["current"]["lastSignal"] = null;
  if (ev) {
    let invalidated = false;
    for (let j = ev.i + 1; j < n; j++) {
      if (ev.side === "buy" ? c[j].c < ev.riskLevel : c[j].c > ev.riskLevel) {
        invalidated = true;
        break;
      }
    }
    lastSignal = { ...ev, barsAgo: L - ev.i, invalidated, changePct: ((c[L].c - ev.price) / ev.price) * 100 };
  }

  return {
    buySetup,
    sellSetup,
    buyCountdown,
    sellCountdown,
    events,
    current: { setupSide, setupCount, nextCloseNeeded, countdown, tdstResistance, tdstSupport, lastSignal, setupLength: SETUP, countdownLength: CD },
  };
}
