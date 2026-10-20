import { PRIMARY_SOURCE } from "../data/klines.ts";
import type { EngineParams } from "../params.ts";
import * as ta from "../ta/core.ts";
import { alignHigher, ENTRY_NAME, findEntries, MAX_HOLD_BARS, type EntryKind } from "../ta/plan.ts";
import { atrSeries, bufferAtr, calibrate } from "../ta/risk.ts";
import { structureDirection, structureSeries, swings, type StructureState, type Swing } from "../ta/structure.ts";
import { COIN_IDS } from "../symbols.ts";
import type { Candle, Timeframe } from "../types.ts";
import { bhAdjust, cells, controlTrades, judge, makeSplit, trades as fwdTrades, type Trade } from "./engine.ts";
import { loadHistory, type ResearchReport, type ResearchRow } from "./run.ts";
import { POLICY_NAME, simulate, type ExitPolicy, type SimContext, type SimResult } from "./sim.ts";

/**
 * E10–E14: the evidence behind the trading-plan page.
 *
 * - E10 anchoring: after the biggest rallies / drops, does the move go on?
 * - E11 exits: on the same entries, which way of taking profit / trailing works best?
 * - E12 entries: breakout, pullback (with or without a confirming close) and reversal,
 *   with the higher timeframe's direction as a filter, against random entries.
 * - E13 stops: the structural stop against a fixed ATR stop of the same average distance;
 *   and stops anchored on equal highs / lows.
 * - E14 beginner habits: a stop hugging the entry, taking +0.5R, trading against the
 *   higher timeframe, shorting a breakout because "it's too high".
 * - The plan scorecard: following the page's plans mechanically, sizes included.
 *
 * Entries happen at the close of the trigger bar; results are in R, after costs.
 * One position at a time per coin and rule, so trades never overlap.
 */

export interface Setup {
  /** timeframe the trade is entered and managed on */
  tf: Timeframe;
  /** timeframe whose direction filters it */
  filter: Timeframe;
}

export const SETUPS: Setup[] = [
  { tf: "4h", filter: "1d" },
  { tf: "1d", filter: "1w" },
];

const MAX_BARS = MAX_HOLD_BARS;
const WARMUP = 300;


export interface Event {
  coin: string;
  i: number;
  t: number;
  dir: 1 | -1;
  kind: EntryKind;
  /** structural stop: the protective swing plus the p80 sweep buffer */
  stop: number;
  /** the swing the stop hangs on */
  anchor: number;
  /** direction of the higher timeframe at entry: by structure and by its 50 EMA */
  fStruct: 1 | -1 | 0;
  fEma: 1 | -1 | 0;
  /** the anchor sits on equal highs / lows (E9 definition) */
  equal: boolean;
  /** relative volume of the entry bar against the last 20 bars' median */
  relVol: number;
}

export interface Prepared {
  coin: string;
  c: Candle[];
  atr: number[];
  ss: StructureState[];
  sw: Swing[];
  /** sweep buffers (ATR) calibrated on the in-sample part only */
  buf: { p50: number; p80: number; p90: number };
  events: Event[];
  /** the higher timeframe's direction by structure, known at the close of bar i */
  fDir: (i: number) => 1 | -1 | 0;
}

/** Everything for one coin and setup: structure, filters, calibrated buffers and the entry events. */
export function prepare(coin: string, setup: Setup, ep: EngineParams, nowSec: number, holdoutFrom: number): Prepared | null {
  const c = loadHistory(coin, setup.tf, nowSec);
  const f = loadHistory(coin, setup.filter, nowSec);
  if (c.length < WARMUP + 200 || f.length < 60) return null;
  const mult = ep.structure.swingAtr;
  const atr = atrSeries(c);
  const ss = structureSeries(c, atr, mult);
  const sw = swings(c, atr, mult);
  const fAtr = atrSeries(f);
  const fss = structureSeries(f, fAtr, mult);
  const fEma = ta.ema(f.map((x) => x.c), 50);
  // the filter bar known at the close of each entry bar
  const fIdx = alignHigher(c, setup.tf, f, setup.filter);
  const fDirStruct = (t: number): 1 | -1 | 0 => (fIdx[t] < 0 ? 0 : structureDirection(fss[fIdx[t]]));
  const fDirEma = (t: number): 1 | -1 | 0 => {
    const k = fIdx[t];
    if (k < 55) return 0;
    return f[k].c > fEma[k] && fEma[k] > fEma[k - 5] ? 1 : f[k].c < fEma[k] && fEma[k] < fEma[k - 5] ? -1 : 0;
  };
  const isEnd = c.findIndex((x) => x.t >= holdoutFrom);
  const cal = calibrate(c.slice(0, isEnd > 0 ? isEnd : c.length), setup.tf, ep.horizon[setup.tf]);
  const buf = { p50: bufferAtr(cal, 50), p80: bufferAtr(cal, 80), p90: bufferAtr(cal, 90) };

  const events: Event[] = findEntries({ tf: setup.tf, c, atr, ss, filterAt: fDirStruct, buf: buf.p80, from: WARMUP }).map((e) => ({
    coin,
    i: e.i,
    t: e.t,
    dir: e.dir,
    kind: e.kind,
    stop: e.stop,
    anchor: e.anchor,
    fStruct: e.filter,
    fEma: fDirEma(e.i),
    equal: e.equal,
    relVol: e.relVol,
  }));
  return { coin, c, atr, ss, sw, buf, events, fDir: fDirStruct };
}

export function ctxOf(p: Prepared, setup: Setup, ep: EngineParams): SimContext {
  return { c: p.c, atr: p.atr, swings: p.sw, buf: p.buf.p80, costPct: ep.stats.costPct, maxBars: MAX_BARS[setup.tf] ?? 120 };
}

export const toTrade = (p: Prepared, e: { i: number }, r: { r: number; pct: number }, size = 1): Trade => ({ t: p.c[e.i].t, coin: p.coin, r: r.r * size, pct: r.pct * size });

/**
 * One position at a time, as a person following the rule would hold it: an event is
 * taken only once the previous trade has closed, so samples never overlap.
 */
export function sequential<E extends { i: number; dir: 1 | -1; stop: number }>(evs: E[], ctx: SimContext, policy: ExitPolicy): { e: E; r: SimResult }[] {
  const out: { e: E; r: SimResult }[] = [];
  let free = -1;
  for (const e of evs) {
    if (e.i < free) continue;
    const r = simulate(ctx, e.i, e.dir, e.stop, policy);
    if (!r) continue;
    out.push({ e, r });
    free = e.i + r.bars;
  }
  return out;
}

/** deterministic random numbers, so reports can be reproduced */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/**
 * Random-timing control: for each event, entries at random bars of the same coin,
 * same direction and the same stop distance in ATR, managed the same way.
 */
export function randomTrades<E extends { i: number; dir: 1 | -1; stop: number }>(p: Prepared, evs: E[], ctx: SimContext, policy: ExitPolicy, perEvent: number, seed: number, size: (e: E) => number = () => 1): Trade[] {
  const r = rng(seed);
  const out: Trade[] = [];
  const n = p.c.length - (ctx.maxBars + 1);
  for (const e of evs) {
    const riskAtr = ((p.c[e.i].c - e.stop) * e.dir) / p.atr[e.i];
    for (let k = 0; k < perEvent; k++) {
      const u = WARMUP + Math.floor(r() * (n - WARMUP));
      if (!(p.atr[u] > 0)) continue;
      const res = simulate(ctx, u, e.dir, p.c[u].c - e.dir * riskAtr * p.atr[u], policy);
      if (res) out.push(toTrade(p, { i: u }, res, size(e)));
    }
  }
  return out;
}

type Row = Omit<ResearchRow, "q" | "consistent" | "verdict">;

/** The higher timeframe agrees (with) / disagrees (against), by the filter definition. */
const agrees = (e: Event, by: "struct" | "ema") => (by === "struct" ? e.fStruct : e.fEma) === e.dir;
const opposes = (e: Event, by: "struct" | "ema") => (by === "struct" ? e.fStruct : e.fEma) === -e.dir;

export async function plansReport(
  ep: EngineParams,
  opts: { paramsVersion: number; coins?: string[]; nowSec?: number; policy?: ExitPolicy } = { paramsVersion: 0 },
): Promise<ResearchReport> {
  const t0 = Date.now();
  const { coins = COIN_IDS, nowSec = Date.now() / 1000, policy = "structure" } = opts;
  const rows: Row[] = [];
  const coverage: ResearchReport["coverage"] = [];
  let holdoutFrom = 0;
  const tick = () => new Promise((ok) => setImmediate(ok));

  for (const setup of SETUPS) {
    const { tf } = setup;
    const split = makeSplit(Date.parse("2017-01-01") / 1000, nowSec);
    holdoutFrom = split.holdoutFrom;
    const preps: Prepared[] = [];
    for (const coin of coins) {
      const p = prepare(coin, setup, ep, nowSec, split.holdoutFrom);
      if (p) preps.push(p);
      await tick();
    }
    if (!preps.length) continue;
    const first = Math.min(...preps.map((p) => p.c[WARMUP].t));
    const tfSplit = makeSplit(first, nowSec);
    coverage.push({ tf, coins: preps.length, bars: Math.round(preps.reduce((s, p) => s + p.c.length, 0) / preps.length), from: first, to: Math.max(...preps.map((p) => p.c[p.c.length - 1].t)), holdoutFrom: tfSplit.holdoutFrom });
    const label = `${tf === "4h" ? "4 小时入场、日线定方向" : "日线入场、周线定方向"}`;
    const row = (family: string, key: string, name: string, sig: Trade[], ctl: Trade[], control: string, step = 1) =>
      rows.push({ family: family as Row["family"], key: `${family}:${key}`, name, side: "bull", tf, horizon: MAX_BARS[tf] ?? 0, cells: cells(sig, ctl, tfSplit, step), control, extra: { setup: tf === "4h" ? 1 : 2 } });

    // ---- E10: anchoring. After the biggest 20-bar moves, the next H bars in the same direction vs. any bar.
    {
      const H = ep.horizon[tf];
      const up: Trade[] = [], dn: Trade[] = [], ctlUp: Trade[] = [], ctlDn: Trade[] = [];
      for (const p of preps) {
        const N = 20;
        const moves = p.c.map((x, i) => (i >= N ? (x.c - p.c[i - N].c) / p.c[i - N].c : 0));
        const grid = p.c.map((_, i) => i).filter((i) => i >= WARMUP && i % H === 0 && i + H < p.c.length);
        const sorted = grid.map((i) => moves[i]).sort((x, y) => x - y);
        const hi = sorted[Math.floor(sorted.length * 0.8)], lo = sorted[Math.floor(sorted.length * 0.2)];
        const atr = ta.atr(p.c, 14);
        up.push(...fwdTrades(p.c, atr, grid.filter((i) => moves[i] >= hi), 1, H, ep.stats.costPct, p.coin));
        dn.push(...fwdTrades(p.c, atr, grid.filter((i) => moves[i] <= lo), -1, H, ep.stats.costPct, p.coin));
        ctlUp.push(...controlTrades(p.c, atr, 1, H, ep.stats.costPct, p.coin, WARMUP).filter((x, k) => k % H === 0));
        ctlDn.push(...controlTrades(p.c, atr, -1, H, ep.stats.costPct, p.coin, WARMUP).filter((x, k) => k % H === 0));
      }
      row("anchor", "after_rally", `大涨之后继续做多（${label}）`, up, ctlUp, "随便哪个时点做多");
      row("anchor", "after_drop", `大跌之后继续做空（${label}）`, dn, ctlDn, "随便哪个时点做空");
    }

    // ---- E11: exits, on the entries the plan would offer (with the higher timeframe), against a fixed 2R target on the same entries
    for (const pol of ["structure", "chandelier", "be_chandelier"] as ExitPolicy[]) {
      const sig: Trade[] = [], base: Trade[] = [];
      for (const p of preps) {
        const ctx = ctxOf(p, setup, ep);
        for (const { e, r } of sequential(p.events.filter((e) => agrees(e, "struct") && e.kind !== "reversal"), ctx, pol)) {
          const b = simulate(ctx, e.i, e.dir, e.stop, "fixed2r");
          if (!b) continue;
          sig.push(toTrade(p, e, r));
          base.push(toTrade(p, e, b));
        }
      }
      row("exit", pol, `${POLICY_NAME[pol]}（${label}）`, sig, base, POLICY_NAME.fixed2r);
      await tick();
    }

    // ---- E12: entry types × filter, against random timing (same direction, stop distance and exits)
    for (const kind of ["breakout", "pullback", "pullback_confirm", "reversal"] as EntryKind[]) {
      for (const filter of ["struct", "ema", "none"] as const) {
        if (kind === "reversal" && filter !== "none") continue; // a reversal is against the old trend by definition
        const sig: Trade[] = [], ctl: Trade[] = [];
        for (const [k, p] of preps.entries()) {
          const ctx = ctxOf(p, setup, ep);
          const taken = sequential(p.events.filter((e) => e.kind === kind && (filter === "none" || agrees(e, filter))), ctx, policy);
          for (const { e, r } of taken) sig.push(toTrade(p, e, r));
          ctl.push(...randomTrades(p, taken.map((x) => x.e), ctx, policy, 3, 1000 + k));
        }
        const fname = filter === "struct" ? "，只做和大周期结构同向" : filter === "ema" ? "，只做和大周期均线同向" : "";
        row("entry", `${kind}:${filter}`, `${ENTRY_NAME[kind]}${fname}（${label}）`, sig, ctl, "同方向、同止损距离的随机入场", 3);
        await tick();
      }
    }

    // ---- E13: the structural stop vs. a fixed ATR stop of the same average distance; equal highs / lows
    {
      const st: Trade[] = [], fx: Trade[] = [], eq: Trade[] = [], single: Trade[] = [];
      for (const p of preps) {
        const ctx = ctxOf(p, setup, ep);
        const taken = sequential(p.events.filter((e) => agrees(e, "struct") && e.kind !== "reversal"), ctx, policy);
        const avg = taken.reduce((s, { e }) => s + ((p.c[e.i].c - e.stop) * e.dir) / p.atr[e.i], 0) / Math.max(1, taken.length);
        for (const { e, r: a } of taken) {
          const b = simulate(ctx, e.i, e.dir, p.c[e.i].c - e.dir * avg * p.atr[e.i], policy);
          if (!b) continue;
          st.push(toTrade(p, e, a));
          fx.push(toTrade(p, e, b));
          (e.equal ? eq : single).push(toTrade(p, e, a));
        }
      }
      row("stop", "structure", `认错位放在结构点外（${label}）`, st, fx, "同平均距离的固定 ATR 止损");
      row("stop", "equal", `认错位挂在等高 / 等低点上（${label}）`, eq, single, "挂在单一高低点上");
    }

    // ---- E14: beginner habits, on the same entries, against following the plan
    {
      const plan: Trade[] = [], tight: Trade[] = [], early: Trade[] = [], against: Trade[] = [], withT: Trade[] = [], fade: Trade[] = [], follow: Trade[] = [];
      for (const p of preps) {
        const ctx = ctxOf(p, setup, ep);
        for (const { e, r: base } of sequential(p.events.filter((e) => e.kind !== "reversal" && agrees(e, "struct")), ctx, policy)) {
          plan.push(toTrade(p, e, base));
          withT.push(toTrade(p, e, base));
          const t = simulate(ctx, e.i, e.dir, p.c[e.i].c - e.dir * 0.3 * p.atr[e.i], policy);
          if (t) tight.push(toTrade(p, e, t));
          const q = simulate(ctx, e.i, e.dir, e.stop, "take05r");
          if (q) early.push(toTrade(p, e, q));
          if (e.kind === "breakout") {
            follow.push(toTrade(p, e, base));
            // "it's too high": short the breakout, stop just above the breakout bar
            const f = simulate(ctx, e.i, (-e.dir) as 1 | -1, e.dir > 0 ? p.c[e.i].h + 0.3 * p.atr[e.i] : p.c[e.i].l - 0.3 * p.atr[e.i], policy);
            if (f) fade.push(toTrade(p, e, f));
          }
        }
        for (const { e, r } of sequential(p.events.filter((e) => e.kind !== "reversal" && opposes(e, "struct")), ctx, policy)) against.push(toTrade(p, e, r));
      }
      row("behavior", "tight", `止损贴着入场价（0.3 倍 ATR）（${label}）`, tight, plan, "按计划放认错位");
      row("behavior", "early", `赚 0.5R 就走（${label}）`, early, plan, "按计划移动认错位");
      row("behavior", "against", `逆着大周期做（${label}）`, against, withT, "顺着大周期做");
      row("behavior", "fade", `觉得“太高 / 太低”，反着突破做（${label}）`, fade, follow, "跟随突破");
    }

    // ---- the plan scorecard: every plan the page would have shown as triggered, followed mechanically,
    // half size for reversals and trades against the higher timeframe (results in R of a full-size risk)
    {
      const all: Trade[] = [], allCtl: Trade[] = [], withT: Trade[] = [], withCtl: Trade[] = [];
      const size = (e: Event) => (e.kind === "reversal" || opposes(e, "struct") ? 0.5 : 1);
      for (const [k, p] of preps.entries()) {
        const ctx = ctxOf(p, setup, ep);
        const offered = p.events.filter((e) => e.kind !== "pullback");
        const taken = sequential(offered, ctx, policy);
        for (const { e, r } of taken) all.push(toTrade(p, e, r, size(e)));
        allCtl.push(...randomTrades(p, taken.map((x) => x.e), ctx, policy, 3, 2000 + k, size));
        const takenW = sequential(offered.filter((e) => e.kind !== "reversal" && agrees(e, "struct")), ctx, policy);
        for (const { e, r } of takenW) withT.push(toTrade(p, e, r));
        withCtl.push(...randomTrades(p, takenW.map((x) => x.e), ctx, policy, 3, 3000 + k));
        await tick();
      }
      row("plan", "page", `按页面计划机械执行：突破、回调确认和反转都做，逆势和反转半仓（${label}）`, all, allCtl, "同方向、同止损距离、同仓位的随机入场", 3);
      row("plan", "with", `只做顺大周期的计划（${label}）`, withT, withCtl, "同方向、同止损距离的随机入场", 3);
    }
  }

  // BH over the rows that test a hypothesis (all of them here)
  const q = bhAdjust(rows.map((r) => (r.cells.is.n >= ep.stats.minSamples ? r.cells.is.p : null)));
  return {
    kind: "plans",
    title: "交易计划的依据：价格锚定、离场、入场、认错位、新手习惯（E10–E14）与计划成绩单",
    createdAt: Date.now(),
    source: PRIMARY_SOURCE,
    paramsVersion: opts.paramsVersion,
    costPct: ep.stats.costPct,
    alpha: ep.stats.alpha,
    holdoutFrom,
    coins,
    coverage,
    rows: rows.map((r, k) => ({ ...r, q: q[k], ...judge(r.cells, q[k], ep.stats.alpha, ep.stats.minSamples) })),
    notes: [
      `入场在触发 K 线收盘；认错位 = 保护性摆动点外加 p80 扫损缓冲（只用样本内数据校准）；离场默认按“${POLICY_NAME[policy]}”，4 小时最多持有 30 天、日线 90 天。`,
      "结果以 R 计（R = 入场到初始认错位的距离），已扣往返成本。按风险定仓位时，R 可以直接比较。",
      "每一行都和括号外写明的对照比较：随机入场、固定 2R、同平均距离的固定止损，或按计划执行。",
      "同一个币、同一条规则同一时间只持有一笔：上一笔离场后才接下一个信号，样本互不重叠。",
      "计划成绩单按页面的规则机械执行；半仓的单子按一半计入，所以结果仍以满仓的一份风险（R）为单位。样本外一栏就是最近 12 个月的滚动表现。",
      "“和大周期同向”有两种判定：结构（更高的高低点或正在向上脱离区间）和均线（收盘在 50 均线之上且均线向上）。",
      "10 个币走势高度相关，合并后的显著性偏乐观，以 BTC / ETH 分开的结果是否一致为准。",
    ],
    durationMs: Date.now() - t0,
  };
}
