/**
 * The accumulation planner (攒币计划) of the 现货囤币 page, ported from research E23b and generalized.
 * Pure: no database, no network, no Node-only imports; the page runs `replay` in the browser.
 *
 * A plan splits a budget (USD) into three buckets:
 *   - DCA: equal weekly buys over the horizon (round(horizonDays / 7) buys, the first one today);
 *   - ladder: limit orders from the head price down to the floor price, weighted equal / pyramid / custom;
 *     anti-FOMO: if the price runs more than fomoPct above the head while ladder money is left, the rest is
 *     spread over fomoWeeks weekly buys; whatever is still unfilled at the horizon is bought then;
 *   - reserve: bought the first day the reserve signal fires (price under the 200-week average or MVRV < 1),
 *     otherwise at the horizon.
 * Every buy pays STACK_FEE.
 */

import type { PriceRef } from "./valuation.ts";

export const STACK_FEE = 0.001;

export type StackShape = "equal" | "pyramid" | "custom";
export type StackSpacing = "linear" | "geometric";

export interface StackInput {
  /** USD */
  budget: number;
  /** the first (highest) ladder level */
  headPrice: number;
  /** the last (lowest) ladder level */
  floorPrice: number;
  /** number of ladder levels, 3–6 */
  levels: number;
  shape: StackShape;
  /** custom weights, one per level from the head down; normalized */
  weights?: number[];
  /** spacing of the levels between head and floor (default linear, like the user's 75k/65k/55k/45k) */
  spacing?: StackSpacing;
  /** explicit level prices from the head down (e.g. after snapping to reference lines); overrides the spacing */
  prices?: number[];
  /** share of the budget bought weekly */
  dcaShare: number;
  /** share kept for the reserve signal, 0–0.5 */
  reserveShare: number;
  horizonDays: number;
  /** anti-FOMO: price this far above the head (0.15 = 15%) … */
  fomoPct: number;
  /** … spreads the unfilled ladder money over this many weekly buys */
  fomoWeeks: number;
  /** fee per buy (default STACK_FEE) */
  fee?: number;
}

export const STACK_DEFAULTS = {
  levels: 4,
  shape: "pyramid" as StackShape,
  spacing: "linear" as StackSpacing,
  dcaShare: 0.4,
  reserveShare: 0.1,
  horizonDays: 180,
  fomoPct: 0.15,
  fomoWeeks: 8,
};

/** Pyramid weights for four levels, as in the research (E23b) */
const PYRAMID4 = [0.15, 0.2, 0.25, 0.4];

export const dcaWeeks = (horizonDays: number) => Math.max(1, Math.round(horizonDays / 7));
const feeOf = (x: StackInput) => x.fee ?? STACK_FEE;
const ladderShare = (x: StackInput) => 1 - x.dcaShare - x.reserveShare;

/** Problems with an input, as Chinese sentences for the page; empty when it is usable. */
export function validateStack(x: StackInput): string[] {
  const e: string[] = [];
  const pos = (v: number) => Number.isFinite(v) && v > 0;
  if (!pos(x.budget)) e.push("预算要大于 0");
  if (!pos(x.headPrice)) e.push("头仓价要大于 0");
  if (!pos(x.floorPrice)) e.push("最低一档的价格要大于 0");
  if (pos(x.headPrice) && pos(x.floorPrice) && x.floorPrice >= x.headPrice) e.push("最低一档要低于头仓价");
  if (!Number.isInteger(x.levels) || x.levels < 3 || x.levels > 6) e.push("档位数要在 3–6 档之间");
  if (x.shape === "custom") {
    const w = x.weights ?? [];
    if (w.length !== x.levels) e.push("自定义比例要每一档填一个");
    else if (w.some((v) => !Number.isFinite(v) || v < 0) || w.reduce((a, b) => a + b, 0) <= 0) e.push("自定义比例不能为负，合计要大于 0");
  }
  if (x.prices) {
    if (x.prices.length !== x.levels) e.push("档位价格的个数要和档位数一致");
    else if (x.prices.some((p, i) => !pos(p) || (i > 0 && p >= x.prices![i - 1]))) e.push("档位价格要从高到低排列，并且都大于 0");
  }
  if (!(x.dcaShare >= 0 && x.dcaShare <= 1)) e.push("定投比例要在 0–100% 之间");
  if (!(x.reserveShare >= 0 && x.reserveShare <= 0.5)) e.push("预备金比例要在 0–50% 之间");
  if (x.dcaShare >= 0 && x.reserveShare >= 0 && ladderShare(x) < -1e-9) e.push("定投和预备金合计不能超过 100%");
  if (!Number.isInteger(x.horizonDays) || x.horizonDays < 28 || x.horizonDays > 730) e.push("计划期限要在 28–730 天之间");
  if (!(x.fomoPct > 0 && x.fomoPct <= 1)) e.push("防踏空的涨幅要在 1–100% 之间");
  if (!Number.isInteger(x.fomoWeeks) || x.fomoWeeks < 1 || x.fomoWeeks > 52) e.push("防踏空分摊的周数要在 1–52 周之间");
  return e;
}

/** Level prices from the head down to the floor (first = head, last = floor), or the explicit ones. */
export function levelPrices(x: Pick<StackInput, "headPrice" | "floorPrice" | "levels" | "spacing" | "prices">): number[] {
  if (x.prices && x.prices.length === x.levels) return [...x.prices];
  const n = x.levels;
  if (x.spacing === "geometric") {
    const q = (x.floorPrice / x.headPrice) ** (1 / (n - 1));
    return Array.from({ length: n }, (_, k) => (k === n - 1 ? x.floorPrice : x.headPrice * q ** k));
  }
  return Array.from({ length: n }, (_, k) => x.headPrice + ((x.floorPrice - x.headPrice) * k) / (n - 1));
}

/**
 * Weights per level from the head down, summing to 1. Pyramid: exactly 15/20/25/40% for four levels
 * (the research's plan); for other counts proportional to 1, 2, …, n (more money lower down).
 */
export function levelWeights(shape: StackShape, n: number, custom?: number[]): number[] {
  if (shape === "custom" && custom && custom.length === n) {
    const s = custom.reduce((a, b) => a + b, 0);
    if (s > 0) return custom.map((w) => w / s);
  }
  if (shape === "pyramid") {
    if (n === 4) return [...PYRAMID4];
    const s = (n * (n + 1)) / 2;
    return Array.from({ length: n }, (_, k) => (k + 1) / s);
  }
  return Array.from({ length: n }, () => 1 / n);
}

// ---------------------------------------------------------------- the ladder

export interface NearbyRef extends PriceRef {
  /** (ref / level − 1), % */
  distPct: number;
}

export interface LadderRow {
  price: number;
  weight: number;
  usd: number;
  /** coins this level buys, after the fee */
  btc: number;
  cumBtc: number;
  cumUsd: number;
  /** average cost of the ladder down to this level */
  cumAvgCost: number;
  /** reference prices within ±3% of the level, nearest first */
  nearbyRefs: NearbyRef[];
  /** the nearest of them, if any (snapping is the page's choice; see snapLevels) */
  snapTo: PriceRef | null;
}

export interface Ladder {
  dcaUsd: number;
  ladderUsd: number;
  reserveUsd: number;
  dcaWeeks: number;
  dcaPerWeek: number;
  rows: LadderRow[];
  /** coins if every level fills */
  totalBtc: number;
  avgCost: number | null;
}

export const SNAP_PCT = 0.03;

function nearby(level: number, refs: PriceRef[], pct: number): NearbyRef[] {
  return refs
    .filter((r) => r.price > 0 && Math.abs(r.price / level - 1) <= pct)
    .map((r) => ({ ...r, distPct: Math.round((r.price / level - 1) * 1000) / 10 }))
    .sort((a, b) => Math.abs(a.distPct) - Math.abs(b.distPct));
}

export function buildLadder(x: StackInput, refs: PriceRef[] = []): Ladder {
  const fee = feeOf(x);
  const ladderUsd = x.budget * Math.max(0, ladderShare(x));
  const prices = levelPrices(x);
  const w = levelWeights(x.shape, prices.length, x.weights);
  let cumBtc = 0,
    cumUsd = 0;
  const rows = prices.map((price, k): LadderRow => {
    const usd = ladderUsd * w[k];
    const btc = (usd * (1 - fee)) / price;
    cumBtc += btc;
    cumUsd += usd;
    const near = nearby(price, refs, SNAP_PCT);
    return { price, weight: w[k], usd, btc, cumBtc, cumUsd, cumAvgCost: cumBtc > 0 ? cumUsd / cumBtc : price, nearbyRefs: near, snapTo: near[0] ?? null };
  });
  const weeks = dcaWeeks(x.horizonDays);
  const dcaUsd = x.budget * x.dcaShare;
  return { dcaUsd, ladderUsd, reserveUsd: x.budget * x.reserveShare, dcaWeeks: weeks, dcaPerWeek: dcaUsd / weeks, rows, totalBtc: cumBtc, avgCost: cumBtc > 0 ? cumUsd / cumBtc : null };
}

/** Move each level to the nearest reference price within `pct` (levels with none stay where they are). */
export function snapLevels(levels: number[], refs: PriceRef[], pct = SNAP_PCT): { price: number; snapped: PriceRef | null }[] {
  return levels.map((p) => {
    const n = nearby(p, refs, pct)[0];
    return n ? { price: n.price, snapped: { label: n.label, price: n.price, kind: n.kind } } : { price: p, snapped: null };
  });
}

// ---------------------------------------------------------------- what-if paths

export type ScenarioKey = "top" | "mid" | "crash";

export interface ScenarioResult {
  key: ScenarioKey;
  title: string;
  start: number;
  bottom: number;
  end: number;
  ladderBtc: number;
  /** ladder levels filled on the way down */
  ladderFilled: number;
  /** anti-FOMO spread the rest of the ladder */
  fomo: boolean;
  dcaBtc: number;
  reserveBtc: number;
  /** trigger: bought when the price reached the reserve trigger; end: at the horizon */
  reserveAt: "trigger" | "end" | "none";
  btc: number;
  /** budget / coins (fees included) */
  avgCost: number;
  /** every dollar is spent by the end of each path */
  cashLeft: 0;
  valueAtBottom: number;
  pnlAtBottom: number;
  pnlAtBottomPct: number;
  valueAtEnd: number;
  /** the whole budget bought today at the current price */
  lumpBtc: number;
  /** the whole budget in equal weekly buys along the same path */
  pureDcaBtc: number;
}

export interface ScenarioOpts {
  /** today's price, where every path starts (default: the head price) */
  currentPrice?: number;
  /** the reserve buys when the path first reaches this price (e.g. the higher of the 200-week average and the
   * realized price); without it the reserve is bought at the end */
  reservePrice?: number | null;
  /** how deep the crash path goes (default: the floor price) */
  crashPrice?: number;
}

/**
 * Three price paths, pure arithmetic (no history). Each path runs in straight lines from today's price down to
 * its bottom at one third of the horizon, then to its end price at the horizon; after the horizon the price
 * stays at the end price (only anti-FOMO buys can fall there).
 *   top:   the head price is the bottom, then the price rises to head × 1.33;
 *   mid:   falls to halfway between head and floor, then recovers to head × 1.07;
 *   crash: falls to the floor (every level fills) and stays there.
 * DCA buys every 7 days along the path; a level fills at its own price when the path reaches it (at today's
 * price if it is already above it); the reserve buys at its trigger price if the path reaches it.
 */
export function scenarios(x: StackInput, opts: ScenarioOpts = {}): ScenarioResult[] {
  const start = opts.currentPrice ?? x.headPrice;
  const mid = (x.headPrice + x.floorPrice) / 2;
  const crash = opts.crashPrice ?? x.floorPrice;
  const paths: [ScenarioKey, string, number, number][] = [
    ["top", "头仓价就是底，之后涨到头仓价 × 1.33", x.headPrice, x.headPrice * 1.33],
    ["mid", "跌到头仓和最低一档的中间，再回到头仓价 × 1.07", mid, x.headPrice * 1.07],
    ["crash", "一路跌到最低一档（每一档都成交），之后停在那里", crash, crash],
  ];
  return paths.map(([key, title, bottom, end]) => runPath(x, key, title, start, Math.min(bottom, start), end, opts.reservePrice ?? null));
}

function runPath(x: StackInput, key: ScenarioKey, title: string, start: number, bottom: number, end: number, reservePrice: number | null): ScenarioResult {
  const fee = feeOf(x);
  const H = x.horizonDays;
  const tb = H / 3;
  const at = (t: number) => (t <= 0 ? start : t <= tb ? start + ((bottom - start) * t) / tb : t < H ? bottom + ((end - bottom) * (t - tb)) / (H - tb) : end);
  const buy = (usd: number, price: number) => (usd * (1 - fee)) / price;
  const weekly = (usd: number) => {
    const n = dcaWeeks(H);
    let c = 0;
    for (let j = 0; j < n; j++) c += buy(usd / n, at(7 * j));
    return c;
  };
  // ladder
  const lad = buildLadder(x);
  let ladderBtc = 0,
    filled = 0,
    left = 0;
  for (const r of lad.rows) {
    if (r.price >= start) {
      ladderBtc += buy(r.usd, start);
      filled++;
    } else if (bottom <= r.price) {
      ladderBtc += buy(r.usd, r.price);
      filled++;
    } else left += r.usd;
  }
  // anti-FOMO: the first time the rising leg passes head × (1 + fomoPct) within the horizon
  const line = x.headPrice * (1 + x.fomoPct);
  let fomo = false;
  if (left > 0) {
    const tf = start > line ? 0 : end > line && bottom < line ? tb + ((line - bottom) / (end - bottom)) * (H - tb) : Infinity;
    if (tf < H) {
      fomo = true;
      for (let j = 0; j < x.fomoWeeks; j++) ladderBtc += buy(left / x.fomoWeeks, at(tf + 7 * j));
      left = 0;
    }
  }
  if (left > 0) ladderBtc += buy(left, end);
  // reserve
  const resUsd = x.budget * x.reserveShare;
  let reserveBtc = 0;
  let reserveAt: ScenarioResult["reserveAt"] = "none";
  if (resUsd > 0) {
    if (reservePrice != null && start <= reservePrice) {
      reserveBtc = buy(resUsd, start);
      reserveAt = "trigger";
    } else if (reservePrice != null && bottom <= reservePrice) {
      reserveBtc = buy(resUsd, reservePrice);
      reserveAt = "trigger";
    } else {
      reserveBtc = buy(resUsd, end);
      reserveAt = "end";
    }
  }
  const dcaBtc = weekly(x.budget * x.dcaShare);
  const btc = ladderBtc + dcaBtc + reserveBtc;
  const valueAtBottom = btc * bottom;
  return {
    key,
    title,
    start,
    bottom,
    end,
    ladderBtc,
    ladderFilled: filled,
    fomo,
    dcaBtc,
    reserveBtc,
    reserveAt,
    btc,
    avgCost: x.budget / btc,
    cashLeft: 0,
    valueAtBottom,
    pnlAtBottom: valueAtBottom - x.budget,
    pnlAtBottomPct: Math.round((valueAtBottom / x.budget - 1) * 1000) / 10,
    valueAtEnd: btc * end,
    lumpBtc: buy(x.budget, start),
    pureDcaBtc: weekly(x.budget),
  };
}

// ---------------------------------------------------------------- historical replay

export interface ReplayHistory {
  day: string[];
  price: number[];
  /** the reserve signal of each day */
  reserve: boolean[];
}

/** The compact form /api/spot sends: the first day, prices, and the reserve signal as a string of 0/1. */
export interface SpotHistoryWire {
  start: string;
  price: number[];
  reserve: string;
}

export function expandHistory(w: SpotHistoryWire): ReplayHistory {
  const d0 = Date.parse(`${w.start}T00:00:00Z`);
  return {
    day: w.price.map((_, i) => new Date(d0 + i * 86400_000).toISOString().slice(0, 10)),
    price: w.price,
    reserve: Array.from(w.reserve, (c) => c === "1"),
  };
}

export interface ReplayStats {
  median: number;
  p10: number;
  p90: number;
  /** share of starts where the plan got more coins, 0–1 */
  better: number;
  periods: { label: string; from: string; to: string; n: number; median: number | null }[];
}

export interface ReplayResult {
  starts: number;
  from: string;
  to: string;
  /** coins of the plan / coins of buying everything on the start day */
  vsLump: ReplayStats;
  /** coins of the plan / coins of equal weekly buys over the same horizon */
  vsDca: ReplayStats;
  /** per start (only with opts.series) */
  series?: { day: string[]; vsLump: number[]; vsDca: number[] };
}

export const REPLAY_PERIODS: [string, string, string][] = [
  ["2015–18", "2015-01-01", "2019-01-01"],
  ["2019–21", "2019-01-01", "2022-01-01"],
  ["2022 起", "2022-01-01", "9999-12-31"],
];

/** E23's quantile: the sorted value at floor(f × (n − 1)). */
const quant = (sorted: number[], f: number) => sorted[Math.floor(f * (sorted.length - 1))];

function stats(r: number[], day: string[]): ReplayStats {
  const sorted = Float64Array.from(r).sort();
  const arr = Array.from(sorted);
  return {
    median: quant(arr, 0.5),
    p10: quant(arr, 0.1),
    p90: quant(arr, 0.9),
    better: r.filter((v) => v > 1).length / r.length,
    periods: REPLAY_PERIODS.map(([label, a, b]) => {
      const v = r.filter((_, n) => day[n] >= a && day[n] < b).sort((x, y) => x - y);
      return { label, from: a, to: b, n: v.length, median: v.length ? quant(v, 0.5) : null };
    }),
  };
}

/**
 * Run the plan on every start day since `from` (default 2015-01-01), daily closes, $1 per start:
 * the head is the start day's close × (headPrice / currentPrice), the levels keep their ratios to the head.
 * A level fills when a daily close is at or below it, at the level price (at the close on the start day).
 * Starts stop early enough that the horizon and the anti-FOMO weeks fit in the history.
 * Returns null when the history is too short for a single start.
 */
export function replay(x: StackInput, h: ReplayHistory, opts: { currentPrice: number; from?: string; series?: boolean }): ReplayResult | null {
  const P = h.price;
  const LAST = P.length - 1;
  const H = x.horizonDays;
  const fee = feeOf(x);
  const weeks = dcaWeeks(H);
  const ratios = levelPrices(x).map((p) => p / x.headPrice);
  const w = levelWeights(x.shape, ratios.length, x.weights);
  const headRatio = x.headPrice / opts.currentPrice;
  const lShare = Math.max(0, ladderShare(x));
  const buy = (usd: number, price: number) => (usd * (1 - fee)) / price;

  const dca = (s: number, usd: number) => {
    let coins = 0,
      cash = usd;
    const base = usd / weeks;
    for (let j = 0; j < weeks && cash > 1e-12; j++) {
      const a = Math.min(cash, base);
      coins += buy(a, P[s + 7 * j]);
      cash -= a;
    }
    return coins + (cash > 1e-12 ? buy(cash, P[s + H]) : 0);
  };
  const lv = new Float64Array(ratios.length);
  const left = new Float64Array(ratios.length);
  const ladder = (s: number, usd: number) => {
    const head = P[s] * headRatio;
    for (let k = 0; k < ratios.length; k++) {
      lv[k] = head * ratios[k];
      left[k] = w[k] * usd;
    }
    const fomoLine = head * (1 + x.fomoPct);
    let coins = 0;
    for (let i = s; i < s + H; i++) {
      let rest = 0;
      for (let k = 0; k < lv.length; k++) {
        if (left[k] <= 0) continue;
        if (P[i] <= lv[k]) {
          coins += buy(left[k], Math.min(lv[k], i === s ? P[s] : lv[k]));
          left[k] = 0;
        } else rest += left[k];
      }
      if (rest > 0 && P[i] > fomoLine) {
        for (let j = 0; j < x.fomoWeeks; j++) coins += buy(rest / x.fomoWeeks, P[Math.min(LAST, i + 7 * j)]);
        return coins;
      }
    }
    let rest = 0;
    for (let k = 0; k < left.length; k++) rest += left[k];
    return coins + buy(rest, P[s + H]);
  };
  const reserve = (s: number, usd: number) => {
    for (let i = s; i < s + H; i++) if (h.reserve[i]) return buy(usd, P[i]);
    return buy(usd, P[s + H]);
  };

  const from = opts.from ?? REPLAY_PERIODS[0][1];
  const s0 = h.day.findIndex((d) => d >= from);
  const sEnd = LAST - H - Math.max(60, 7 * x.fomoWeeks + 4);
  if (s0 < 0 || s0 > sEnd) return null;
  const n = sEnd - s0 + 1;
  const vsLump = new Array<number>(n),
    vsDca = new Array<number>(n),
    days = new Array<string>(n);
  for (let s = s0; s <= sEnd; s++) {
    const plan = (x.dcaShare > 0 ? dca(s, x.dcaShare) : 0) + (lShare > 0 ? ladder(s, lShare) : 0) + (x.reserveShare > 0 ? reserve(s, x.reserveShare) : 0);
    const k = s - s0;
    vsLump[k] = plan / buy(1, P[s]);
    vsDca[k] = plan / dca(s, 1);
    days[k] = h.day[s];
  }
  return {
    starts: n,
    from: h.day[s0],
    to: h.day[sEnd],
    vsLump: stats(vsLump, days),
    vsDca: stats(vsDca, days),
    ...(opts.series ? { series: { day: days, vsLump, vsDca } } : {}),
  };
}
