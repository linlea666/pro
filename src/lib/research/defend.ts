import { MARK_SOURCE, PRIMARY_SOURCE, readStored } from "../data/klines.ts";
import { openInterestSeries } from "../data/perp.ts";
import type { EngineParams } from "../params.ts";
import { getDb } from "../server/db.ts";
import { RESEARCH_COINS } from "../symbols.ts";
import { findDefends, lastAtOrBefore, LOWER_WARMUP, nearStop, type DefendEvent, type LowerFrame } from "../ta/defend.ts";
import { roundStep } from "../ta/levels.ts";
import { atrSeries, bufferAtr, calibrate } from "../ta/risk.ts";
import { structureSeries } from "../ta/structure.ts";
import { TF_SECONDS, type Candle } from "../types.ts";
import { bhAdjust, cells, judge, makeSplit, type Split, type Trade } from "./engine.ts";
import { ctxOf, prepare, randomTrades, SETUPS, sequential, toTrade, type Prepared } from "./plans.ts";
import { loadHistory, type ResearchReport, type ResearchRow } from "./run.ts";
import { runUp, simulate, type SimContext, type SimResult } from "./sim.ts";

/**
 * E17 / E18: defending a level, and where the stop goes.
 *
 * E17 — the defend plans (src/lib/ta/defend.ts): 4-hour bars come to a held level (swept and closed back,
 * or rejected), to a broken level from the other side, or make a fresh extreme with a rejection, and the next
 * close turns back. Against random entries (same direction and stop distance), and then each piece of stall
 * evidence — taker flow, an open-interest flush, the hour chart turning — on the same events with and without
 * it. Evidence that passes in-sample (≥ 0.1R, significant after BH, the same sign on BTC, ETH and both halves)
 * is counted with equal weights; the count is judged once, on the held-out last 12 months. The daily direction
 * and the funding rate are background: shown, never counted.
 *
 * E18 — near vs far stops on the same entries (the defend plans and the page's other plans): the near stop sits
 * just beyond the extreme on the hour chart, the far one beyond the 4-hour structure. Results in R, so the
 * money at risk is the same and only the size differs. Then what could make the near stop worse than it looks:
 * slippage on stop orders, the mark price that exchanges trigger stops with, stops sitting where others' stops
 * crowd (round prices, clusters of wicks), and second tries at a level that has just swept the first.
 *
 * One position at a time per coin and rule; the hour chart (and so the near stop and the turn) only exists for
 * the hour history kept (2 years), open interest from the archive, funding from the stored history.
 */

const SETUP = SETUPS[0]; // 4-hour entries, daily direction
const WARMUP = 300;
/** stopped out within this many bars of the entry: caught "halfway down the hill" */
const QUICK_BARS = 6;
/** E18: extra slippage on stop exits, % of price */
const SLIP_PCT = 0.1;
/** E18: half-width of a crowded zone, and how far a crowded stop is moved, ATR */
const CROWD_ATR = 0.25;
const MOVE_ATR = 0.5;
/** E18: a second try is a defend within this many bars of one at the same extreme (±1 ATR) whose near stop was hit */
const SECOND_BARS = 30;

type Row = Omit<ResearchRow, "q" | "consistent" | "verdict">;
type Ev = { i: number; dir: 1 | -1; stop: number };
type Evidence = "flow" | "oi" | "turn";
const EVIDENCE: Evidence[] = ["flow", "oi", "turn"];
const EVIDENCE_NAME: Record<Evidence, string> = { flow: "主动成交：卖盘衰竭或被吸收", oi: "持仓量骤降（多头被洗出）", turn: "1 小时转强" };

interface Def extends DefendEvent {
  coin: string;
  /** funding crowded on the other side (fuel for this trade); null without funding history */
  fuel: boolean | null;
}

interface CoinData {
  p: Prepared;
  ctx: SimContext;
  lower: LowerFrame | null;
  lowerTimes: number[];
  /** mark-price bars aligned with p.c (BTC and ETH) */
  mark: (Candle | undefined)[] | null;
  defs: Def[];
}

/**
 * Funding crowded against `dir` at time `at`: the last settlement is in the bottom fifth of the 90 days
 * before (shorts paying, for a long) or the top fifth (longs paying, for a short).
 */
export function fundingFuel(f: { t: number[]; rate: number[] }, dir: 1 | -1, at: number): boolean | null {
  const k = lastAtOrBefore(f.t, at);
  if (k < 0 || at - f.t[k] > 12 * 3600) return null;
  const from = lastAtOrBefore(f.t, at - 90 * 86400) + 1;
  const past = f.rate.slice(from, k + 1).sort((a, b) => a - b);
  if (past.length < 60) return null;
  return dir > 0 ? f.rate[k] <= past[Math.floor(past.length * 0.2)] : f.rate[k] >= past[Math.floor(past.length * 0.8)];
}

function load(coin: string, ep: EngineParams, nowSec: number, holdoutFrom: number): CoinData | null {
  const p = prepare(coin, SETUP, ep, nowSec, holdoutFrom);
  if (!p) return null;
  const ctx = ctxOf(p, SETUP, ep);
  let lower: LowerFrame | null = null;
  const h = loadHistory(coin, "1h", nowSec);
  if (h.length >= 600) {
    const hatr = atrSeries(h);
    const isEnd = h.findIndex((x) => x.t >= holdoutFrom);
    const cal = calibrate(h.slice(0, isEnd > 0 ? isEnd : h.length), "1h", ep.horizon["1h"]);
    lower = { c: h, atr: hatr, ss: structureSeries(h, hatr, ep.structure.swingAtr), buf: bufferAtr(cal, 80) };
  }
  let mark: CoinData["mark"] = null;
  const sec = TF_SECONDS[SETUP.tf];
  const m = readStored(coin, SETUP.tf, MARK_SOURCE, 1_000_000).filter((x) => x.t + sec <= nowSec);
  if (m.length) {
    const byT = new Map(m.map((x) => [x.t, x]));
    mark = p.c.map((x) => byT.get(x.t));
  }
  const fr = getDb().prepare("SELECT t, rate FROM funding_rates WHERE coin = ? AND source = ? AND t <= ? ORDER BY t").all(coin, PRIMARY_SOURCE, nowSec) as { t: number; rate: number }[];
  const funding = { t: fr.map((x) => x.t), rate: fr.map((x) => x.rate) };
  const defs = findDefends({ tf: SETUP.tf, c: p.c, atr: p.atr, ss: p.ss, filterAt: p.fDir, buf: p.buf.p80, lower, oi: openInterestSeries(coin, nowSec), from: WARMUP, rules: ep.defend }).map((d) => ({
    ...d,
    coin,
    fuel: fundingFuel(funding, d.dir, d.t + sec),
  }));
  return { p, ctx, lower, lowerTimes: lower ? lower.c.map((x) => x.t) : [], mark, defs };
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.floor(s.length / 2)] * 100) / 100;
};
const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : null);
const meanR = (xs: number[]) => (xs.length ? Math.round((xs.reduce((s, v) => s + v, 0) / xs.length) * 1000) / 1000 : null);

/** Trade-shape numbers for a list of simulated trades: stopped out, stopped quickly, typical drawdown, how far before the stop. */
function shape(list: { r: SimResult; reach: number }[], prefix = ""): Record<string, number | null> {
  return {
    [`${prefix}stopPct`]: pct(list.filter((x) => x.r.exit === "stop" && x.r.r < 0).length, list.length),
    [`${prefix}quickStopPct`]: pct(list.filter((x) => x.r.exit === "stop" && x.r.r < 0 && x.r.bars <= QUICK_BARS).length, list.length),
    [`${prefix}maeMedR`]: median(list.map((x) => x.r.mae)),
    [`${prefix}reach1`]: pct(list.filter((x) => x.reach >= 1).length, list.length),
    [`${prefix}reach2`]: pct(list.filter((x) => x.reach >= 2).length, list.length),
    [`${prefix}reach3`]: pct(list.filter((x) => x.reach >= 3).length, list.length),
  };
}

export async function defendReport(
  ep: EngineParams,
  opts: { paramsVersion: number; coins?: string[]; nowSec?: number } = { paramsVersion: 0 },
): Promise<ResearchReport> {
  const t0 = Date.now();
  const { coins = RESEARCH_COINS, nowSec = Date.now() / 1000 } = opts;
  const tick = () => new Promise((ok) => setImmediate(ok));
  const tf = SETUP.tf;
  const sec = TF_SECONDS[tf];
  const pre = makeSplit(Date.parse("2017-01-01") / 1000, nowSec);
  const data: CoinData[] = [];
  for (const coin of coins) {
    const d = load(coin, ep, nowSec, pre.holdoutFrom);
    if (d) data.push(d);
    await tick();
  }
  const coverage: ResearchReport["coverage"] = [];
  const groups: Row[][] = [];
  if (!data.length) return empty();
  const first = Math.min(...data.map((d) => d.p.c[WARMUP].t));
  const split = makeSplit(first, nowSec);
  coverage.push({ tf, coins: data.length, bars: Math.round(data.reduce((s, d) => s + d.p.c.length, 0) / data.length), from: first, to: Math.max(...data.map((d) => d.p.c[d.p.c.length - 1].t)), holdoutFrom: split.holdoutFrom });
  const withLower = data.filter((d) => d.lower);
  if (withLower.length) {
    const lf = Math.min(...withLower.map((d) => d.lower!.c[0].t));
    coverage.push({ tf: "1h", coins: withLower.length, bars: Math.round(withLower.reduce((s, d) => s + d.lower!.c.length, 0) / withLower.length), from: lf, to: Math.max(...withLower.map((d) => d.lower!.c[d.lower!.c.length - 1].t)), holdoutFrom: split.holdoutFrom });
  }
  // rows that need the hour chart start with it (after its warm-up) and are split on their own dates
  const hourFirst = withLower.length ? Math.min(...withLower.map((d) => d.lower!.c[0].t)) + LOWER_WARMUP * 3600 : first;
  const hourSplit = makeSplit(hourFirst, nowSec);
  const hourReady = (cd: CoinData, d: Def) => cd.lowerTimes.length > 0 && cd.lowerTimes[0] + LOWER_WARMUP * 3600 <= cd.p.c[d.e].t;
  const horizon = ep.horizon[tf];
  const mk = (family: Row["family"], key: string, name: string, sig: Trade[], ctl: Trade[], control: string, step: number, extra: Record<string, number | null> = {}, sp: Split = split): Row => ({
    family,
    key: `${family}:${key}`,
    name,
    side: "bull",
    tf,
    horizon,
    cells: cells(sig, ctl, sp, step),
    control,
    extra,
  });
  const far = (d: Def): Def & Ev => ({ ...d, stop: d.far });
  const near = (d: Def): Def & Ev => ({ ...d, stop: d.near! });
  // a near stop exists and is closer than the far one
  const hasNear = (d: Def) => d.near != null && (d.near - d.far) * d.dir > 0;
  const run = (cd: CoinData, evs: (Def & Ev)[]) => sequential(evs, cd.ctx, "structure");
  const reachOf = (cd: CoinData, e: Ev) => runUp(cd.ctx, e.i, e.dir, e.stop);

  // ---- E17: defend events against random entries; by shape
  const base: Row[] = [];
  const subsets: [string, string, (d: Def) => boolean][] = [
    ["all", "守位计划（全部）", () => true],
    ["sweep", "扫过完好的位后收回", (d) => d.shape === "sweep" && d.levelKind === "pivot"],
    ["rejection", "回测完好的位、长影线拒绝", (d) => d.shape === "rejection" && d.levelKind === "pivot"],
    ["flip", "突破后回踩（阻力变支撑）", (d) => d.levelKind === "flip"],
    ["fresh", "新高 / 新低后长影线拒绝", (d) => d.levelKind === "fresh"],
  ];
  for (const [key, name, f] of subsets) {
    const sig: Trade[] = [], ctl: Trade[] = [], sh: { r: SimResult; reach: number }[] = [];
    data.forEach((cd, k) => {
      const taken = run(cd, cd.defs.filter(f).map(far));
      for (const { e, r } of taken) {
        sig.push(toTrade(cd.p, e, r));
        sh.push({ r, reach: reachOf(cd, e) });
      }
      ctl.push(...randomTrades(cd.p, taken.map((x) => x.e), cd.ctx, "structure", 3, 1700 + k));
    });
    base.push(mk("defend", key, `${name}，远止损（结构认错位）`, sig, ctl, "同方向、同止损距离的随机入场", 3, shape(sh)));
    await tick();
  }

  // background, not counted: the daily direction and crowded funding
  {
    const withT: Trade[] = [], against: Trade[] = [], fuel: Trade[] = [], noFuel: Trade[] = [];
    for (const cd of data) {
      for (const { e, r } of run(cd, cd.defs.map(far))) {
        if (e.filter === e.dir) withT.push(toTrade(cd.p, e, r));
        else against.push(toTrade(cd.p, e, r));
        if (e.fuel === true) fuel.push(toTrade(cd.p, e, r));
        else if (e.fuel === false) noFuel.push(toTrade(cd.p, e, r));
      }
    }
    base.push(mk("defend", "bg:trend", "背景：日线方向相同", withT, against, "日线方向不同或不明", 1));
    base.push(mk("defend", "bg:funding", "背景：资金费率在反方向拥挤（燃料）", fuel, noFuel, "资金费率不拥挤", 1));
  }
  groups.push(base);

  // ---- E17 step 1: each piece of evidence, with vs without, on the same events (far and near stops)
  const evRows: Row[] = [];
  const evKey: { ev: Evidence; stop: "far" | "near"; row: Row }[] = [];
  for (const stop of ["far", "near"] as const) {
    const taken = data.map((cd) => ({ cd, list: run(cd, stop === "far" ? cd.defs.map(far) : cd.defs.filter(hasNear).map(near)) }));
    for (const ev of EVIDENCE) {
      const yes: Trade[] = [], no: Trade[] = [];
      let unknown = 0;
      for (const { cd, list } of taken) {
        for (const { e, r } of list) {
          if (e[ev] === true) yes.push(toTrade(cd.p, e, r));
          else if (e[ev] === false) no.push(toTrade(cd.p, e, r));
          else unknown++;
        }
      }
      const row = mk("defend", `ev:${ev}:${stop}`, `证据：${EVIDENCE_NAME[ev]}（${stop === "far" ? "远止损" : "近止损"}）`, yes, no, "同一类守位事件，没有这项证据", 1, { unknown }, stop === "near" || ev === "turn" ? hourSplit : split);
      evRows.push(row);
      evKey.push({ ev, stop, row });
    }
    await tick();
  }
  const evJudged = finish(evRows, ep);
  groups.push(evRows);

  // ---- E17 step 2: the evidence that passed in-sample, counted with equal weights; judged on the holdout
  const compRows: Row[] = [];
  const passedNote: string[] = [];
  for (const stop of ["far", "near"] as const) {
    const passed = EVIDENCE.filter((ev) => {
      const k = evKey.findIndex((x) => x.ev === ev && x.stop === stop);
      const r = evJudged[k];
      const c = r.cells;
      const sign = Math.sign(c.is.edgeR ?? 0);
      return sign > 0 && (c.is.edgeR ?? 0) >= 0.1 && r.q != null && r.q <= ep.stats.alpha && [c.btc, c.eth, c.firstHalf, c.secondHalf].every((g) => Math.sign(g.edgeR ?? 0) === sign);
    });
    const counted = passed.length ? passed : EVIDENCE;
    const label = passed.length ? passed.map((x) => EVIDENCE_NAME[x]).join("、") : "三项全计（没有一项通过第一步，仅供参考）";
    passedNote.push(`${stop === "far" ? "远止损" : "近止损"}：${passed.length ? `通过第一步的证据是 ${label}` : "没有一项证据通过第一步"}`);
    for (const need of [2, 3]) {
      if (need > counted.length) continue;
      const sig: Trade[] = [], ctl: Trade[] = [];
      for (const cd of data) {
        const known = cd.defs.filter((d) => counted.every((ev) => d[ev] != null) && (stop === "far" || hasNear(d)));
        const pick = stop === "far" ? far : near;
        const score = (d: Def) => counted.filter((ev) => d[ev] === true).length;
        for (const { e, r } of run(cd, known.filter((d) => score(d) >= need).map(pick))) sig.push(toTrade(cd.p, e, r));
        for (const { e, r } of run(cd, known.map(pick))) ctl.push(toTrade(cd.p, e, r));
      }
      compRows.push(mk("defend", `score${need}:${stop}`, `至少 ${need} 项证据（${label}；${stop === "far" ? "远止损" : "近止损"}）`, sig, ctl, "同期全部守位事件（不看证据）", 1, {}, stop === "near" || counted.includes("turn") ? hourSplit : split));
    }
  }
  groups.push(compRows);

  // ---- E17, the hour chart as timing: wait for it to turn (up to 6 bars, no new extreme) instead of entering at the stall
  const waitRows: Row[] = [];
  for (const stop of ["far", "near"] as const) {
    const sig: Trade[] = [], ctl: Trade[] = [];
    let events = 0, turned = 0;
    for (const cd of data) {
      const pool = cd.defs.filter((d) => hourReady(cd, d) && (stop === "far" || hasNear(d)));
      events += pool.length;
      const waited = pool.flatMap((d) => {
        const k = d.confirm;
        if (!k || (stop === "near" && !(k.near != null && (k.near - k.far) * d.dir > 0))) return [];
        return [{ ...d, i: k.i, stop: stop === "far" ? k.far : k.near! }];
      });
      turned += waited.length;
      for (const { e, r } of run(cd, waited)) sig.push(toTrade(cd.p, e, r));
      for (const { e, r } of run(cd, pool.map(stop === "far" ? far : near))) ctl.push(toTrade(cd.p, e, r));
    }
    waitRows.push(mk("defend", `wait:${stop}`, `等 1 小时转强再入场（${stop === "far" ? "远止损" : "近止损"}）`, sig, ctl, "拐头就入场，不等 1 小时", 1, { turnedPct: pct(turned, events) }, hourSplit));
  }
  groups.push(waitRows);

  // ---- E18: near vs far stops on the same entries, and what could make the near stop worse
  const stopRows: Row[] = [];
  const planNear = (cd: CoinData): (Ev & { near: number; far: number })[] => {
    if (!cd.lower) return [];
    const out: (Ev & { near: number; far: number })[] = [];
    for (const e of cd.p.events) {
      // the page's plans that go with the daily direction: breakouts and confirmed pullbacks (it never offers
      // entering inside the pullback zone, and reversals are against the old trend by definition)
      if (e.fStruct !== e.dir || e.kind === "reversal" || e.kind === "pullback") continue;
      const t = cd.p.c[e.i].t;
      if (cd.lowerTimes[0] > t - LOWER_WARMUP * 3600) continue;
      const n = nearStop(cd.lower, cd.lowerTimes, e.dir, t + sec, cd.p.c[e.i].c, cd.p.atr[e.i], undefined, ep.defend.minNearAtr);
      if (n == null || !((e.stop - n) * e.dir < 0)) continue;
      out.push({ i: e.i, dir: e.dir, stop: e.stop, near: n, far: e.stop });
    }
    return out;
  };
  const sets: [string, string, (cd: CoinData) => (Ev & { near: number; far: number })[]][] = [
    ["defend", "守位计划", (cd) => cd.defs.filter(hasNear).map((d) => ({ i: d.i, dir: d.dir, stop: d.far, near: d.near!, far: d.far }))],
    ["plans", "顺大周期的突破 / 回调计划", planNear],
  ];
  for (const [key, label, entriesOf] of sets) {
    const nearT: Trade[] = [], farT: Trade[] = [], nearSlip: Trade[] = [], farSlip: Trade[] = [], nearMark: Trade[] = [], nearLast: Trade[] = [];
    const crowded: Trade[] = [], clear: Trade[] = [], moved: Trade[] = [], unmoved: Trade[] = [];
    const onRound: Trade[] = [], offRound: Trade[] = [], onWicks: Trade[] = [], offWicks: Trade[] = [];
    const shN: { r: SimResult; reach: number }[] = [], shF: { r: SimResult; reach: number }[] = [], shMark: { r: SimResult; reach: number }[] = [], shLast: { r: SimResult; reach: number }[] = [];
    let crowdN = 0;
    for (const cd of data) {
      // the same entries for both stops: taken one at a time as the far-stop plan would hold them
      for (const { e, r: rf } of sequential(entriesOf(cd), cd.ctx, "structure")) {
        const n = { ...e, stop: e.near };
        const rn = simulate(cd.ctx, e.i, e.dir, e.near, "structure");
        if (!rn) continue;
        nearT.push(toTrade(cd.p, e, rn));
        farT.push(toTrade(cd.p, e, rf));
        shN.push({ r: rn, reach: reachOf(cd, n) });
        shF.push({ r: rf, reach: reachOf(cd, e) });
        const slipCtx = { ...cd.ctx, stopSlipPct: SLIP_PCT };
        const sn = simulate(slipCtx, e.i, e.dir, e.near, "structure"), sf = simulate(slipCtx, e.i, e.dir, e.far, "structure");
        if (sn && sf) {
          nearSlip.push(toTrade(cd.p, e, sn));
          farSlip.push(toTrade(cd.p, e, sf));
        }
        if (cd.mark && cd.mark[e.i]) {
          const markCtx = { ...cd.ctx, trigger: cd.mark };
          const rm = simulate(markCtx, e.i, e.dir, e.near, "structure");
          if (rm) {
            nearMark.push(toTrade(cd.p, e, rm));
            nearLast.push(toTrade(cd.p, e, rn));
            shMark.push({ r: rm, reach: runUp(markCtx, e.i, e.dir, e.near) });
            shLast.push({ r: rn, reach: reachOf(cd, n) });
          }
        }
        // crowded: a round price or a cluster of wicks within CROWD_ATR of the stop
        const A = cd.p.atr[e.i];
        const unit = roundStep(e.near) / 5;
        const round = Math.abs(e.near - Math.round(e.near / unit) * unit) <= CROWD_ATR * A;
        let wicks = 0;
        for (let j = Math.max(0, e.i - 99); j <= e.i; j++) if (Math.abs((e.dir > 0 ? cd.p.c[j].l : cd.p.c[j].h) - e.near) <= CROWD_ATR * A) wicks++;
        (round ? onRound : offRound).push(toTrade(cd.p, e, rn));
        (wicks >= 3 ? onWicks : offWicks).push(toTrade(cd.p, e, rn));
        if (round || wicks >= 3) {
          crowdN++;
          crowded.push(toTrade(cd.p, e, rn));
          const rm = simulate(cd.ctx, e.i, e.dir, e.near - e.dir * MOVE_ATR * A, "structure");
          if (rm) {
            moved.push(toTrade(cd.p, e, rm));
            unmoved.push(toTrade(cd.p, e, rn));
          }
        } else clear.push(toTrade(cd.p, e, rn));
      }
      await tick();
    }
    const S = (key2: string, name: string, sig: Trade[], ctl: Trade[], control: string, extra: Record<string, number | null> = {}) =>
      stopRows.push(mk("stop2", `${key2}:${key}`, `${name}：${label}`, sig, ctl, control, 1, extra, hourSplit));
    S("near", "近止损（1 小时极点外）对远止损", nearT, farT, "同一批入场，远止损（4 小时结构认错位）", { ...shape(shN), ...shape(shF, "far_") });
    // what the extra slippage costs each stop, all trades: mean R without minus mean R with
    const cost = (a: Trade[], b: Trade[]) => (a.length && b.length ? Math.round((meanR(a.map((x) => x.r))! - meanR(b.map((x) => x.r))!) * 1000) / 1000 : null);
    S("slip", `止损多滑 ${SLIP_PCT}% 时，近止损对远止损`, nearSlip, farSlip, `同一批入场，远止损，同样多滑 ${SLIP_PCT}%`, { slipCostNearR: cost(nearT, nearSlip), slipCostFarR: cost(farT, farSlip) });
    S("mark", "近止损按标记价触发（BTC / ETH）", nearMark, nearLast, "同一批入场，按最新成交价触发", { ...shape(shMark), ...shape(shLast, "last_") });
    S("crowded", "近止损落在整数价位或影线密集处", crowded, clear, "近止损不在这些地方", { crowdedPct: pct(crowdN, nearT.length) });
    S("crowded_round", "其中：近止损旁边有整数价位", onRound, offRound, "旁边没有整数价位", { pct: pct(onRound.length, nearT.length) });
    S("crowded_wicks", "其中：近止损旁边影线密集", onWicks, offWicks, "旁边影线不密集", { pct: pct(onWicks.length, nearT.length) });
    S("moved", `把拥挤处的近止损再往外挪 ${MOVE_ATR} 倍 ATR`, moved, unmoved, "同一批入场，不挪");
  }
  // second tries: a defend at an extreme within 1 ATR of one whose near stop was just hit
  {
    const second: Trade[] = [], firstT: Trade[] = [];
    for (const cd of data) {
      const all = cd.defs.filter(hasNear);
      const isSecond = (d: Def) =>
        all.some((m) => {
          if (m.dir !== d.dir || m.i >= d.i || m.i < d.i - SECOND_BARS || Math.abs(m.extreme - d.extreme) > cd.p.atr[d.i]) return false;
          for (let j = m.i + 1; j <= d.i; j++) if (d.dir > 0 ? cd.p.c[j].l <= m.near! : cd.p.c[j].h >= m.near!) return true;
          return false;
        });
      for (const { e, r } of run(cd, all.map(near))) (isSecond(e) ? second : firstT).push(toTrade(cd.p, e, r));
    }
    stopRows.push(mk("stop2", "second", "第二次守同一个位（上一次的近止损刚被扫）", second, firstT, "第一次守", 1, {}, hourSplit));
  }
  groups.push(stopRows);

  const rows = groups.flatMap((g) => finish(g, ep));
  const point = (coin: string) => {
    const cd = data.find((d) => d.p.coin === coin);
    if (!cd) return null;
    const rs = cd.defs.filter(hasNear).map((d) => ({ n: Math.abs(cd.p.c[d.i].c - d.near!), f: Math.abs(cd.p.c[d.i].c - d.far) }));
    return rs.length ? `${coin} 近 ${median(rs.map((x) => x.n))} / 远 ${median(rs.map((x) => x.f))}` : null;
  };
  return {
    kind: "defend",
    title: "守位计划：止跌 / 止涨证据，近止损与远止损",
    createdAt: Date.now(),
    source: PRIMARY_SOURCE,
    paramsVersion: opts.paramsVersion,
    rules: { ...ep.defend },
    costPct: ep.stats.costPct,
    alpha: ep.stats.alpha,
    holdoutFrom: split.holdoutFrom,
    coins: data.map((d) => d.p.coin),
    coverage,
    rows,
    notes: [
      "守位计划：4 小时价格来到完好的摆动高低点（扫过后收回，或长影线拒绝）、被突破过的位从另一侧回踩、或创 50 根新高 / 新低并长影线拒绝，之后第一次收盘拐回时入场。结果以 R（止损距离）计，扣成本，按“跟着结构移动认错位”离场，一个币同时只持有一笔。",
      "三项止跌 / 止涨证据（定义在看结果之前写定）：主动成交——新低处累计主动成交差高于上一个低点（卖盘衰竭），或放量（≥2 倍）、主动卖出占多却收回（被吸收）；持仓量——扫损前 4 小时到这根收盘，持仓量下降超过过去 30 天同长度变化的 p80；1 小时转强——极点之后 1 小时出现更高的低点并收盘站上前一个反弹高点。数据缺的时点不算“否”，单独计数。",
      `第一步只看样本内：某项证据“有”比“没有”至少好 0.1R、BH 校正后显著、BTC / ETH 和前后两半方向一致才算通过；第二步把通过的证据等权计数，看最近 12 个月样本外。${passedNote.join("；")}。`,
      "日线方向和资金费率只作背景，不计分。",
      "“等 1 小时转强再入场”：拐头之后最多 6 根 4 小时 K 线内、没有再创新低（新高）的前提下，1 小时出现更高的低点（更低的高点）并收盘越过前一个反弹点，就在那根 4 小时收盘入场；对照是同一批事件拐头就入场。",
      `近止损：1 小时保护性极点（含被守的极点）之外加 1 小时 p80 扫损缓冲，至少 0.5 倍 4 小时 ATR；远止损：4 小时结构认错位。两者在同一批入场上比较，按风险定仓位时每笔亏损都是 1R，差别只在仓位大小和被扫概率。止损距离中位数（点）：${["BTC", "ETH"].map(point).filter(Boolean).join("；") || "—"}。`,
      `“很快被扫”= 入场后 ${QUICK_BARS} 根内打到止损；“先到 kR”= 打到初始止损之前价格至少走到 k 倍止损距离。滑点敏感性：止损成交价再差 ${SLIP_PCT}%。标记价：BTC / ETH 用 Binance 标记价 K 线判断是否触发止损，成交仍按最新价。拥挤处：止损 ${CROWD_ATR} 倍 ATR 内有整数价位（BTC 约每 1,000）或过去 100 根里至少 3 根影线。`,
      "1 小时数据只保留 2 年，所以近止损和 1 小时转强的样本只有最近 2 年；持仓量来自 Binance 公开归档。",
    ],
    durationMs: Date.now() - t0,
  };

  function empty(): ResearchReport {
    return { kind: "defend", title: "守位计划：止跌 / 止涨证据，近止损与远止损", createdAt: Date.now(), source: PRIMARY_SOURCE, paramsVersion: opts.paramsVersion, costPct: ep.stats.costPct, alpha: ep.stats.alpha, holdoutFrom: pre.holdoutFrom, coins: [], coverage: [], rows: [], notes: ["本地历史不够，无法生成。"], durationMs: Date.now() - t0 };
  }
}

/** BH within one group of hypotheses, then the usual judgement. */
function finish(rows: Row[], ep: EngineParams): ResearchRow[] {
  const q = bhAdjust(rows.map((r) => (r.cells.is.n < ep.stats.minSamples ? null : r.cells.is.p)));
  return rows.map((r, k) => ({ ...r, q: q[k], ...judge(r.cells, q[k], ep.stats.alpha, ep.stats.minSamples) }));
}
