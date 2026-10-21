import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Candle, Timeframe } from "../src/lib/types.ts";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sl-watch-"));
process.env.LOG_LEVEL = "error";
const { atrSeries } = await import("../src/lib/ta/risk.ts");
const { structureSeries } = await import("../src/lib/ta/structure.ts");
const { prevPeriodHL } = await import("../src/lib/ta/levels.ts");
const { firstReclaim, firstTurn, pickLevels, stopBeyond, touchedLevel, turnAt, watchLevels } = await import("../src/lib/ta/watch.ts");
type StructureState = import("../src/lib/ta/structure.ts").StructureState;
type Swing = import("../src/lib/ta/structure.ts").Swing;

const M15 = 900;
const T0 = Date.parse("2026-03-02T00:00:00Z") / 1000;

/** 15-minute bars walking through the given prices in steps of 0.5 (a small wick on each side). */
function path15(points: number[]): Candle[] {
  const out: Candle[] = [];
  let p = points[0];
  for (const to of points.slice(1)) {
    while (Math.abs(to - p) > 1e-9) {
      const o = p;
      p = Math.abs(to - p) <= 0.5 ? to : p + Math.sign(to - p) * 0.5;
      out.push({ t: T0 + out.length * M15, o, h: Math.max(o, p) + 0.1, l: Math.min(o, p) - 0.1, c: p, v: 1 });
    }
  }
  return out;
}

const swing = (t: number, kind: "high" | "low", label: Swing["label"], price = 100): Swing => ({ i: t, t, price, kind, confirmedAt: t + 5, label });
const state = (lastLow: Swing | null, lastHigh: Swing | null, beyond: 1 | -1 | 0): StructureState => ({
  state: "range",
  breach: "none",
  protective: null,
  lastHigh,
  lastLow,
  prevHigh: null,
  prevLow: null,
  legs: 0,
  since: null,
  beyond,
});

test("turn: a higher low made after the extreme, then a close beyond the last swing high", () => {
  const ext = 1000;
  assert.equal(turnAt(state(swing(1100, "low", "HL"), swing(1050, "high", "LH"), 1), 1, ext), true);
  assert.equal(turnAt(state(swing(1100, "low", "HL"), swing(1050, "high", "LH"), 0), 1, ext), false, "no close above the bounce high yet");
  assert.equal(turnAt(state(swing(900, "low", "HL"), null, 1), 1, ext), false, "the higher low came before the extreme");
  assert.equal(turnAt(state(swing(1000, "low", "HL"), null, 1), 1, ext), false, "the extreme's own bar is not after it");
  assert.equal(turnAt(state(swing(1100, "low", "LL"), null, 1), 1, ext), false, "a lower low is not a turn");
  assert.equal(turnAt(state(null, null, 1), 1, ext), false);
  // the mirror image for shorts
  assert.equal(turnAt(state(null, swing(1100, "high", "LH"), -1), -1, ext), true);
  assert.equal(turnAt(state(null, swing(1100, "high", "HH"), -1), -1, ext), false);
  assert.equal(turnAt(state(swing(1100, "low", "HL"), swing(1100, "high", "LH"), 1), -1, ext), false, "beyond the wrong way");
});

/**
 * The user's case: price comes down to a level at 100, pokes through, bounces, makes a new lower low, then a
 * higher low and a close above the bounce high.
 */
const scenario = () => path15([110, 108, 112, 108, 112, 109, 112, 99.8, 103, 97, 100.5, 98.5, 102.5, 104, 108]);

test("15-minute turn: catching the touch, against waiting for the higher low and the close above the bounce", () => {
  const c = scenario();
  const atr = atrSeries(c);
  const ss = structureSeries(c, atr);
  const levels = [{ price: 100, kind: "prevDay" as const }];
  const k0 = c.findIndex((x, k) => k > 10 && touchedLevel(x, levels, 1) != null);
  assert.ok(k0 > 0 && c[k0].l <= 100 && c[k0 - 1].l > 100, "A: the first bar that reaches the level");
  const firstLow = Math.min(...c.slice(k0, k0 + 8).map((x) => x.l));
  const newLow = Math.min(...c.map((x) => x.l));
  assert.ok(newLow < firstLow - 2, "the scenario makes a new low after the first one");

  const C = firstTurn(c, k0, 1, 288, (k, tX) => turnAt(ss[k], 1, tX))!;
  assert.ok(C, "C triggers");
  assert.equal(C.extreme, newLow, "the extreme is the newest low, not the first one");
  assert.equal(c[C.extremeI].l, newLow);
  const s = ss[C.i];
  assert.equal(s.lastLow!.label, "HL");
  assert.ok(s.lastLow!.t > C.extremeT && s.lastLow!.price > newLow, "a higher low after the newest low");
  assert.ok(c[C.i].c > s.lastHigh!.price, "the close is above the bounce high");
  assert.ok(c[C.i].c > 100.5 && c[C.i - 1].c <= s.lastHigh!.price + 0.1 * atr[C.i - 1], "the first close above it");
  const stop = stopBeyond(C.extreme, 1, 0.8, 1);
  assert.equal(stop, newLow - 0.8, "the stop goes beyond the newest low");
  assert.ok(stop < firstLow - 2);
  // B: the first close back above the level, within 16 bars
  const B = firstReclaim(c, k0, 100, 1, 16)!;
  assert.ok(B && B.i > k0 && c[B.i].c > 100 && B.i <= k0 + 16);
  assert.ok(B.extreme >= firstLow - 1e-9, "B comes before the new low");
});

test("no lookahead: the C trigger ignores the bars after it, the level list the bars after its moment", () => {
  const c = scenario();
  const ss = structureSeries(c, atrSeries(c));
  const k0 = c.findIndex((x, k) => k > 10 && x.l <= 100);
  const C = firstTurn(c, k0, 1, 288, (k, tX) => turnAt(ss[k], 1, tX))!;
  const changed = c.map((x, k) => (k > C.i ? { ...x, o: x.o - 20, h: x.h - 20, l: x.l - 30, c: x.c - 25 } : x));
  const ss2 = structureSeries(changed, atrSeries(changed));
  assert.deepEqual(firstTurn(changed, k0, 1, 288, (k, tX) => turnAt(ss2[k], 1, tX)), C);

  // levels: daily and 4-hour bars of a random walk; changing everything after the moment changes nothing
  let s = 7;
  const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const walk = (n: number, sec: number) => {
    let p = 100;
    return Array.from({ length: n }, (_, i): Candle => {
      const o = p;
      p *= 1 + (r() - 0.5) * 0.06;
      return { t: T0 - 400 * 86400 + i * sec, o, h: Math.max(o, p) * (1 + r() * 0.01), l: Math.min(o, p) * (1 - r() * 0.01), c: p, v: 1 };
    });
  };
  const daily = walk(400, 86400), c4 = walk(2400, 4 * 3600);
  const j1 = 300, endSec = daily[j1].t + 86400;
  const j4 = c4.findLastIndex((x) => x.t + 4 * 3600 <= endSec);
  const frames = (d: Candle[], f: Candle[]) => ({ daily: d, atr1d: atrSeries(d), j1, c4h: f, atr4h: atrSeries(f), j4, endSec });
  const ref = Math.max(daily[j1].c, c4[j4].c) * 1.5;
  for (const dir of [1, -1] as const) {
    const at = watchLevels(frames(daily, c4), dir, dir > 0 ? ref : ref / 4, 0.5);
    assert.ok(at.length > 0);
    const later = (xs: Candle[], j: number) => xs.map((x, k) => (k > j ? { ...x, h: x.h * 3, l: x.l / 3 } : x));
    assert.deepEqual(watchLevels(frames(later(daily, j1), later(c4, j4)), dir, dir > 0 ? ref : ref / 4, 0.5), at);
    // nearest first, on the defended side, merged
    for (let k = 1; k < at.length; k++) assert.ok((at[k - 1].price - at[k].price) * dir > 0.25 * 0.5 - 1e-9);
  }
});

test("levels: merged within 0.25 ATR, the preferred kind kept; only those price came down to", () => {
  const cands = [
    { price: 99.9, kind: "swing4h" as const },
    { price: 100, kind: "prevWeek" as const },
    { price: 95, kind: "prevDay" as const },
    { price: 95.2, kind: "swing1d" as const },
    { price: 104.8, kind: "prevMonth" as const },
  ];
  const got = pickLevels(cands, 1, 105, 1);
  assert.deepEqual(got, [
    { price: 100, kind: "prevWeek" },
    { price: 95.2, kind: "swing1d" },
  ]);
  assert.deepEqual(touchedLevel({ t: 0, o: 101, h: 101, l: 94, c: 96, v: 1 }, got, 1), { price: 100, kind: "prevWeek" }, "the nearest of the levels reached");
});

test("previous day: the last complete UTC day, at 00:00 too", () => {
  const D = 86400;
  const day = Date.parse("2026-10-14T00:00:00Z") / 1000;
  const daily: Candle[] = [-2, -1, 0].map((k) => ({ t: day + k * D, o: 100, h: 110 + k, l: 90 + k, c: 100, v: 1 }));
  assert.deepEqual(prevPeriodHL(daily, day, "day"), { h: 109, l: 89 }, "at 00:00 the day just finished");
  assert.deepEqual(prevPeriodHL(daily, day + 8 * 3600, "day"), { h: 109, l: 89 }, "during the day, today is left out");
  assert.deepEqual(prevPeriodHL(daily, day + D, "day"), { h: 110, l: 90 });
});

test("previous day / week / month: walking back gives the forward scan's answer, gaps included", () => {
  const D = 86400;
  const start = Date.parse("2024-12-20T00:00:00Z") / 1000;
  const daily: Candle[] = [];
  for (let k = 0; k < 500; k++) if (k % 37 !== 5 && k % 53 !== 9) daily.push({ t: start + k * D, o: 100, h: 110 + ((k * 7) % 13), l: 90 - ((k * 5) % 11), c: 100, v: 1 });
  const key = { day: (s: number) => new Date(s * 1000).toISOString().slice(0, 10), month: (s: number) => new Date(s * 1000).toISOString().slice(0, 7) };
  const week = (s: number) => Math.floor((s / D + 3) / 7); // weeks starting Monday (1970-01-01 was a Thursday)
  const forward = (end: number, k: (s: number) => string | number) => {
    let cur: { k: string | number; h: number; l: number } | null = null;
    for (const x of daily) {
      if (x.t >= end || k(x.t) === k(end)) continue;
      if (cur && cur.k === k(x.t)) cur = { k: cur.k, h: Math.max(cur.h, x.h), l: Math.min(cur.l, x.l) };
      else cur = { k: k(x.t), h: x.h, l: x.l };
    }
    return cur && { h: cur.h, l: cur.l };
  };
  for (let end = start; end < start + 520 * D; end += 0.37 * D) {
    assert.deepEqual(prevPeriodHL(daily, end, "day"), forward(end, key.day), `day at ${end}`);
    assert.deepEqual(prevPeriodHL(daily, end, "week"), forward(end, week), `week at ${end}`);
    assert.deepEqual(prevPeriodHL(daily, end, "month"), forward(end, key.month), `month at ${end}`);
  }
});

test("watch report: the four entries, the paired comparisons, the signs and the 24-hour moves", async () => {
  const { store } = await import("../src/lib/data/klines.ts");
  const { watchReport } = await import("../src/lib/research/watch.ts");
  const { DEFAULT_ENGINE_PARAMS } = await import("../src/lib/params.ts");
  // 100 days ending 330 days ago: most of it in-sample, the last weeks in the held-out year
  const end = Math.floor(Date.now() / 1000 / 86400) * 86400 - 330 * 86400;
  const agg = (c: Candle[], sec: number) => {
    const out: Candle[] = [];
    for (const x of c) {
      const t = Math.floor(x.t / sec) * sec;
      const last = out[out.length - 1];
      if (last && last.t === t) {
        last.h = Math.max(last.h, x.h);
        last.l = Math.min(last.l, x.l);
        last.c = x.c;
        last.v += x.v;
        last.tbv = (last.tbv ?? 0) + (x.tbv ?? 0);
      } else out.push({ ...x, t });
    }
    return out;
  };
  for (const [coin, seed] of [
    ["BTC", 11],
    ["ETH", 12],
  ] as const) {
    let s = seed;
    const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const n = 9600;
    let p = 100;
    const c: Candle[] = Array.from({ length: n }, (_, i) => {
      const o = p;
      p *= 1 + (r() - 0.5) * 0.008 + (r() < 0.01 ? (r() - 0.5) * 0.04 : 0);
      const v = 100 + 100 * r();
      return { t: end - (n - i) * M15, o, h: Math.max(o, p) * (1 + r() * 0.002), l: Math.min(o, p) * (1 - r() * 0.002), c: p, v, tbv: v * r() };
    });
    const sets: [Timeframe, Candle[]][] = [
      ["15m", c],
      ["1h", agg(c, 3600)],
      ["4h", agg(c, 4 * 3600)],
      ["1d", agg(c, 86400)],
    ];
    for (const [tf, bars] of sets) store(coin, tf, "binance-futures", bars);
  }
  const r = await watchReport(DEFAULT_ENGINE_PARAMS, { paramsVersion: 0 });
  assert.equal(r.kind, "watch");
  const keys = r.rows.map((x) => x.key);
  for (const k of ["watch:A", "watch:B", "watch:C", "watch:C1", "watch:B_vs_A", "watch:C_vs_A", "watch:C1_vs_A", "watch_sign:rsi", "watch_sign:hour", "move24:drop:long", "move24:rise:short"]) assert.ok(keys.includes(k), k);
  assert.ok(r.rows.find((x) => x.key === "watch:A")!.cells.is.n + r.rows.find((x) => x.key === "watch:A")!.cells.oos.n > 0, "events were found");
  for (const x of r.rows) {
    for (const k of ["triggerPct", "halfwayPct", "halfwayA", "quickStopPct", "quickStopA", "missedPct"]) {
      const v = x.extra?.[k];
      if (v != null) assert.ok(v >= 0 && v <= 100, `${x.key} ${k}`);
    }
  }
  const cva = r.rows.find((x) => x.key === "watch:C_vs_A")!.extra!;
  assert.ok("halfwayDiff" in cva && "halfwayP" in cva && "halfwayQ" in cva && "halfwayConsistent" in cva);
  assert.equal(r.rows.find((x) => x.key === "watch:A")!.extra!.triggerPct, 100, "A triggers on every event");
  assert.equal(r.coverage[0].tf, "15m");
});

// ---------------------------------------------------------------- the live state (watchState) and the page (computeWatch)

const { alignHigher } = await import("../src/lib/ta/plan.ts");
const { watchState } = await import("../src/lib/ta/watch.ts");

/** Bars of a coarser timeframe made from finer ones. */
function aggregate(c: Candle[], sec: number): Candle[] {
  const out: Candle[] = [];
  for (const x of c) {
    const t = Math.floor(x.t / sec) * sec;
    const last = out[out.length - 1];
    if (last && last.t === t) {
      last.h = Math.max(last.h, x.h);
      last.l = Math.min(last.l, x.l);
      last.c = x.c;
      last.v += x.v;
    } else out.push({ ...x, t });
  }
  return out;
}

/** The watch input for 15-minute bars `c`, with the hour chart made from them and one key low at 100. */
function watchInput(c: Candle[], windowBars = 288) {
  const h = aggregate(c, 3600);
  const hatr = atrSeries(h);
  const hIdx = alignHigher(c, "15m", h, "1h");
  return {
    c,
    atr: hIdx.map((j) => (j >= 0 ? hatr[j] : NaN)),
    ss: structureSeries(c, atrSeries(c)),
    h,
    hss: structureSeries(h, hatr),
    hIdx,
    levels: (_j: number, dir: 1 | -1) => (dir > 0 ? [{ price: 100, kind: "prevWeek" as const }] : []),
    buf: 0.8,
    rules: { nearAtr: 1.5, windowBars },
  };
}

/** Swinging above the level long enough to warm up the hour ATR (about 2.2), then the given path from 112. */
const warm = [112, 108, 112, 108, 112, 108, 112, 108, 112, 108, 112];

test("watch: near, touched and still falling, a new lower low, the turn, then the turn undone", () => {
  // down to the level, through it to 98.5, a small bounce, a new low at 96, a bounce to 99.5, a higher low at
  // 97.5, a close above the bounce high, then a break under the 96 low
  const c = path15([...warm, 103, 98.5, 99.5, 96, 99.5, 97.5, 100.5, 101, 95, 96]);
  const w = watchInput(c);
  const at = (n: number) => watchState(w, 1, n);
  const states = c.map((_, n) => (n < 60 ? null : at(n).state));
  const path: string[] = [];
  for (const s of states) if (s && s !== path[path.length - 1]) path.push(s);
  assert.deepEqual(path, ["far", "near", "falling", "turned", "falling"]);

  const touch = states.indexOf("falling");
  assert.ok(c[touch].l <= 100 && c[touch - 1].l > 100, "the event starts on the bar that reaches the level");
  const first = at(touch);
  assert.equal(first.level?.name, "上周低点");
  assert.equal(first.event?.startT, c[touch].t);
  assert.equal(first.event?.attempt, 1);
  assert.equal(first.event?.newExtremes.length, 1);
  // the small bounce under the level: still falling, no new extreme
  const bounce = c.findIndex((x, k) => k > touch && x.c === 99.5);
  assert.equal(at(bounce).state, "falling");
  assert.equal(at(bounce).event?.newExtremes.length, 1);
  // the new lower low
  const low = c.findIndex((x, k) => k > touch && x.c === 96);
  assert.equal(at(low).event?.newExtremes.length, 2, "a new low after a bounce is a new entry");
  assert.equal(at(low).event?.extreme, 95.9);

  const ti = states.indexOf("turned");
  const s = at(ti);
  const ss = w.ss[ti];
  assert.equal(ss.lastLow?.label, "HL");
  assert.ok(ss.lastLow!.price > 95.9 && c[ti].c > ss.lastHigh!.price, "a higher low, then a close above the bounce high");
  assert.equal(s.event?.turn?.t, c[ti].t);
  assert.equal(s.event?.turn?.entry, c[ti].c);
  assert.equal(s.event?.turn?.extreme, 95.9, "the stop hangs on the newest low, not the first one");
  assert.equal(s.event?.turn?.stop, stopBeyond(95.9, 1, 0.8, w.atr[ti]));
  assert.ok(s.event!.turn!.stop < 95.9);
  // still turned while the low holds
  assert.equal(at(ti + 4).state, "turned");

  const broke = states.lastIndexOf("falling");
  const f = at(states.indexOf("falling", ti));
  assert.equal(f.event?.attempt, 2, "a turn undone by a new low: the second wait");
  assert.equal(f.event?.turn, null);
  assert.equal(at(broke).event?.newExtremes.length, 3);
  assert.ok(at(broke).event!.extreme < 95.9);
});

test("watch: no lookahead; bars after the moment (or one still forming) change nothing", () => {
  const c = path15([...warm, 103, 98.5, 99.5, 96, 99.5, 97.5, 100.5, 101, 95, 96]);
  const w = watchInput(c);
  for (const n of [100, 104, 112, 125, 131, 140, 146]) {
    const before = watchState(w, 1, n);
    // everything after n replaced: a crash, then a rally
    const changed = c.map((x, k) => (k > n ? { ...x, o: x.o - 8, h: x.h - 7, l: x.l - 9, c: x.c - (k % 2 ? 9 : 2) } : x));
    assert.deepEqual(watchState(watchInput(changed), 1, n), before, `bar ${n}`);
    // only the bars up to n
    assert.deepEqual(watchState(watchInput(c.slice(0, n + 1)), 1), before);
    // a forming bar would only be bar n + 1: the closed bars decide
    const forming = { ...c[n], t: c[n].t + M15, o: c[n].c, h: c[n].c + 0.2, l: 90, c: 91 };
    assert.deepEqual(watchState(watchInput([...c.slice(0, n + 1), forming]), 1, n), before);
  }
});

test("watch: an event ends when the window passes, or once price is 3 ATR above the level", () => {
  // touched, then hovering under the level without a turn
  const hover: number[] = [];
  for (let k = 0; k < 320; k++) hover.push(k % 2 ? 99 : 98.5);
  const c = path15([...warm, 103, 98.5, ...hover]);
  const w = watchInput(c);
  const k0 = c.findIndex((x, k) => k > 80 && x.l <= 100);
  assert.ok(watchState(w, 1, k0 + 287).event, "still watched on the last bar of the window");
  assert.equal(watchState(w, 1, k0 + 287).event?.startT, c[k0].t);
  const after = watchState(w, 1, k0 + 288);
  assert.equal(after.event, null, "288 bars later it is over");
  assert.equal(after.state, "far", "no key low below the price any more");
  assert.equal(after.level, null);
  assert.equal(watchState(watchInput(c, 96), 1, k0 + 96).event, null, "a shorter window from the parameters");

  // touched, then straight up: no turn, and once a close is 3 hour ATR above the level it is over
  const d = path15([...warm, 103, 98.5, 112]);
  const v = watchInput(d);
  const t0 = d.findIndex((x, k) => k > 80 && x.l <= 100);
  const end = d.findIndex((x, k) => k > t0 && x.c - 100 >= 3 * v.atr[k]);
  assert.ok(end > t0);
  assert.ok(watchState(v, 1, end - 1).event, "before the close 3 ATR above");
  const s = watchState(v, 1, end);
  assert.equal(s.event, null);
  assert.equal(s.state, "far");
  assert.equal(s.level?.price, 100);
  assert.ok(s.distAtr! <= -3);
});

test("watch page: a replay never sees what came after its moment; the research is worded from the verdicts", async () => {
  const { getDb } = await import("../src/lib/server/db.ts");
  const { store } = await import("../src/lib/data/klines.ts");
  const { saveReport } = await import("../src/lib/research/run.ts");
  const { computeWatch, watchResearchText } = await import("../src/lib/watch.ts");
  const { DEFAULT_ENGINE_PARAMS } = await import("../src/lib/params.ts");
  const { TF_SECONDS } = await import("../src/lib/types.ts");
  const D = 86400;
  const NOW = Math.floor(Date.now() / 1000 / D) * D;
  // slow waves and per-bar noise, as the plan replay test; another coin than the report test's
  const noise = (t: number) => {
    const x = Math.sin(t * 12.9898) * 43758.5453;
    return (x - Math.floor(x) - 0.5) * 0.006;
  };
  const price = (t: number) => 100 * Math.exp(0.15 * Math.sin(t / (D * 40)) + 0.04 * Math.sin(t / (D * 1.3)) + 0.01 * Math.sin(t / 7000) + noise(t));
  const bars = (tf: Timeframe, from: number, to: number, bump = 1): Candle[] => {
    const sec = TF_SECONDS[tf];
    const out: Candle[] = [];
    for (let t = Math.ceil(from / sec) * sec; t <= to; t += sec) {
      const o = price(t) * bump, c = price(t + sec) * bump;
      const v = 1000 + 500 * Math.sin(t / 7777);
      out.push({ t, o, c, h: Math.max(o, c) * 1.002, l: Math.min(o, c) * 0.998, v, tbv: v * (0.5 + 0.3 * Math.sin(t / 5555)) });
    }
    return out;
  };
  globalThis.fetch = (async () => new Response("[]", { status: 503 })) as typeof fetch;
  const FROM: Partial<Record<Timeframe, number>> = { "15m": NOW - 60 * D, "1h": NOW - 400 * D, "4h": NOW - 600 * D, "1d": NOW - 1500 * D };
  const TFS: Timeframe[] = ["15m", "1h", "4h", "1d"];
  for (const tf of TFS) store("SOL", tf, "binance-futures", bars(tf, FROM[tf]!, NOW));

  const grp = (n: number, meanR: number, edgeR: number) => ({ n, hit: 40, hitLo: 35, hitHi: 45, baseHit: 40, meanPct: 0, meanR, edgeR, p: 0.01 });
  const row = (key: string, family: string, verdict: string, edgeR: number, extra: Record<string, number | null> = {}) =>
    ({ family, key, name: key, side: "bull", tf: "15m", horizon: 672, cells: { is: grp(400, 0.1, edgeR), oos: grp(100, 0, 0), btc: grp(50, 0, 0), eth: grp(50, 0, 0), firstHalf: grp(100, 0, 0), secondHalf: grp(100, 0, 0) }, q: 0.01, consistent: true, verdict, extra }) as never;
  const A = row("watch:A", "watch", "比随机差", -0.53, { halfwayPct: 80 });
  const C = row("watch:C", "watch", "无可证明的优势", 0.02, { halfwayPct: 73 });
  const CA = row("watch:C_vs_A", "watch", "有优势", 0.57, { halfwayPct: 73, halfwayA: 80, halfwayDiff: -7, halfwayQ: 0.01, halfwayConsistent: 1 });
  const text = watchResearchText(A, C, CA)!;
  assert.equal(text, "历史上，碰到关键位就接，平均每笔比同方向随机入场差 0.53R；等 15 分钟转强再进，比碰到就接好 0.57R（接到半山腰——入场后又被反向打出 1 倍 1 小时 ATR——的比例 80% → 73%），本身和同方向随机入场比没有可证明的优势。转强不预测方向，它只是让你少接飞刀。");
  const weak = watchResearchText(row("watch:A", "watch", "无可证明的优势", -0.1), C, row("watch:C_vs_A", "watch", "无可证明的优势", 0.05, { halfwayPct: 78, halfwayA: 80, halfwayDiff: -2, halfwayQ: 0.4, halfwayConsistent: 0 }))!;
  assert.match(weak, /差别不能确定.*差别不能确定/);
  assert.match(weak, /还不能算可靠/);
  assert.doesNotMatch(weak, /少接飞刀|到底|见顶/);
  assert.match(watchResearchText(row("watch:A", "watch", "样本不足", 0), undefined, undefined)!, /样本还不够/);
  assert.equal(watchResearchText(undefined, undefined, undefined), null);
  saveReport({
    kind: "watch", title: "watch", createdAt: Date.now(), source: "binance-futures", paramsVersion: 0, costPct: 0.15, alpha: 0.05, holdoutFrom: NOW - 365 * D, coins: ["BTC"], coverage: [], notes: [], durationMs: 1, rules: { nearAtr: 1.5, windowBars: 288 },
    rows: [A, C, CA, row("watch_sign:rsi", "watch_sign", "无可证明的优势", 0.1), row("move24:drop:long", "move24", "无可证明的优势", 0, { volRatio: 1.8 }), row("move24:rise:short", "move24", "无可证明的优势", 0, { volRatio: 1.6 })],
  });

  // a few moments: each the same after everything later is rewritten
  const ends = [20, 17, 13, 9].map((k) => NOW - k * D + 37 * 900);
  const before = [];
  for (const end of ends) before.push(await computeWatch("SOL", DEFAULT_ENGINE_PARAMS, end));
  for (const [k, v] of before.entries()) {
    assert.equal(v.end, ends[k]);
    assert.equal(v.lastClosedT + 900, ends[k]);
    assert.equal(v.forming, false, "a replay has no bar forming");
    assert.equal(v.price, v.closedPrice);
    assert.equal(v.research?.text, text);
    assert.equal(v.long.dir, 1);
    assert.equal(v.short.dir, -1);
    assert.ok(v.levels.length > 0);
    for (const l of v.levels) assert.ok(l.distAtr !== 0 && ["none", "pierced", "broken"].includes(l.state));
    assert.ok(v.move24 && v.move24.pctRank != null && v.move24.topDrops.length > 0);
    assert.equal(v.move24!.volRatio, v.move24!.changePct! < 0 ? 1.8 : 1.6);
    for (const s of [v.long, v.short]) {
      assert.equal(s.piercing, false);
      if (s.event) {
        assert.equal(s.signs?.length, 7);
        assert.match(s.signs!.find((x) => x.key === "rsi")!.text!, /差别不能确定/);
        assert.ok((s.event.extreme - s.event.stop) * s.dir > 0, "the stop is beyond the newest extreme");
      } else assert.equal(s.signs, null);
    }
    assert.doesNotMatch(v.headline, /到底|见顶/);
  }
  const d = getDb();
  // every bar not closed by the earliest moment, the hour, 4-hour and daily bars still forming then included
  const first = ends[ends.length - 1];
  for (const tf of TFS) {
    const from = first - TF_SECONDS[tf] + 1;
    d.prepare("DELETE FROM candles WHERE coin = 'SOL' AND tf = ? AND t >= ?").run(tf, from);
    store("SOL", tf, "binance-futures", bars(tf, from, NOW, 0.7));
  }
  for (const [k, end] of ends.entries()) {
    const after = await computeWatch("SOL", DEFAULT_ENGINE_PARAMS, end);
    const strip = (v: typeof after) => {
      const { updatedAt: _u, ...rest } = v;
      return rest;
    };
    // the percentile base and the biggest drops read the stored history up to the moment, so they stay too
    assert.deepEqual(strip(after), strip(before[k]), `moment ${k}`);
  }
  assert.ok(before.some((v) => v.long.event || v.short.event), "an event at one of the moments at least");
});
