import { closedThrough, type KlineResult } from "./data/klines.ts";
import { getPerpSnapshot } from "./data/perp.ts";
import { cutoff, horizonText, keyLevels, relevel, ReplayError, seriesAt } from "./analysis.ts";
import { logger } from "./server/log.ts";
import { currentParams } from "./server/params-store.ts";
import { getCalibration } from "./server/riskcalib.ts";
import { DEFAULT_ENGINE_PARAMS, type EngineParams } from "./params.ts";
import { getReport, type ResearchReport, type ResearchRow } from "./research/run.ts";
import { simulate } from "./research/sim.ts";
import { buildPlans, findEntries, higherDirection, MAX_HOLD_BARS, type EntryKind, type PlanEvidence, type SidePlan } from "./ta/plan.ts";
import { atrSeries } from "./ta/risk.ts";
import { describeStructure, structureDirection, structureSeries, swings, type StructureState, type StructureView, type Swing } from "./ta/structure.ts";
import { TF_LABEL, TF_SECONDS, type Candle, type Timeframe } from "./types.ts";

/**
 * The trend map and the trading plans for one coin: the structure on every
 * timeframe of the framework, a long and a short plan on the entry timeframe
 * filtered by the one above it, and what the research says about such plans.
 * Like the analysis, only closed bars are used; a replay sees nothing after its moment.
 */

export type Framework = "4h" | "1d";

export const FRAMEWORKS: Record<Framework, { tf: Timeframe; filter: Timeframe; map: Timeframe[] }> = {
  // the default swing rhythm: the daily sets the direction, 4 hours finds the entry
  "4h": { tf: "4h", filter: "1d", map: ["1w", "1d", "4h", "1h"] },
  "1d": { tf: "1d", filter: "1w", map: ["1w", "1d", "4h"] },
};

export interface TrendMapRow {
  tf: Timeframe;
  /** filter: sets the direction; entry: plans are made here; context / reference: bigger / smaller picture */
  role: "context" | "filter" | "entry" | "reference";
  view: StructureView;
  /** the direction this timeframe gives the one below it */
  direction: 1 | -1 | 0;
  atr: number;
}

/** One research row, reduced to what the page shows. */
export interface ScoreRow {
  key: string;
  name: string;
  control: string | null;
  n: number;
  hit: number | null;
  meanR: number | null;
  /** the control's mean R (random entries, or the other way of doing it) */
  controlR: number | null;
  edgeR: number | null;
  oosN: number;
  oosMeanR: number | null;
  oosEdgeR: number | null;
  verdict: string;
}

export interface PlanScorecard {
  reportId: number;
  createdAt: number;
  source: string;
  /** start of the held-out last 12 months */
  holdoutFrom: number;
  /** following the page mechanically (all plans), and only the ones with the higher timeframe */
  rows: ScoreRow[];
  /** set when the last 12 months lost money */
  warning: string | null;
}

export interface PlanOutcome {
  kind: EntryKind;
  /** none: the trigger did not come within `watchBars`; open: still running at the end of the data */
  status: "none" | "open" | "closed";
  watchBars: number;
  entryT: number | null;
  entry: number | null;
  stop: number | null;
  /** result in R after costs (open: marked at the last close) */
  r: number | null;
  exit: "stop" | "target" | "time" | null;
  exitT: number | null;
  /** best excursion in R before the exit */
  mfe: number | null;
}

export interface TrendPlan {
  coin: string;
  framework: Framework;
  tf: Timeframe;
  filterTf: Timeframe;
  source: string;
  updatedAt: number;
  /** latest traded price (live) */
  price: number;
  closedPrice: number;
  lastClosedT: number;
  atr: number;
  map: TrendMapRow[];
  /** e.g. "日线上升趋势，4小时区间 / 转折中" */
  headline: string;
  /** which side is with the higher timeframe */
  bias: string;
  long: SidePlan;
  short: SidePlan;
  buffers: { p50: number; p80: number; p90: number };
  /** sweep buffers and noise curve measured on this coin (false: defaults) */
  calibrated: boolean;
  noise: [number, number][] | null;
  noiseHorizon: string | null;
  levels: { price: number; side: "support" | "resistance"; strength: number; methods: string[] }[];
  /** recent bars of the entry timeframe; the bar still forming last, when there is one */
  candles: Candle[];
  forming: boolean;
  /** last 91 daily closes, for the correlation between held coins */
  daily: number[];
  /** round-trip cost every result here has paid, % */
  costPct: number;
  scorecard: PlanScorecard | null;
  /** research rows the lessons quote: anchoring, exits, beginner habits, stops */
  lessons: ScoreRow[];
  replay?: { end: number; future: Candle[]; long: PlanOutcome | null; short: PlanOutcome | null };
}

const CHART_BARS = 150;
/** how long a waiting plan stays the plan, for replays */
const WATCH_BARS = 30;

const r3 = (x: number) => Math.round(x * 1000) / 1000;

// ---------------------------------------------------------------- research

let reportMemo: { at: number; value: (ResearchReport & { id: number }) | null } | null = null;

function latestPlansReport() {
  if (reportMemo && Date.now() - reportMemo.at < 10 * 60_000) return reportMemo.value;
  let value: (ResearchReport & { id: number }) | null = null;
  try {
    value = getReport(undefined, "plans");
  } catch {
    // no database (CLI, tests): plans without evidence
  }
  reportMemo = { at: Date.now(), value };
  return value;
}

export function scoreRow(r: ResearchRow): ScoreRow {
  const { is, oos } = r.cells;
  return {
    key: r.key,
    name: r.name,
    control: r.control ?? null,
    n: is.n,
    hit: is.hit,
    meanR: is.meanR,
    controlR: is.meanR != null && is.edgeR != null ? r3(is.meanR - is.edgeR) : null,
    edgeR: is.edgeR,
    oosN: oos.n,
    oosMeanR: oos.meanR,
    oosEdgeR: oos.edgeR,
    verdict: r.verdict,
  };
}

function evidenceOf(r: ResearchRow): PlanEvidence {
  return { key: r.key, n: r.cells.is.n, hit: r.cells.is.hit, meanR: r.cells.is.meanR, edgeR: r.cells.is.edgeR, oosEdgeR: r.cells.oos.edgeR, oosN: r.cells.oos.n, verdict: r.verdict };
}

/** The research row that measures a plan like this one. */
export function evidenceKey(p: SidePlan): string | null {
  if (!p.kind) return null;
  if (p.kind === "reversal") return "entry:reversal:none";
  return `entry:${p.kind}:${p.alignment === "with" ? "struct" : "none"}`;
}

const LESSON_KEYS = ["anchor:after_rally", "anchor:after_drop", "exit:structure", "stop:structure", "stop:equal", "behavior:tight", "behavior:early", "behavior:against", "behavior:fade"];

function research(tf: Timeframe) {
  const report = latestPlansReport();
  if (!report) return { report: null, rows: new Map<string, ResearchRow>() };
  return { report, rows: new Map(report.rows.filter((r) => r.tf === tf).map((r) => [r.key, r])) };
}

function scorecardOf(report: ResearchReport & { id: number }, rows: Map<string, ResearchRow>, tf: Timeframe): PlanScorecard | null {
  const list = ["plan:page", "plan:with"].map((k) => rows.get(k)).filter((x): x is ResearchRow => !!x).map(scoreRow);
  if (!list.length) return null;
  const page = list[0];
  const m = page.oosMeanR;
  const warning =
    m != null && m < 0 && page.oosN > 0
      ? `最近 12 个月，按页面计划机械执行平均每笔 ${m > -0.005 ? "约 0R" : `−${Math.abs(m).toFixed(2)}R`}（${page.oosN} 笔，已扣成本）：这套规则最近没有赚钱。照做时仓位要小，别指望靠它稳定盈利。`
      : null;
  return { reportId: report.id, createdAt: report.createdAt, source: report.source, holdoutFrom: report.coverage.find((c) => c.tf === tf)?.holdoutFrom ?? report.holdoutFrom, rows: list, warning };
}

// ---------------------------------------------------------------- the plan

interface Frame {
  tf: Timeframe;
  c: Candle[];
  atr: number[];
  ss: StructureState[];
  sw: Swing[];
}

function frame(tf: Timeframe, c: Candle[], mult: number): Frame {
  const atr = atrSeries(c);
  return { tf, c, atr, ss: structureSeries(c, atr, mult), sw: swings(c, atr, mult) };
}

const NO_VIEW: StructureView = { state: "range", breach: "none", label: "数据不足", position: "", protective: null, lastHigh: null, lastLow: null, legs: 0, ageBars: null, retracement: null, beyond: 0, swings: [] };

function biasText(filterTf: Timeframe, dir: 1 | -1 | 0, view: StructureView): string {
  const F = TF_LABEL[filterTf];
  // a range being left on a close counts as a direction too: say which
  const how = view.state === "range" ? `在向${dir > 0 ? "上" : "下"}脱离区间` : `结构向${dir > 0 ? "上" : "下"}`;
  if (dir > 0) return `${F}${how}：做多是顺势，做空是逆势（逆势只给半仓）。价格“已经涨了很多”不是做空的理由。`;
  if (dir < 0) return `${F}${how}：做空是顺势，做多是逆势（逆势只给半仓）。价格“已经跌了很多”不是做多的理由。`;
  return `${F}没有明确方向（${view.label}）：多空都不算顺势，等${F}走出更高或更低的高低点再加大仓位。`;
}

/**
 * The plan at the close of the last bar finished by `replayEnd` (null: live).
 * `ep` defaults to the saved engine parameters.
 */
export async function computeTrendPlan(coin: string, fw: Framework, ep: EngineParams = DEFAULT_ENGINE_PARAMS, replayEnd: number | null = null): Promise<TrendPlan> {
  const F = FRAMEWORKS[fw];
  const perpP = replayEnd == null ? getPerpSnapshot(coin).catch(() => null) : Promise.resolve(null);
  const raw = await Promise.all(F.map.map((tf) => seriesAt(coin, tf, replayEnd)));
  const byTf = new Map<Timeframe, KlineResult>(F.map.map((tf, k) => [tf, raw[k]]));
  const main = byTf.get(F.tf)!;
  const nowSec = closedThrough(main);
  const end = replayEnd ?? nowSec;
  const mult = ep.structure.swingAtr;
  const closedBy = (tf: Timeframe) => cutoff(byTf.get(tf)!.candles, tf, replayEnd ?? closedThrough(byTf.get(tf)!));
  const frames = new Map(F.map.map((tf) => [tf, frame(tf, closedBy(tf), mult)]));
  const E = frames.get(F.tf)!, H = frames.get(F.filter)!;
  if (E.c.length < 300) {
    if (replayEnd != null) throw new ReplayError("这个时间点之前的数据不足以判断结构，请选择更近的时间");
    throw new Error(`${coin} ${F.tf} 已收盘的 K 线太少（${E.c.length} 根）`);
  }
  const L = E.c.length - 1;
  const closedPrice = E.c[L].c;
  const formingBar = replayEnd == null ? (main.candles.find((x) => x.t + TF_SECONDS[F.tf] > nowSec) ?? null) : null;
  const live = formingBar ? formingBar.c : closedPrice;
  const filterAt = higherDirection(E.c, F.tf, H.c, F.filter, H.ss);

  // the stored calibration is measured on the whole history: a replay uses the defaults
  const cal = replayEnd == null ? getCalibration(coin, F.tf) : null;
  const [{ supports, resistances }, perp] = await Promise.all([keyLevels(coin, F.tf, closedPrice, E.atr[L], ep.levels, end, replayEnd != null), perpP]);
  const funding = perp ? { rate: perp.avgRate7d ?? perp.fundingRate, intervalH: perp.intervalHours ?? 8 } : null;
  const plans = buildPlans({
    tf: F.tf,
    filterTf: F.filter,
    c: E.c,
    atr: E.atr,
    ss: E.ss,
    sw: E.sw,
    filterAt,
    cal,
    levels: [...supports, ...resistances],
    livePrice: live,
    costPct: ep.stats.costPct,
    funding,
  });

  const { report, rows } = research(F.tf);
  for (const p of [plans.long, plans.short]) {
    const key = evidenceKey(p);
    const r = key ? rows.get(key) : undefined;
    p.evidence = r ? evidenceOf(r) : null;
  }

  const map: TrendMapRow[] = F.map.map((tf) => {
    const f = frames.get(tf)!;
    const n = f.c.length - 1;
    const role: TrendMapRow["role"] = tf === F.filter ? "filter" : tf === F.tf ? "entry" : TF_SECONDS[tf] > TF_SECONDS[F.filter] ? "context" : "reference";
    if (f.c.length < 30) return { tf, role, view: NO_VIEW, direction: 0, atr: 0 };
    return { tf, role, view: describeStructure(f.c, f.atr, f.ss, f.sw), direction: structureDirection(f.ss[n]), atr: r3(f.atr[n]) };
  });
  const fView = map.find((m) => m.role === "filter")!.view, eView = map.find((m) => m.role === "entry")!.view;
  const all = relevel([...supports, ...resistances], live);
  const daily = frames.get("1d")?.c ?? [];

  const out: TrendPlan = {
    coin,
    framework: fw,
    tf: F.tf,
    filterTf: F.filter,
    source: main.source,
    updatedAt: main.fetchedAt,
    price: live,
    closedPrice,
    lastClosedT: E.c[L].t,
    atr: r3(E.atr[L]),
    map,
    headline: `${TF_LABEL[F.filter]}${fView.label}，${TF_LABEL[F.tf]}${eView.label}`,
    bias: biasText(F.filter, filterAt(L), fView),
    long: plans.long,
    short: plans.short,
    buffers: { p50: r3(plans.buffers.p50), p80: r3(plans.buffers.p80), p90: r3(plans.buffers.p90) },
    calibrated: !!cal,
    noise: cal?.noise ?? null,
    noiseHorizon: cal ? horizonText(F.tf, cal.horizon) : null,
    levels: [...all.supports.slice(0, 4), ...all.resistances.slice(0, 4)].map((l) => ({ price: l.price, side: l.side, strength: l.strength, methods: l.methods.slice(0, 3) })),
    candles: formingBar ? [...E.c.slice(-CHART_BARS), formingBar] : E.c.slice(-CHART_BARS),
    forming: !!formingBar,
    daily: daily.slice(-91).map((x) => x.c),
    costPct: ep.stats.costPct,
    scorecard: report ? scorecardOf(report, rows, F.tf) : null,
    lessons: LESSON_KEYS.map((k) => rows.get(k)).filter((x): x is ResearchRow => !!x).map(scoreRow),
  };

  if (replayEnd != null) {
    // what happened next: the stored bars after the moment, the same rules applied as they came
    const secE = TF_SECONDS[F.tf];
    const full = main.candles.filter((x) => x.t + secE <= nowSec);
    const hAll = byTf.get(F.filter)!.candles.filter((x) => x.t + TF_SECONDS[F.filter] <= closedThrough(byTf.get(F.filter)!));
    const fe = frame(F.tf, full, mult), fh = frame(F.filter, hAll, mult);
    const filterAll = higherDirection(full, F.tf, hAll, F.filter, fh.ss);
    const ctx = { c: full, atr: fe.atr, swings: fe.sw, buf: plans.buffers.p80, costPct: ep.stats.costPct, maxBars: MAX_HOLD_BARS[F.tf] ?? 120 };
    const later = findEntries({ tf: F.tf, c: full, atr: fe.atr, ss: fe.ss, filterAt: filterAll, buf: plans.buffers.p80, from: L - 7 }).filter((e) => e.i > L && e.i <= L + WATCH_BARS);
    const outcome = (p: SidePlan): PlanOutcome | null => {
      if (!p.kind || p.status === "none") return null;
      const dir = p.side === "long" ? 1 : -1;
      const base = { kind: p.kind, watchBars: WATCH_BARS };
      let i = -1, stop = NaN;
      if (p.status === "active" && p.entryT != null && p.invalidation) {
        i = full.findIndex((x) => x.t === p.entryT);
        stop = p.invalidation.stop;
      } else {
        const ev = later.find((e) => e.dir === dir && e.kind === p.kind);
        if (ev) {
          i = ev.i;
          stop = ev.stop;
        }
      }
      if (i < 0) return { ...base, status: "none", entryT: null, entry: null, stop: null, r: null, exit: null, exitT: null, mfe: null };
      const entry = full[i].c;
      const res = simulate(ctx, i, dir, stop, "structure");
      if (res) return { ...base, status: "closed", entryT: full[i].t, entry, stop, r: r3(res.r), exit: res.exit, exitT: full[i + res.bars].t, mfe: r3(res.mfe) };
      // still open at the end of the stored bars: marked at the last close
      const last = full[full.length - 1].c;
      const R = (entry - stop) * dir;
      const marked = (dir * (last - entry) - (ep.stats.costPct / 100) * entry) / R;
      return { ...base, status: "open", entryT: full[i].t, entry, stop, r: r3(marked), exit: null, exitT: null, mfe: null };
    };
    out.replay = { end: replayEnd, future: full.slice(L + 1, L + 1 + 200), long: outcome(plans.long), short: outcome(plans.short) };
  }
  return out;
}

// ---------------------------------------------------------------- cached entry points

const TTL_MS = 60_000;
const cache = new Map<string, { at: number; value?: TrendPlan; pending?: Promise<TrendPlan> }>();

/** The live plan, cached for a minute (and per parameter version, so saved parameters apply at once). */
export async function getTrendPlan(coin: string, fw: Framework): Promise<TrendPlan> {
  const params = currentParams();
  const key = `${coin}:${fw}:${params.version}`;
  const hit = cache.get(key);
  if (hit?.value && Date.now() - hit.at < TTL_MS) return hit.value;
  if (hit?.pending) return hit.pending;
  for (const k of cache.keys()) if (!k.endsWith(`:${params.version}`)) cache.delete(k);
  const t0 = Date.now();
  const pending = computeTrendPlan(coin, fw, params.engine);
  cache.set(key, { at: hit?.at ?? 0, value: hit?.value, pending });
  try {
    const value = await pending;
    cache.set(key, { at: Date.now(), value });
    logger.debug("engine", `交易计划完成 ${coin} ${fw}`, { durationMs: Date.now() - t0 });
    return value;
  } catch (e) {
    if (hit?.value) cache.set(key, { at: hit.at, value: hit.value });
    else cache.delete(key);
    throw e;
  }
}

const replayCache = new Map<string, Promise<TrendPlan>>();

/** Time machine: the plan as it stood when the bar ending at `end` (Unix seconds) closed. */
export function trendPlanAt(coin: string, fw: Framework, end: number): Promise<TrendPlan> {
  const params = currentParams();
  const key = `${coin}:${fw}:${end}:${params.version}`;
  const hit = replayCache.get(key);
  if (hit) return hit;
  const p = computeTrendPlan(coin, fw, params.engine, end).catch((e) => {
    replayCache.delete(key);
    throw e;
  });
  replayCache.set(key, p);
  if (replayCache.size > 300) replayCache.delete(replayCache.keys().next().value!);
  return p;
}
