/**
 * The decision at a key level, for a live position, in USDT and against what the research found. Pure.
 *
 * - Losing side (`losingMatrix`): cut now / hold the original stop / top up within the risk budget /
 *   average down (move the stop out) / lock with an opposite position. E47 decides what is recommended.
 * - Winning side (`winningMatrix`): hold with the trailing stop / cut a third when a close fails at the next
 *   level / cut a third at the touch / add after a close beyond it (steady, aggressive). E31, E31e, E47b.
 * - `addTiers`: the most the three styles allow at the next add level; isolated aggressive adds may only
 *   use the floating profit ("house money").
 * - `mustExit` (P4): when the daily trend runs against the position: the stop that has to hold, where a bounce
 *   is the exit, and where the daily trend would turn back.
 * - `hedgePlan` (P4): what locking costs and what it does not solve.
 * Numbers describe the past; nothing here says where the price goes.
 */

import { againstBig, type BigTrend } from "./bigtrend.ts";
import { maxAdd, pnlAt, type Dir, type LiqOf, type MarginMode, type Position } from "./roll.ts";

/** What the research found (R = the first fill's risk; per trade, after costs; in-sample unless noted). */
export const RESEARCH = {
  /** E47 (2026-11-09, 10 coins, 4h, 2,039 trades): topping up a losing position against one full entry */
  e47: {
    touchHalf: 0.54, lossAfterHalf: 0.87, plus1RAfterHalf: 0.2, meanAfterHalf: -0.42,
    touchSwing: 0.33, lossAfterSwing: 0.94, plus1RAfterSwing: 0.14, meanAfterSwing: -0.71,
    scaleIn: "计划内分批补仓（到入场和止损中间、或到保护摆动点再补，碰到就补或等 1 小时转强再补，打到止损都不超过 1R）对一次满仓 −0.01 到 −0.03R / 笔，四种都不达标；最大回撤小一些（63R → 54R），因为没碰到补仓位时仓位更小。",
    average: "摊平（打到止损不走、再加一样多、止损往外挪 1R，最多两次）：−0.06R / 笔，10% 的单亏超 1.5R，最差一笔 −6.3R，最大回撤 98R（满仓 63R）。",
  },
  /** E31 / E31d / E47b: adding on a close beyond a swing */
  e31: { none: 0.16, steady: 0.22, aggressive: 0.26, aggressiveT: 1.78, ddNone: 63, ddAggressive: 102 },
  /** E31e: cutting at the levels ahead */
  e31e: { none: 0.16, touch: 0.05, close: 0.1, ddNone: 63, ddTouch: 40, ddClose: 48 },
} as const;

export type Verdict = "建议" | "可以" | "不建议" | "临时";
export interface DecisionRow {
  action: string;
  /** what this does in the good / bad scenario, USDT (null: not applicable) */
  good: number | null;
  bad: number | null;
  /** what the research says */
  hist: string;
  verdict: Verdict;
}

const fmt = (v: number) => (v >= 1000 ? Math.round(v).toLocaleString("en-US") : v >= 1 ? v.toFixed(2) : v.toPrecision(4));

/**
 * Losing side. `anchor` = the swing the structure stop protects; `budget` = USDT the whole position may lose
 * at the stop. Good scenario = back to the average; bad = the stop.
 */
export function losingMatrix(o: { dir: Dir; pos: Position; price: number; stop: number | null; anchor: number | null; fee: number; budget: number; posMode: "net" | "hedge" | null }): { zone: string; rows: DecisionRow[] } {
  const { dir: d, pos, price, stop } = o;
  const e = RESEARCH.e47;
  const now = pnlAt(pos, price, o.fee);
  const atStop = stop != null ? pnlAt(pos, stop, o.fee) : null;
  const half = stop != null ? pos.avg - d * 0.5 * Math.abs(pos.avg - stop) : null;
  const atSwing = o.anchor != null && d * (price - o.anchor) <= 0;
  const pastHalf = half != null && d * (price - half) <= 0;
  const zone = atSwing
    ? `价格已经回到止损保护的摆动点 ${fmt(o.anchor!)}：历史上走到这里的单 ${pct(e.lossAfterSwing)} 最后亏钱，之后能到 +1R 的只有 ${pct(e.plus1RAfterSwing)}（E47）。`
    : pastHalf
      ? `价格已经走过入场到止损的一半（${fmt(half!)}）：历史上走到这里的单 ${pct(e.lossAfterHalf)} 最后亏钱，之后能到 +1R 的 ${pct(e.plus1RAfterHalf)}（E47）。`
      : "还在入场附近，没有走到计划里的认错区。";
  // the top-up the budget allows at the price: the whole position at the stop loses exactly the budget
  let topUp: number | null = null;
  if (stop != null && atStop != null && d * (price - stop) > 0) {
    const room = o.budget + atStop;
    const perUnit = d * (price - stop) + o.fee * (price + stop);
    topUp = room > 0 && perUnit > 0 ? room / perUnit : 0;
  }
  const rows: DecisionRow[] = [
    { action: "现在认错，市价平掉", good: now, bad: now, hist: "亏损就定在这里，之后涨跌都和你无关。", verdict: atSwing ? "可以" : "可以" },
    {
      action: stop != null ? `守原止损 ${fmt(stop)}，不加不减` : "守止损（先挂好止损单）",
      good: 0,
      bad: atStop,
      hist: atSwing || pastHalf ? `从这里拿到原止损和现在认错，历史期望差不多（走到这里的单最后平均 ${(atSwing ? e.meanAfterSwing : e.meanAfterHalf).toFixed(2)}R，现在大约 ${stop != null && atStop ? (now / Math.abs(atStop)).toFixed(2) : "—"}R）。按计划走，不要中途改主意。` : "这就是开仓时的计划。",
      verdict: stop != null ? "建议" : "建议",
    },
    {
      action: topUp != null && topUp > 0 ? `补仓 ${topUp.toPrecision(3)}（打到止损合计仍只亏每笔风险）` : "补仓拉低均价",
      good: topUp != null && topUp > 0 ? 0 : null,
      bad: topUp != null && topUp > 0 ? -o.budget : atStop,
      hist: `${e.scaleIn}${atSwing ? `已经回到摆动点再补，94% 的单最后仍亏。` : ""}${topUp === 0 ? " 现在打到止损已经超过每笔风险，按规则没有补仓空间。" : ""}`,
      verdict: "不建议",
    },
    { action: "摊平：不认错，加仓并把止损挪远", good: null, bad: null, hist: e.average, verdict: "不建议" },
    {
      action: o.posMode === "net" ? "开反向单（单向持仓 = 减仓）" : "锁仓：开等量反向单",
      good: now,
      bad: now,
      hist: "锁仓把浮亏定在现在、推迟认错：两边都要付手续费，解锁时还要再判断一次方向，实盘里常见解锁后再亏一次。只在暂时无法盯盘、又不想现在平仓时临时用，并且事先写好解锁条件。",
      verdict: "临时",
    },
  ];
  return { zone, rows };
}

/**
 * Winning side at the next key level `level`. Good scenario = the price reaches `beyond` (the level after it,
 * or 1 ATR past it); bad = it turns and hits the stop. `addQty` = what the rules allow after a close beyond.
 */
export function winningMatrix(o: { dir: Dir; pos: Position; level: number; beyond: number; stop: number | null; fee: number; addQty: number; aggressiveQty: number }): DecisionRow[] {
  const { pos, level, beyond, stop } = o;
  const r = RESEARCH;
  const third = pos.qty / 3;
  const rest: Position = { ...pos, qty: pos.qty - third };
  const cutAt = (at: number) => pnlAt({ ...pos, qty: third }, at, o.fee);
  const withAdd = (q: number) => {
    const Q = pos.qty + q, avg = (pos.avg * pos.qty + level * q) / Q;
    const p: Position = { ...pos, qty: Q, avg };
    return { good: pnlAt(p, beyond, o.fee) - o.fee * level * q, bad: stop != null ? pnlAt(p, stop, o.fee) - o.fee * level * q : null };
  };
  const steady = withAdd(o.addQty), aggr = withAdd(o.aggressiveQty);
  return [
    { action: "拿着，止损跟着结构往前移", good: pnlAt(pos, beyond, o.fee), bad: stop != null ? pnlAt(pos, stop, o.fee) : null, hist: `不减不加：+${r.e31e.none.toFixed(2)}R / 笔，最大回撤 ${r.e31e.ddNone}R；赚的笔少但大行情拿得住（E31e）。`, verdict: "可以" },
    { action: `${fmt(level)} 收盘没站稳就减三分之一`, good: pnlAt(pos, beyond, o.fee), bad: cutAt(level) + (stop != null ? pnlAt(rest, stop, o.fee) : 0), hist: `+${r.e31e.close.toFixed(2)}R / 笔，回撤 ${r.e31e.ddClose}R：比不减平稳，比碰到就减多赚（差别不显著）。页面默认。`, verdict: "建议" },
    { action: `碰到 ${fmt(level)} 就减三分之一`, good: cutAt(level) + pnlAt(rest, beyond, o.fee), bad: cutAt(level) + (stop != null ? pnlAt(rest, stop, o.fee) : 0), hist: `+${r.e31e.touch.toFixed(2)}R / 笔，比不减少 0.11R、各段都更差；回撤最小（${r.e31e.ddTouch}R），大行情的利润砍掉六成。`, verdict: "不建议" },
    ...(o.addQty > 0 ? [{ action: `收盘站上 ${fmt(level)} 后加 ${o.addQty.toPrecision(3)}（稳健）`, good: steady.good, bad: steady.bad, hist: `滚仓 +${r.e31.steady.toFixed(2)}R / 笔 对不滚 +${r.e31.none.toFixed(2)}R（差 0.05R，不达标）：大行情拿得更重，七成加过仓的单比不滚差。`, verdict: "可以" as Verdict }] : []),
    ...(o.aggressiveQty > o.addQty ? [{ action: `收盘站上后加 ${o.aggressiveQty.toPrecision(3)}（激进）`, good: aggr.good, bad: aggr.bad, hist: `激进 +${r.e31.aggressive.toFixed(2)}R / 笔（t ${r.e31.aggressiveT}，不达标），最大回撤 ${r.e31.ddAggressive}R（不滚 ${r.e31.ddNone}R）；在随机时点加也一样多，多出来的只是仓位更大（E47b）。`, verdict: "可以" as Verdict }] : []),
  ];
}

export interface AddTier {
  name: string;
  qty: number;
  binding: string;
  margin: number;
  avg: number;
  liq: number | null;
  atStop: number;
  /** after the add, the price where the floating profit is half of what it is at the add price: cut a third there */
  giveback: number;
}

/**
 * The three styles at the add level `at` (stop `stop`): break-even rolling (budget 0), steady (budget = the
 * risk per trade, half the last fill, 3 adds), aggressive (budget = the risk per trade, as much as the last
 * fill, 5 adds). Isolated aggressive adds may only use the floating profit at `at` (the add's margin ≤ it).
 */
export function addTiers(o: { pos: Position; at: number; stop: number; budget: number; mode: MarginMode; leverage: number; account: number; atr: number | null; fee: number; available: number | null; liqOf?: LiqOf }): AddTier[] {
  const tier = (name: string, budget: number, rules: { pyramid: number; maxAdds: number }, house = false) => {
    const lim = maxAdd({ pos: o.pos, price: o.at, stop: o.stop, budget, mode: o.mode, leverage: o.leverage, account: o.account, atr: o.atr, fee: o.fee, rules, available: o.available, liqOf: o.liqOf, house });
    return { name, qty: lim.qty, binding: lim.binding, margin: (lim.qty * o.at) / Math.max(1, o.leverage), avg: lim.avg, liq: lim.liq, atStop: lim.atStop, giveback: lim.avg + 0.5 * (o.at - lim.avg) };
  };
  return [
    tier("保守：保本滚", 0, { pyramid: 1, maxAdds: 5 }),
    tier("标准：稳健", o.budget, { pyramid: 0.5, maxAdds: 3 }),
    tier(o.mode === "isolated" ? "激进：逐仓浮盈滚" : "激进：可亏一笔风险", o.budget, { pyramid: 1, maxAdds: 5 }, o.mode === "isolated"),
  ];
}

export interface MustExit {
  /** the daily trend is against the position */
  against: true;
  /** "日线下降趋势，11-05 收盘起第 4 天" */
  trend: string;
  /** the stop that has to hold now (the tighter of the stop in force and the 4-hour structure stop) */
  stop: number | null;
  /** a bounce to here that fails to close beyond it is the exit (the nearest key level between price and average) */
  exit: number | null;
  /** a daily close beyond this turns the daily trend back (unlock / re-add condition) */
  flip: number | null;
  stopBeforeLiq: boolean | null;
}

/** P4: the daily trend against the position. Null when it is not. */
export function mustExit(o: { dir: Dir; price: number; avg: number; stop: number | null; structureStop: number | null; levels: number[]; big: BigTrend | null | undefined; liq: number | null }): MustExit | null {
  if (!againstBig(o.big, o.dir)) return null;
  const d = o.dir, day = o.big!.day;
  const cands = [o.stop, o.structureStop].filter((x): x is number => x != null && d * (o.price - x) > 0);
  // the tighter one: nearest to the price on the losing side
  const stop = cands.length ? cands.sort((a, b) => d * (b - a))[0] : (o.stop ?? o.structureStop);
  const exit = o.levels.filter((x) => d * (x - o.price) > 0 && d * (o.avg - x) >= 0).sort((a, b) => d * (a - b))[0] ?? null;
  const since = day.sinceT != null ? `${new Date((day.sinceT + 8 * 3600) * 1000).toISOString().slice(5, 10)} 收盘起第 ${day.bars} 天` : "";
  return { against: true, trend: `日线${day.label}${since ? `，${since}` : ""}`, stop, exit, flip: day.flipAt, stopBeforeLiq: stop != null && o.liq != null ? d * (stop - o.liq) > 0 : null };
}

export interface HedgePlan {
  possible: boolean;
  rows: { name: string; qty: number; fees: number; margin: number; fundingDay: number; frozen: number }[];
  unlock: string;
}

/**
 * P4: locking with an opposite position on the same contract (hedge mode only; in one-way mode an opposite
 * order just reduces). Full lock freezes the open profit or loss; half lock halves the exposure. Fees are the
 * hedge leg's open and later close; funding on the same contract cancels for the locked part.
 */
export function hedgePlan(o: { dir: Dir; qty: number; avg: number; price: number; leverage: number; fee: number; funding: number | null; posMode: "net" | "hedge" | null; flip: number | null }): HedgePlan {
  const open = o.dir * (o.price - o.avg) * o.qty;
  const row = (name: string, share: number) => {
    const q = o.qty * share;
    return { name, qty: q, fees: 2 * o.fee * o.price * q, margin: (q * o.price) / Math.max(1, o.leverage), fundingDay: o.funding != null ? o.dir * o.funding * o.price * (o.qty - q) * 3 : 0, frozen: open * share };
  };
  return {
    possible: o.posMode === "hedge",
    rows: [row("全锁（等量反向）", 1), row("半锁", 0.5)],
    unlock: o.flip != null ? `解锁条件写在前面：日线收盘回到 ${fmt(o.flip)} ${o.dir > 0 ? "上方" : "下方"}（日线方向转回来）就平掉反向单；如果 3 天内没有发生，就两边一起平掉认错。` : "解锁条件写在前面：日线方向转回你这边就平掉反向单；3 天内没有发生就两边一起平掉认错。",
  };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
