import { test } from "node:test";
import assert from "node:assert/strict";
import type { BigTrend, TfTrend } from "../src/lib/ta/bigtrend.ts";
import { addTiers, hedgePlan, losingMatrix, mustExit, winningMatrix } from "../src/lib/ta/decide.ts";
import { pnlAt, positionOf } from "../src/lib/ta/roll.ts";
import { pickRollAlerts, type Market, type RollBook } from "../src/lib/rollbook.ts";

const near = (a: number | null, b: number, eps = 1e-6) => assert.ok(a != null && Math.abs(a - b) < eps, `${a} ≉ ${b}`);
const long = positionOf(1, [{ kind: "open", price: 100, qty: 10 }], 0);

const tf = (dir: 1 | -1 | 0, o: Partial<TfTrend> = {}): TfTrend => ({ tf: "1d", dir, label: dir < 0 ? "下降趋势" : dir > 0 ? "上升趋势" : "区间", sinceT: Date.UTC(2026, 10, 5) / 1000, sincePrice: 98, bars: 4, atLeast: false, protective: 104, pierceAt: 104.5, flipAt: 105, close: 97, phase: null, ...o });
const big = (day: -1 | 0 | 1): BigTrend => ({ week: tf(1, { tf: "1w" }), day: tf(day), dir: 0 });

test("losing side: the zone from E47, holding the plan first, no top-up recommendation", () => {
  // stop 90 (1R = 100 USDT), price 94: past the halfway point (95)
  const m = losingMatrix({ dir: 1, pos: long, price: 94, stop: 90, anchor: 92, fee: 0, budget: 100, posMode: "net" });
  assert.match(m.zone, /87% 最后亏钱/);
  const [cut, hold, top, avg, lock] = m.rows;
  near(cut.good, -60);
  assert.equal(hold.verdict, "建议");
  near(hold.bad, -100);
  // the budget is already used by the stop: no room to top up
  assert.match(top.action, /补仓拉低均价/);
  assert.equal(top.verdict, "不建议");
  assert.match(top.hist, /没有补仓空间/);
  assert.equal(avg.verdict, "不建议");
  assert.match(lock.action, /单向持仓 = 减仓/);
  // at the protected swing the stronger number; with room in the budget, the top-up keeps the stop loss at the budget
  const s = losingMatrix({ dir: 1, pos: long, price: 92, stop: 90, anchor: 92, fee: 0, budget: 150, posMode: "hedge" });
  assert.match(s.zone, /94% 最后亏钱/);
  near(s.rows[2].bad, -150);
  assert.match(s.rows[2].action, /补仓 25/);
  assert.match(s.rows[4].action, /锁仓/);
});

test("winning side: hold / cut on a failed close / cut at the touch / add, in USDT for both outcomes", () => {
  const rows = winningMatrix({ dir: 1, pos: long, level: 110, beyond: 120, stop: 95, fee: 0, addQty: 3, aggressiveQty: 6 });
  assert.deepEqual(rows.map((r) => r.verdict), ["可以", "建议", "不建议", "可以", "可以"]);
  near(rows[0].good, 200);
  near(rows[0].bad, -50);
  // cut a third at the touch: 1/3 at 110 (+33.3), the rest to 120 (+133.3) or to the stop (−33.3)
  near(rows[2].good, 100 / 3 + (20 * 20) / 3);
  near(rows[2].bad, 100 / 3 - 100 / 3);
  // add 3 at 110: average 102.3, 13 to 120 = +230; to 95 = −95
  near(rows[3].good, pnlAt({ dir: 1, qty: 13, avg: (1000 + 330) / 13 }, 120, 0));
  near(rows[3].bad, pnlAt({ dir: 1, qty: 13, avg: (1000 + 330) / 13 }, 95, 0));
});

test("three add tiers; isolated aggressive adds only with the floating profit", () => {
  const base = { pos: long, at: 110, stop: 105, budget: 100, mode: "isolated" as const, leverage: 10, account: 10000, atr: 2, fee: 0, available: null };
  const [safe, steady, aggr] = addTiers(base);
  // break-even: 10 × (105 − 100) + x × (105 − 110) ≥ 0 → x ≤ 10; capped at the last fill (10)
  near(safe.qty, 10);
  // steady: half the last fill
  near(steady.qty, 5);
  // aggressive: budget allows (100 + 50) / 5 = 30, the last fill caps at 10, the floating profit (100 USDT) pays 100 × 10 / 110 ≈ 9.09
  near(aggr.qty, 1000 / 110);
  assert.equal(aggr.binding, "house");
  // the giveback price: half of the profit at the add price after the add
  near(aggr.giveback, aggr.avg + 0.5 * (110 - aggr.avg));
  // cross: no house cap
  assert.equal(addTiers({ ...base, mode: "cross" })[2].binding, "pyramid");
});

test("must exit: only against the daily trend; the tighter stop, the bounce exit, the flip back", () => {
  const o = { dir: 1 as const, price: 97, avg: 100, stop: 90, structureStop: 93, levels: [95, 98.5, 99.5, 103], liq: 85 };
  assert.equal(mustExit({ ...o, big: big(1) }), null);
  assert.equal(mustExit({ ...o, big: big(0) }), null);
  const x = mustExit({ ...o, big: big(-1) })!;
  assert.equal(x.stop, 93, "the tighter of the stop in force and the 4-hour structure stop");
  assert.equal(x.exit, 98.5, "the nearest key level between the price and the average");
  assert.equal(x.flip, 105);
  assert.equal(x.stopBeforeLiq, true);
  assert.match(x.trend, /日线下降趋势，11-05 收盘起第 4 天/);
  assert.equal(mustExit({ ...o, liq: 94, big: big(-1) })!.stopBeforeLiq, false);
});

test("hedge plan: one-way mode cannot lock; fees, frozen result and funding of full and half locks", () => {
  const h = hedgePlan({ dir: 1, qty: 10, avg: 100, price: 95, leverage: 10, fee: 0.0005, funding: 0.0001, posMode: "hedge", flip: 105 });
  assert.equal(h.possible, true);
  const [full, half] = h.rows;
  near(full.frozen, -50);
  near(full.fees, 2 * 0.0005 * 95 * 10);
  near(full.margin, 95);
  assert.equal(full.fundingDay, 0);
  near(half.frozen, -25);
  near(half.fundingDay, 0.0001 * 95 * 5 * 3);
  assert.match(h.unlock, /105(\.0+)? 上方/);
  assert.equal(hedgePlan({ dir: 1, qty: 10, avg: 100, price: 95, leverage: 10, fee: 0, funding: null, posMode: "net", flip: null }).possible, false);
});

test("the trend alert fires once when the daily trend turns against a holding", () => {
  const book: RollBook = { accounts: [{ id: "a", name: "主账户", total: 10000, riskPct: 2, budget: "keep", fee: 0, holdings: [{ id: "h", coin: "ETH", dir: 1, mode: "isolated", leverage: 5, fills: [{ kind: "open", price: 100, qty: 10 }], stop: 90, targets: [], realizedBase: 0 }] }], alert: { enabled: true, to: [], dailyCap: 30 } };
  const m = (day: -1 | 1): Record<string, Market> => ({ ETH: { price: 97, atr: 2, levels: [98.5], swingStop: { "1": { stop: 93, anchor: 95 }, "-1": null }, funding: null, lastClose: null, big: big(day) } });
  const r1 = pickRollAlerts(book, m(1), {});
  const r2 = pickRollAlerts(book, m(1), r1.mem);
  assert.equal(r2.alerts.filter((a) => a.kind === "trend").length, 0);
  const r3 = pickRollAlerts(book, m(-1), r2.mem);
  const t = r3.alerts.filter((a) => a.kind === "trend");
  assert.equal(t.length, 1);
  assert.match(t[0].title, /日线下降趋势/);
  // the 4-hour structure stop (93) is tighter than the 90 entered: against the daily trend it is the one that must hold
  assert.match(t[0].lines.join(" "), /必须守住的止损：93/);
  assert.match(t[0].lines.join(" "), /反弹到 98\.50* 一带/);
  assert.equal(pickRollAlerts(book, m(-1), r3.mem).alerts.filter((a) => a.kind === "trend").length, 0, "only once");
});
