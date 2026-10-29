import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanBook, pickRollAlerts, rollMailText, type Market, type RollBook } from "../src/lib/rollbook.ts";

const book = (over: Partial<RollBook["accounts"][number]["holdings"][number]> = {}): RollBook => ({
  accounts: [
    {
      id: "a1",
      name: "主账户",
      total: 10000,
      riskPct: 2,
      budget: "keep",
      fee: 0,
      holdings: [{ id: "h1", coin: "ETH", dir: 1, mode: "isolated", leverage: 10, fills: [{ kind: "open", price: 2300, qty: 4 }], stop: 2250, targets: [2400], realizedBase: 0, ...over }],
    },
  ],
  alert: { enabled: true, to: [], dailyCap: 30 },
});
const mk = (price: number, o: Partial<Market> = {}): Record<string, Market> => ({
  ETH: { price, atr: 20, levels: [2360, 2450], swingStop: { "1": null, "-1": null }, funding: null, lastClose: { t: 1000, c: price, prev: price }, ...o },
});

test("cleanBook keeps known coins, drops examples and bad fills, checks recipients", () => {
  const b = cleanBook(
    {
      accounts: [{ id: "x", name: "A", total: 5000, riskPct: 2, budget: "even", fee: 0.0005, holdings: [
        { id: "1", coin: "ETH", dir: 1, mode: "cross", leverage: 5, fills: [{ kind: "open", price: 100, qty: 1 }, { kind: "bogus", price: 1, qty: 1 }], stop: 90, targets: [120, -1], realizedBase: 0 },
        { id: "2", coin: "NOPE", dir: 1, fills: [{ kind: "open", price: 1, qty: 1 }] },
        { id: "3", coin: "ETH", dir: 1, fills: [{ kind: "open", price: 1, qty: 1 }], example: true },
      ] }],
      alert: { enabled: true, to: ["a@b.co"], dailyCap: 999 },
    },
    ["BTC", "ETH"],
  );
  assert.equal(b.accounts[0].holdings.length, 1);
  assert.equal(b.accounts[0].holdings[0].fills.length, 1);
  assert.deepEqual(b.accounts[0].holdings[0].targets, [120]);
  assert.equal(b.accounts[0].budget, "even");
  assert.equal(b.alert.dailyCap, 30);
  assert.throws(() => cleanBook({ alert: { to: ["not-mail"] } }, ["ETH"]), /收件邮箱/);
});

test("the first round only records", () => {
  const r = pickRollAlerts(book(), mk(2340), {});
  assert.equal(r.alerts.length, 0);
  assert.equal(r.mem.h1.price, 2340);
});

test("crossing a target and the stop getting close", () => {
  const { mem } = pickRollAlerts(book(), mk(2390), {});
  const r = pickRollAlerts(book(), mk(2405), mem);
  assert.deepEqual(r.alerts.map((a) => a.kind), ["target"]);
  assert.match(r.alerts[0].lines[0], /\+400 USDT/);
  // the same state again: nothing new
  assert.equal(pickRollAlerts(book(), mk(2406), r.mem).alerts.length, 0);
  const near = pickRollAlerts(book({ stop: 2400 }), mk(2405), r.mem);
  assert.ok(near.alerts.some((a) => a.kind === "stop" && a.title.includes("快到止损")));
});

test("an add after a 4-hour close beyond a level, once per bar", () => {
  const b = book({ stop: 2320 });
  const { mem } = pickRollAlerts(b, mk(2350, { lastClose: { t: 1000, c: 2350, prev: 2340 } }), {});
  const r = pickRollAlerts(b, mk(2370, { lastClose: { t: 2000, c: 2370, prev: 2350 } }), mem);
  const add = r.alerts.find((a) => a.kind === "add");
  assert.ok(add, "add alert");
  assert.match(add!.title, /2,360/);
  assert.match(add!.lines[0], /最多加 2/);
  assert.equal(pickRollAlerts(b, mk(2372, { lastClose: { t: 2000, c: 2370, prev: 2350 } }), r.mem).alerts.filter((a) => a.kind === "add").length, 0);
});

test("account risk over the line fires when it starts", () => {
  const b = book({ stop: 2200 }); // 400 at the stop: 4%
  const { mem } = pickRollAlerts(b, mk(2340), {});
  b.accounts[0].total = 5000; // now 8%
  const r = pickRollAlerts(b, mk(2340), mem);
  assert.ok(r.alerts.some((a) => a.kind === "risk"));
});

test("mail text", () => {
  const { subject, text } = rollMailText([{ key: "k", kind: "target", title: "主账户 · ETH 多单：到了你填的价位 2,400", lines: ["x"] }], "http://1.2.3.4:3000");
  assert.match(subject, /滚仓提醒/);
  assert.match(text, /\/roll/);
});

test("a holding that confirms adds on 1-hour closes reads those, and cleanBook keeps the choice", () => {
  const b = book({ stop: 2320, confirmTf: "1h" });
  assert.equal(cleanBook(b, ["ETH"]).accounts[0].holdings[0].confirmTf, "1h");
  const four = { lastClose: { t: 1000, c: 2350, prev: 2340 } };
  const { mem } = pickRollAlerts(b, mk(2350, { ...four, closes: { "1h": { t: 500, c: 2350, prev: 2340 } } }), {});
  // the 4-hour bar has not closed again, the hour has
  const r = pickRollAlerts(b, mk(2370, { ...four, closes: { "1h": { t: 600, c: 2370, prev: 2350 } } }), mem);
  const add = r.alerts.find((a) => a.kind === "add");
  assert.ok(add, "add alert");
  assert.match(add!.title, /1 小时收盘站上 2,360/);
});

test("the giveback alert: only when switched on, once per best price", () => {
  const b = book({ giveback: true, stop: 2250, targets: [] });
  let { mem } = pickRollAlerts(b, mk(2300), {});
  ({ mem } = pickRollAlerts(b, mk(2380), mem)); // best 2380: 80 beyond the average, 4 ATR
  assert.equal(mem.h1.best, 2380);
  const r = pickRollAlerts(b, mk(2335), mem); // keeps 35 of 80
  const g = r.alerts.find((a) => a.kind === "giveback");
  assert.ok(g, "giveback alert");
  assert.match(g!.lines[0], /减 1\.333/);
  assert.equal(pickRollAlerts(b, mk(2330), r.mem).alerts.filter((a) => a.kind === "giveback").length, 0);
  assert.equal(pickRollAlerts(book({ targets: [] }), mk(2335), mem).alerts.filter((a) => a.kind === "giveback").length, 0);
});
