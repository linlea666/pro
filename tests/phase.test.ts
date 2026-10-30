import { test } from "node:test";
import assert from "node:assert/strict";
import type { Candle } from "../src/lib/types.ts";
import { atrSeries } from "../src/lib/ta/risk.ts";
import { structureSeries } from "../src/lib/ta/structure.ts";
import { turnAt } from "../src/lib/ta/watch.ts";
import { phaseAt, phaseDir, type Phase } from "../src/lib/ta/phase.ts";

const T0 = Date.parse("2026-03-02T00:00:00Z") / 1000;

/** 15-minute bars walking through the given prices in steps of 0.5 (a small wick on each side). */
function path(points: number[]): Candle[] {
  const out: Candle[] = [];
  let p = points[0];
  for (const to of points.slice(1)) {
    while (Math.abs(to - p) > 1e-9) {
      const o = p;
      p = Math.abs(to - p) <= 0.5 ? to : p + Math.sign(to - p) * 0.5;
      out.push({ t: T0 + out.length * 900, o, h: Math.max(o, p) + 0.1, l: Math.min(o, p) - 0.1, c: p, v: 1 });
    }
  }
  return out;
}

// up, then a decline with lower highs and lower lows, a stall at 98, a bounce, a higher low, a reclaim, a new uptrend
const c = path([100, 112, 106, 110, 103, 107, 98, 98, 98.5, 98, 98.5, 98, 101, 99.5, 102.5, 100.5, 104, 101.5, 106]);
const atr = atrSeries(c);
const ss = structureSeries(c, atr, 2);
const all = c.map((_, n) => phaseAt(c, atr, ss, n));
const at = (n: number) => all[n]!;
/** the first bar at or after `from` with this side and stage */
const first = (from: number, dir: 1 | -1, stage: number) => all.findIndex((p, n) => n >= from && p?.dir === dir && p.stage === stage);

test("not enough swings: no phase", () => {
  assert.equal(phaseAt(c, atr, ss, 3), null);
  assert.equal(phaseDir(ss, 3), null);
});

test("a decline walks ① → ② → ③ → ④, then the mirror ladder takes over", () => {
  const fall = all.findIndex((p, n) => n > 60 && ss[n].state === "down" && p?.stage === 1);
  assert.ok(fall > 0);
  const p1 = at(fall);
  assert.equal(p1.dir, 1);
  assert.deepEqual(p1.checks, [false, false, false, false]);
  const n2 = first(fall, 1, 2);
  assert.ok(n2 > fall, "a stall after the last new low");
  assert.deepEqual(at(n2).checks, [true, false, false, false]);
  assert.ok(at(n2).heldAt! > at(n2).low, "② says how far it must bounce for the low to hold");
  const n3 = first(n2, 1, 3);
  assert.ok(n3 > n2);
  assert.deepEqual(at(n3).checks.slice(0, 2), [true, true]);
  assert.equal(at(n3).low, at(n2).low, "the bounce keeps the same low");
  const n4 = first(n3, 1, 4);
  assert.ok(n4 > n3);
  const p4 = at(n4);
  assert.deepEqual(p4.checks, [true, true, true, true]);
  assert.ok(p4.higherLow! > p4.low);
  assert.equal(p4.invalid, p4.higherLow);
  assert.ok(c[n4].c > p4.bounce + 0.1 * atr[n4] - 1e-9);
  // later the structure turns up: the mirror ladder (从上涨转弱) is shown instead
  assert.ok(all.some((p, n) => n > n4 && ss[n].state === "up" && p?.dir === -1));
});

test("a pullback that holds above the low stays ③ with a candidate; breaking the low goes back to ①", () => {
  const n = all.findIndex((p) => p?.dir === 1 && p.stage === 3 && p.candidate != null);
  assert.ok(n > 0);
  const p = at(n);
  assert.ok(p.candidate! > p.low);
  assert.equal(p.invalid, p.low);
  // the first bar after it that trades below the low is ① again, with the new low
  const k = c.findIndex((x, j) => j > n && x.l < p.low);
  assert.ok(k > n);
  assert.equal(at(k).stage, 1);
  assert.ok(at(k).low < p.low);
});

test("④ is the watch's turn: the defended low is a higher low and a close is past the bounce high", () => {
  let seen = 0;
  for (let n = 0; n < c.length; n++) {
    const p = all[n];
    if (!p || p.dir !== 1) continue;
    const s = ss[n];
    // wherever the watch would call a turn here, the ladder is at ④
    if (s.lastLow && turnAt(s, 1, s.lastLow.t - 1)) {
      assert.equal(p.stage, 4, `bar ${n}`);
      seen++;
    }
    if (p.stage === 4) assert.equal(s.lastLow?.label, "HL");
  }
  assert.ok(seen > 0);
});

test("the two ladders mirror each other", () => {
  const flip = (x: Candle): Candle => ({ ...x, o: 300 - x.o, h: 300 - x.l, l: 300 - x.h, c: 300 - x.c });
  const m = c.map(flip);
  const matr = atrSeries(m);
  const mss = structureSeries(m, matr, 2);
  for (let n = 0; n < c.length; n++) {
    const a = all[n], b = phaseAt(m, matr, mss, n);
    assert.equal(!!a, !!b);
    if (!a || !b) continue;
    const same = (x: Phase, y: Phase) => x.stage === y.stage && x.dir === -y.dir && Math.abs(x.low - (300 - y.low)) < 1e-9 && Math.abs(x.invalid - (300 - y.invalid)) < 1e-9;
    assert.ok(same(a, b), `bar ${n}`);
  }
});
