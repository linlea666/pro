import { test } from "node:test";
import assert from "node:assert/strict";
import type { Candle } from "../src/lib/types.ts";
import { computeTd } from "../src/lib/ta/td.ts";
import { ema, rsi, sma } from "../src/lib/ta/core.ts";
import { clusterLevels } from "../src/lib/ta/levels.ts";
import { zigzag } from "../src/lib/ta/zigzag.ts";
import { forwardStats } from "../src/lib/ta/stats.ts";

const bar = (t: number, c: number, spread = 1): Candle => ({ t: t * 3600, o: c, h: c + spread, l: c - spread, c, v: 100 });
const series = (closes: number[]) => closes.map((c, i) => bar(i, c));

test("sma / ema basics", () => {
  assert.deepEqual(sma([1, 2, 3, 4], 2).slice(1), [1.5, 2.5, 3.5]);
  const e = ema([1, 1, 1, 1, 1], 3);
  assert.ok(Number.isNaN(e[1]));
  assert.equal(e[4], 1);
});

test("rsi is 100 for a straight rally", () => {
  const r = rsi(Array.from({ length: 30 }, (_, i) => 100 + i), 14);
  assert.equal(r[29], 100);
});

test("TD buy setup counts nine consecutive lower closes after a price flip", () => {
  // 6 rising bars, then 12 falling bars
  const closes = [100, 101, 102, 103, 104, 105, ...Array.from({ length: 12 }, (_, i) => 104 - i)];
  const td = computeTd(series(closes));
  const nine = td.events.find((e) => e.kind === "setup9" && e.side === "buy");
  assert.ok(nine, "expected a buy setup 9");
  assert.equal(td.buySetup[nine!.i], 9);
  assert.equal(td.buySetup[nine!.i - 8], 1);
  // TDST resistance is the highest true high of the setup
  assert.ok(td.current.tdstResistance! >= closes[nine!.i - 8]);
});

test("TD setup is interrupted when a close fails the comparison", () => {
  const closes = [100, 101, 102, 103, 104, 103, 102, 101, 100, 99, 120, 98, 97];
  const td = computeTd(series(closes));
  assert.equal(td.events.filter((e) => e.kind === "setup9").length, 0);
});

test("zigzag alternates highs and lows", () => {
  const closes = [...Array.from({ length: 20 }, (_, i) => 100 + i * 2), ...Array.from({ length: 20 }, (_, i) => 138 - i * 2), ...Array.from({ length: 20 }, (_, i) => 100 + i * 2)];
  const c = series(closes);
  const piv = zigzag(c, c.map(() => 2), 3);
  for (let k = 1; k < piv.length; k++) assert.notEqual(piv[k].kind, piv[k - 1].kind);
  assert.ok(piv.some((p) => p.kind === "high" && p.price >= 138));
});

test("clusterLevels merges nearby candidates and splits sides", () => {
  const cands = [
    { price: 95, weight: 1, method: "swing" as const, label: "a", tf: "4h" as const },
    { price: 95.2, weight: 1, method: "volume" as const, label: "b", tf: "1d" as const },
    { price: 106, weight: 1, method: "ma" as const, label: "c", tf: "4h" as const },
  ];
  const { supports, resistances } = clusterLevels(cands, 100, 0.5);
  assert.equal(supports.length, 1);
  assert.equal(supports[0].methods.length, 2);
  assert.equal(supports[0].contributions, 2);
  assert.equal(resistances[0].side, "resistance");
});

test("forwardStats compares against the base rate", () => {
  const c = series(Array.from({ length: 100 }, (_, i) => 100 + i)); // always up
  const s = forwardStats(c, "k", "k", "bull", [10, 30, 50, 70], 5);
  assert.equal(s.winRate, 100);
  assert.equal(s.baseWinRate, 100);
  assert.equal(s.reliability, "证据不足");
});

test("params: defaults resolve, overrides clamp, invalid values rejected", async () => {
  const { DEFAULT_PARAMS, resolveParams, validateParams, diffFromDefaults, engineParams } = await import("../src/lib/params.ts");
  assert.equal(resolveParams({})["td.setupLength"], 9);
  assert.equal(resolveParams({ "td.setupLength": 99 })["td.setupLength"], 13);
  assert.equal(resolveParams({ "unknown.key": 1 })["unknown.key"], undefined);
  assert.match(validateParams({ "ind.rsiLow": 5 }) ?? "", /RSI/);
  assert.match(validateParams({ ...DEFAULT_PARAMS, "ind.rsiLow": 40, "ind.rsiHigh": 60, "trend.mild": 50 }) ?? "", /趋势成立线/);
  assert.equal(validateParams(DEFAULT_PARAMS), null);
  assert.deepEqual(diffFromDefaults({ ...DEFAULT_PARAMS, "levels.bandAtr": 1 }), { "levels.bandAtr": 1 });
  const w = engineParams({ "verdict.w.trend": 50, "verdict.w.momentum": 50, "verdict.w.position": 0, "verdict.w.timing": 0 }).verdict;
  assert.equal(w.trend + w.momentum + w.position + w.timing, 1);
});

test("TD honours a custom setup length", () => {
  const closes = [100, 101, 102, 103, 104, 105, ...Array.from({ length: 12 }, (_, i) => 104 - i)];
  const td = computeTd(series(closes), { setupLength: 7, setupLookback: 4, countdownLength: 13, countdownLookback: 2, classicCancel: false });
  const ev = td.events.find((e) => e.kind === "setup9" && e.side === "buy");
  assert.ok(ev);
  assert.equal(td.buySetup[ev!.i], 7);
  assert.equal(td.current.setupLength, 7);
});
