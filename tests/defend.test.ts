import { test } from "node:test";
import assert from "node:assert/strict";
import type { Candle } from "../src/lib/types.ts";
import { atrSeries } from "../src/lib/ta/risk.ts";
import { structureSeries } from "../src/lib/ta/structure.ts";
import { findDefends, nearStop, netTakerFlow, oiFlush, type DefendEvent, type LowerFrame, type OiSeries } from "../src/lib/ta/defend.ts";
import { runUp, simulate, type SimContext } from "../src/lib/research/sim.ts";
import { DEFAULT_ENGINE_PARAMS, engineParams, validateParams } from "../src/lib/params.ts";

const H = 3600;
const bar = (t: number, o: number, h: number, l: number, c: number, extra: Partial<Candle> = {}): Candle => ({ t: t * H, o, h, l, c, v: 1, ...extra });

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/** An hourly random walk with taker volume, its 4-hour bars and hourly open interest. */
function market(hours: number, seed: number) {
  const r = rng(seed);
  const t0 = 1_700_000_000 - (1_700_000_000 % (4 * H));
  const h: Candle[] = [];
  let p = 100;
  for (let k = 0; k < hours; k++) {
    const o = p;
    p = o * (1 + (r() - 0.5) * 0.012 + (r() < 0.02 ? (r() - 0.5) * 0.05 : 0));
    const v = 100 + 200 * r();
    h.push({ t: t0 + k * H, o, h: Math.max(o, p) * (1 + 0.003 * r()), l: Math.min(o, p) * (1 - 0.003 * r()), c: p, v, tbv: v * r() });
  }
  const c: Candle[] = [];
  for (let k = 0; k + 4 <= h.length; k += 4) {
    const g = h.slice(k, k + 4);
    c.push({ t: g[0].t, o: g[0].o, h: Math.max(...g.map((x) => x.h)), l: Math.min(...g.map((x) => x.l)), c: g[3].c, v: g.reduce((s, x) => s + x.v, 0), tbv: g.reduce((s, x) => s + x.tbv!, 0) });
  }
  let oi = 1000;
  const oiS: OiSeries = { t: [], oi: [] };
  for (const x of h) {
    oi *= 1 + (r() - 0.5) * 0.02;
    oiS.t.push(x.t);
    oiS.oi.push(oi);
  }
  return { h, c, oi: oiS };
}

function defends(m: ReturnType<typeof market>, rules?: typeof DEFAULT_ENGINE_PARAMS.defend) {
  const atr = atrSeries(m.c);
  const hatr = atrSeries(m.h);
  const lower: LowerFrame = { c: m.h, atr: hatr, ss: structureSeries(m.h, hatr), buf: 0.5 };
  return findDefends({ tf: "4h", c: m.c, atr, ss: structureSeries(m.c, atr), filterAt: () => 0, buf: 0.8, lower, oi: m.oi, from: 300, rules });
}

test("defend settings: the parameter defaults are the rule as researched; other values change it", () => {
  assert.deepEqual(engineParams().defend, { stallBars: 3, freshBars: 50, reachAtr: 0.25, minNearAtr: 0.5 });
  assert.equal(validateParams({ "defend.stallBars": 2, "defend.minNearAtr": 1 }), null);
  assert.ok(validateParams({ "defend.stallBars": 9 }));
  const m = market(4 * 1200, 3);
  const plain = defends(m);
  assert.deepEqual(defends(m, DEFAULT_ENGINE_PARAMS.defend), plain);
  assert.notDeepEqual(defends(m, { ...DEFAULT_ENGINE_PARAMS.defend, stallBars: 1 }), plain);
});

test("simulator: half off at 2R, slippage on stops, a limit entry price, and the mark price as the trigger", () => {
  const base = Array.from({ length: 30 }, (_, i) => bar(i, 100, 101, 99, 100));
  const ctx = (c: Candle[]): SimContext => ({ c, atr: atrSeries(c), swings: [], buf: 0.8, costPct: 0, maxBars: 50 });
  // up to 102 (2R), then back to the stop at 99: half +2R, half −1R
  const c = [...base, bar(30, 100, 102.2, 99.6, 101), bar(31, 101, 101.2, 98.5, 99)];
  assert.ok(Math.abs(simulate(ctx(c), 29, 1, 99, "scale2r")!.r - 0.5) < 1e-9);
  assert.equal(simulate(ctx(c), 29, 1, 99, "structure")!.r, -1);
  const slipped = simulate({ ...ctx(c), stopSlipPct: 1 }, 29, 1, 99, "structure")!;
  assert.ok(Math.abs(slipped.r - (99 * 0.99 - 100)) < 1e-9, "the stop fills 1% worse");
  assert.equal(simulate({ ...ctx(c), stopSlipPct: 0 }, 29, 1, 99, "structure")!.r, -1, "no slippage: as before");
  // a limit filled at 100.5 during bar 29, stop 99.5: R is 1
  assert.ok(Math.abs(simulate(ctx(c), 29, 1, 99.5, "structure", 100.5)!.r - -1) < 1e-9);
  // the last price wicks to 98.5 but the mark price only to 99.2: not stopped by the mark
  const mark: Candle[] = c.map((x) => ({ ...x, l: Math.max(x.l, 99.2) }));
  const byMark = simulate({ ...ctx(c), trigger: mark, maxBars: 2 }, 29, 1, 99, "structure")!;
  assert.equal(byMark.exit, "time");
  assert.equal(simulate({ ...ctx(c), trigger: [] }, 29, 1, 99, "structure")!.r, -1, "missing mark bars fall back to the last price");
  // run-up before the stop: 2.2R, the stop bar does not count
  assert.ok(Math.abs(runUp(ctx(c), 29, 1, 99) - 2.2) < 1e-9);
  assert.ok(simulate(ctx(c), 29, 1, 99, "structure")!.mae >= 1, "worst excursion reaches the stop");
});

test("taker flow: the sum of buying minus selling; unknown when a bar lacks it or the bars start too late", () => {
  const c = [bar(0, 1, 1, 1, 1, { v: 10, tbv: 7 }), bar(1, 1, 1, 1, 1, { v: 10, tbv: 2 }), bar(2, 1, 1, 1, 1, { v: 10, tbv: 9 })];
  const times = c.map((x) => x.t);
  assert.equal(netTakerFlow(c, times, 0, 3 * H), 4 - 6 + 8);
  assert.equal(netTakerFlow(c, times, H, 2 * H), -6, "only the bars opening in [from, to)");
  assert.equal(netTakerFlow(c, times, -H, 3 * H), null, "the bars do not reach back");
  const missing = [c[0], { ...c[1], tbv: undefined }, c[2]];
  assert.equal(netTakerFlow(missing, times, 0, 3 * H), null);
});

test("open interest flush: measured against its own past; later hours never change it", () => {
  const oi: OiSeries = { t: [], oi: [] };
  for (let k = 0; k < 40 * 24; k++) {
    oi.t.push(k * H);
    oi.oi.push(1000 * (1 + 0.005 * Math.sin(k)));
  }
  const end = 35 * 24 * H;
  assert.equal(oiFlush(oi, end - 8 * H, end), false, "ordinary wiggles");
  const k = oi.t.indexOf(end);
  oi.oi[k] = oi.oi[k - 8] * 0.9;
  assert.equal(oiFlush(oi, end - 8 * H, end), true, "a 10% drop into the low");
  const later = { t: oi.t, oi: oi.oi.map((x, j) => (j > k ? x * 3 : x)) };
  assert.equal(oiFlush(later, end - 8 * H, end), true);
  assert.equal(oiFlush({ t: oi.t.slice(0, 100), oi: oi.oi.slice(0, 100) }, end - 8 * H, end), null, "no data at that time");
});

test("defends: stops beyond the extreme, the far one at least as far, and nothing looks ahead", () => {
  const m = market(4 * 1500, 7);
  const evs = defends(m);
  assert.ok(evs.length > 20, `found ${evs.length}`);
  const atr = atrSeries(m.c);
  for (const e of evs) {
    const entry = m.c[e.i].c;
    assert.ok((entry - e.far) * e.dir > 0, "the far stop is on the losing side");
    assert.ok((e.extreme - e.far) * e.dir > 0, "beyond the extreme");
    if (e.near != null) {
      assert.ok((e.extreme - e.near) * e.dir > 0, "the near stop is beyond the extreme too");
      assert.ok((entry - e.near) * e.dir >= 0.5 * atr[e.i] - 1e-9, "at least half an ATR away");
      assert.ok((e.near - e.far) * e.dir >= 0, "the far stop is never closer than the near one");
    }
    assert.ok(e.e < e.i && e.i - e.e <= 3);
  }
  assert.ok(evs.some((e) => e.flow != null) && evs.some((e) => e.oi != null), "evidence is measured");
  // replaying on the bars known at each entry gives the same event (apart from waiting for the turn, which looks ahead)
  const strip = ({ confirm, ...rest }: DefendEvent) => (void confirm, rest);
  for (const e of [evs[3], evs[Math.floor(evs.length / 2)], evs[evs.length - 1]]) {
    const end = m.c[e.i].t + 4 * H;
    const cut = {
      h: m.h.filter((x) => x.t < end),
      c: m.c.slice(0, e.i + 1),
      oi: { t: m.oi.t.filter((t) => t <= end), oi: m.oi.oi.slice(0, m.oi.t.filter((t) => t <= end).length) },
    };
    const again = defends(cut).find((x) => x.i === e.i && x.dir === e.dir);
    assert.ok(again, `event at ${e.i} found again`);
    assert.deepEqual(strip(again!), strip(e));
  }
});

test("near stop: from the hour chart, beyond the defended extreme even when the hour chart has a higher low", () => {
  const m = market(4 * 400, 11);
  const hatr = atrSeries(m.h);
  const lower: LowerFrame = { c: m.h, atr: hatr, ss: structureSeries(m.h, hatr), buf: 0.5 };
  const times = m.h.map((x) => x.t);
  const end = m.h[m.h.length - 1].t + H;
  const entry = m.h[m.h.length - 1].c;
  const plain = nearStop(lower, times, 1, end, entry, 0.01 * entry);
  assert.ok(plain != null && plain < entry);
  const deep = nearStop(lower, times, 1, end, entry, 0.01 * entry, plain! - 5);
  assert.ok(deep! < plain! - 5, "pushed beyond a lower extreme");
  const far = nearStop(lower, times, 1, end, entry, 100 * entry);
  assert.ok(far! <= entry - 50 * entry, "never closer than half the main ATR");
});
