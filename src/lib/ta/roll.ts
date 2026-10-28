/**
 * Rolling a futures position (滚仓助手): average price, profit at a price, funding, liquidation,
 * how much may be added without the whole position losing more than its budget at the stop,
 * and where to take some off. Pure functions, shared by the page and (later) the alert job.
 *
 * Nothing here predicts direction. Adding on strength only changes the shape of the result:
 * more in a long trend, less (or a small loss instead of a small gain) when it turns early.
 */

import { MMR } from "./plan.ts";

export type Dir = 1 | -1;
export type MarginMode = "isolated" | "cross";

export interface Fill {
  kind: "open" | "add" | "reduce";
  price: number;
  qty: number;
  /** unix seconds, when known */
  t?: number;
}

export interface Position {
  dir: Dir;
  qty: number;
  avg: number;
  /** closed profit after fees, USDT */
  realized: number;
  /** fees paid so far, USDT */
  fees: number;
  /** size of the latest opening or adding fill, for the pyramid rule */
  lastAdd: number;
  /** adds since the first fill */
  adds: number;
}

/** Binance USDT-M fees: maker 0.02%, taker 0.05% (as fractions). */
export const DEFAULT_FEE = { maker: 0.0002, taker: 0.0005 };

/** The rules the page applies, written into the page so a change shows. */
export const ROLL_RULES = {
  /** each add at most this share of the previous fill */
  pyramid: 0.5,
  maxAdds: 3,
  /** stop must sit at least this many ATR before liquidation after an add */
  liqGapAtr: 1,
  /** total notional / account at most this */
  maxLeverage: 5,
  /** "close to the stop" / "close to liquidation", in ATR */
  nearStopAtr: 0.5,
  nearLiqAtr: 2,
  /** at a take-profit level when within this many ATR */
  atLevelAtr: 0.25,
  /** share taken off at the first and second level ahead */
  cuts: [1 / 3, 1 / 3],
} as const;

/**
 * Replays the fills. Adds move the average; reductions keep it (Binance's rule) and close
 * profit. Every fill pays the taker fee. A reduction larger than the position closes it.
 */
export function positionOf(dir: Dir, fills: Fill[], fee = DEFAULT_FEE.taker): Position {
  let qty = 0, avg = 0, realized = 0, fees = 0, lastAdd = 0, adds = 0;
  for (const f of fills) {
    if (!(f.price > 0) || !(f.qty > 0)) continue;
    if (f.kind === "reduce") {
      const q = Math.min(f.qty, qty);
      const cost = q * f.price * fee;
      realized += dir * (f.price - avg) * q - cost;
      fees += cost;
      qty -= q;
      if (qty <= 1e-12) { qty = 0; avg = 0; lastAdd = 0; adds = 0; }
      continue;
    }
    const cost = f.qty * f.price * fee;
    realized -= cost;
    fees += cost;
    avg = (avg * qty + f.price * f.qty) / (qty + f.qty);
    qty += f.qty;
    if (f.kind === "add" && lastAdd > 0) adds++;
    lastAdd = f.qty;
  }
  return { dir, qty, avg, realized, fees, lastAdd, adds };
}

/** Open profit at `price`, after the fee to close it, USDT. */
export function pnlAt(p: Pick<Position, "dir" | "qty" | "avg">, price: number, fee = DEFAULT_FEE.taker): number {
  return p.dir * (price - p.avg) * p.qty - price * p.qty * fee;
}

/**
 * Funding still to pay over `settlements` (positive: you pay). Longs pay a positive rate,
 * shorts receive it.
 */
export const fundingCost = (dir: Dir, notional: number, rate: number, settlements: number) => dir * rate * notional * settlements;

/** How many 8-hourly funding settlements (00:00, 08:00, 16:00 UTC) fall in (from, to]. */
export function settlementsBetween(fromSec: number, toSec: number, everyH = 8): number {
  const step = everyH * 3600;
  return toSec > fromSec ? Math.max(0, Math.floor(toSec / step) - Math.floor(fromSec / step)) : 0;
}

/**
 * Liquidation price, ignoring the closing fee and funding. Isolated: the margin backing this
 * position is notional / leverage. Cross: everything in the account backs it, so `account` is
 * the wallet balance left for it (other positions' losses pull it closer). Solves
 *   collateral + dir·(liq − avg)·qty = mmr·liq·qty.
 * Null when the position cannot be liquidated (a long backed by more than its notional).
 */
export function liquidationPrice(o: { dir: Dir; qty: number; avg: number; mode: MarginMode; leverage: number; account: number; mmr?: number }): number | null {
  const mmr = o.mmr ?? MMR;
  if (!(o.qty > 0) || !(o.avg > 0)) return null;
  const collateral = o.mode === "isolated" ? (o.avg * o.qty) / Math.max(1, o.leverage) : o.account;
  const liq = (o.dir * o.avg * o.qty - collateral) / (o.qty * (o.dir - mmr));
  return liq > 0 && Number.isFinite(liq) ? liq : null;
}

export interface AddLimit {
  /** the most that may be added at `price` (0: do not add) */
  qty: number;
  /** which rule set the limit */
  binding: "budget" | "pyramid" | "liquidation" | "leverage" | "count" | "losing" | "stop";
  /** after adding `qty` */
  avg: number;
  liq: number | null;
  /** whole position at the stop after adding `qty`, fees included (negative: a loss) */
  atStop: number;
}

/**
 * How much may be added at `price` with the stop at `stop`:
 *  - only on the winning side (price beyond the average) and with the stop behind the price;
 *  - the whole position at the stop loses at most `budget` (0: must not lose), fees included;
 *  - at most ROLL_RULES.pyramid of the previous fill, at most ROLL_RULES.maxAdds adds;
 *  - the stop still sits ≥ liqGapAtr ATR before the new liquidation price;
 *  - total notional / account ≤ maxLeverage.
 */
export function maxAdd(o: {
  pos: Position;
  price: number;
  stop: number;
  budget: number;
  mode: MarginMode;
  leverage: number;
  account: number;
  atr: number | null;
  fee?: number;
  rules?: Partial<Record<keyof typeof ROLL_RULES, number>>;
}): AddLimit {
  const r: Record<"pyramid" | "maxAdds" | "liqGapAtr" | "maxLeverage", number> = { ...ROLL_RULES, ...o.rules };
  const fee = o.fee ?? DEFAULT_FEE.taker;
  const { pos, price, stop } = o;
  const d = pos.dir;
  const after = (x: number) => {
    const q = pos.qty + x;
    const avg = q > 0 ? (pos.avg * pos.qty + price * x) / q : 0;
    const liq = liquidationPrice({ dir: d, qty: q, avg, mode: o.mode, leverage: o.leverage, account: o.account });
    const atStop = d * (stop - avg) * q - fee * (price * x + stop * q);
    return { avg, liq, atStop };
  };
  const none = (binding: AddLimit["binding"]): AddLimit => ({ qty: 0, binding, ...after(0) });
  if (!(pos.qty > 0) || !(price > 0)) return none("losing");
  if (d * (price - pos.avg) <= 0) return none("losing");
  if (d * (price - stop) <= 0) return none("stop");
  if (pos.adds >= r.maxAdds) return none("count");

  // whole position at the stop: A + x·(d·(stop − price) − fee·(price + stop)) − fee·stop·qty ≥ −budget
  const a = d * (stop - pos.avg) * pos.qty - fee * stop * pos.qty;
  const lossPerUnit = Math.abs(price - stop) + fee * (price + stop);
  const limits: [AddLimit["binding"], number][] = [
    ["budget", (o.budget + a) / lossPerUnit],
    ["pyramid", r.pyramid * pos.lastAdd],
    ["leverage", o.account > 0 ? (r.maxLeverage * o.account) / price - pos.qty : Infinity],
  ];
  // liquidation moves toward the price as size grows: bisect for the largest size that keeps the gap
  const gap = (o.atr ?? 0) * r.liqGapAtr;
  const ok = (x: number) => {
    const { liq } = after(x);
    return liq == null || d * (stop - liq) >= gap;
  };
  const cap = Math.max(0, Math.min(...limits.map(([, v]) => v)));
  if (!ok(cap)) {
    let lo = 0, hi = cap;
    if (!ok(0)) hi = 0;
    for (let i = 0; i < 60 && hi > 0; i++) {
      const mid = (lo + hi) / 2;
      if (ok(mid)) lo = mid;
      else hi = mid;
    }
    limits.push(["liquidation", lo]);
  }
  let best = limits[0];
  for (const l of limits) if (l[1] < best[1]) best = l;
  const qty = Math.max(0, best[1]);
  return { qty, binding: best[0], ...after(qty) };
}

/** What adding `qty` at `price` does, without any rule: for the page's free preview. */
export function previewAdd(o: { pos: Position; price: number; qty: number; stop: number | null; mode: MarginMode; leverage: number; account: number; fee?: number }) {
  const fee = o.fee ?? DEFAULT_FEE.taker;
  const pos = positionOf(o.pos.dir, [
    { kind: "open", price: o.pos.avg, qty: o.pos.qty },
    { kind: "add", price: o.price, qty: o.qty },
  ], 0);
  const liq = liquidationPrice({ dir: pos.dir, qty: pos.qty, avg: pos.avg, mode: o.mode, leverage: o.leverage, account: o.account });
  const atStop = o.stop == null ? null : pos.dir * (o.stop - pos.avg) * pos.qty - fee * (o.price * o.qty + o.stop * pos.qty);
  const stopBeforeLiq = o.stop == null || liq == null || pos.dir * (o.stop - liq) > 0;
  return { qty: pos.qty, avg: pos.avg, liq, atStop, stopBeforeLiq, margin: o.mode === "isolated" ? (pos.avg * pos.qty) / Math.max(1, o.leverage) : null };
}

/** What taking `qty` off at `price` does: closed profit (after fee) and what is left. */
export function previewReduce(pos: Position, price: number, qty: number, fee = DEFAULT_FEE.taker) {
  const q = Math.min(Math.max(0, qty), pos.qty);
  return { qty: q, realized: pos.dir * (price - pos.avg) * q - price * q * fee, left: pos.qty - q, avg: pos.avg };
}

export interface Cut {
  price: number;
  qty: number;
  /** closed profit of this cut, after fee */
  realized: number;
  left: number;
}

/**
 * Take-profit cuts at the first levels ahead of the price (resistance for a long, support for
 * a short): ROLL_RULES.cuts of the position at each, the rest follows the trailing stop.
 * The levels are places a move may stall, not targets.
 */
export function cutPlan(pos: Position, price: number, levels: number[], fee = DEFAULT_FEE.taker, shares: readonly number[] = ROLL_RULES.cuts): Cut[] {
  const ahead = levels.filter((l) => pos.dir * (l - price) > 0 && pos.dir * (l - pos.avg) > 0).sort((a, b) => pos.dir * (a - b));
  const out: Cut[] = [];
  let left = pos.qty;
  for (let i = 0; i < shares.length && i < ahead.length; i++) {
    const q = pos.qty * shares[i];
    if (q > left) break;
    left -= q;
    out.push({ price: ahead[i], qty: q, realized: pos.dir * (ahead[i] - pos.avg) * q - ahead[i] * q * fee, left });
  }
  return out;
}

/** The next level the price would have to close beyond before an add (resistance for a long). */
export const nextAddLevel = (dir: Dir, price: number, levels: number[]): number | null =>
  levels.filter((l) => dir * (l - price) > 0).sort((a, b) => dir * (a - b))[0] ?? null;

export type Tone = "good" | "wait" | "warn" | "bad";

/**
 * The one-line state of a position, most urgent first:
 * liquidation near → past the stop → near the stop → losing → at a cut → stop locks profit → hold.
 */
export function rollStatus(o: {
  pos: Position;
  price: number;
  stop: number | null;
  liq: number | null;
  atr: number | null;
  cuts: Cut[];
  addLevel: number | null;
  fee?: number;
}): { tone: Tone; title: string; detail: string } {
  const { pos, price, stop, liq } = o;
  const d = pos.dir;
  const atr = o.atr && o.atr > 0 ? o.atr : price * 0.01;
  const f = (v: number) => (v >= 1000 ? Math.round(v).toLocaleString("en-US") : v >= 1 ? v.toFixed(2) : v.toPrecision(4));
  const money = (v: number) => `${v >= 0 ? "" : "−"}${Math.abs(Math.round(v)).toLocaleString("en-US")} USDT`;
  if (!(pos.qty > 0)) return { tone: "wait", title: "没有持仓", detail: "这笔已经全部平掉了。" };
  if (liq != null && d * (price - liq) < ROLL_RULES.nearLiqAtr * atr)
    return { tone: "bad", title: "离强平太近", detail: `强平价 ${f(liq)}，离现价不到 ${ROLL_RULES.nearLiqAtr} 倍 ATR。先减仓或补保证金。` };
  if (stop != null && d * (price - stop) <= 0)
    return { tone: "bad", title: "已经过了止损", detail: `止损 ${f(stop)} 已被越过，按计划应该离场。` };
  if (stop != null && d * (price - stop) < ROLL_RULES.nearStopAtr * atr)
    return { tone: "warn", title: "快到止损", detail: `离止损 ${f(stop)} 不到 ${ROLL_RULES.nearStopAtr} 倍 ATR。打到止损${moneyAt(pos, stop, o.fee, money)}。` };
  if (d * (price - pos.avg) <= 0)
    return { tone: "warn", title: "浮亏中：不加仓", detail: stop != null ? `守住止损 ${f(stop)}。亏损的单不加仓摊平。` : "还没有填止损：先定好认错的位置。" };
  const at = o.cuts.find((c) => Math.abs(c.price - price) < ROLL_RULES.atLevelAtr * atr || d * (price - c.price) > 0);
  if (at) return { tone: "good", title: "到减仓位", detail: `${f(at.price)} 一带可以减 ${trimQty(at.qty)}，减完落袋 ${money(at.realized)}。` };
  const locked = stop != null && pnlAt(pos, stop, o.fee) >= 0;
  const next =
    o.addLevel != null ? `等 ${f(o.addLevel)} 收盘站上再看加仓。` : o.cuts.length ? `前方 ${f(o.cuts[0].price)} 一带先减一部分，剩下按移动认错位拿着。` : "前方没有关键位，按移动认错位拿着。";
  if (locked) return { tone: "good", title: "拿着，止损已保本", detail: `打到止损${moneyAt(pos, stop!, o.fee, money)}。${next}` };
  return { tone: "good", title: "拿着", detail: stop != null ? `打到止损${moneyAt(pos, stop, o.fee, money)}。${next}` : `还没有填止损。${next}` };
}

function moneyAt(pos: Position, stop: number, fee: number | undefined, money: (v: number) => string) {
  const v = pnlAt(pos, stop, fee);
  return v >= 0 ? `也赚 ${money(v)}` : `亏 ${money(-v)}`;
}

/** A quantity with sensible decimals: 0.5, 0.034, 1,250. */
export function trimQty(q: number): string {
  if (!(q > 0)) return "0";
  if (q >= 1000) return Math.round(q).toLocaleString("en-US");
  if (q >= 1) return String(Math.round(q * 1000) / 1000);
  return q.toPrecision(3).replace(/\.?0+$/, "");
}
