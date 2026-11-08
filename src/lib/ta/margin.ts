/**
 * Margin and liquidation on the exchange's own numbers (synced accounts). Pure functions.
 *
 * - The maintenance rate of a position is what the exchange charges it now (maintenance ÷ notional),
 *   so the exchange's tiers come along; MMR (0.5%) only when the exchange gives none.
 * - Isolated: the position's own margin backs it.
 * - Cross: everything in cross backs everything in cross. The cross equity is the account equity less
 *   the isolated positions' equity; liquidation is when it falls to the cross maintenance margin. For one
 *   contract, the other contracts stay at their mark prices and every cross leg on this contract (both
 *   sides in hedge mode) moves with it.
 * The exchange's liquidation price stays the truth for the position as it is; these models answer
 * "what if": an add, a price shock. `liqCheck` says how far the model is from the exchange.
 */

import type { ExPosition, ExSnapshot } from "../exchange.ts";
import { MMR } from "./plan.ts";
import type { Dir, LiqOf } from "./roll.ts";

export const MARGIN_RULES = {
  /** the stop must sit at least this many 4-hour ATR before liquidation */
  liqGapAtr: 1,
  /** equity ÷ maintenance: below this warn, below `ratioDanger` urgent (1 = liquidation) */
  ratioWarn: 3,
  ratioDanger: 1.5,
  /** BTC moves for the stress test */
  shocks: [-0.2, -0.15, -0.1, -0.05, 0.05, 0.1, 0.15, 0.2],
  /** the account should survive this BTC move without a liquidation */
  survive: 0.15,
  /** an alt's move per BTC move when its own history is missing */
  defaultBeta: 1.2,
  /** the model's liquidation price against the exchange's: beyond this the page marks it "估算" */
  tolerance: 0.01,
} as const;

/** The maintenance rate the exchange charges this position now. */
export const effMmr = (p: Pick<ExPosition, "mmr" | "qty" | "mark">): number => (p.mmr != null && p.qty > 0 && p.mark > 0 ? p.mmr / (p.qty * p.mark) : MMR);

/** Isolated: margin + dir·(P − avg)·qty = mmr·P·qty, solved for P. Null when it cannot be liquidated. */
export function isoLiq(o: { dir: Dir; qty: number; avg: number; margin: number; mmr: number }): number | null {
  if (!(o.qty > 0) || !(o.avg > 0)) return null;
  const liq = (o.dir * o.avg * o.qty - o.margin) / (o.qty * (o.dir - o.mmr));
  return liq > 0 && Number.isFinite(liq) ? liq : null;
}

const isoEquity = (s: ExSnapshot) => s.positions.filter((p) => p.mode === "isolated").reduce((t, p) => t + (p.margin ?? 0) + p.upl, 0);

/**
 * Cross liquidation price of the contract of position `key`, optionally after adding `add.qty` at
 * `add.price` to it (the add pays `fee` and starts with the profit or loss of its price against the mark).
 */
export function crossLiqAt(s: ExSnapshot, key: string, add?: { qty: number; price: number; fee?: number }): number | null {
  const k = s.positions.find((p) => p.key === key);
  if (!k || k.mode !== "cross") return null;
  const m = k.mark;
  let equity = s.equity - isoEquity(s);
  let S = 0, R = 0, others = 0;
  for (const p of s.positions) {
    if (p.mode !== "cross") continue;
    const r = effMmr(p);
    if (p.instId === k.instId) {
      S += p.dir * p.qty;
      R += r * p.qty;
    } else others += r * p.mark * p.qty;
  }
  if (add && add.qty > 0) {
    S += k.dir * add.qty;
    R += effMmr(k) * add.qty;
    equity += k.dir * (m - add.price) * add.qty - (add.fee ?? 0) * add.price * add.qty;
  }
  // equity + S·(P − m) = others + R·P
  const den = S - R;
  if (!(Math.abs(S) > 1e-12) || Math.abs(den) < 1e-12) return null;
  const liq = (others - equity + S * m) / den;
  // only a price on the losing side of the net position is a liquidation
  return liq > 0 && Number.isFinite(liq) && Math.sign(S) * (m - liq) > 0 ? liq : null;
}

/** The model against the exchange for a position as it is. */
export function liqCheck(s: ExSnapshot, p: ExPosition): { model: number | null; diff: number | null; estimate: boolean } {
  const model = p.mode === "cross" ? crossLiqAt(s, p.key) : p.margin != null ? isoLiq({ dir: p.dir, qty: p.qty, avg: p.avg, margin: p.margin, mmr: effMmr(p) }) : null;
  if (model == null || p.liq == null) return { model, diff: null, estimate: false };
  const diff = (model - p.liq) / p.liq;
  return { model, diff, estimate: Math.abs(diff) > MARGIN_RULES.tolerance };
}

/**
 * `LiqOf` for maxAdd / previewAdd on a synced position: isolated adds bring their own margin
 * (size × price ÷ leverage); cross uses the whole cross account.
 */
export function exLiqOf(s: ExSnapshot, p: ExPosition, fee = 0): LiqOf {
  if (p.mode === "cross") return (_q, _avg, added, price) => crossLiqAt(s, p.key, { qty: added, price, fee });
  return (q, avg, added, price) => (p.margin != null ? isoLiq({ dir: p.dir, qty: q, avg, margin: p.margin + (added * price) / Math.max(1, p.lever), mmr: effMmr(p) }) : null);
}

/** The add that moves the average to `target`: adding at `price` reaches it only when target lies between them. */
export function qtyForAvg(o: { qty: number; avg: number; price: number; target: number }): number | null {
  const q = (o.qty * (o.avg - o.target)) / (o.target - o.price);
  return q > 0 && Number.isFinite(q) ? q : null;
}

export interface WhatIf {
  qty: number;
  /** margin the add takes (size × price ÷ leverage) */
  margin: number;
  avg: number;
  total: number;
  liq: number | null;
  /** whole position at the stop after the add, fees included */
  atStop: number | null;
  /** atStop as a share of equity, % (negative: a loss) */
  atStopPct: number | null;
  /** the price move back to the new average, % of the add price (how far it must go to break even) */
  toEven: number;
  /** the checks; null: not checkable */
  marginOk: boolean | null;
  budgetOk: boolean | null;
  liqOk: boolean | null;
  /** why it is red */
  problems: string[];
}

/**
 * The add calculator (the user's screenshot), both sides: add `qty` at `price`, or the size that moves
 * the average to `target`. Checks the free margin, the risk budget at the stop, and that the stop still
 * sits ≥ `gap` before liquidation.
 */
export function whatIfAdd(o: {
  dir: Dir;
  qty: number;
  avg: number;
  price: number;
  add: { qty: number } | { target: number };
  lever: number;
  fee: number;
  stop: number | null;
  equity: number;
  /** null: not known (hand-entered accounts) */
  available: number | null;
  budget: number;
  gap: number;
  liqOf: LiqOf;
}): WhatIf | null {
  const q = "qty" in o.add ? o.add.qty : qtyForAvg({ qty: o.qty, avg: o.avg, price: o.price, target: o.add.target });
  if (q == null || !(q > 0) || !(o.price > 0)) return null;
  const total = o.qty + q;
  const avg = (o.avg * o.qty + o.price * q) / total;
  const margin = (q * o.price) / Math.max(1, o.lever);
  const liq = o.liqOf(total, avg, q, o.price);
  const atStop = o.stop != null ? o.dir * (o.stop - avg) * total - o.fee * (o.price * q + o.stop * total) : null;
  const marginOk = o.available != null ? margin <= o.available : null;
  const budgetOk = atStop != null ? atStop >= -o.budget - 1e-9 : null;
  const liqOk = o.stop != null ? liq == null || o.dir * (o.stop - liq) >= o.gap : liq == null || o.dir * (o.price - liq) > o.gap;
  const problems: string[] = [];
  if (marginOk === false) problems.push(`需要保证金 ${margin.toFixed(1)} USDT，可用只有 ${o.available!.toFixed(1)}`);
  if (budgetOk === false) problems.push(`加完打到止损亏 ${Math.abs(atStop!).toFixed(0)} USDT，超过每笔风险 ${o.budget.toFixed(0)}`);
  if (!liqOk) problems.push(o.stop != null ? "加完强平价离止损太近（或在止损之前）" : "加完强平价离加仓价太近");
  return { qty: q, margin, avg, total, liq, atStop, atStopPct: atStop != null && o.equity > 0 ? (atStop / o.equity) * 100 : null, toEven: (o.dir * (avg - o.price) / o.price) * 100, marginOk, budgetOk, liqOk, problems };
}

/**
 * Every position at its stop at once. A stop order covering part of a position stops that part; the rest
 * (and a position without one) runs to liquidation: isolated loses its margin, cross has no bound of its own.
 */
export function lossAtStops(rows: { dir: Dir; qty: number; avg: number; stop: number | null; covered: number | null; liq: number | null; mode: "isolated" | "cross"; margin: number | null }[], fee: number) {
  let loss = 0, unbounded = 0;
  for (const r of rows) {
    const covered = r.stop == null ? 0 : Math.min(r.qty, r.covered ?? r.qty);
    if (covered > 0) loss += Math.max(0, -(r.dir * (r.stop! - r.avg) * covered - fee * r.stop! * covered));
    const open = r.qty - covered;
    if (open > 1e-12) {
      if (r.mode === "isolated" && r.margin != null) loss += r.margin * (open / r.qty);
      else if (r.liq != null) loss += Math.max(0, -(r.dir * (r.liq - r.avg) * open));
      else unbounded++;
    }
  }
  return { loss, unbounded };
}

export interface StressRow {
  /** BTC move, fraction */
  shock: number;
  equity: number;
  /** equity ÷ maintenance after the move; null: nothing in cross */
  ratio: number | null;
  /** positions liquidated by the move */
  liquidated: string[];
  /** the cross account is wiped out */
  wiped: boolean;
}

/**
 * BTC moves by `shock`, every coin by its beta times that. Isolated positions lose at most their equity;
 * the cross account is liquidated when its equity falls to its maintenance margin.
 */
export function stressTest(s: ExSnapshot, beta: (p: ExPosition) => number, shocks: readonly number[] = MARGIN_RULES.shocks): StressRow[] {
  return shocks.map((shock) => {
    let crossEq = s.equity - isoEquity(s), crossMaint = 0, isoEq = 0;
    const liquidated: string[] = [];
    for (const p of s.positions) {
      const px = p.mark * (1 + beta(p) * shock);
      const move = p.dir * (px - p.mark) * p.qty;
      if (p.mode === "isolated") {
        const eq = (p.margin ?? 0) + p.upl + move;
        const liq = p.liq ?? (p.margin != null ? isoLiq({ dir: p.dir, qty: p.qty, avg: p.avg, margin: p.margin, mmr: effMmr(p) }) : null);
        if (liq != null && p.dir * (px - liq) <= 0) liquidated.push(p.key);
        else isoEq += eq;
      } else {
        crossEq += move;
        crossMaint += effMmr(p) * px * p.qty;
      }
    }
    const hasCross = s.positions.some((p) => p.mode === "cross");
    const wiped = hasCross && crossEq <= crossMaint;
    if (wiped) for (const p of s.positions) if (p.mode === "cross") liquidated.push(p.key);
    return { shock, equity: (wiped ? 0 : crossEq) + isoEq, ratio: hasCross && crossMaint > 0 ? Math.max(0, crossEq) / crossMaint : null, liquidated, wiped };
  });
}

/** The largest BTC move (fraction, in the account's losing direction) the account takes without any liquidation. */
export function survivableMove(s: ExSnapshot, beta: (p: ExPosition) => number, dir: 1 | -1): number {
  const bad = (x: number) => stressTest(s, beta, [dir * x])[0].liquidated.length > 0;
  if (!s.positions.length) return 1;
  if (bad(0)) return 0;
  if (!bad(0.9)) return 0.9;
  let lo = 0, hi = 0.9;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (bad(mid)) hi = mid;
    else lo = mid;
  }
  return lo;
}

/** Beta of a coin's daily returns against BTC's over the closes given (same days, oldest first). */
export function betaOf(coin: number[], btc: number[]): number | null {
  const n = Math.min(coin.length, btc.length);
  if (n < 30) return null;
  const a = coin.slice(-n), b = btc.slice(-n);
  const ra: number[] = [], rb: number[] = [];
  for (let i = 1; i < n; i++) {
    if (a[i - 1] > 0 && b[i - 1] > 0) {
      ra.push(a[i] / a[i - 1] - 1);
      rb.push(b[i] / b[i - 1] - 1);
    }
  }
  const mean = (x: number[]) => x.reduce((t, v) => t + v, 0) / x.length;
  const ma = mean(ra), mb = mean(rb);
  let cov = 0, vb = 0;
  for (let i = 0; i < ra.length; i++) {
    cov += (ra[i] - ma) * (rb[i] - mb);
    vb += (rb[i] - mb) ** 2;
  }
  return vb > 0 ? cov / vb : null;
}

/**
 * The stop against the structure stop (the swing beyond the p80 sweep buffer), in ATR: describes, does not judge.
 * Closer than the structure stop gets swept more often (E18: two to five times in 24 hours); farther loses more.
 */
export function stopVsStructure(dir: Dir, stop: number | null, structure: number | null, atr: number | null, qty: number): { text: string; tone: "ok" | "warn" } | null {
  if (stop == null || structure == null || !(atr != null && atr > 0)) return null;
  const d = (dir * (stop - structure)) / atr;
  if (Math.abs(d) < 0.25) return { text: `止损和结构认错位 ${fmtP(structure)} 基本一致。`, tone: "ok" };
  if (d > 0) return { text: `止损比结构认错位 ${fmtP(structure)} 近 ${d.toFixed(1)} 倍 ATR：更容易被正常波动扫掉（回测 E18：近止损 24 小时内被扫是远止损的 2–5 倍，结果没有可证明的差别）。`, tone: "warn" };
  return { text: `止损比结构认错位 ${fmtP(structure)} 远 ${(-d).toFixed(1)} 倍 ATR：打到时多亏约 ${Math.round(-d * atr * qty).toLocaleString("en-US")} USDT。`, tone: "warn" };
}

const fmtP = (v: number) => (v >= 1000 ? v.toLocaleString("en-US", { maximumFractionDigits: 1 }) : v >= 1 ? v.toFixed(v >= 100 ? 2 : 3) : v.toPrecision(4));
