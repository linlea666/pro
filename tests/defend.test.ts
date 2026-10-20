import { test } from "node:test";
import assert from "node:assert/strict";
import type { Candle } from "../src/lib/types.ts";
import { atrSeries } from "../src/lib/ta/risk.ts";
import { structureSeries } from "../src/lib/ta/structure.ts";
import { findDefends, liveDefends, lowerReady, nearStop, netTakerFlow, oiFlush, planNearStop, type DefendEvent, type LowerFrame, type OiSeries } from "../src/lib/ta/defend.ts";
import { findEntries } from "../src/lib/ta/plan.ts";
import { prevPeriodHL } from "../src/lib/ta/levels.ts";
import { defenseTiers } from "../src/lib/ta/tiers.ts";
import { swings } from "../src/lib/ta/structure.ts";
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

/** The market cut at the close of 4-hour bar k: everything known then (the hour bars up to that close). */
function cutAt(m: ReturnType<typeof market>, k: number) {
  const atr = atrSeries(m.c), ss = structureSeries(m.c, atr);
  const hatr = atrSeries(m.h), hss = structureSeries(m.h, hatr);
  const end = m.c[k].t + 4 * H;
  const hn = m.h.filter((x) => x.t < end).length;
  const lower: LowerFrame = { c: m.h.slice(0, hn), atr: hatr.slice(0, hn), ss: hss.slice(0, hn), buf: 0.5 };
  return { c: m.c.slice(0, k + 1), atr: atr.slice(0, k + 1), ss: ss.slice(0, k + 1), lower, oi: m.oi, end };
}

test("live defends: the events a scan of the whole history finds, with the stops it found", () => {
  const m = market(4 * 1500, 7);
  const all = defends(m);
  let n = 0;
  for (const e of all.slice(10, 40)) {
    const x = cutAt(m, e.i);
    const live = liveDefends({ tf: "4h", c: x.c, atr: x.atr, ss: x.ss, filterAt: () => 0, buf: 0.8, lower: x.lower, oi: x.oi, forming: null, livePrice: x.c[e.i].c, cal: null, costPct: 0.15, funding: null });
    const p = live[e.dir > 0 ? "long" : "short"];
    assert.ok(p, `event at ${e.i} is shown at its close`);
    assert.equal(p!.entryT, m.c[e.i].t);
    assert.equal(p!.far.stop, e.far);
    assert.equal(p!.level, e.level);
    if (p!.near) assert.equal(p!.near.stop, e.near);
    assert.ok(p!.text.length > 10);
    n++;
  }
  assert.ok(n >= 20);
});

test("live defends: a bar since the entry that reached the near stop drops it; the far stop or a big run drops the plan", () => {
  const m = market(4 * 1500, 7);
  const withNear = defends(m).filter((e) => e.near != null && (e.near - e.far) * e.dir > 0 && e.i < m.c.length - 2);
  let n = 0;
  for (const e of withNear.slice(0, 15)) {
    const x = cutAt(m, e.i);
    const entry = x.c[e.i].c;
    const next = (low: number): Candle => ({ t: x.c[e.i].t + 4 * H, o: entry, h: Math.max(entry, low), l: Math.min(entry, low), c: entry, v: 1 });
    const run = (bar: Candle, livePrice = entry) =>
      liveDefends({ tf: "4h", c: [...x.c, bar], atr: [...x.atr, x.atr[e.i]], ss: [...x.ss, x.ss[e.i]], filterAt: () => 0, buf: 0.8, lower: x.lower, oi: x.oi, forming: null, livePrice, cal: null, costPct: 0.15, funding: null })[e.dir > 0 ? "long" : "short"];
    const between = (e.near! + e.far) / 2;
    const p = run(next(between));
    if (!p || p.entryT !== x.c[e.i].t) continue; // a newer event took its place
    assert.equal(p.near, null, "the near stop was reached");
    assert.match(p.nearNote!, /已经被碰过/);
    assert.equal(p.far.stop, e.far);
    const gone = run(next(e.far - e.dir * 0.01 * entry));
    assert.ok(!gone || gone.entryT !== x.c[e.i].t, "the far stop was reached");
    const ran = run(next(entry), entry + e.dir * 0.6 * (entry - e.far) * e.dir);
    assert.ok(!ran || ran.entryT !== x.c[e.i].t, "already ran half the risk");
    n++;
  }
  assert.ok(n >= 5, `checked ${n}`);
});

test("near stop of a plan: as the research placed it, only when nearer than the far stop and the hour chart is up to date", () => {
  const m = market(4 * 1500, 11);
  const atr = atrSeries(m.c), ss = structureSeries(m.c, atr);
  const hatr = atrSeries(m.h);
  const lower: LowerFrame = { c: m.h, atr: hatr, ss: structureSeries(m.h, hatr), buf: 0.5 };
  const times = m.h.map((x) => x.t);
  let same = 0, none = 0;
  for (const e of findEntries({ tf: "4h", c: m.c, atr, ss, filterAt: () => 0, buf: 0.8, from: 400 }).slice(0, 60)) {
    const end = m.c[e.i].t + 4 * H;
    const research = nearStop(lower, times, e.dir, end, m.c[e.i].c, atr[e.i]);
    const r = planNearStop({ lower, times, tf: "4h", c: m.c.slice(0, e.i + 1), atr, i: e.i, dir: e.dir, far: e.stop, forming: null });
    if (research != null && (research - e.stop) * e.dir > 0) {
      assert.equal(r.stop, research);
      same++;
    } else {
      assert.equal(r.stop, null);
      assert.ok(r.note);
      none++;
    }
  }
  assert.ok(same > 10, `${same} / ${none}`);
  const e = findEntries({ tf: "4h", c: m.c, atr, ss, filterAt: () => 0, buf: 0.8, from: 400 })[0];
  const end = m.c[e.i].t + 4 * H;
  // a far stop nearer than the hour chart's: one stop only
  const n0 = nearStop(lower, times, e.dir, end, m.c[e.i].c, atr[e.i])!;
  const tight = planNearStop({ lower, times, tf: "4h", c: m.c.slice(0, e.i + 1), atr, i: e.i, dir: e.dir, far: (n0 + m.c[e.i].c) / 2, forming: null });
  assert.equal(tight.stop, null);
  assert.match(tight.note!, /并不比/);
  // the hour bar ending at the entry close missing (a gap or lagging data): no near stop
  const gap = times.filter((t) => t !== end - H);
  assert.equal(lowerReady(times, end), true);
  assert.equal(lowerReady(gap, end), false);
  assert.equal(lowerReady(times.filter((t) => t > end - 100 * H), end), false, "not warmed up");
});

test("previous week / month: the period containing the moment is left out, on a Monday too", () => {
  const D = 86400;
  const monday = Date.parse("2026-10-12T00:00:00Z") / 1000;
  const daily: Candle[] = [];
  for (let k = -21; k < 3; k++) {
    const t = monday + k * D;
    const week = Math.floor(k / 7); // -3, -2, -1 before this Monday; 0 from it
    daily.push({ t, o: 100, h: 110 + week * 10 + (k % 7 === 0 ? 0 : 1), l: 90 + week * 10, c: 100, v: 1 });
  }
  const last = prevPeriodHL(daily, monday, "week")!;
  assert.deepEqual(last, { h: 101, l: 80 }, "the week just finished, even with no bar of the new week yet");
  assert.deepEqual(prevPeriodHL(daily, monday + 8 * 3600, "week"), last, "Monday 08:00: the new week is left out");
  assert.equal(prevPeriodHL(daily, monday + 3 * D, "month")!.l, 60, "September");
});

test("lines of defence: near, mid, far, each further away and on the defended side", () => {
  const m = market(4 * 1500, 5);
  const atr = atrSeries(m.c);
  const daily: Candle[] = [];
  for (const x of m.h) {
    const t = x.t - (x.t % 86400);
    const d = daily[daily.length - 1];
    if (d && d.t === t) {
      d.h = Math.max(d.h, x.h);
      d.l = Math.min(d.l, x.l);
      d.c = x.c;
    } else daily.push({ t, o: x.o, h: x.h, l: x.l, c: x.c, v: 1 });
  }
  const datr = atrSeries(daily), dss = structureSeries(daily, datr);
  let seen = 0;
  for (const k of [600, 800, 1000, 1200, 1400]) {
    const c = m.c.slice(0, k + 1);
    const endSec = c[k].t + 4 * H;
    const closedDays = daily.filter((d) => d.t + 86400 <= endSec);
    const inp = { tf: "4h" as const, c, atr: atr.slice(0, k + 1), sw: swings(c, atr.slice(0, k + 1)), higherTf: "1d" as const, higher: dss[closedDays.length - 1] ?? null, daily: closedDays, endSec, live: c[k].c };
    for (const dir of [1, -1] as const) {
      const lines = defenseTiers(inp, dir);
      const order = ["near", "mid", "far"];
      let prev = -Infinity;
      for (const l of lines) {
        assert.ok(l.distAtr > 0, "on the defended side");
        assert.ok(l.distAtr >= prev, "further each time");
        prev = l.distAtr;
        seen++;
      }
      assert.deepEqual(lines.map((l) => l.tier), order.filter((t) => lines.some((l) => l.tier === t)), "in order, each at most once");
      if (lines[0]) assert.ok(lines[0].tier === "near" && lines[0].distAtr >= 0.5);
    }
  }
  assert.ok(seen >= 10);
});
