import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExPosition, ExSnapshot } from "../src/lib/exchange.ts";
import { betaOf, crossLiqAt, effMmr, exLiqOf, isoLiq, liqCheck, lossAtStops, qtyForAvg, stopVsStructure, stressTest, survivableMove, whatIfAdd } from "../src/lib/ta/margin.ts";
import { maxAdd, positionOf } from "../src/lib/ta/roll.ts";

const near = (a: number | null, b: number, eps = 1e-6) => assert.ok(a != null && Math.abs(a - b) < eps, `${a} ≉ ${b}`);

const pos = (o: Partial<ExPosition>): ExPosition => ({ key: "BTC-USDT-SWAP|cross|1", instId: "BTC-USDT-SWAP", coin: "BTC", base: "BTC", dir: 1, qty: 1, avg: 100, mark: 100, liq: null, lever: 10, mode: "cross", margin: null, mmr: 0.5, upl: 0, notional: 100, side: "net", realized: null, t: null, ...o });
const snap = (positions: ExPosition[], equity: number): ExSnapshot => ({ id: "a", name: "a", ex: "okx", t: 0, equity, available: equity, frozen: 0, upl: 0, mmr: null, mgnRatio: null, posMode: "net", positions, stops: [], warnings: [] });

test("the user's screenshot: 2.17 ZEC at 1,267.46, add at 1,350 to move the average to 1,290", () => {
  near(qtyForAvg({ qty: 2.17, avg: 1267.46, price: 1350, target: 1290 }), (2.17 * 22.54) / 60);
  const w = whatIfAdd({ dir: 1, qty: 2.17, avg: 1267.46, price: 1350, add: { target: 1290 }, lever: 10, fee: 0.0005, stop: null, equity: 4120.68, available: 2244.1, budget: 82, gap: 0, liqOf: () => null })!;
  assert.equal(+w.qty.toFixed(2), 0.82);
  assert.equal(+w.margin.toFixed(1), 110.1, "0.815 ZEC × 1,350 ÷ 10 (the screenshot rounds the size to 0.82 first: 110.7)");
  near(w.avg, 1290, 1e-9);
  assert.equal(w.marginOk, true);
  // the average cannot be moved outside [avg, price]
  assert.equal(qtyForAvg({ qty: 2.17, avg: 1267.46, price: 1350, target: 1400 }), null);
  // losing side: averaging down a long at 1,200 to 1,240
  const d = whatIfAdd({ dir: 1, qty: 2.17, avg: 1267.46, price: 1200, add: { target: 1240 }, lever: 10, fee: 0, stop: 1150, equity: 4000, available: 100, budget: 80, gap: 0, liqOf: () => 1100 })!;
  near(d.avg, 1240, 1e-9);
  assert.equal(d.marginOk, false, "1.49 ZEC × 1,200 ÷ 10 ≈ 179 > 100 free");
  assert.equal(d.budgetOk, false, "3.66 ZEC × (1,150 − 1,240) ≈ −329 > 80");
  assert.deepEqual(d.problems.length, 2);
  near(d.toEven, (40 / 1200) * 100);
});

test("isolated liquidation from the position's own margin and the exchange's maintenance rate", () => {
  // margin + (P − avg)·qty = mmr·P·qty  →  P = (100 − 10) / (1 − 0.005)
  near(isoLiq({ dir: 1, qty: 1, avg: 100, margin: 10, mmr: 0.005 }), 90 / 0.995);
  near(isoLiq({ dir: -1, qty: 1, avg: 100, margin: 10, mmr: 0.005 }), 110 / 1.005);
  assert.equal(isoLiq({ dir: 1, qty: 1, avg: 100, margin: 200, mmr: 0.005 }), null, "a long backed by more than its notional");
  near(effMmr(pos({ mmr: 2, qty: 1, mark: 100 })), 0.02);
  // an isolated add brings its own margin (size × price ÷ leverage)
  const p = pos({ mode: "isolated", margin: 10, mmr: 0.5, lever: 10, key: "k" });
  const s = snap([p], 1000);
  near(exLiqOf(s, p)(2, 100, 1, 100), (200 - 20) / (2 * 0.995));
});

test("cross liquidation over the whole cross account: other contracts, isolated equity, hedge legs, an add", () => {
  // equity 50 backs one cross long of 1 at 100: 50 + (P − 100) = 0.005·P
  const one = snap([pos({})], 50);
  near(crossLiqAt(one, "BTC-USDT-SWAP|cross|1"), 50 / 0.995);
  // an isolated position's equity does not back the cross ones
  const withIso = snap([pos({}), pos({ key: "ETH|isolated|1", instId: "ETH", mode: "isolated", margin: 20, upl: 0 })], 70);
  near(crossLiqAt(withIso, "BTC-USDT-SWAP|cross|1"), 50 / 0.995);
  // another cross contract adds its maintenance margin
  const two = snap([pos({}), pos({ key: "ETH|cross|1", instId: "ETH", mark: 10, qty: 1, mmr: 0.1 })], 50);
  near(crossLiqAt(two, "BTC-USDT-SWAP|cross|1"), (0.1 - 50 + 100) / 0.995);
  // hedge: a long and a short on the same contract cancel
  assert.equal(crossLiqAt(snap([pos({}), pos({ key: "BTC-USDT-SWAP|cross|-1", dir: -1 })], 50), "BTC-USDT-SWAP|cross|1"), null);
  // adding 1 at the mark: 50 + 2(P − 100) = 0.01·P
  near(crossLiqAt(one, "BTC-USDT-SWAP|cross|1", { qty: 1, price: 100 }), 150 / 1.99);
  // against the exchange's own number
  assert.equal(liqCheck(one, { ...one.positions[0], liq: 50.3 }).estimate, false);
  assert.equal(liqCheck(one, { ...one.positions[0], liq: 45 }).estimate, true);
});

test("maxAdd on a live position: the free margin and the account-level liquidation limit it, not the account leverage", () => {
  const p = pos({});
  const s = snap([p], 50);
  const position = positionOf(1, [{ kind: "open", price: 90, qty: 1 }], 0);
  // winning side at 100 with a stop at 95: the liquidation model (~75 after one more) keeps the gap
  const lim = maxAdd({ pos: position, price: 100, stop: 95, budget: 100, mode: "cross", leverage: 10, account: 50, atr: 5, fee: 0, rules: { pyramid: 10 }, available: 30, liqOf: exLiqOf(s, p) });
  assert.equal(lim.binding, "margin");
  near(lim.qty, 3, 1e-9);
});

test("everything at its stop: covered parts at the stop, the rest to liquidation (isolated: its margin)", () => {
  const r = lossAtStops(
    [
      { dir: 1, qty: 2, avg: 100, stop: 90, covered: 1, liq: 80, mode: "cross", margin: null },
      { dir: 1, qty: 1, avg: 100, stop: null, covered: null, liq: 90, mode: "isolated", margin: 10 },
      { dir: -1, qty: 1, avg: 100, stop: null, covered: null, liq: null, mode: "cross", margin: null },
    ],
    0,
  );
  near(r.loss, 10 + 20 + 10);
  assert.equal(r.unbounded, 1);
});

test("stress test: isolated loses its margin at most, cross is wiped at its maintenance margin", () => {
  const s = snap([pos({}), pos({ key: "SOL|isolated|1", instId: "SOL", coin: "SOL", mode: "isolated", margin: 10, mark: 100, liq: 90.5, upl: 0 })], 60);
  const beta = (p: ExPosition) => (p.coin === "SOL" ? 2 : 1);
  const [down5, up5] = stressTest(s, beta, [-0.05, 0.05]);
  assert.deepEqual(down5.liquidated, ["SOL|isolated|1"], "SOL moves 2 × −5% = −10%, past its liquidation at 90.5");
  near(down5.equity, 50 - 5, 1e-9);
  assert.equal(up5.liquidated.length, 0);
  const crash = stressTest(s, beta, [-0.6])[0];
  assert.equal(crash.wiped, true);
  // the cross long alone survives down to ~49.75%: SOL's isolated liquidation comes first at −4.75%
  near(survivableMove(s, beta, -1), 0.0475, 1e-4);
  near(survivableMove(snap([pos({})], 50), () => 1, -1), 1 - 50 / 0.995 / 100, 1e-6);
});

test("beta of daily returns and the stop against the structure stop", () => {
  const btc = Array.from({ length: 60 }, (_, i) => 100 * (1 + 0.01 * Math.sin(i)));
  const alt: number[] = btc.map((_, i) => (i ? 0 : 50));
  for (let i = 1; i < btc.length; i++) alt[i] = alt[i - 1] * (1 + 2 * (btc[i] / btc[i - 1] - 1));
  near(betaOf(alt, btc), 2, 1e-9);
  assert.equal(betaOf([1, 2], [1, 2]), null, "too short");
  assert.equal(stopVsStructure(1, 99.9, 100, 10, 1)?.tone, "ok");
  assert.match(stopVsStructure(1, 105, 100, 10, 1)!.text, /近 0.5 倍 ATR/);
  assert.match(stopVsStructure(1, 85, 100, 10, 2)!.text, /远 1.5 倍 ATR：打到时多亏约 30 USDT/);
  assert.equal(stopVsStructure(1, null, 100, 10, 1), null);
});
