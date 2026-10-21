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
