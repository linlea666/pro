/**
 * 交易所账户（只读）：OKX / Binance U 本位合约的余额、持仓和止损挂单，统一成一份快照。
 * 这里只有类型和把交易所原始返回解析成快照的纯函数；签名请求在 server/exchange/。
 * 数量一律换算成币（OKX 是张数 × ctVal），价格和金额都是 USDT。
 */

import type { Dir, MarginMode } from "./ta/roll.ts";

export type ExchangeId = "okx" | "binance";
export const EXCHANGE_NAME: Record<ExchangeId, string> = { okx: "欧易 OKX", binance: "币安 Binance" };

export interface ExPosition {
  /** `<instId>|<dir>`: the same position across syncs (a net position that flips side is a new one) */
  key: string;
  instId: string;
  /** the site's coin id, null when the coin is not on the site */
  coin: string | null;
  base: string;
  dir: Dir;
  /** coins */
  qty: number;
  avg: number;
  mark: number;
  /** the exchange's own liquidation price; null when it shows none */
  liq: number | null;
  lever: number;
  mode: MarginMode;
  /** isolated margin (or the cross initial margin), USDT */
  margin: number | null;
  /** maintenance margin, USDT */
  mmr: number | null;
  upl: number;
  notional: number;
  side: "net" | "long" | "short";
  realized: number | null;
  /** opened, unix seconds */
  t: number | null;
}

export interface ExStop {
  instId: string;
  /** the position it closes */
  dir: Dir;
  /** stop-loss trigger */
  sl: number | null;
  /** take-profit trigger */
  tp: number | null;
  /** coins; null: closes the whole position */
  qty: number | null;
  trail: boolean;
}

export interface ExSnapshot {
  id: string;
  name: string;
  ex: ExchangeId;
  /** ms */
  t: number;
  /** USDT equity (wallet + unrealized) */
  equity: number;
  /** available to open */
  available: number;
  /** held by open orders */
  frozen: number;
  upl: number;
  /** account maintenance margin, USDT (null when the exchange does not give it) */
  mmr: number | null;
  /**
   * equity ÷ maintenance margin, the same for both exchanges (liquidation at 1×). OKX shows this ratio
   * as its 保证金率; Binance shows the inverse (maintenance ÷ margin balance) as its 保证金比率.
   */
  mgnRatio: number | null;
  posMode: "net" | "hedge";
  positions: ExPosition[];
  stops: ExStop[];
  warnings: string[];
}

const n = (x: unknown): number => {
  const v = typeof x === "number" ? x : parseFloat(String(x ?? ""));
  return Number.isFinite(v) ? v : 0;
};
const nOrNull = (x: unknown): number | null => {
  if (x === "" || x == null) return null;
  const v = n(x);
  return v > 0 ? v : null;
};

/** The site's coin for an exchange base asset: BTC → BTC; PEPE → 1000PEPE when only that is listed. */
export function coinFor(base: string, coins: string[]): string | null {
  const b = base.toUpperCase();
  if (coins.includes(b)) return b;
  return coins.find((c) => c === `1000${b}` || `1000${c}` === b) ?? null;
}

// ---------------------------------------------------------------- OKX

export interface OkxInstrument {
  instId: string;
  ctVal: string;
  ctValCcy: string;
  settleCcy: string;
  ctType: string;
}

/** contract value in coins per contract, for the USDT-settled linear swaps */
export function okxContractValues(list: OkxInstrument[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of list) if (i.settleCcy === "USDT" && i.ctType === "linear" && n(i.ctVal) > 0) out[i.instId] = n(i.ctVal);
  return out;
}

/** `perm` from /api/v5/account/config: only "read_only" is accepted */
export function okxReadOnly(perm: string): boolean {
  const p = perm.split(",").map((x) => x.trim()).filter(Boolean);
  return p.length > 0 && p.every((x) => x === "read_only");
}

type Raw = Record<string, unknown>;

export function parseOkx(input: {
  id: string;
  name: string;
  t: number;
  config: Raw;
  balance: Raw;
  positions: Raw[];
  algos: Raw[];
  ctVal: Record<string, number>;
  coins: string[];
}): ExSnapshot {
  const warnings: string[] = [];
  const posMode = input.config.posMode === "long_short_mode" ? "hedge" : "net";
  const lv = String(input.config.acctLv ?? "");
  if (lv === "1") warnings.push("这个账户是“简单交易模式”，不能做合约。");
  if (lv === "4") warnings.push("这个账户是“组合保证金模式”，强平按整个组合计算，这里的推演只是近似，以交易所为准。");
  const usdt = ((input.balance.details as Raw[] | undefined) ?? []).find((d) => d.ccy === "USDT") ?? {};
  const multi = lv === "3" || lv === "4";
  // single-currency margin: the USDT line is the account; multi-currency: the account-level adjusted equity
  const equity = multi ? n(input.balance.adjEq) || n(input.balance.totalEq) : n(usdt.eq);
  const positions: ExPosition[] = [];
  for (const p of input.positions) {
    const instId = String(p.instId ?? "");
    if (p.instType !== "SWAP" || !instId.endsWith("-USDT-SWAP")) continue;
    const ct = input.ctVal[instId];
    const pos = n(p.pos);
    if (!ct) {
      if (pos) warnings.push(`${instId} 缺少合约面值，暂时跳过。`);
      continue;
    }
    if (!pos) continue;
    const side = (p.posSide === "long" || p.posSide === "short" ? p.posSide : "net") as ExPosition["side"];
    const dir: Dir = side === "long" ? 1 : side === "short" ? -1 : pos > 0 ? 1 : -1;
    const qty = Math.abs(pos) * ct;
    const mark = n(p.markPx);
    const base = instId.split("-")[0];
    const mode: MarginMode = p.mgnMode === "isolated" ? "isolated" : "cross";
    positions.push({
      key: `${instId}|${dir}`,
      instId,
      coin: coinFor(base, input.coins),
      base,
      dir,
      qty,
      avg: n(p.avgPx),
      mark,
      liq: nOrNull(p.liqPx),
      lever: n(p.lever) || 1,
      mode,
      margin: mode === "isolated" ? nOrNull(p.margin) : nOrNull(p.imr),
      mmr: nOrNull(p.mmr),
      upl: n(p.upl),
      notional: n(p.notionalUsd) || qty * mark,
      side,
      realized: p.realizedPnl != null && p.realizedPnl !== "" ? n(p.realizedPnl) : null,
      t: n(p.cTime) ? Math.floor(n(p.cTime) / 1000) : null,
    });
  }
  const stops: ExStop[] = [];
  for (const a of input.algos) {
    const instId = String(a.instId ?? "");
    const ct = input.ctVal[instId];
    if (!ct) continue;
    // the position it closes: hedge mode names it; net mode closes the side opposite to the order
    const dir: Dir = a.posSide === "long" ? 1 : a.posSide === "short" ? -1 : a.side === "sell" ? 1 : -1;
    const whole = a.closeFraction === "1" || a.closeFraction === 1 || !n(a.sz);
    const trail = a.ordType === "move_order_stop";
    // a trailing stop has no fixed trigger until it activates: show its activation price if any
    const sl = trail ? nOrNull(a.activePx) ?? nOrNull(a.triggerPx) : nOrNull(a.slTriggerPx);
    stops.push({ instId, dir, sl, tp: trail ? null : nOrNull(a.tpTriggerPx), qty: whole ? null : n(a.sz) * ct, trail });
  }
  const mmr = multi ? nOrNull(input.balance.mmr) : nOrNull(usdt.mmr);
  return {
    id: input.id,
    name: input.name,
    ex: "okx",
    t: input.t,
    equity,
    available: n(usdt.availEq) || n(usdt.availBal),
    frozen: n(usdt.ordFrozen),
    upl: n(usdt.upl),
    mmr,
    mgnRatio: mmr != null && equity > 0 ? equity / mmr : null,
    posMode,
    positions,
    stops,
    warnings,
  };
}

// ---------------------------------------------------------------- Binance

/** /sapi/v1/account/apiRestrictions: reading only, no trading of any kind, no withdrawals */
export function binanceReadOnly(r: Raw): { ok: boolean; ipRestrict: boolean } {
  const banned = ["enableWithdrawals", "enableFutures", "enableSpotAndMarginTrading", "enableMargin", "enableVanillaOptions", "enableInternalTransfer", "enablePortfolioMarginTrading", "permitsUniversalTransfer"];
  return { ok: r.enableReading === true && banned.every((k) => r[k] !== true), ipRestrict: r.ipRestrict === true };
}

const STOP_TYPES = new Set(["STOP_MARKET", "STOP", "TRAILING_STOP_MARKET"]);
const TP_TYPES = new Set(["TAKE_PROFIT_MARKET", "TAKE_PROFIT"]);

export function parseBinance(input: { id: string; name: string; t: number; account: Raw; risks: Raw[]; orders: Raw[]; dual: boolean; coins: string[] }): ExSnapshot {
  const warnings: string[] = [];
  const risk = new Map(input.risks.map((r) => [`${r.symbol}|${r.positionSide}`, r]));
  const positions: ExPosition[] = [];
  for (const p of (input.account.positions as Raw[] | undefined) ?? []) {
    const amt = n(p.positionAmt);
    const symbol = String(p.symbol ?? "");
    if (!amt || !symbol.endsWith("USDT")) continue;
    const r = risk.get(`${symbol}|${p.positionSide}`) ?? {};
    const side = (p.positionSide === "LONG" ? "long" : p.positionSide === "SHORT" ? "short" : "net") as ExPosition["side"];
    const dir: Dir = side === "long" ? 1 : side === "short" ? -1 : amt > 0 ? 1 : -1;
    const base = symbol.slice(0, -4);
    const qty = Math.abs(amt);
    const mark = n(r.markPrice) || Math.abs(n(p.notional)) / qty;
    const isolated = p.isolated === true || r.marginType === "isolated";
    positions.push({
      key: `${symbol}|${dir}`,
      instId: symbol,
      coin: coinFor(base, input.coins),
      base,
      dir,
      qty,
      avg: n(p.entryPrice) || n(r.entryPrice),
      mark,
      liq: nOrNull(r.liquidationPrice),
      lever: n(p.leverage) || n(r.leverage) || 1,
      mode: isolated ? "isolated" : "cross",
      margin: isolated ? nOrNull(p.isolatedWallet) ?? nOrNull(r.isolatedMargin) : nOrNull(p.initialMargin),
      mmr: nOrNull(p.maintMargin),
      upl: n(p.unrealizedProfit),
      notional: Math.abs(n(p.notional)) || qty * mark,
      side,
      realized: null,
      t: n(p.updateTime) ? Math.floor(n(p.updateTime) / 1000) : null,
    });
  }
  const stops: ExStop[] = [];
  for (const o of input.orders) {
    // the classic open orders and the newer algo (conditional) orders name their fields differently
    const type = String(o.type ?? o.orderType ?? o.algoType ?? "");
    const isStop = STOP_TYPES.has(type), isTp = TP_TYPES.has(type);
    if (!isStop && !isTp) continue;
    const reduce = o.reduceOnly === true || o.closePosition === true || o.closePosition === "true" || input.dual;
    if (!reduce) continue;
    const symbol = String(o.symbol ?? "");
    const dir: Dir = o.positionSide === "LONG" ? 1 : o.positionSide === "SHORT" ? -1 : o.side === "SELL" ? 1 : -1;
    const trigger = nOrNull(o.stopPrice) ?? nOrNull(o.triggerPrice) ?? nOrNull(o.activatePrice);
    const whole = o.closePosition === true || o.closePosition === "true";
    const qty = n(o.origQty) || n(o.quantity);
    stops.push({ instId: symbol, dir, sl: isStop ? trigger : null, tp: isTp ? trigger : null, qty: whole || !qty ? null : qty, trail: type === "TRAILING_STOP_MARKET" });
  }
  const margin = n(input.account.totalMarginBalance);
  const maint = nOrNull(input.account.totalMaintMargin);
  return {
    id: input.id,
    name: input.name,
    ex: "binance",
    t: input.t,
    equity: margin,
    available: n(input.account.availableBalance),
    frozen: n(input.account.totalOpenOrderInitialMargin),
    upl: n(input.account.totalUnrealizedProfit),
    mmr: maint,
    mgnRatio: maint != null && margin > 0 ? margin / maint : null,
    posMode: input.dual ? "hedge" : "net",
    positions,
    stops,
    warnings,
  };
}

/**
 * The stop orders protecting one position: the tightest stop-loss and how much of the position the
 * stop orders cover (null qty = the whole position).
 */
export function stopOf(s: ExSnapshot, p: ExPosition): { sl: number | null; covered: number | null; tp: number | null; trail: boolean } {
  const mine = s.stops.filter((x) => x.instId === p.instId && x.dir === p.dir);
  const sls = mine.filter((x) => x.sl != null);
  if (!sls.length) return { sl: null, covered: null, tp: mine.find((x) => x.tp != null)?.tp ?? null, trail: false };
  // tightest = closest to the price on the losing side
  const sl = sls.map((x) => x.sl!).sort((a, b) => p.dir * (b - a))[0];
  const covered = sls.some((x) => x.qty == null) ? p.qty : Math.min(p.qty, sls.reduce((t, x) => t + (x.qty ?? 0), 0));
  return { sl, covered, tp: mine.find((x) => x.tp != null)?.tp ?? null, trail: sls.some((x) => x.trail) };
}
