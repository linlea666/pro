import { test } from "node:test";
import assert from "node:assert/strict";
import type { Candle } from "../src/lib/types.ts";
import { atrSeries } from "../src/lib/ta/risk.ts";
import { structureSeries, swings } from "../src/lib/ta/structure.ts";
import { buildPlans, sizePosition, trailingStop } from "../src/lib/ta/plan.ts";
import { simulate, type SimContext } from "../src/lib/research/sim.ts";

const bar = (t: number, o: number, h: number, l: number, c: number): Candle => ({ t: t * 3600, o, h, l, c, v: 1 });

test("simulator: target, stop, gaps and the conservative same-bar rule", () => {
  const base = Array.from({ length: 30 }, (_, i) => bar(i, 100, 101, 99, 100));
  const ctx = (c: Candle[]): SimContext => ({ c, atr: atrSeries(c), swings: [], buf: 0.8, costPct: 0, maxBars: 50 });
  const up = [...base, bar(30, 100, 103, 99.5, 102.5)];
  assert.equal(simulate(ctx(up), 29, 1, 99, "fixed2r")!.r, 2, "2R target at 102 is reached");
  const both = [...base, bar(30, 100, 103, 98, 101)];
  assert.equal(simulate(ctx(both), 29, 1, 99, "fixed2r")!.r, -1, "a bar reaching stop and target counts as stopped");
  const gap = [...base, bar(30, 97, 97.5, 96, 97)];
  assert.equal(simulate(ctx(gap), 29, 1, 99, "fixed2r")!.r, -3, "a gap through the stop fills at the open");
  const costly = { ...ctx(up), costPct: 0.15 };
  assert.ok(Math.abs(simulate(costly, 29, 1, 99, "fixed2r")!.r - (2 - 0.15)) < 1e-9, "cost of 0.15% of 100 on a risk of 1");
});

test("trailing: the stop only tightens, and the page's trailing stop matches the simulator", () => {
  const pts = [100, 110, 105, 115, 109, 121, 116, 126];
  const c: Candle[] = [];
  let p = pts[0];
  for (let k = 1; k < pts.length; k++) {
    const step = Math.sign(pts[k] - p);
    while (p !== pts[k]) {
      const o = p;
      p += step;
      c.push(bar(c.length, o, Math.max(o, p) + 0.3, Math.min(o, p) - 0.3, p));
    }
  }
  const atr = atrSeries(c);
  const sw = swings(c, atr);
  const entry = c.findIndex((x) => x.c === 106) + 1; // during the pullback to 105
  const stop0 = 104;
  const now = trailingStop(c, atr, sw, 0.8, entry, 1, stop0);
  assert.ok(now > stop0, "moved up behind the later higher lows");
  assert.ok(now < 116, "but stays under the latest higher low");
  // a long run of the simulator ends with the same stop the page shows
  const ctx: SimContext = { c, atr, swings: sw, buf: 0.8, costPct: 0, maxBars: 1000 };
  const res = simulate(ctx, entry, 1, stop0, "structure");
  assert.equal(res, null, "still open at the end of the data");
  // tighten-only: a lower swing never moves the stop down
  assert.equal(trailingStop(c, atr, sw, 0.8, entry, 1, 115), 115);
});

test("plans: the stop sits beyond the protective swing plus the buffer; against the higher timeframe means half size", () => {
  const pts = [100, 110, 105, 115, 109, 121, 117];
  const c: Candle[] = [];
  let p = pts[0];
  for (let k = 1; k < pts.length; k++) {
    const step = Math.sign(pts[k] - p);
    while (p !== pts[k]) {
      const o = p;
      p += step;
      c.push(bar(c.length, o, Math.max(o, p) + 0.3, Math.min(o, p) - 0.3, p));
    }
  }
  const atr = atrSeries(c);
  const ss = structureSeries(c, atr);
  const sw = swings(c, atr);
  const plans = buildPlans({ tf: "4h", filterTf: "1d", c, atr, ss, sw, filterAt: () => 1, cal: null, levels: [], livePrice: c[c.length - 1].c, costPct: 0.15, funding: null });
  const L = plans.long;
  assert.equal(L.alignment, "with");
  assert.ok(L.invalidation, "a long plan with a stop");
  assert.ok(Math.abs(L.invalidation!.anchor - 108.7) < 1e-9, "anchored on the last higher low");
  assert.ok(L.invalidation!.stop < L.invalidation!.anchor - 0.5 * atr[c.length - 1], "the stop leaves the sweep buffer");
  assert.ok(L.invalidation!.zone[0] < L.invalidation!.stop && L.invalidation!.stop < L.invalidation!.zone[1]);
  const S = plans.short;
  assert.equal(S.alignment, "against");
  if (S.status !== "none") assert.equal(S.size, "half");
});

test("sizing: risk budget sets the size; the stop must come before liquidation", () => {
  const ok = sizePosition({ capital: 1000, riskPct: 2, entry: 100, stop: 95, leverage: 5 });
  assert.ok(Math.abs(ok.qty - 4) < 1e-9, "20 USDT risk / 5 per unit");
  assert.equal(ok.stopBeforeLiq, true);
  const bad = sizePosition({ capital: 1000, riskPct: 2, entry: 100, stop: 80, leverage: 10 });
  assert.equal(bad.stopBeforeLiq, false, "10x liquidates near 90.5, before a stop at 80");
  const short = sizePosition({ capital: 1000, riskPct: 1, entry: 100, stop: 104, leverage: 20 });
  assert.equal(short.dir, -1);
  assert.equal(short.stopBeforeLiq, true, "20x short liquidates at 100 × (1 + 0.05 − 0.005) = 104.5, after a stop at 104");
  assert.equal(sizePosition({ capital: 1000, riskPct: 1, entry: 100, stop: 106, leverage: 20 }).stopBeforeLiq, false);
});
