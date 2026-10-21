import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Candle, Timeframe } from "../src/lib/types.ts";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sl-patterns-"));
process.env.LOG_LEVEL = "error";
const { atrSeries } = await import("../src/lib/ta/risk.ts");
const { structureSeries } = await import("../src/lib/ta/structure.ts");
const { findPatterns, locateSetup, paLevelSource, PA_RULES, PATTERNS, trendOf } = await import("../src/lib/ta/patterns.ts");
type PaInput = import("../src/lib/ta/patterns.ts").PaInput;
type PaSetup = import("../src/lib/ta/patterns.ts").PaSetup;
type PatternKind = import("../src/lib/ta/patterns.ts").PatternKind;
type StructureState = import("../src/lib/ta/structure.ts").StructureState;

const M15 = 900;
const T0 = Date.parse("2026-03-02T00:00:00Z") / 1000;

/** Bars from [o, h, l, c] rows, 15 minutes apart. */
const bars = (rows: number[][], t0 = T0): Candle[] => rows.map(([o, h, l, c], i) => ({ t: t0 + i * M15, o, h, l, c, v: 1 }));
/** 20 quiet bars around 100 (ATR 1), so the pattern bars have an ATR to be measured with. */
const FLAT = Array.from({ length: 20 }, () => [100, 100.5, 99.5, 100]);
/** The mirror image around 100: highs become lows. */
const mirror = (c: Candle[]): Candle[] => c.map((x) => ({ ...x, o: 200 - x.o, h: 200 - x.l, l: 200 - x.h, c: 200 - x.c }));
const input = (c: Candle[]): PaInput => {
  const atr = atrSeries(c);
  return { tf: "15m", c, atr, ss: structureSeries(c, atr) };
};
const find = (c: Candle[], kind: PatternKind) => findPatterns(input(c), { kinds: [kind] });
const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;

/** Bars walking through the given prices in steps of 0.5 (a 0.1 wick on each side): swing points to break. */
function walk(points: number[]): number[][] {
  const out: number[][] = [];
  let p = points[0];
  for (const to of points.slice(1)) {
    while (Math.abs(to - p) > 1e-9) {
      const o = p;
      p = Math.abs(to - p) <= 0.5 ? to : p + Math.sign(to - p) * 0.5;
      out.push([o, Math.max(o, p) + 0.1, Math.min(o, p) - 0.1, p]);
    }
  }
  return out;
}

// ---------------------------------------------------------------- the five patterns, their mirror and their windows

const pinRows = (after: number[][]) => [...FLAT, [99.8, 100.2, 98.6, 100.0], ...after, ...FLAT];

test("long wick: found, entered on the first close above its high, and the mirror for shorts", () => {
  const c = bars(pinRows([[100, 100.4, 99.8, 100.1], [100.1, 100.6, 100, 100.5]]));
  const [x] = find(c, "pin").filter((y) => y.start === 20);
  assert.ok(x, "the pin is found");
  assert.equal(x.dir, 1);
  assert.equal(x.status, "entered");
  assert.equal(x.s, 20);
  assert.equal(x.e, 22, "the second bar after it closes above its high");
  assert.equal(x.entry, 100.5);
  assert.equal(x.extreme, 98.6);
  assert.equal(x.trigger, 100.2);
  const atr = atrSeries(c);
  assert.ok(close(x.stop, 98.6 - 0.8 * atr[22]), "stop: the extreme minus the p80 buffer × ATR at the entry");
  assert.ok(close(x.riskAtr, (100.5 - x.stop) / atr[22]) && x.ok);

  const [y] = find(mirror(c), "pin").filter((z) => z.start === 20);
  assert.equal(y.dir, -1);
  assert.equal(y.e, 22);
  assert.ok(close(y.extreme, 101.4) && close(y.trigger, 99.8) && close(y.entry!, 99.5));
  assert.ok(close(y.stop, 2 * 100 - x.stop), "the stop mirrors too");
  assert.equal(find(c, "pin").filter((z) => z.start === 20 && z.dir === -1).length, 0, "a long wick down is no short");
});

test("long wick: the window is 3 bars, and a close below the low first voids it", () => {
  const late = bars(pinRows([[100, 100.2, 99.8, 100.1], [100.1, 100.2, 99.9, 100], [100, 100.2, 99.9, 100.1], [100.1, 100.8, 100, 100.7]]));
  const [a] = find(late, "pin").filter((y) => y.start === 20);
  assert.equal(a.status, "expired", "the close above came on the 4th bar");
  assert.equal(a.e, null);

  const voided = bars(pinRows([[100, 100.1, 98.3, 98.5], [98.5, 100.6, 98.4, 100.5]]));
  const [b] = find(voided, "pin").filter((y) => y.start === 20);
  assert.equal(b.status, "void", "closed below the pin's low before closing above its high");

  const open = bars(pinRows([]).slice(0, 22));
  const [w] = find(open, "pin").filter((y) => y.start === 20);
  assert.equal(w.status, "waiting", "the data ends inside the window");
  assert.equal(w.trigger, 100.2);
});

test("not a long wick: too small, the close too low, or not the lowest of the last bars", () => {
  const small = bars([...FLAT, [99.9, 100.0, 99.7, 99.98], ...FLAT]);
  assert.equal(find(small, "pin").filter((y) => y.start === 20).length, 0, "range under 0.5 ATR");
  const weak = bars([...FLAT, [100.0, 100.2, 98.6, 99.4], ...FLAT]);
  assert.equal(find(weak, "pin").filter((y) => y.start === 20).length, 0, "closes in the lower part of its range");
  const notLow = bars([...FLAT.slice(0, 17), [100, 100.5, 98.0, 100], ...FLAT.slice(0, 2), [99.8, 100.2, 98.6, 100.0], ...FLAT]);
  assert.equal(find(notLow, "pin").filter((y) => y.start === 20).length, 0, "a lower low 3 bars before");
});

test("engulfing: a down bar covered by an up bar, entered above the pair's high; the mirror for shorts", () => {
  const rows = [...FLAT, [100, 100.2, 99.0, 99.2], [99.1, 100.4, 98.9, 100.1], [100.1, 100.7, 100, 100.6], ...FLAT];
  const c = bars(rows);
  const [x] = find(c, "engulf").filter((y) => y.start === 20);
  assert.ok(x);
  assert.equal(x.dir, 1);
  assert.equal(x.s, 21);
  assert.equal(x.e, 22);
  assert.equal(x.extreme, 98.9);
  assert.equal(x.trigger, 100.4);
  const [y] = find(mirror(c), "engulf").filter((z) => z.start === 20);
  assert.equal(y.dir, -1);
  assert.equal(y.e, 22);
  assert.ok(close(y.extreme, 101.1) && close(y.trigger, 99.6));

  // the body covers only part of the first bar's: no pattern
  const partial = bars([...FLAT, [100, 100.2, 99.0, 99.2], [99.3, 100.4, 98.9, 99.9], ...FLAT]);
  assert.equal(find(partial, "engulf").filter((z) => z.start === 20).length, 0);
  // a close below the pair's low before the close above: void
  const voided = bars([...FLAT, [100, 100.2, 99.0, 99.2], [99.1, 100.4, 98.9, 100.1], [100, 100.1, 98.5, 98.7], [98.7, 100.8, 98.6, 100.6], ...FLAT]);
  assert.equal(find(voided, "engulf").find((z) => z.start === 20)!.status, "void");
});

test("inside-bar breakout: the first close outside the mother sets the direction; nested bars count once", () => {
  const base = [...FLAT, [100, 101.5, 98.5, 100.5], [100.5, 101, 99.5, 100.2], [100.2, 100.8, 99.8, 100.4]];
  const up = bars([...base, [100.4, 101.9, 100.3, 101.8], ...FLAT.map(([o, h, l, c]) => [o + 1.8, h + 1.8, l + 1.8, c + 1.8])]);
  const xs = find(up, "inside").filter((y) => y.start === 20);
  assert.equal(xs.length, 1, "one mother, one setup");
  assert.equal(find(up, "inside").filter((y) => y.start === 21 || y.start === 22).length, 0, "the inside bars are not mothers themselves");
  const [x] = xs;
  assert.equal(x.dir, 1);
  assert.equal(x.s, 22, "the last inside bar");
  assert.equal(x.e, 23);
  assert.equal(x.extreme, 98.5, "the mother's low");
  assert.equal(x.trigger, 101.5);

  const down = bars([...base, [100.4, 100.5, 98.0, 98.2], ...FLAT.map(([o, h, l, c]) => [o - 1.8, h - 1.8, l - 1.8, c - 1.8])]);
  const [y] = find(down, "inside").filter((z) => z.start === 20);
  assert.equal(y.dir, -1);
  assert.equal(y.e, 23);
  assert.equal(y.extreme, 101.5, "the mother's high for a short");

  // no close outside within 3 bars: expired, both ways, counted as one pattern
  const flat = bars([...base, [100.4, 101.6, 100, 101], [101, 101.6, 100.5, 101.2], [101.2, 101.6, 100.5, 101.4], [101.4, 102, 101, 101.9], ...FLAT]);
  const z = find(flat, "inside").filter((w) => w.start === 20);
  assert.deepEqual(z.map((w) => w.status), ["expired", "expired"]);
});

/** A swing low at 99.9 (confirmed), a lower high at 106.1, then down to 100.5: ready to break the low. */
const twoB = (after: number[][]) => bars([...walk([100, 110, 100, 106, 100.5]), ...after, ...FLAT.slice(0, 5)]);

test("false break (2B): the first trade below the last swing low, then a close back above within 3 bars", () => {
  const c = twoB([[100.5, 100.6, 99.2, 99.6], [99.6, 100.4, 99.5, 100.3]]);
  const inp = input(c);
  const b = c.length - 7;
  const P = inp.ss[b - 1].lastLow!;
  assert.ok(close(P.price, 99.9) && P.confirmedAt < b, "the last swing low, confirmed before the break");
  const xs = findPatterns(inp, { kinds: ["fake2b"] }).filter((y) => y.dir === 1);
  assert.equal(xs.length, 1, "each swing is used once");
  const [x] = xs;
  assert.equal(x.start, b);
  assert.equal(x.s, b - 1, "classified on the bar before the break");
  assert.equal(x.status, "entered");
  assert.equal(x.e, b + 1);
  assert.equal(x.extreme, 99.2, "the low of the break and reclaim bars");
  assert.equal(x.loc, "key", "on a swing point by definition");
  assert.equal(x.trend, trendOf(inp.ss[b - 1], 1));

  // one bar through and back: r = b
  const one = twoB([[100.5, 100.6, 99.2, 100.2]]);
  assert.equal(findPatterns(input(one), { kinds: ["fake2b"] }).find((y) => y.dir === 1)!.e, one.length - 6);
  // a close 0.8 ATR below first: void; no close back within 3 bars: expired
  const voided = twoB([[100.5, 100.6, 99.2, 99.6], [99.6, 99.7, 98.6, 98.7], [98.7, 100.4, 98.6, 100.3]]);
  assert.equal(findPatterns(input(voided), { kinds: ["fake2b"] }).find((y) => y.dir === 1)!.status, "void");
  const slow = twoB([[100.5, 100.6, 99.2, 99.6], [99.6, 99.8, 99.4, 99.6], [99.6, 99.8, 99.4, 99.7], [99.7, 100.4, 99.6, 100.3]]);
  assert.equal(findPatterns(input(slow), { kinds: ["fake2b"] }).find((y) => y.dir === 1)!.status, "expired");
  // the mirror: a false break of a swing high
  const m = mirror(c);
  const [y] = findPatterns(input(m), { kinds: ["fake2b"] }).filter((z) => z.dir === -1);
  assert.equal(y.e, b + 1);
  assert.ok(close(y.extreme, 100.8) && close(y.trigger, 100.1));
});

/** A swing high at 106.1 (confirmed), a higher low, then up to 105.5: ready to break out. */
const retest = (after: number[][]) => bars([...walk([100, 106, 101, 104, 105.5]), ...after, ...FLAT.slice(0, 3).map(([o, h, l, c]) => [o + 8, h + 8, l + 8, c + 8])]);

test("breakout-retest: a close above the last swing high, a bar back to it, then a close above that bar's high", () => {
  const c = retest([[105.5, 106.9, 105.4, 106.8], [106.8, 107.0, 106.2, 106.5], [106.5, 107.3, 106.4, 107.2]]);
  const inp = input(c);
  const b = c.length - 6;
  const H = inp.ss[b - 1].lastHigh!;
  assert.ok(close(H.price, 106.1), "the swing high");
  const [x] = findPatterns(inp, { kinds: ["retest"] }).filter((y) => y.dir === 1);
  assert.equal(x.start, b);
  assert.equal(x.status, "entered");
  assert.equal(x.e, b + 2);
  assert.equal(x.s, b + 1, "classified on the bar before the entry");
  assert.equal(x.extreme, 106.2, "the low from the first retest to the bar before the entry");
  assert.equal(x.trigger, 107.0, "the retest bar's high");
  assert.equal(x.loc, "key");

  // back below the swing by 0.8 ATR on a close: over
  const failed = retest([[105.5, 106.9, 105.4, 106.8], [106.8, 106.9, 105.0, 105.1], [105.1, 107.3, 105.0, 107.2]]);
  assert.equal(findPatterns(input(failed), { kinds: ["retest"] }).find((y) => y.dir === 1)!.status, "void");
  // no retest within 10 bars: expired
  const away = retest([[105.5, 106.9, 105.4, 106.8], ...Array.from({ length: 11 }, (_, k) => [107 + k * 0.5, 107.7 + k * 0.5, 106.9 + k * 0.5, 107.5 + k * 0.5])]);
  assert.equal(findPatterns(input(away), { kinds: ["retest"] }).find((y) => y.dir === 1)!.status, "expired");
  // the entry has to come within 3 bars of the latest retest
  const late = retest([[105.5, 106.9, 105.4, 106.8], [106.8, 107.0, 106.2, 106.5], [106.5, 106.9, 106.4, 106.8], [106.8, 106.9, 106.4, 106.7], [106.7, 106.95, 106.4, 106.8], [106.8, 107.3, 106.6, 107.2]]);
  assert.notEqual(findPatterns(input(late), { kinds: ["retest"] }).find((y) => y.dir === 1)?.status, "entered");
  // the mirror
  const [y] = findPatterns(input(mirror(c)), { kinds: ["retest"] }).filter((z) => z.dir === -1);
  assert.equal(y.e, b + 2);
  assert.ok(close(y.extreme, 93.8) && close(y.trigger, 93));
});

// ---------------------------------------------------------------- classification

test("trend: with, against or a range, by the structure on the pattern's bar", () => {
  const st = (state: StructureState["state"]) => ({ state }) as StructureState;
  assert.equal(trendOf(st("up"), 1), "with");
  assert.equal(trendOf(st("up"), -1), "against");
  assert.equal(trendOf(st("down"), -1), "with");
  assert.equal(trendOf(st("down"), 1), "against");
  assert.equal(trendOf(st("range"), 1), "range");
  assert.equal(trendOf(undefined, -1), "range");
});

test("key level: a support within 0.5 ATR of the extreme, known at the bar; the pattern's own bars do not count", () => {
  const c = bars(pinRows([[100, 100.4, 99.8, 100.1], [100.1, 100.6, 100, 100.5]]));
  const base = input(c);
  const x = findPatterns(base, { kinds: ["pin"], locate: false }).find((y) => y.start === 20)!;
  assert.equal(x.loc, null, "not located unless asked");
  const A = base.atr[20];
  const at = (price: number, i?: number): PaInput => ({ ...base, levels: () => [{ price, kind: "pivot", i }] });
  assert.equal(locateSetup(at(98.6 - 0.4 * A), x), "key");
  assert.equal(locateSetup(at(98.6 + 0.45 * A), x), "key", "resistance-turned-support just above counts as well");
  assert.equal(locateSetup(at(98.6 - 0.6 * A), x), "mid");
  assert.equal(locateSetup(at(98.6, 20), x), "mid", "a swing on the pattern's own bar");
  assert.equal(locateSetup(at(98.6, 12), x), "key");
  assert.equal(locateSetup(base, x), "mid", "no level source: the middle");
  assert.equal(findPatterns(at(98.6), { kinds: ["pin"] }).find((y) => y.start === 20)!.loc, "key", "located by default");
});

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

function randomWalk(n: number, seed: number, sec: number, t0: number): Candle[] {
  let s = seed;
  const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  let p = 100;
  return Array.from({ length: n }, (_, i) => {
    const o = p;
    p *= 1 + (r() - 0.5) * 0.02 + (r() < 0.02 ? (r() - 0.5) * 0.06 : 0);
    return { t: t0 + i * sec, o, h: Math.max(o, p) * (1 + r() * 0.006), l: Math.min(o, p) * (1 - r() * 0.006), c: p, v: 1 };
  });
}

const H1 = 3600;
const hourly = randomWalk(3000, 7, H1, Date.parse("2025-01-01T00:00:00Z") / 1000);
const frames = (upTo: number) => {
  const end = hourly[upTo - 1].t + H1;
  const c4 = aggregate(hourly, 4 * H1).filter((x) => x.t + 4 * H1 <= end);
  const d1 = aggregate(hourly, 86400).filter((x) => x.t + 86400 <= end);
  return { c4, d1 };
};
const hourInput = (c: Candle[], c4: Candle[], d1: Candle[]): PaInput => {
  const atr = atrSeries(c);
  return { tf: "1h", c, atr, ss: structureSeries(c, atr), levels: paLevelSource("1h", c, atr, [{ tf: "4h", c: c4, atr: atrSeries(c4) }, { tf: "1d", c: d1, atr: atrSeries(d1) }], d1) };
};

test("level source: the previous day's low and this chart's intact swings, from bars closed by then only", () => {
  const { c4, d1 } = frames(hourly.length);
  const full = hourInput(hourly, aggregate(hourly, 4 * H1), aggregate(hourly, 86400));
  for (const s of [500, 1203, 2222]) {
    const lv = full.levels!(s, 1);
    // the previous UTC day's low
    const dayStart = Math.floor((hourly[s].t + H1) / 86400) * 86400;
    const prev = hourly.filter((x) => x.t >= dayStart - 86400 && x.t < dayStart);
    assert.ok(lv.some((x) => x.kind === "period" && close(x.price, Math.min(...prev.map((y) => y.l)))), `previous day's low at ${s}`);
    assert.ok(lv.some((x) => x.kind === "pivot") && lv.every((x) => x.kind !== "pivot" || x.i! <= s - 5));
    // the same levels from data that ends at bar s, with the higher frames cut to the bars closed by then
    const cut = hourly.slice(0, s + 1);
    const f = frames(s + 1);
    const short = hourInput(cut, f.c4, f.d1);
    const key = (xs: { price: number; kind: string }[]) => xs.map((x) => `${x.kind}:${x.price}`).sort();
    assert.deepEqual(key(short.levels!(s, 1)), key(lv), `levels at ${s}`);
    assert.deepEqual(key(short.levels!(s, -1)), key(full.levels!(s, -1)), `resistance at ${s}`);
  }
  assert.ok(c4.length && d1.length);
});

test("no look-ahead: cutting off later bars changes no earlier pattern or entry", () => {
  const { c4, d1 } = frames(hourly.length);
  const full = findPatterns(hourInput(hourly, c4, d1));
  const entered = full.filter((x) => x.status === "entered");
  for (const kind of PATTERNS) assert.ok(entered.some((x) => x.kind === kind), `some ${kind} on a random walk`);
  const id = (x: PaSetup) => `${x.kind}|${x.dir}|${x.start}`;
  for (const cut of [800, 1500, 2400]) {
    const part = findPatterns(hourInput(hourly.slice(0, cut), c4, d1));
    const byId = new Map(part.map((x) => [id(x), x]));
    for (const x of entered.filter((y) => y.e! < cut)) assert.deepEqual(byId.get(id(x)), x, `${id(x)} with ${cut} bars`);
    for (const x of part.filter((y) => y.status === "entered")) assert.ok(x.e! < cut && entered.some((y) => id(y) === id(x)), `${id(x)} is entered with all the bars too`);
    // a setup resolved before the cut (void / expired) is resolved the same way
    const fullById = new Map(full.map((x) => [id(x), x]));
    for (const x of part.filter((y) => y.status === "void" || y.status === "expired")) assert.equal(fullById.get(id(x))?.status, x.status, id(x));
  }
});

test("chunked scans give the same setups as one pass", () => {
  const inp = hourInput(hourly, aggregate(hourly, 4 * H1), aggregate(hourly, 86400));
  const one = findPatterns(inp, { locate: false });
  const parts = [0, 750, 1500, 2250].flatMap((k) => findPatterns(inp, { from: k, to: k + 750, locate: false }));
  const key = (x: PaSetup) => JSON.stringify(x);
  assert.deepEqual(parts.map(key).sort(), one.map(key).sort());
});

// ---------------------------------------------------------------- the report

test("patterns report: two rows per timeframe and pattern, controls, extras", async () => {
  const { store } = await import("../src/lib/data/klines.ts");
  const { patternsReport, PA_TFS } = await import("../src/lib/research/patterns.ts");
  const { DEFAULT_ENGINE_PARAMS } = await import("../src/lib/params.ts");
  const day = 86400;
  const today = Math.floor(Date.now() / 1000 / day) * day;
  for (const [coin, seed] of [
    ["BTC", 21],
    ["ETH", 22],
  ] as const) {
    // each timeframe its own walk: the series only have to be long enough, partly in-sample and partly held out
    const h4 = randomWalk(1300, seed + 20, 4 * H1, today - 250 * day - 1300 * 4 * H1);
    const d1 = randomWalk(800, seed + 30, day, today - 800 * day);
    const sets: [Timeframe, Candle[]][] = [
      ["4h", h4],
      ["1d", d1],
      // weeks open on Monday (the epoch was a Thursday)
      ["1w", aggregate(d1.map((x) => ({ ...x, t: x.t - 4 * day })), 7 * day).map((x) => ({ ...x, t: x.t + 4 * day }))],
    ];
    for (const [tf, c] of sets) store(coin, tf, "binance-futures", c);
  }
  const r = await patternsReport(DEFAULT_ENGINE_PARAMS, { paramsVersion: 0, coins: ["BTC", "ETH"] });
  assert.equal(r.kind, "patterns");
  assert.deepEqual(PA_TFS, ["4h", "1d"]);
  assert.deepEqual(r.coverage.map((x) => x.tf), PA_TFS);
  assert.deepEqual(r.rules, { ...PA_RULES });
  assert.equal(r.rows.length, 20);
  assert.ok(r.rows.every((x) => x.family === "pa"));
  const keys = r.rows.map((x) => x.key);
  for (const tf of PA_TFS) for (const kind of PATTERNS) for (const k of ["all", "text"]) assert.ok(keys.includes(`pa:${tf}:${kind}:${k}`), `pa:${tf}:${kind}:${k}`);
  assert.equal(r.rows.find((x) => x.key === "pa:4h:pin:text")!.name, "4 小时 · 长影线 · 关键位 + 顺势");
  assert.equal(r.rows.find((x) => x.key === "pa:1d:fake2b:text")!.name, "日线 · 假突破 2B · 顺势");
  const n = (x: { cells: { is: { n: number }; oos: { n: number } } }) => x.cells.is.n + x.cells.oos.n;
  let total = 0;
  for (const tf of PA_TFS) {
    for (const kind of PATTERNS) {
      const all = r.rows.find((x) => x.key === `pa:${tf}:${kind}:all`)!;
      const text = r.rows.find((x) => x.key === `pa:${tf}:${kind}:text`)!;
      total += n(all);
      assert.equal(all.extra!.trades, n(all));
      assert.ok(n(text) <= n(all), "the textbook trades are a subset");
      const tp = all.extra!.triggerPct;
      if (tp != null) assert.ok(tp >= 0 && tp <= 100);
      assert.ok(all.extra!.setups! >= all.cells.is.n, "every in-sample trade is an in-sample pattern");
    }
  }
  assert.ok(total > 0, "patterns were traded");
  for (const x of r.rows) {
    for (const k of ["reach2", "quickStopPct"]) {
      const v = x.extra?.[k];
      if (v != null) assert.ok(v >= 0 && v <= 100, `${x.key} ${k}`);
    }
    assert.equal(x.control, "同一币种、同方向、同止损距离的随机入场");
  }
  assert.ok(r.notes.some((x) => x.startsWith("意外发现")));
});
