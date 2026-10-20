import { PRIMARY_SOURCE } from "../data/klines.ts";
import { LEVEL_METHODS, type EngineParams } from "../params.ts";
import * as ta from "../ta/core.ts";
import { levelCandidates, periodCandidates } from "../ta/levels.ts";
import { swings } from "../ta/structure.ts";
import type { Candle, Timeframe } from "../types.ts";
import { bhAdjust, cells, judge, makeSplit, type Trade } from "./engine.ts";
import { loadHistory, type ResearchReport, type ResearchRow } from "./run.ts";
import { runUp, simulate, type SimContext } from "./sim.ts";

/**
 * Key levels (the E6 event study, on the stored history): every time price comes
 * back to a level known at that moment, trade against it — enter just before the
 * level, stop beyond the usual sweep depth (0.85 ATR), take profit at 2R or close
 * after the holding time — and compare with random price lines that live like
 * real ones. Also how often each kind of level is pierced (a close 0.1 ATR beyond)
 * or invalidated (0.8 ATR beyond) within the holding time: the two states v1.3 shows.
 *
 * E16 asks the question a trader asks instead: every level breaks some day, so what
 * did defending it give before it broke? The same touches are followed with no target
 * and no short holding time — until the stop, or 180 bars (4h) / 90 (daily) — and
 * measured in R (the stop distance), which puts a 100-point move in ETH and a
 * 3,000-point move in BTC on the same scale: how often price reached 1, 2, 3, 5R before
 * the stop, the furthest it went, and what three ways of exiting made.
 */

const METHOD_NAME: Record<string, string> = {
  swing: "摆动高低",
  fractal: "Williams 分形",
  volume: "成交量分布",
  pivot: "经典 Pivot",
  camarilla: "Camarilla",
  fibPivot: "Fibonacci Pivot",
  fib: "Fibonacci 回撤",
  prevHL: "前日/周/月高低",
  donchian: "Donchian 通道",
  keltner: "Keltner 通道",
  bollinger: "布林带",
  ma: "均线",
  avwap: "锚定 VWAP",
  round: "整数关口",
};
const PLACEBO = "random";
const ENTRY_ATR = 0.1;
const STOP_ATR = 0.85;
const TARGET_R = 2;
const PIERCE_ATR = 0.1;
const BREAK_ATR = 0.8;
const SETUP: Partial<Record<Timeframe, { step: number; hold: number }>> = { "1h": { step: 6, hold: 72 }, "4h": { step: 3, hold: 60 }, "1d": { step: 1, hold: 30 } };
/** E16: how long a defended level is followed */
const LONG_HOLD: Partial<Record<Timeframe, number>> = { "1h": 240, "4h": 180, "1d": 90 };
const REACH = [1, 2, 3, 5];

/** deterministic, so a report can be reproduced */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

interface LevelTrade extends Trade {
  pierced: boolean;
  broken: boolean;
}

/** One touch of a level known at the time: the limit order at E filled during bar j, stop at S. */
export interface Touch {
  /** method (or "random" for a placebo line) */
  g: string;
  L: number;
  j: number;
  /** +1: a resistance above, traded short; −1: a support below, traded long */
  sg: 1 | -1;
  E: number;
  S: number;
}

/**
 * Every touch of a level known at the close of the bar before, in order (the E6 rules): checked every
 * `step` bars, levels at least 0.3 ATR away, the same method and price once per 12 bars, random lines
 * that live until broken or 300 bars old.
 */
export async function touchEvents(c: Candle[], daily: Candle[], tf: Timeframe, ep: EngineParams, seed: number, step: number, atr = ta.atr(c, 14)): Promise<Touch[]> {
  const out: Touch[] = [];
  const rnd = rng(seed);
  const placebo: { L: number; born: number; above: boolean }[] = [];
  const recent = new Map<string, { L: number; j: number }[]>();
  const fresh = (g: string, L: number, j: number, A: number) => {
    const arr = recent.get(g) ?? [];
    if (arr.some((x) => j - x.j < 12 && Math.abs(x.L - L) < 0.3 * A)) return false;
    arr.push({ L, j });
    if (arr.length > 50) arr.shift();
    recent.set(g, arr);
    return true;
  };
  let di = 0;
  for (let t = 600; t < c.length - 2; t += step) {
    const A = atr[t], p = c[t].c;
    if (!(A > 0)) continue;
    // levels known at the close of bar t
    const lv: { g: string; L: number }[] = levelCandidates(c.slice(Math.max(0, t - 999), t + 1), tf, ep.levels).map((x) => ({ g: x.method, L: x.price }));
    while (di + 1 < daily.length && daily[di + 1].t <= c[t].t) di++;
    // the day in progress only marks where the current period starts
    for (const x of periodCandidates(daily.slice(Math.max(0, di - 70), di + 1), p, ep.levels)) lv.push({ g: x.method, L: x.price });
    // random lines that live until broken or 300 bars old
    for (let k = placebo.length - 1; k >= 0; k--) {
      const q = placebo[k];
      if (t - q.born > 300 || (q.above ? p > q.L : p < q.L)) placebo.splice(k, 1);
    }
    for (let k = 0; k < 2; k++) placebo.push({ L: p + (0.3 + rnd() * 5.7) * A, born: t, above: true }, { L: p - (0.3 + rnd() * 5.7) * A, born: t, above: false });
    for (const q of placebo) lv.push({ g: PLACEBO, L: q.L });

    for (const { g, L } of lv) {
      if (!(L > 0) || Math.abs(L - p) < 0.3 * A) continue;
      const sg = L > p ? 1 : -1; // +1: resistance above, trade short
      const E = L - sg * ENTRY_ATR * A, S = L + sg * STOP_ATR * A;
      for (let j = t + 1; j <= Math.min(t + step, c.length - 2); j++) {
        const x = c[j];
        if ((E - c[j - 1].c) * sg <= 0 || !(sg > 0 ? x.h >= E : x.l <= E) || !fresh(g, L, j, A)) continue;
        out.push({ g, L, j, sg, E, S });
      }
    }
    if (t % 300 < step) await new Promise((ok) => setImmediate(ok));
  }
  return out;
}

/** The E6 outcome: 2R target or the holding time, and whether the level was pierced / invalidated meanwhile. */
function e6Outcome(c: Candle[], atr: number[], x: Touch, hold: number, cost: number, coin: string): LevelTrade {
  const { j, sg, E, S, L } = x;
  const R = Math.abs(S - E);
  const bar = c[j];
  // conservative: a bar that reaches the stop as well counts as stopped
  let r = -1, pierced = false, broken = false;
  const end = Math.min(c.length - 1, j + hold);
  if (!(sg > 0 ? bar.h >= S : bar.l <= S)) {
    r = Number.NaN;
    for (let k = j + 1; k <= end; k++) {
      const y = c[k];
      if (sg > 0 ? y.h >= S : y.l <= S) { r = -1; break; }
      if ((sg > 0 ? E - y.l : y.h - E) / R >= TARGET_R) { r = TARGET_R; break; }
    }
    if (Number.isNaN(r)) r = Math.max(-1, ((E - c[end].c) * sg) / R);
  }
  for (let k = j; k <= end; k++) {
    const beyond = ((c[k].c - L) * sg) / atr[k];
    if (beyond > PIERCE_ATR) pierced = true;
    if (beyond > BREAK_ATR) { broken = true; break; }
  }
  const net = r - ((cost / 100) * E) / R;
  return { t: bar.t, coin, r: net, pct: (net * R * 100) / E, pierced, broken };
}

interface MfeTrade extends Trade {
  /** furthest excursion before the stop, in R and in ATR at entry */
  mfe: number;
  mfeAtr: number;
  /** reached k·R before the stop, for k in REACH */
  reach: boolean[];
  /** R with the other two exits */
  scale: number;
  fixed: number;
  /** bar the trade ended (one position at a time per method) */
  until: number;
}

/** E16: the touch followed until its stop (or the long holding time), with three exits. */
function e16Outcome(c: Candle[], atr: number[], ctx: SimContext, x: Touch, cost: number, coin: string): MfeTrade | null {
  const { j, sg, E, S } = x;
  const dir = (-sg) as 1 | -1;
  const R = Math.abs(S - E);
  const costR = ((cost / 100) * E) / R;
  const res = (r: number) => ({ r, pct: (r * R * 100) / E });
  // filled and stopped in the same bar: the conservative reading
  if (sg > 0 ? c[j].h >= S : c[j].l <= S) {
    const lost = -1 - costR;
    return { t: c[j].t, coin, ...res(lost), mfe: 0, mfeAtr: 0, reach: REACH.map(() => false), scale: lost, fixed: lost, until: j };
  }
  const main = simulate(ctx, j, dir, S, "structure", E);
  const scale = simulate(ctx, j, dir, S, "scale2r", E);
  const fixed = simulate(ctx, j, dir, S, "fixed2r", E);
  if (!main || !scale || !fixed) return null;
  const best = runUp(ctx, j, dir, S, E);
  return {
    t: c[j].t,
    coin,
    r: main.r,
    pct: main.pct,
    mfe: best,
    mfeAtr: (best * R) / atr[j],
    reach: REACH.map((k) => best >= k),
    scale: scale.r,
    fixed: fixed.r,
    until: j + main.bars,
  };
}

const pctOf = (xs: boolean[]) => (xs.length ? Math.round((xs.filter(Boolean).length / xs.length) * 1000) / 10 : null);
const meanOf = (xs: number[]) => (xs.length ? Math.round((xs.reduce((s, v) => s + v, 0) / xs.length) * 1000) / 1000 : null);
function quantile(xs: number[], q: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor(q * s.length))] * 100) / 100;
}

export async function levelsReport(
  ep: EngineParams,
  opts: { paramsVersion: number; coins?: string[]; tfs?: Timeframe[]; nowSec?: number } = { paramsVersion: 0 },
): Promise<ResearchReport> {
  const t0 = Date.now();
  const { coins = ["BTC", "ETH"], tfs = ["4h", "1d"], nowSec = Date.now() / 1000 } = opts;
  const cost = ep.stats.costPct;
  const rows: Omit<ResearchRow, "q" | "consistent" | "verdict">[] = [];
  const mfeRows: Omit<ResearchRow, "q" | "consistent" | "verdict">[] = [];
  const coverage: ResearchReport["coverage"] = [];
  const riskPoints: string[] = [];
  let holdoutFrom = 0;
  for (const tf of tfs) {
    const setup = SETUP[tf];
    if (!setup) continue;
    const { step, hold } = setup;
    const byMethod = new Map<string, LevelTrade[]>();
    const byMethodMfe = new Map<string, MfeTrade[]>();
    let first = Infinity, last = 0, bars = 0, used = 0;
    for (const coin of coins) {
      const c = loadHistory(coin, tf, nowSec);
      const daily = loadHistory(coin, "1d", nowSec);
      if (c.length < 1200) continue;
      used++;
      bars += c.length;
      const atr = ta.atr(c, 14);
      first = Math.min(first, c[600].t);
      last = Math.max(last, c[c.length - 1].t);
      const touches = await touchEvents(c, daily, tf, ep, 20261020 + used, step, atr);
      const ctx: SimContext = { c, atr, swings: swings(c, atr, ep.structure.swingAtr), buf: STOP_ATR, costPct: cost, maxBars: LONG_HOLD[tf] ?? 180 };
      // one defended position at a time per method on each coin
      const free = new Map<string, number>();
      const risks: number[] = [];
      for (const x of touches) {
        const list = byMethod.get(x.g) ?? [];
        list.push(e6Outcome(c, atr, x, hold, cost, coin));
        byMethod.set(x.g, list);
        if (x.j < (free.get(x.g) ?? -1)) continue;
        const m = e16Outcome(c, atr, ctx, x, cost, coin);
        if (!m) continue;
        free.set(x.g, m.until);
        const ml = byMethodMfe.get(x.g) ?? [];
        ml.push(m);
        byMethodMfe.set(x.g, ml);
        if (x.g !== PLACEBO) risks.push(Math.abs(x.S - x.E));
      }
      const med = quantile(risks, 0.5);
      if (med != null) riskPoints.push(`${coin} ${tf} ${med >= 100 ? Math.round(med).toLocaleString("en-US") : med}`);
      await new Promise((ok) => setImmediate(ok));
    }
    if (!used) continue;
    const split = makeSplit(first, nowSec);
    holdoutFrom = split.holdoutFrom;
    coverage.push({ tf, coins: used, bars: Math.round(bars / used), from: first, to: last, holdoutFrom: split.holdoutFrom });
    const control = byMethod.get(PLACEBO) ?? [];
    const share = (xs: LevelTrade[], f: (x: LevelTrade) => boolean) => (xs.length ? Math.round((xs.filter(f).length / xs.length) * 1000) / 10 : null);
    const controlMfe = byMethodMfe.get(PLACEBO) ?? [];
    for (const g of [...LEVEL_METHODS, PLACEBO]) {
      const name = g === PLACEBO ? "随机价格线（对照）" : METHOD_NAME[g] ?? g;
      const list = byMethod.get(g);
      if (list?.length) {
        rows.push({
          family: "level",
          key: `level:${g}`,
          name,
          side: "bear",
          tf,
          horizon: hold,
          cells: cells(list, control, split, 1),
          extra: { piercedPct: share(list, (x) => x.pierced), brokenPct: share(list, (x) => x.broken) },
        });
      }
      const ml = byMethodMfe.get(g);
      if (ml?.length) {
        const extra: Record<string, number | null> = {};
        REACH.forEach((k, n) => {
          extra[`reach${k}`] = pctOf(ml.map((x) => x.reach[n]));
          extra[`reach${k}Ctl`] = pctOf(controlMfe.map((x) => x.reach[n]));
        });
        extra.mfeMedR = quantile(ml.map((x) => x.mfe), 0.5);
        extra.mfeP75R = quantile(ml.map((x) => x.mfe), 0.75);
        extra.mfeMedAtr = quantile(ml.map((x) => x.mfeAtr), 0.5);
        extra.scaleR = meanOf(ml.map((x) => x.scale));
        extra.fixedR = meanOf(ml.map((x) => x.fixed));
        extra.scaleCtlR = meanOf(controlMfe.map((x) => x.scale));
        extra.fixedCtlR = meanOf(controlMfe.map((x) => x.fixed));
        mfeRows.push({ family: "level_mfe", key: `level_mfe:${g}`, name, side: "bear", tf, horizon: LONG_HOLD[tf] ?? 180, cells: cells(ml, controlMfe, split, 1), extra, control: "随机价格线，同样守到止损" });
      }
    }
  }
  // two families of hypotheses, corrected separately (so the E6 rows read as before)
  const judged = (list: typeof rows) => {
    const q = bhAdjust(list.map((r) => (r.key.endsWith(`:${PLACEBO}`) || r.cells.is.n < ep.stats.minSamples ? null : r.cells.is.p)));
    return list.map((r, k) => ({ ...r, q: q[k], ...judge(r.cells, q[k], ep.stats.alpha, ep.stats.minSamples) }));
  };
  return {
    kind: "levels",
    title: "关键位：触位反向交易对随机价格线，刺穿与失效比例；守住之前能走多远",
    createdAt: Date.now(),
    source: PRIMARY_SOURCE,
    paramsVersion: opts.paramsVersion,
    costPct: cost,
    alpha: ep.stats.alpha,
    holdoutFrom,
    coins,
    coverage,
    rows: [...judged(rows), ...judged(mfeRows)],
    notes: [
      `每次价格回到当时已知的关键位，就在位前 ${ENTRY_ATR} 倍 ATR 处反向入场，止损放在位外 ${STOP_ATR} 倍 ATR（历史扫损深度约 p80），${TARGET_R}R 止盈，否则持有期结束时平仓；结果以 R（止损距离）计，已扣成本。`,
      "对照是随机价格线：和真实关键位一样，被收盘越过或满 300 根就作废。“优势”= 某种方法的平均 R 减去同币同期随机线的平均 R。",
      `“刺穿”= 持有期内收盘越过该位 ${PIERCE_ATR} 倍 ATR；“失效”= 越过 ${BREAK_ATR} 倍 ATR（v1.3 防守位页的两级状态）。`,
      "同一种方法、同一个价位附近 12 根内只算一次；被动态更新的位（均线、通道）按当时的价格记。",
      `“守住之前能走多远”（E16）：同样的触位，不设止盈、不设短持有期，一直跟到止损或最长 ${LONG_HOLD["4h"]} 根（4 小时）/ ${LONG_HOLD["1d"]} 根（日线）；同一种方法在一个币上同时只守一笔。主结果按“跟着结构移动认错位”离场，另给“2R 先平一半”和“固定 2R”两种；“先到 kR”是打到止损之前价格至少走到 k 倍止损距离的比例。`,
      `以 R 计等于按各币自己的波动折算：1R（止损距离）的中位数约为 ${riskPoints.join("、") || "—"} 点。`,
    ],
    durationMs: Date.now() - t0,
  };
}
