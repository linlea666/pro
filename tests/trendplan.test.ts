import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Candle, Timeframe } from "../src/lib/types.ts";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sl-plan-"));
process.env.LOG_LEVEL = "error";
const { getDb } = await import("../src/lib/server/db.ts");
const { store } = await import("../src/lib/data/klines.ts");
const { computeTrendPlan } = await import("../src/lib/trendplan.ts");
const { DEFAULT_ENGINE_PARAMS } = await import("../src/lib/params.ts");
const { TF_SECONDS } = await import("../src/lib/types.ts");
const { atrSeries } = await import("../src/lib/ta/risk.ts");
const { structureSeries, swings } = await import("../src/lib/ta/structure.ts");
const { buildPlans, findEntries } = await import("../src/lib/ta/plan.ts");
const { bufferAtr } = await import("../src/lib/ta/risk.ts");
const { simulate } = await import("../src/lib/research/sim.ts");
const { sequential } = await import("../src/lib/research/plans.ts");

const D = 86400;
const NOW = Math.floor(Date.now() / 1000 / D) * D;

/** The same deterministic market as the replay test: slow waves plus per-bar noise. */
const noise = (t: number) => {
  const x = Math.sin(t * 12.9898) * 43758.5453;
  return (x - Math.floor(x) - 0.5) * 0.01;
};
const price = (t: number) => 100 * Math.exp(0.15 * Math.sin(t / (D * 40)) + 0.05 * Math.sin(t / (D * 3)) + noise(t));
function bars(tf: Timeframe, from: number, to: number, bump = 1): Candle[] {
  const sec = TF_SECONDS[tf];
  const out: Candle[] = [];
  for (let t = Math.ceil(from / sec) * sec; t <= to; t += sec) {
    const o = price(t) * bump, c = price(t + sec) * bump;
    out.push({ t, o, c, h: Math.max(o, c) * 1.003, l: Math.min(o, c) * 0.997, v: 1000 + 500 * Math.sin(t / 7777) });
  }
  return out;
}

globalThis.fetch = (async (input: string) => {
  const q = new URL(input).searchParams;
  const tf = q.get("interval") as Timeframe;
  const sec = TF_SECONDS[tf];
  const limit = Number(q.get("limit"));
  const end = q.has("endTime") ? Number(q.get("endTime")) / 1000 : NOW;
  const rows = bars(tf, end - (limit - 1) * sec, end).slice(-limit).map((x) => [x.t * 1000, String(x.o), String(x.h), String(x.l), String(x.c), String(x.v)]);
  return new Response(JSON.stringify(rows), { status: 200 });
}) as typeof fetch;

const FROM: Record<string, number> = { "15m": NOW - 300 * D, "1h": NOW - 700 * D, "4h": NOW - 1500 * D, "1d": NOW - 3000 * D, "1w": NOW - 3000 * D };
const TFS: Timeframe[] = ["15m", "1h", "4h", "1d", "1w"];
for (const tf of TFS) store("BTC", tf, "binance-futures", bars(tf, FROM[tf], NOW));

test("plan replay: the trend map and plans at an old moment never see what came after it", async () => {
  const end = NOW - 200 * D + TF_SECONDS["4h"];
  const before = await computeTrendPlan("BTC", "4h", DEFAULT_ENGINE_PARAMS, end);
  assert.equal(before.lastClosedT + TF_SECONDS["4h"], end);
  assert.deepEqual(before.map.map((m) => m.tf), ["1w", "1d", "4h", "1h"]);
  assert.ok(before.replay?.future.length, "what happened next is shown");
  for (const p of [before.long, before.short]) {
    if (!p.invalidation || p.entry == null) continue;
    const dir = p.side === "long" ? 1 : -1;
    assert.ok((p.entry - p.invalidation.stop) * dir > 0, "the stop is on the losing side of the entry");
    assert.ok((p.invalidation.anchor - p.invalidation.stop) * dir > 0, "and beyond the anchor by the buffer");
  }

  const d = getDb();
  for (const tf of TFS) {
    d.prepare("DELETE FROM candles WHERE coin = 'BTC' AND tf = ? AND t >= ?").run(tf, end);
    store("BTC", tf, "binance-futures", bars(tf, end, NOW, 1.5));
  }
  const after = await computeTrendPlan("BTC", "4h", DEFAULT_ENGINE_PARAMS, end);
  const strip = (p: typeof before) => {
    const { replay: _r, updatedAt: _u, ...rest } = p;
    return rest;
  };
  assert.deepEqual(strip(after), strip(before));
  assert.notDeepEqual(after.replay?.future, before.replay?.future, "only the future changed");
});

const bar = (t: number, o: number, h: number, l: number, c: number): Candle => ({ t: t * 3600, o, h, l, c, v: 1 });
function path_(pts: number[]): Candle[] {
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
  return c;
}

test("plans: a waiting plan hangs its stop below a new low that is not a confirmed swing yet", () => {
  // higher highs and lows up to 110, then a fall under the last higher low (104) that has not turned into a swing
  const c = path_([100, 108, 104, 110, 103]);
  const atr = atrSeries(c);
  const ss = structureSeries(c, atr);
  const n = c.length - 1;
  assert.equal(ss[n].lastLow?.price, 103.7, "the last confirmed low is the 104 higher low");
  const plans = buildPlans({ tf: "4h", filterTf: "1d", c, atr, ss, sw: swings(c, atr), filterAt: () => 0, cal: null, levels: [], livePrice: c[n].c, costPct: 0.15, funding: null });
  const lowest = Math.min(...c.slice(-15).map((x) => x.l));
  assert.equal(plans.long.kind, "breakout");
  assert.equal(plans.long.invalidation?.anchor, lowest, "anchored on the newest low, not the older swing");
  assert.ok(plans.long.invalidation!.stop < lowest);
});

test("plans: a triggered plan whose stop a later wick reached is no longer shown as triggered", () => {
  const base = path_([100, 110, 104, 114]);
  const atr0 = atrSeries(base);
  const ev = findEntries({ tf: "4h", c: base, atr: atr0, ss: structureSeries(base, atr0), filterAt: () => 0, buf: bufferAtr(null, 80), from: 20 }).find((e) => e.kind === "breakout" && e.dir === 1)!;
  assert.ok(ev, "a breakout above 110");
  const entry = base[ev.i].c;
  const plansWith = (next: Candle, forming: Candle | null = null) => {
    const c = [...base.slice(0, ev.i + 1), next];
    const atr = atrSeries(c);
    return buildPlans({ tf: "4h", filterTf: "1d", c, atr, ss: structureSeries(c, atr), sw: swings(c, atr), filterAt: () => 0, cal: null, levels: [], livePrice: (forming ?? next).c, forming, costPct: 0.15, funding: null }).long;
  };
  const quiet = bar(ev.i + 1, entry, entry + 0.2, entry - 0.3, entry - 0.1);
  assert.equal(plansWith(quiet).status, "active", "nothing reached the stop");
  assert.equal(plansWith(quiet).entryT, base[ev.i].t);
  const swept = { ...quiet, l: ev.stop - 0.2 };
  assert.notEqual(plansWith(swept).entryT, base[ev.i].t, "a closed bar wicked through the stop");
  assert.notEqual(plansWith(quiet, { ...quiet, t: quiet.t + 3600, l: ev.stop - 0.1 }).entryT, base[ev.i].t, "the forming bar did");
});

test("research: one position at a time, so the trades of a rule never overlap", () => {
  const c = path_([100, 110, 100, 112, 100, 115]);
  const atr = atrSeries(c);
  const ctx = { c, atr, swings: swings(c, atr), buf: 0.8, costPct: 0, maxBars: 40 };
  const ev = (i: number) => ({ coin: "BTC", i, t: c[i].t, dir: 1 as const, kind: "breakout" as const, stop: c[i].c - 3, anchor: c[i].c - 2, fStruct: 0 as const, fEma: 0 as const, equal: false, relVol: 1 });
  const evs = [20, 22, 24, 40, 41].map(ev);
  const taken = sequential(evs, ctx, "fixed2r");
  for (let k = 1; k < taken.length; k++) assert.ok(taken[k].e.i >= taken[k - 1].e.i + taken[k - 1].r.bars, "the next trade starts after the previous one closed");
  assert.ok(taken.length < evs.length, "overlapping signals are skipped");
  assert.deepEqual(taken[0].r, simulate(ctx, 20, 1, c[20].c - 3, "fixed2r"));
});
