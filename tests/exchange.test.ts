import { test } from "node:test";
import assert from "node:assert/strict";
import { binanceReadOnly, coinFor, okxContractValues, okxReadOnly, parseBinance, parseOkx, stopOf, type ExSnapshot } from "../src/lib/exchange.ts";
import { cleanBook, exAccountOf, exGuard, holdingView, migrateMirrors, pickRollAlerts, prefKey, prefsOf, type Market, type RollBook } from "../src/lib/rollbook.ts";
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

const mkt = (price: number, o: Partial<Market> = {}): Market => ({ price, atr: 30, levels: [], swingStop: { "1": null, "-1": null }, funding: null, lastClose: null, ...o });

test("exAccountOf: the exchange account itself, stable ids, page settings by position, unlisted coins kept", () => {
  const s = okx();
  const acc = exAccountOf(s, {});
  assert.equal(acc.id, "o1");
  assert.equal(acc.exchange, "o1");
  assert.equal(acc.total, 4120.68);
  assert.equal(acc.snap, s);
  // every position, including DOGE that the site does not list
  assert.deepEqual(acc.holdings.map((h) => [h.coin, h.ex?.listed]), [["ZEC", true], ["ETH", true], ["BTC", true], ["DOGE", false]]);
  const zec = acc.holdings[0];
  assert.equal(zec.id, "o1:ZEC-USDT-SWAP|isolated|1");
  assert.equal(zec.leverage, 10);
  assert.equal(zec.ex?.sl, 1200);
  // the page's realized figure equals the exchange's (the opening fee is not counted twice)
  const v = holdingView(zec, acc, mkt(1267.56));
  assert.ok(Math.abs(v.pos.realized - -1.37) < 1e-9);
  assert.equal(v.stop, 1200);
  assert.equal(v.stopFrom, "exchange");
  assert.equal(v.liq, 1150.2);
  assert.equal(v.available, 2244.1, "the free margin limits adds");
  assert.ok(v.liqOf, "adds use the account-level liquidation model");

  // what the page sets is stored per position and survives every read
  const prefs = { [zec.id]: prefsOf({ ...zec, stop: 1210, targets: [1400], style: "bold" }) };
  const again = exAccountOf(s, prefs, { riskPct: 1, budget: "even", fee: 0.0005 });
  const z2 = again.holdings[0];
  assert.equal(z2.id, zec.id);
  assert.equal(z2.stop, 1210);
  assert.deepEqual(z2.targets, [1400]);
  assert.equal(z2.style, "bold");
  assert.equal(again.riskPct, 1);
  assert.equal(again.budget, "even");
  // the exchange's stop order still comes first
  assert.equal(holdingView(z2, again, mkt(1267)).stop, 1200);
  // a position that grew on the exchange keeps its settings (same id)
  const grown = exAccountOf({ ...s, positions: s.positions.map((p) => (p.coin === "ZEC" ? { ...p, qty: 3, avg: 1290 } : p)) }, prefs);
  assert.deepEqual(grown.holdings[0].fills.map((f) => [f.kind, f.price, f.qty]), [["open", 1290, 3]]);
  assert.equal(grown.holdings[0].stop, 1210);

  // exchange accounts are never stored with the hand-entered book
  const c = cleanBook({ accounts: [acc, { id: "m", name: "手填", total: 1000, riskPct: 2, budget: "keep", fee: 0, holdings: [{ id: "h", coin: "ETH", dir: 1, mode: "isolated", leverage: 5, fills: [{ kind: "open", price: 2000, qty: 1 }], stop: 1900, targets: [], realizedBase: 0 }] }], alert: { enabled: false, to: [], dailyCap: 30 } }, COINS);
  assert.deepEqual(c.accounts.map((a) => a.id), ["m"]);
});

test("migrateMirrors: old mirror accounts go, their position settings become prefs (old keys had no margin mode)", () => {
  const raw = {
    accounts: [
      { id: "m", name: "手填", holdings: [] },
      { id: "ex-o1", name: "okx", exchange: "o1", holdings: [
        { id: "x1", coin: "BTC", dir: 1, mode: "isolated", leverage: 20, fills: [], stop: 75000, targets: [80000], realizedBase: 0, style: "bold", ex: { key: "BTC-USDT-SWAP|1" } },
        { id: "x2", coin: "BTC", dir: -1, mode: "cross", leverage: 10, fills: [], stop: null, targets: [], realizedBase: 0, ex: { key: "BTC-USDT-SWAP|cross|-1" } },
      ] },
    ],
  };
  const m = migrateMirrors(raw)!;
  assert.deepEqual((m.accounts as { id: string }[]).map((a) => a.id), ["m"]);
  assert.deepEqual(m.prefs, { [prefKey("o1", "BTC-USDT-SWAP|isolated|1")]: { stop: 75000, targets: [80000], style: "bold" }, [prefKey("o1", "BTC-USDT-SWAP|cross|-1")]: { targets: [] } });
  assert.equal(migrateMirrors({ accounts: [{ id: "m" }] }), null, "nothing to do");
});

test("exGuard and the guard alert: no stop order, a stop beyond liquidation, partial cover; ids stay stable", () => {
  const ex = { key: "k", instId: "ETH-USDT-SWAP", liq: 1800, mark: 2000, upl: 0, margin: null, mmr: null, sl: null as number | null, covered: null as number | null, tp: null, trail: false, t: 0, listed: true };
  assert.equal(exGuard({ dir: 1, ex }, 1)?.state, "none");
  assert.equal(exGuard({ dir: 1, ex: { ...ex, sl: 1700, covered: 1 } }, 1)?.state, "beyondLiq");
  assert.equal(exGuard({ dir: 1, ex: { ...ex, sl: 1900, covered: 0.5 } }, 1)?.state, "partial");
  assert.equal(exGuard({ dir: 1, ex: { ...ex, sl: 1900, covered: 1 } }, 1)?.state, "ok");
  assert.equal(exGuard({ dir: 1 }, 1), null, "hand-entered holdings have no exchange orders to check");

  const s = okx();
  const book = (snap: ExSnapshot): RollBook => ({ accounts: [exAccountOf(snap, {})], alert: { enabled: true, to: [], dailyCap: 30 } });
  const m: Record<string, Market> = { ZEC: mkt(1267), ETH: mkt(2230), BTC: mkt(77000), DOGE: mkt(0.21) };
  // first round: the account is learnt, nothing is mailed
  const r1 = pickRollAlerts(book({ ...s, positions: s.positions.filter((p) => p.coin === "ZEC") }), m, {});
  assert.equal(r1.alerts.length, 0);
  // ETH (no stop order), BTC (stop covers half) and DOGE (not on the site, no stop order) open afterwards: all mailed at once
  const r2 = pickRollAlerts(book(s), m, r1.mem);
  assert.deepEqual(r2.alerts.filter((a) => a.kind === "guard").map((a) => a.title).sort(), ["okx · BTC 多单：止损单只覆盖一部分仓位", "okx · DOGE 多单：交易所没有止损单", "okx · ETH 空单：交易所没有止损单"]);
  // the real equity drives the account risk: BTC at its stop alone is ~11% of 4,120 USDT
  assert.ok(r2.alerts.some((a) => a.kind === "risk"));
  // the next read builds the same ids: nothing is repeated
  assert.equal(pickRollAlerts(book(s), m, r2.mem).alerts.length, 0);
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
  const hs = exAccountOf(s, {}).holdings;
  assert.equal(hs.length, 3);
  assert.equal(new Set(hs.map((h) => h.id)).size, 3, "three holdings, three ids");
  assert.deepEqual(hs.map((h) => [h.mode, h.dir, h.leverage, exGuard(h, positionQty(h))?.state]), [["isolated", 1, 20, "partial"], ["cross", 1, 10, "none"], ["cross", -1, 10, "ok"]]);
  // and the next read finds each one again
  assert.deepEqual(exAccountOf(s, {}).holdings.map((h) => h.id), hs.map((h) => h.id));
});

const positionQty = (h: RollBook["accounts"][number]["holdings"][number]) => h.fills.reduce((q, f) => q + (f.kind === "reduce" ? -f.qty : f.qty), 0);

test("a missing stop order leads the status", () => {
  const acc = exAccountOf(okx(), {});
  const eth = acc.holdings.find((h) => h.coin === "ETH")!;
  const v = holdingView(eth, acc, mkt(2230, { swingStop: { "1": null, "-1": { stop: 2300, anchor: 2280 } } }));
  assert.equal(v.status?.title, "交易所没有止损单");
  assert.equal(v.status?.tone, "bad");
});
