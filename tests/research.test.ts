import { test } from "node:test";
import assert from "node:assert/strict";
import type { Candle } from "../src/lib/types.ts";
import * as ta from "../src/lib/ta/core.ts";
import { bhAdjust, cells, controlTrades, group, judge, makeSplit, trades, type Trade } from "../src/lib/research/engine.ts";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
const H = 3600;
const T0 = 1_600_000_000;
function walk(n: number, seed: number, drift = 0): Candle[] {
  const r = rng(seed);
  let p = 100;
  return Array.from({ length: n }, (_, i) => {
    const o = p;
    p *= 1 + (r() - 0.5) * 0.02 + drift;
    return { t: T0 + i * H, o, h: Math.max(o, p) * 1.002, l: Math.min(o, p) * 0.998, c: p, v: 1 };
  });
}

test("research: trades never overlap, pay the cost and are measured in ATR", () => {
  const c = Array.from({ length: 100 }, (_, i): Candle => ({ t: i * H, o: 100 + i, h: 101 + i, l: 99 + i, c: 100 + i, v: 1 }));
  const atr = ta.atr(c, 14);
  const t = trades(c, atr, [20, 21, 30, 40], 1, 10, 0.15, "BTC");
  assert.deepEqual(t.map((x) => x.t), [20 * H, 30 * H, 40 * H]);
  const pct = (10 / 120) * 100 - 0.15;
  assert.ok(Math.abs(t[0].pct - pct) < 1e-9);
  assert.ok(Math.abs(t[0].r - pct / ((atr[20] / 120) * 100)) < 1e-9);
});

test("research: BH adjustment", () => {
  assert.deepEqual(bhAdjust([0.01, 0.04, null, 0.03]), [0.03, 0.04, null, 0.04]);
});

test("research: a rule only passes with a big, significant edge that BTC, ETH, both halves and the holdout agree on", () => {
  const g = (edgeR: number, n = 100) => ({ n, hit: 50, hitLo: 40, hitHi: 60, baseHit: 50, meanPct: 0, meanR: edgeR, edgeR, p: 0.001 });
  const good = { is: g(0.3), oos: g(0.2, 40), btc: g(0.2), eth: g(0.4), firstHalf: g(0.3), secondHalf: g(0.3) };
  assert.equal(judge(good, 0.01, 0.05, 30).verdict, "有优势");
  assert.equal(judge({ ...good, eth: g(-0.1) }, 0.01, 0.05, 30).verdict, "无可证明的优势", "ETH disagrees");
  assert.equal(judge({ ...good, oos: g(0.05, 40) }, 0.01, 0.05, 30).verdict, "无可证明的优势", "too small out of sample");
  assert.equal(judge(good, 0.2, 0.05, 30).verdict, "无可证明的优势", "not significant after BH");
  assert.equal(judge({ ...good, is: g(0.3, 10) }, 0.01, 0.05, 30).verdict, "样本不足");
  const bad = Object.fromEntries(Object.entries(good).map(([k, v]) => [k, { ...v, edgeR: -(v.edgeR ?? 0) }])) as typeof good;
  assert.equal(judge(bad, 0.01, 0.05, 30).verdict, "比随机差");
});

test("research: random signals on random walks are almost never labelled (≤ 5%)", () => {
  const coins = { BTC: walk(20_000, 1), ETH: walk(20_000, 2) };
  const now = T0 + 20_000 * H;
  const split = makeSplit(T0, now, 120);
  const r = rng(99);
  const horizon = 24;
  const ctl: Trade[] = [];
  const data = Object.entries(coins).map(([coin, c]) => {
    const atr = ta.atr(c, 14);
    ctl.push(...controlTrades(c, atr, 1, horizon, 0.15, coin, 300));
    return { coin, c, atr };
  });
  const rows = Array.from({ length: 100 }, () => {
    const sig: Trade[] = [];
    for (const { coin, c, atr } of data) {
      const idx = Array.from({ length: c.length }, (_, i) => i).filter((i) => i >= 300 && r() < 0.01);
      sig.push(...trades(c, atr, idx, 1, horizon, 0.15, coin));
    }
    return cells(sig, ctl, split, horizon);
  });
  const q = bhAdjust(rows.map((x) => x.is.p));
  const flagged = rows.filter((x, k) => judge(x, q[k], 0.05, 30).verdict !== "无可证明的优势").length;
  assert.ok(flagged <= 5, `${flagged} of 100 random signals were labelled`);
  // and the control is what an "every bar" strategy gets: its edge against itself is zero
  assert.equal(group(ctl, ctl, horizon).edgeR, 0);
});

test("families: a copy of an indicator added to its family changes nothing; raw counting would double it", async () => {
  const { familyVotes, FAMILIES } = await import("../src/lib/ta/indicators.ts");
  const byId = new Map<string, (1 | -1 | 0)[]>([
    ["macd", [1]],
    ["roc", [1]],
    ["rsi", [-1]],
    ["mfi", [-1]],
  ]);
  const panel = { readings: [], summary: {} as never, net: [0], bullCount: [2], bearCount: [2], byId };
  const total = (fs: typeof FAMILIES) => familyVotes(panel, 0, fs).reduce((s, f) => s + f.score, 0);
  const base = total(FAMILIES);
  byId.set("macd_copy", [1]);
  const withCopy = FAMILIES.map((f) => (f.id === "impulse" ? { ...f, members: [...f.members, "macd_copy"] } : f));
  assert.equal(total(withCopy), base);
  assert.equal(base, 0, "one family for, one against: even");
  assert.equal(familyVotes(panel, 0).length, 2, "families without any enabled member are left out");
});
