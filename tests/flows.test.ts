import { test } from "node:test";
import assert from "node:assert/strict";
import {
  afterTable,
  buyState,
  corr,
  FLOW_RULES,
  flowNow,
  premarketDays,
  premiumZ,
  quintileMeans,
  rankIn,
  truePremium,
  zBand,
  zSeries,
  zTable,
  type FlowDay,
} from "../src/lib/flows/stats.ts";

const day = (i: number) => new Date(Date.UTC(2025, 0, 1) + i * 86400_000).toISOString().slice(0, 10);
const flows = (f: number[]): FlowDay[] => f.map((flow, i) => ({ day: day(i), flow, aum: 1e11, perEtf: null }));

test("rankIn counts the share strictly below", () => {
  assert.equal(rankIn(5, [1, 5, 9, 3]), 0.5);
  assert.equal(rankIn(0, [1, 2]), 0);
  assert.ok(Number.isNaN(rankIn(1, [])));
});

test("buyState bands follow the 7-day rank", () => {
  assert.equal(buyState(0.95), "强");
  assert.equal(buyState(0.8), "偏强");
  assert.equal(buyState(0.5), "平常");
  assert.equal(buyState(0.2), "偏弱");
  assert.equal(buyState(0.05), "弱");
});

test("flowNow ranks the day and the sums against the previous days only, and counts the streak", () => {
  const n = FLOW_RULES.lookback + 10;
  const f: number[] = Array.from({ length: n }, (_, i) => (i % 2 ? 1e8 : -1e8));
  f[n - 3] = 2e8;
  f[n - 2] = 3e8;
  f[n - 1] = 4e8; // a bigger inflow than any before it, third inflow in a row
  const x = flowNow(flows(f))!;
  assert.equal(x.pct, 1);
  assert.equal(x.streak, 3);
  assert.equal(x.sum3, 9e8);
  assert.equal(x.p3, 1);
  assert.equal(x.state, "强");
  assert.ok(Math.abs(x.aumPct! - 0.4) < 1e-9);
  // too little history
  assert.equal(flowNow(flows(f.slice(0, FLOW_RULES.lookback))), null);
  // an outflow streak is negative
  const g = [...f.slice(0, -2), -1e8, -2e8];
  assert.equal(flowNow(flows(g))!.streak, -2);
});

test("true premium removes the USDT peg", () => {
  // Coinbase 100,000 USD, Binance 100,100 USDT, USDT at 0.999 USD → Binance in USD 99,999.9
  const p = truePremium(100_000, 100_100, 0.999);
  assert.ok(Math.abs(p - (100_000 / 99_999.9 - 1)) < 1e-12);
  assert.ok(p > 0 && p < 1e-5);
});

test("premarket days use the 08–12 UTC bars on weekdays only and need enough bars", () => {
  const t0 = Date.UTC(2025, 0, 6) / 1000; // a Monday
  const hours = [];
  for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++) hours.push({ t: t0 + d * 86400 + h * 3600, prem: h >= 8 && h <= 12 ? 0.001 * (d + 1) : 1 });
  // Tuesday keeps only three premarket bars
  const cut = hours.filter((x) => !(x.t >= t0 + 86400 + 8 * 3600 && x.t < t0 + 86400 + 10 * 3600));
  const p = premarketDays(cut);
  assert.deepEqual(p.map((x) => x.day), ["2025-01-06", "2025-01-08", "2025-01-09", "2025-01-10"]);
  assert.ok(Math.abs(p[0].prem - 0.001) < 1e-12);
  assert.equal(p[0].bars, 5);
});

test("premium Z and its bands", () => {
  const hist = Array.from({ length: 60 }, (_, i) => (i % 2 ? 1 : -1));
  const z = premiumZ(2, hist)!;
  assert.ok(Math.abs(z - 2 / Math.sqrt(60 / 59)) < 1e-9);
  assert.equal(premiumZ(1, hist.slice(1)), null);
  assert.equal(premiumZ(1, Array(60).fill(0)), null);
  assert.equal(zBand(1.6), "买盘强");
  assert.equal(zBand(1), "偏买");
  assert.equal(zBand(0.8), "略偏买");
  assert.equal(zBand(0), "平常");
  assert.equal(zBand(-0.8), "略偏卖");
  assert.equal(zBand(-1.2), "偏卖");
  assert.equal(zBand(-2), "卖盘强");
  const s = zSeries(Array.from({ length: 70 }, (_, i) => ({ day: day(i), prem: i % 2 ? 1 : -1 })));
  assert.equal(s.length, 10);
  assert.equal(s[0].day, day(60));
});

test("the Z table counts inflow days and session rises per band, with an all-days row", () => {
  const rows = [
    { day: "a", z: 2, flow: 1, session: 0.01 },
    { day: "b", z: 1.7, flow: -1, session: -0.01 },
    { day: "c", z: 0, flow: 1, session: null },
    { day: "d", z: -2, flow: -1, session: -0.02 },
  ];
  const t = zTable(rows);
  const strong = t.find((x) => x.band === "买盘强")!;
  assert.equal(strong.days, 2);
  assert.equal(strong.inflowPct, 50);
  assert.equal(strong.upPct, 50);
  assert.equal(t.find((x) => x.band === "平常")!.upPct, null);
  const all = t[t.length - 1];
  assert.equal(all.band, "所有日子");
  assert.equal(all.days, 4);
  assert.equal(all.inflowPct, 50);
  assert.ok(Math.abs(all.avgPct! - (-0.02 / 3) * 100) < 1e-9);
});

test("after table, correlation and fifths", () => {
  const a = afterTable([1, 2, 3], [1, 3], (r, h) => (r === 3 && h === 3 ? null : (r - 2) / 100));
  assert.equal(a[0].n, 3);
  assert.ok(Math.abs(a[0].avgPct) < 1e-12);
  assert.ok(Math.abs(a[0].upPct - 100 / 3) < 1e-9);
  assert.equal(a[1].n, 2);
  assert.ok(Math.abs(corr([1, 2, 3, 4], [2, 4, 6, 8]) - 1) < 1e-12);
  assert.ok(Number.isNaN(corr([1, 1, 1], [1, 2, 3])));
  const q = quintileMeans([5, 1, 4, 2, 3, 6, 7, 8, 9, 10], [50, 10, 40, 20, 30, 60, 70, 80, 90, 100]);
  assert.equal(q.length, 5);
  assert.equal(q[0].mean, 15);
  assert.equal(q[4].mean, 95);
});
