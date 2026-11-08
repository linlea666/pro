import { test } from "node:test";
import assert from "node:assert/strict";
import { binanceReadOnly, coinFor, okxContractValues, okxReadOnly, parseBinance, parseOkx, stopOf, type ExSnapshot } from "../src/lib/exchange.ts";
import { cleanBook, exGuard, holdingView, pickExAlerts, pickRollAlerts, reconcileBook, type Market, type RollBook } from "../src/lib/rollbook.ts";
import { binanceSign, okxSign } from "../src/lib/server/exchange.ts";

const COINS = ["BTC", "ETH", "ZEC", "1000PEPE"];

test("signatures: Binance's documented example, OKX base64 HMAC-SHA256 of ts + method + path + body", () => {
  // https://developers.binance.com/docs/derivatives/usds-margined-futures/general-info (SIGNED endpoint example)
  const q = "symbol=LTCBTC&side=BUY&type=LIMIT&timeInForce=GTC&quantity=1&price=0.1&recvWindow=5000&timestamp=1499827319559";
  assert.equal(binanceSign(q, "NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j"), "c8db56825ae71d6d79447849e617115f4a920fa2acdcab2b053c4b2838bd6b71");
  // HMAC-SHA256 with an empty key over an empty message (RFC 4231-style known value)
  assert.equal(okxSign("", "", "", "", ""), "thNnmggU2ex3L5XXeMNfxf8Wl8STcVZTxscSFEKSxa0=");
  // the method and the path with its query are part of the message
  assert.notEqual(okxSign("2026-11-09T00:00:00.000Z", "GET", "/api/v5/account/balance", "", "s"), okxSign("2026-11-09T00:00:00.000Z", "GET", "/api/v5/account/positions", "", "s"));
});

test("read-only checks refuse trading and withdrawal permissions", () => {
  assert.equal(okxReadOnly("read_only"), true);
  assert.equal(okxReadOnly("read_only,trade"), false);
  assert.equal(okxReadOnly("read_only,withdraw,trade"), false);
  assert.equal(okxReadOnly(""), false);
  assert.deepEqual(binanceReadOnly({ enableReading: true, ipRestrict: true }), { ok: true, ipRestrict: true });
  assert.equal(binanceReadOnly({ enableReading: true, enableFutures: true }).ok, false);
  assert.equal(binanceReadOnly({ enableReading: true, enableWithdrawals: true }).ok, false);
  assert.equal(binanceReadOnly({ enableReading: false }).ok, false);
});

test("coinFor maps exchange base assets to the site's coins", () => {
  assert.equal(coinFor("zec", COINS), "ZEC");
  assert.equal(coinFor("PEPE", COINS), "1000PEPE");
  assert.equal(coinFor("DOGE", COINS), null);
});

// the account in the user's screenshot: ZEC long isolated, ETH short cross, BTC long cross
const okx = (): ExSnapshot =>
  parseOkx({
    id: "o1",
    name: "okx",
    t: 1_800_000_000_000,
    config: { perm: "read_only", posMode: "net_mode", acctLv: "2" },
    balance: { totalEq: "4130", details: [{ ccy: "USDT", eq: "4120.68", availEq: "2244.1", availBal: "2300", ordFrozen: "0", upl: "35.2", mmr: "120.5", mgnRatio: "34.2" }] },
    positions: [
      { instType: "SWAP", instId: "ZEC-USDT-SWAP", posSide: "net", pos: "217", avgPx: "1267.46", markPx: "1267.56", liqPx: "1150.2", lever: "10", mgnMode: "isolated", margin: "275.04", mmr: "13.75", upl: "0.22", notionalUsd: "2750.6", realizedPnl: "-1.37", cTime: "1799990000000" },
      { instType: "SWAP", instId: "ETH-USDT-SWAP", posSide: "net", pos: "-161.5", avgPx: "2236.94733127", markPx: "2230", liqPx: "", lever: "10", mgnMode: "cross", imr: "360.1", mmr: "14.4", upl: "11.2", realizedPnl: "" },
      { instType: "SWAP", instId: "BTC-USDT-SWAP", posSide: "net", pos: "1634", avgPx: "76725.43261123", markPx: "77000", liqPx: "52000", lever: "10", mgnMode: "cross", imr: "1258", mmr: "50.3", upl: "44.8" },
      { instType: "SWAP", instId: "DOGE-USDT-SWAP", posSide: "net", pos: "10", avgPx: "0.2", markPx: "0.21", lever: "5", mgnMode: "cross", upl: "1" },
      { instType: "SWAP", instId: "BTC-USD-SWAP", posSide: "net", pos: "5", avgPx: "77000" },
      { instType: "SWAP", instId: "SOL-USDT-SWAP", posSide: "net", pos: "0", avgPx: "" },
    ],
    algos: [
      { instId: "ZEC-USDT-SWAP", ordType: "conditional", side: "sell", posSide: "net", sz: "217", closeFraction: "1", slTriggerPx: "1200", tpTriggerPx: "" },
      { instId: "BTC-USDT-SWAP", ordType: "conditional", side: "sell", posSide: "net", sz: "800", slTriggerPx: "74000", tpTriggerPx: "" },
    ],
    ctVal: okxContractValues([
      { instId: "ZEC-USDT-SWAP", ctVal: "0.01", ctValCcy: "ZEC", settleCcy: "USDT", ctType: "linear" },
      { instId: "ETH-USDT-SWAP", ctVal: "0.01", ctValCcy: "ETH", settleCcy: "USDT", ctType: "linear" },
      { instId: "BTC-USDT-SWAP", ctVal: "0.0001", ctValCcy: "BTC", settleCcy: "USDT", ctType: "linear" },
      { instId: "DOGE-USDT-SWAP", ctVal: "1000", ctValCcy: "DOGE", settleCcy: "USDT", ctType: "linear" },
      { instId: "BTC-USD-SWAP", ctVal: "100", ctValCcy: "USD", settleCcy: "BTC", ctType: "inverse" },
    ]),
    coins: COINS,
  });

test("parseOkx: equity, contracts to coins, directions, liquidation, unknown coins, stop orders", () => {
  const s = okx();
  assert.equal(s.equity, 4120.68);
  assert.equal(s.available, 2244.1);
  assert.equal(s.frozen, 0);
  assert.ok(Math.abs(s.mgnRatio! - 4120.68 / 120.5) < 1e-9);
  assert.equal(s.posMode, "net");
  assert.equal(s.positions.length, 4);
  const [zec, eth, btc, doge] = s.positions;
  assert.ok(Math.abs(zec.qty - 2.17) < 1e-12);
  assert.equal(zec.dir, 1);
  assert.equal(zec.mode, "isolated");
  assert.equal(zec.margin, 275.04);
  assert.equal(zec.liq, 1150.2);
  assert.equal(zec.coin, "ZEC");
  assert.equal(zec.t, 1799990000);
  assert.equal(eth.dir, -1);
  assert.ok(Math.abs(eth.qty - 1.615) < 1e-12);
  assert.equal(eth.liq, null);
  assert.equal(eth.realized, null);
  assert.ok(Math.abs(btc.qty - 0.1634) < 1e-12);
  assert.equal(btc.mode, "cross");
  assert.equal(doge.coin, null);
  assert.equal(doge.qty, 10000);
  // ZEC: one stop for the whole position; BTC: one covering 800 of 1634 contracts
  assert.deepEqual(stopOf(s, zec), { sl: 1200, covered: zec.qty, tp: null, trail: false });
  const b = stopOf(s, btc);
  assert.equal(b.sl, 74000);
  assert.ok(Math.abs(b.covered! - 0.08) < 1e-12);
  assert.equal(stopOf(s, eth).sl, null);
});

test("parseBinance: margin balance, hedge-mode sides, classic and algo stop orders", () => {
  const s = parseBinance({
    id: "b1",
    name: "bn",
    t: 1,
    account: {
      totalMarginBalance: "5000",
      availableBalance: "3000",
      totalOpenOrderInitialMargin: "50",
      totalUnrealizedProfit: "-20",
      totalMaintMargin: "40",
      positions: [
        { symbol: "ETHUSDT", positionSide: "LONG", positionAmt: "2", entryPrice: "2200", leverage: "5", isolated: true, isolatedWallet: "880", maintMargin: "8.8", unrealizedProfit: "-20", notional: "4380" },
        { symbol: "ETHUSDT", positionSide: "SHORT", positionAmt: "0", entryPrice: "0" },
        { symbol: "1000PEPEUSDT", positionSide: "SHORT", positionAmt: "-100000", entryPrice: "0.01", leverage: "3", isolated: false, initialMargin: "333", maintMargin: "10", unrealizedProfit: "0", notional: "-1000" },
      ],
    },
    risks: [
      { symbol: "ETHUSDT", positionSide: "LONG", markPrice: "2190", liquidationPrice: "1780.5", marginType: "isolated" },
      { symbol: "1000PEPEUSDT", positionSide: "SHORT", markPrice: "0.01", liquidationPrice: "0.03", marginType: "cross" },
    ],
    orders: [
      { symbol: "ETHUSDT", type: "STOP_MARKET", side: "SELL", positionSide: "LONG", stopPrice: "2100", closePosition: true },
      { symbol: "ETHUSDT", type: "LIMIT", side: "SELL", positionSide: "LONG", price: "2500", origQty: "1" },
      { symbol: "1000PEPEUSDT", orderType: "STOP_MARKET", side: "BUY", positionSide: "SHORT", triggerPrice: "0.012", quantity: "50000" },
    ],
    dual: true,
    coins: COINS,
  });
  assert.equal(s.equity, 5000);
  assert.equal(s.mgnRatio, 125);
  assert.equal(s.posMode, "hedge");
  assert.equal(s.positions.length, 2);
  const [eth, pepe] = s.positions;
  assert.equal(eth.dir, 1);
  assert.equal(eth.mode, "isolated");
  assert.equal(eth.liq, 1780.5);
  assert.equal(eth.margin, 880);
  assert.equal(pepe.coin, "1000PEPE");
  assert.equal(pepe.dir, -1);
  assert.equal(pepe.qty, 100000);
  assert.deepEqual(stopOf(s, eth), { sl: 2100, covered: 2, tp: null, trail: false });
  assert.deepEqual(stopOf(s, pepe), { sl: 0.012, covered: 50000, tp: null, trail: false });
});

const empty = (): RollBook => ({ accounts: [{ id: "m", name: "手填", total: 1000, riskPct: 2, budget: "keep", fee: 0.0005, holdings: [{ id: "h", coin: "ETH", dir: 1, mode: "isolated", leverage: 5, fills: [{ kind: "open", price: 2000, qty: 1 }], stop: 1900, targets: [], realizedBase: 0 }] }], alert: { enabled: true, to: [], dailyCap: 30 } });

test("reconcileBook mirrors positions, keeps page settings, follows quantity changes, drops closed ones", () => {
  const s = okx();
  const b1 = reconcileBook(empty(), [s]);
  assert.equal(b1.accounts.length, 2);
  assert.equal(b1.accounts[0].holdings.length, 1, "hand-entered account untouched");
  const ex = b1.accounts[1];
  assert.equal(ex.exchange, "o1");
  assert.equal(ex.total, 4120.68);
  assert.deepEqual(ex.holdings.map((h) => h.coin), ["ZEC", "ETH", "BTC"], "DOGE is not on the site");
  const zec = ex.holdings[0];
  assert.equal(zec.source, "exchange");
  assert.equal(zec.mode, "isolated");
  assert.equal(zec.leverage, 10);
  assert.equal(zec.ex?.sl, 1200);
  // the page's realized figure equals the exchange's (the opening fee is not counted twice)
  const v = holdingView(zec, ex, { price: 1267.56, atr: 20, levels: [], swingStop: { "1": null, "-1": null }, funding: null, lastClose: null });
  assert.ok(Math.abs(v.pos.realized - -1.37) < 1e-9);
  assert.equal(v.stop, 1200);
  assert.equal(v.stopFrom, "exchange");
  assert.equal(v.liq, 1150.2);

  // the page sets a stop, targets and a style; the next sync keeps them and the fills
  const edited: RollBook = { ...b1, accounts: b1.accounts.map((a) => (a.exchange ? { ...a, riskPct: 1, holdings: a.holdings.map((h) => (h.coin === "ZEC" ? { ...h, stop: 1210, targets: [1400], style: "bold" as const } : h)) } : a)) };
  const b2 = reconcileBook(edited, [s]);
  const z2 = b2.accounts[1].holdings.find((h) => h.coin === "ZEC")!;
  assert.equal(z2.id, zec.id);
  assert.equal(z2.stop, 1210);
  assert.deepEqual(z2.targets, [1400]);
  assert.equal(z2.style, "bold");
  assert.equal(z2.fills, edited.accounts[1].holdings[0].fills);
  assert.equal(b2.accounts[1].riskPct, 1);

  // added on the exchange: one new opening fill at the new average; ETH closed: gone
  const s3: ExSnapshot = { ...s, positions: s.positions.filter((p) => p.coin !== "ETH").map((p) => (p.coin === "ZEC" ? { ...p, qty: 3, avg: 1290 } : p)) };
  const b3 = reconcileBook(b2, [s3]);
  const z3 = b3.accounts[1].holdings.find((h) => h.coin === "ZEC")!;
  assert.deepEqual(z3.fills.map((f) => [f.kind, f.price, f.qty]), [["open", 1290, 3]]);
  assert.equal(z3.stop, 1210);
  assert.deepEqual(b3.accounts[1].holdings.map((h) => h.coin), ["ZEC", "BTC"]);

  // what the page sends back survives cleanBook with the exchange fields
  const c = cleanBook(b3, COINS);
  assert.equal(c.accounts[1].exchange, "o1");
  assert.equal(c.accounts[1].holdings[0].source, "exchange");
  assert.equal(c.accounts[1].holdings[0].ex?.key, "ZEC-USDT-SWAP|isolated|1");
});

test("exGuard and the guard alert: no stop order, a stop beyond liquidation, partial cover", () => {
  const ex = { key: "k", instId: "ETH-USDT-SWAP", liq: 1800, mark: 2000, upl: 0, margin: null, mmr: null, sl: null as number | null, covered: null as number | null, tp: null, trail: false, t: 0 };
  assert.equal(exGuard({ dir: 1, ex }, 1)?.state, "none");
  assert.equal(exGuard({ dir: 1, ex: { ...ex, sl: 1700, covered: 1 } }, 1)?.state, "beyondLiq");
  assert.equal(exGuard({ dir: 1, ex: { ...ex, sl: 1900, covered: 0.5 } }, 1)?.state, "partial");
  assert.equal(exGuard({ dir: 1, ex: { ...ex, sl: 1900, covered: 1 } }, 1)?.state, "ok");
  assert.equal(exGuard({ dir: 1 }, 1), null, "hand-entered holdings have no exchange orders to check");

  const s = okx();
  const book = reconcileBook({ accounts: [], alert: { enabled: true, to: [], dailyCap: 30 } }, [{ ...s, positions: s.positions.filter((p) => p.coin === "ZEC") }]);
  const m: Record<string, Market> = {};
  for (const c of ["ZEC", "ETH", "BTC"]) m[c] = { price: c === "ZEC" ? 1267 : c === "ETH" ? 2230 : 77000, atr: 10, levels: [], swingStop: { "1": null, "-1": null }, funding: null, lastClose: null };
  // first round: the account is learnt, nothing is mailed
  const r1 = pickRollAlerts(book, m, {});
  assert.equal(r1.alerts.length, 0);
  // ETH (no stop order) and BTC (stop covers half) open afterwards: both mailed at once as new trades
  const book2 = reconcileBook(book, [s]);
  const r2 = pickRollAlerts(book2, m, r1.mem);
  assert.deepEqual(r2.alerts.filter((a) => a.kind === "guard").map((a) => a.title.split("：")[1]).sort(), ["交易所没有止损单", "止损单只覆盖一部分仓位"]);
  // and the real equity now drives the account risk: BTC at its stop alone is ~11% of 4,120 USDT
  assert.ok(r2.alerts.some((a) => a.kind === "risk"));
  // nothing changed: no repeat
  assert.equal(pickRollAlerts(reconcileBook(book2, [s]), m, r2.mem).alerts.length, 0);
});

test("an isolated and a cross position on the same contract stay apart, each with its own stop orders", () => {
  // the user's account on 2026-11-09: hedge mode, BTC long isolated 20x, BTC long cross 10x, BTC short cross
  const s = parseOkx({
    id: "o1",
    name: "okx",
    t: 1,
    config: { perm: "read_only", posMode: "long_short_mode", acctLv: "2" },
    balance: { details: [{ ccy: "USDT", eq: "4090.88", availEq: "1000", mmr: "80" }] },
    positions: [
      { instType: "SWAP", instId: "BTC-USDT-SWAP", posSide: "long", pos: "1860", avgPx: "75891.03", markPx: "75893", liqPx: "72422.5", lever: "20", mgnMode: "isolated", margin: "705.79" },
      { instType: "SWAP", instId: "BTC-USDT-SWAP", posSide: "long", pos: "1634", avgPx: "76725.43", markPx: "75893", liqPx: "", lever: "10", mgnMode: "cross", imr: "1240.3" },
      { instType: "SWAP", instId: "BTC-USDT-SWAP", posSide: "short", pos: "1411", avgPx: "77369.6", markPx: "75893", liqPx: "", lever: "10", mgnMode: "cross", imr: "1071" },
    ],
    algos: [
      { instId: "BTC-USDT-SWAP", ordType: "conditional", tdMode: "isolated", side: "sell", posSide: "long", sz: "930", slTriggerPx: "75450" },
      { instId: "BTC-USDT-SWAP", ordType: "conditional", tdMode: "cross", side: "buy", posSide: "short", sz: "1411", closeFraction: "1", slTriggerPx: "77500" },
    ],
    ctVal: { "BTC-USDT-SWAP": 0.0001 },
    coins: COINS,
  });
  assert.equal(s.posMode, "hedge");
  assert.deepEqual(s.positions.map((p) => p.key), ["BTC-USDT-SWAP|isolated|1", "BTC-USDT-SWAP|cross|1", "BTC-USDT-SWAP|cross|-1"]);
  const [iso, cross, short] = s.positions;
  // the 75,450 stop belongs to the isolated long only, and covers half of it
  assert.equal(stopOf(s, iso).sl, 75450);
  assert.ok(Math.abs(stopOf(s, iso).covered! - 0.093) < 1e-12);
  assert.equal(stopOf(s, cross).sl, null, "the cross long has no stop order");
  assert.equal(stopOf(s, short).sl, 77500);
  const b = reconcileBook({ accounts: [], alert: { enabled: false, to: [], dailyCap: 30 } }, [s]);
  const hs = b.accounts[0].holdings;
  assert.equal(hs.length, 3);
  assert.equal(new Set(hs.map((h) => h.id)).size, 3, "three holdings, three ids");
  assert.deepEqual(hs.map((h) => [h.mode, h.dir, h.leverage, exGuard(h, positionQty(h))?.state]), [["isolated", 1, 20, "partial"], ["cross", 1, 10, "none"], ["cross", -1, 10, "ok"]]);
  // and the next sync finds each one again
  const again = reconcileBook(b, [s]).accounts[0].holdings;
  assert.deepEqual(again.map((h) => h.id), hs.map((h) => h.id));
});

const positionQty = (h: RollBook["accounts"][number]["holdings"][number]) => h.fills.reduce((q, f) => q + (f.kind === "reduce" ? -f.qty : f.qty), 0);

test("positions on coins the site does not list still get the stop-order alert; a missing stop order leads the status", () => {
  const s = okx();
  // DOGE is not on the site: no holding, but its missing stop order is checked
  const r1 = pickExAlerts([s], {});
  assert.equal(r1.alerts.length, 0, "first round only learns");
  assert.equal(pickExAlerts([s], r1.mem).alerts.length, 0, "unchanged: nothing new");
  const opened: ExSnapshot = { ...s, positions: [...s.positions, { ...s.positions[3], key: "PEPE-USDT-SWAP|cross|1", instId: "PEPE-USDT-SWAP", base: "PEPE2", coin: null }] };
  const r2 = pickExAlerts([opened], r1.mem);
  assert.deepEqual(r2.alerts.map((a) => a.title), ["okx · PEPE-USDT-SWAP 多单：交易所没有止损单"]);
  assert.ok(r2.alerts.every((a) => a.kind === "guard"));

  // a synced holding without a stop order: the status says so first, whatever the plan says
  const b = reconcileBook({ accounts: [], alert: { enabled: false, to: [], dailyCap: 30 } }, [s]);
  const acc = b.accounts[0];
  const eth = acc.holdings.find((h) => h.coin === "ETH")!;
  const v = holdingView(eth, acc, { price: 2230, atr: 30, levels: [], swingStop: { "1": null, "-1": { stop: 2300, anchor: 2280 } }, funding: null, lastClose: null });
  assert.equal(v.status?.title, "交易所没有止损单");
  assert.equal(v.status?.tone, "bad");
  assert.equal(acc.name, "okx", "the mirror is named after the exchange account");
});
