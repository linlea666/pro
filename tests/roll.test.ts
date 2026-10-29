import { test } from "node:test";
import assert from "node:assert/strict";
import { cutPlan, fundingCost, planSteps, liquidationPrice, maxAdd, nextAddLevel, pnlAt, positionOf, previewAdd, previewReduce, rollStatus, settlementsBetween, trimQty } from "../src/lib/ta/roll.ts";

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);

test("adds move the average, reductions keep it and close profit", () => {
  const p = positionOf(1, [
    { kind: "open", price: 2300, qty: 4 },
    { kind: "add", price: 2360, qty: 2 },
  ], 0);
  near(p.avg, 2320);
  assert.equal(p.qty, 6);
  assert.equal(p.adds, 1);
  assert.equal(p.lastAdd, 2);
  const r = positionOf(1, [
    { kind: "open", price: 2300, qty: 4 },
    { kind: "add", price: 2360, qty: 2 },
    { kind: "reduce", price: 2420, qty: 3 },
  ], 0);
  near(r.avg, 2320);
  near(r.realized, 300);
  assert.equal(r.qty, 3);
  // a short: profit when the price falls; fees come off
  const s = positionOf(-1, [{ kind: "open", price: 100, qty: 10 }, { kind: "reduce", price: 90, qty: 10 }], 0.001);
  assert.equal(s.qty, 0);
  near(s.realized, 100 - 1 - 0.9);
  near(s.fees, 1.9);
});

test("profit at a price includes the closing fee", () => {
  const p = positionOf(1, [{ kind: "open", price: 2300, qty: 4 }], 0);
  near(pnlAt(p, 2350, 0), 200);
  near(pnlAt(p, 2400, 0), 400);
  near(pnlAt(p, 2400, 0.0005), 400 - 4.8);
  near(pnlAt({ dir: -1, qty: 4, avg: 2300 }, 2250, 0), 200);
});

test("liquidation: isolated by leverage, cross by the account", () => {
  // long 10x isolated: avg·(1 − 1/L)/(1 − mmr)
  near(liquidationPrice({ dir: 1, qty: 4, avg: 2300, mode: "isolated", leverage: 10, account: 10000, mmr: 0.005 })!, (2300 * 0.9) / 0.995);
  near(liquidationPrice({ dir: -1, qty: 4, avg: 2300, mode: "isolated", leverage: 10, account: 10000, mmr: 0.005 })!, (2300 * 1.1) / 1.005);
  // cross with more in the account than the notional: a long cannot be liquidated
  assert.equal(liquidationPrice({ dir: 1, qty: 4, avg: 2300, mode: "cross", leverage: 10, account: 10000 }), null);
  // cross with 1,000 left: the loss that eats it
  const liq = liquidationPrice({ dir: 1, qty: 4, avg: 2300, mode: "cross", leverage: 10, account: 1000, mmr: 0.005 })!;
  near(1000 + (liq - 2300) * 4, 0.005 * liq * 4);
});

test("funding settlements and cost", () => {
  const h = 3600;
  assert.equal(settlementsBetween(7 * h, 17 * h), 2);
  assert.equal(settlementsBetween(8 * h, 16 * h), 1);
  assert.equal(settlementsBetween(10 * h, 9 * h), 0);
  near(fundingCost(1, 10000, 0.0001, 3), 3);
  near(fundingCost(-1, 10000, 0.0001, 3), -3);
});

test("the add limit: budget, pyramid, losing side, liquidation", () => {
  const pos = positionOf(1, [{ kind: "open", price: 2300, qty: 4 }], 0);
  const base = { pos, price: 2360, stop: 2310, budget: 200, mode: "isolated" as const, leverage: 10, account: 10000, atr: 20, fee: 0 };
  // budget alone allows (200 + 40) / 50 = 4.8; the pyramid caps at half of 4
  const a = maxAdd(base);
  assert.equal(a.binding, "pyramid");
  near(a.qty, 2);
  near(a.avg, 2320);
  near(a.atStop, -60);
  // break-even rolling: (0 + 40) / 50 = 0.8
  const b = maxAdd({ ...base, budget: 0 });
  assert.equal(b.binding, "budget");
  near(b.qty, 0.8);
  near(b.atStop, 0);
  // losing side, and a stop beyond the price
  assert.equal(maxAdd({ ...base, price: 2290 }).binding, "losing");
  assert.equal(maxAdd({ ...base, stop: 2370 }).binding, "stop");
  // high leverage puts liquidation near the stop: the gap rule caps the add
  const c = maxAdd({ ...base, leverage: 30, stop: 2280, budget: 1000, rules: { pyramid: 10 } });
  assert.equal(c.binding, "liquidation");
  assert.ok(c.liq! <= 2280 - 20 + 1e-6);
  // account leverage cap: 5 × 10,000 / 2360 − 4
  const d = maxAdd({ ...base, budget: 1e9, rules: { pyramid: 100 }, account: 10000 });
  assert.equal(d.binding, "leverage");
  near(d.qty, 50000 / 2360 - 4);
});

test("the third add is the last", () => {
  const pos = positionOf(1, [
    { kind: "open", price: 100, qty: 8 },
    { kind: "add", price: 110, qty: 4 },
    { kind: "add", price: 120, qty: 2 },
    { kind: "add", price: 130, qty: 1 },
  ], 0);
  assert.equal(pos.adds, 3);
  assert.equal(maxAdd({ pos, price: 140, stop: 125, budget: 100, mode: "cross", leverage: 5, account: 1e6, atr: 2, fee: 0 }).binding, "count");
});

test("previews of an add and a reduction", () => {
  const pos = positionOf(1, [{ kind: "open", price: 2300, qty: 4 }], 0);
  const a = previewAdd({ pos, price: 2360, qty: 2, stop: 2310, mode: "isolated", leverage: 10, account: 10000, fee: 0 });
  near(a.avg, 2320);
  near(a.atStop!, -60);
  assert.ok(a.stopBeforeLiq);
  near(a.margin!, 1392);
  const r = previewReduce(pos, 2400, 1, 0);
  near(r.realized, 100);
  assert.equal(r.left, 3);
  assert.equal(previewReduce(pos, 2400, 9, 0).qty, 4);
});

test("cuts at the levels ahead, and the next add level", () => {
  const pos = positionOf(1, [{ kind: "open", price: 2300, qty: 6 }], 0);
  const cuts = cutPlan(pos, 2410, [2380, 2520, 2600, 2250, 2700], 0);
  assert.deepEqual(cuts.map((c) => c.price), [2520, 2600]);
  near(cuts[0].qty, 2);
  near(cuts[0].realized, 440);
  near(cuts[1].left, 2);
  assert.equal(nextAddLevel(1, 2410, [2380, 2450, 2520]), 2450);
  assert.equal(nextAddLevel(-1, 2410, [2380, 2450, 2300]), 2380);
  assert.equal(nextAddLevel(1, 2410, [2380]), null);
});

test("status: most urgent first", () => {
  const pos = positionOf(1, [{ kind: "open", price: 2300, qty: 4 }], 0);
  const s = (o: Partial<Parameters<typeof rollStatus>[0]>) => rollStatus({ pos, price: 2400, stop: 2250, liq: 2080, atr: 20, cuts: [], addLevel: 2450, fee: 0, ...o });
  assert.equal(s({ liq: 2370 }).title, "离强平太近");
  assert.equal(s({ liq: 2410 }).title, "已经越过强平价");
  assert.equal(s({ stop: 2410 }).title, "已经过了止损");
  assert.equal(s({ stop: 2395 }).title, "快到止损");
  assert.equal(s({ price: 2290 }).title, "浮亏中：不加仓");
  assert.equal(s({ cuts: [{ price: 2402, qty: 1, realized: 100, left: 3 }] }).title, "到减仓位");
  assert.equal(s({ stop: 2320 }).title, "拿着，止损已保本");
  assert.equal(s({}).title, "拿着");
  assert.match(s({}).detail, /亏 200 USDT/);
});

test("quantities print with sensible decimals", () => {
  assert.equal(trimQty(0.5), "0.5");
  assert.equal(trimQty(0.0341), "0.0341");
  assert.equal(trimQty(2.12345), "2.123");
  assert.equal(trimQty(1250.4), "1,250");
});

test("plan steps: the add first, then cuts sized on the bigger position", () => {
  const pos = positionOf(-1, [{ kind: "open", price: 2380, qty: 4 }], 0);
  const s = planSteps({ pos, price: 2320, stop: 2385, add: { price: 2290, qty: 2 }, levels: [2230, 2200, 2400], fee: 0 });
  assert.deepEqual(s.map((x) => x.kind), ["add", "cut", "cut"]);
  near(s[0].avg, 2350);
  assert.equal(s[0].left, 6);
  near(s[0].atStop!, -210);
  near(s[1].qty, 2);
  near(s[1].realized, 240);
  near(s[1].closeAll, 720);
  near(s[2].banked, 240 + 300);
  near(s[2].atStop!, 540 - 70);
  assert.equal(planSteps({ pos, price: 2320, stop: 2385, add: null, levels: [2230], fee: 0 })[0].kind, "cut");
});

test("the stop an add needs: break-even means beyond the new average", async () => {
  const { stopForAdd } = await import("../src/lib/ta/roll.ts");
  const pos = positionOf(-1, [{ kind: "open", price: 2347, qty: 4 }], 0);
  const t = stopForAdd({ pos, price: 2287, qty: 4, budget: 0, fee: 0 });
  near(t, 2317);
  // with a budget the stop may sit higher for a short: 2317 + 200 / 8
  near(stopForAdd({ pos, price: 2287, qty: 4, budget: 200, fee: 0 }), 2342);
  const l = stopForAdd({ pos: positionOf(1, [{ kind: "open", price: 100, qty: 2 }], 0), price: 110, qty: 2, budget: 10, fee: 0 });
  near(l, 105 - 10 / 4);
});
