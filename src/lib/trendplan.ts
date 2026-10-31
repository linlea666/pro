import { closedThrough, type KlineResult } from "./data/klines.ts";
import { getPerpSnapshot, openInterestSeries } from "./data/perp.ts";
import { cutoff, horizonText, keyLevels, relevel, ReplayError, seriesAt } from "./analysis.ts";
import { logger } from "./server/log.ts";
import { currentParams } from "./server/params-store.ts";
import { getCalibration } from "./server/riskcalib.ts";
import { DEFAULT_ENGINE_PARAMS, type EngineParams } from "./params.ts";
import { getReport, type ReportKind, type ResearchReport, type ResearchRow } from "./research/run.ts";
import { simulate } from "./research/sim.ts";
import { liveDefends, lowerReady, LOWER_WARMUP, nearStop, planNearStop, type LowerFrame } from "./ta/defend.ts";
import { buildPlans, findEntries, higherDirection, MAX_HOLD_BARS, stopOption, type DefendPlan, type EntryKind, type NearFarStats, type PlanEvidence, type SidePlan } from "./ta/plan.ts";
import { atrSeries, bufferAtr } from "./ta/risk.ts";
import { defenseTiers, type DefenseLine } from "./ta/tiers.ts";
import { weekLine, type WeekLine } from "./ta/weekline.ts";
import { bigTrendOf, type BigTrend } from "./ta/bigtrend.ts";
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

/** A trade followed with the page's rules from its entry: closed, or still open (marked at the last close). */
export interface StopResult {
  stop: number;
  status: "open" | "closed";
  /** result in R after costs */
  r: number;
  exit: "stop" | "target" | "time" | null;
  exitT: number | null;
  /** best excursion in R before the exit (closed trades) */
  mfe: number | null;
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
  /** the same entry with the near stop, when the plan had one (4-hour entries) */
  near: StopResult | null;
}

/** What happened after a defended level was traded: with the far stop and with the near one. */
export interface DefendOutcome {
  entryT: number;
  entry: number;
  far: StopResult;
  near: StopResult | null;
}

/** E16 in a few numbers: do key levels run further than random prices before they fail? */
export interface LevelReach {
  tf: Timeframe;
  methods: number;
  /** methods judged better / worse than random lines */
  better: number;
  worse: number;
  /** share reaching 2R before the stop, %: range over the methods, and random lines */
  reach2: [number, number] | null;
  reach2Random: number | null;
  text: string;
  /** one line for the price ladder */
  short: string;
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
  levels: { price: number; side: "support" | "resistance"; strength: number; methods: string[]; methodCount?: number; tfs?: string[] }[];
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
  /** near / mid / far lines of defence for a long (below) and a short (above), described only */
  defenses: { long: DefenseLine[]; short: DefenseLine[] };
  /** closed weekly closes against their 50-week average, described only (E24); null under 50 weeks */
  week50: WeekLine | null;
  /** 周线、日线的大趋势（只描述）；数据不够时为 null */
  big: BigTrend | null;
  /** research on defended levels and near stops: rows the lessons quote, and a line per stall sign */
  defendLessons: ScoreRow[];
  defendChecks: Record<"flow" | "oi" | "turn", string> | null;
  /** near against far stops on the page's plans (4-hour entries), and when that sample starts */
  nearFar: { plans: NearFarStats | null; defend: NearFarStats | null; since: string | null; note: string | null };
  levelReach: LevelReach | null;
  replay?: { end: number; future: Candle[]; long: PlanOutcome | null; short: PlanOutcome | null; defend: { long: DefendOutcome | null; short: DefendOutcome | null } };
}

const CHART_BARS = 150;
/** how long a waiting plan stays the plan, for replays */
const WATCH_BARS = 30;

const r3 = (x: number) => Math.round(x * 1000) / 1000;
const signedR = (x: number | null) => (x == null ? "—" : `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(2)}R`);

// ---------------------------------------------------------------- research

const reportMemo = new Map<ReportKind, { at: number; value: (ResearchReport & { id: number }) | null }>();

export function latestReport(kind: ReportKind) {
  const hit = reportMemo.get(kind);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.value;
  let value: (ResearchReport & { id: number }) | null = null;
  try {
    value = getReport(undefined, kind);
  } catch {
    // no database (CLI, tests): plans without evidence
  }
  reportMemo.set(kind, { at: Date.now(), value });
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
  const report = latestReport("plans");
  if (!report) return { report: null, rows: new Map<string, ResearchRow>() };
  return { report, rows: new Map(report.rows.filter((r) => r.tf === tf).map((r) => [r.key, r])) };
}

/** The conclusion of a research row in words: a plan against random entries, or one way against another. */
export function verdictWords(r: ResearchRow | undefined, what: "plan" | "diff"): string {
  if (!r) return what === "plan" ? "研究数字会在服务器生成研究报告后显示" : "研究数字会在服务器生成研究报告后显示。";
  switch (r.verdict) {
    case "有优势":
      return what === "plan" ? "历史上比同方向、同止损距离的随机入场好，统计上站得住" : "近止损平均每笔明显更好，统计上站得住。";
    case "比随机差":
      return what === "plan" ? "历史上比同方向、同止损距离的随机入场差，统计上站得住" : "近止损平均每笔明显更差，统计上站得住。";
    case "样本不足":
      return what === "plan" ? "样本还不够，下不了结论" : "样本还不够，下不了结论。";
    default:
      return what === "plan" ? "历史上没有可证明的优势：和同方向、同止损距离的随机入场比，差别在统计上站不住，或在各段数据上方向不一致" : "两种止损平均每笔的差别不能确定。";
  }
}

function nearFarOf(r: ResearchRow | undefined): NearFarStats | null {
  if (!r) return null;
  const e = r.extra ?? {};
  const v = (k: string) => (e[k] == null ? null : e[k]);
  return {
    key: r.key,
    n: r.cells.is.n + r.cells.oos.n,
    near: { stopPct: v("stopPct"), quickPct: v("quickStopPct"), reach2: v("reach2") },
    far: { stopPct: v("far_stopPct"), quickPct: v("far_quickStopPct"), reach2: v("far_reach2") },
    edgeR: r.cells.is.edgeR,
    oosEdgeR: r.cells.oos.edgeR,
    verdict: r.verdict,
  };
}

/** One sentence on near against far stops for plans like this one. */
function nearFarText(s: NearFarStats | null, row: ResearchRow | undefined, since: string | null): string {
  if (!s) return verdictWords(undefined, "diff");
  const pct = (x: number | null) => (x == null ? "—" : `${x}%`);
  return `${since ? `${since} 以来` : "最近"}同类 ${s.n} 笔：近止损 24 小时内被扫 ${pct(s.near.quickPct)}，止损前先到 2R ${pct(s.near.reach2)}；远止损分别是 ${pct(s.far.quickPct)}、${pct(s.far.reach2)}。${verdictWords(row, "diff")}`;
}

const DEFEND_ROW: Record<string, string> = { "pivot:sweep": "defend:sweep", "pivot:rejection": "defend:rejection", flip: "defend:flip", fresh: "defend:fresh" };
const CHECK_NAME = { flow: "主动成交", oi: "持仓量骤降", turn: "1 小时转强" } as const;

/** E16 from the latest levels report, for the entry timeframe; the conclusion is worded from the verdicts. */
function levelReachOf(tf: Timeframe): LevelReach | null {
  const rep = latestReport("levels");
  const rows = rep?.rows.filter((r) => r.family === "level_mfe" && r.tf === tf) ?? [];
  const methods = rows.filter((r) => !r.key.endsWith(":random"));
  if (!methods.length) return null;
  const rnd = rows.find((r) => r.key.endsWith(":random"));
  const reach = methods.map((r) => r.extra?.reach2).filter((x): x is number => x != null);
  const better = methods.filter((r) => r.verdict === "有优势").length;
  const worse = methods.filter((r) => r.verdict === "比随机差").length;
  const r2 = reach.length ? ([Math.min(...reach), Math.max(...reach)] as [number, number]) : null;
  const rr = rnd?.extra?.reach2 ?? null;
  const judged = better ? `${better} 种在统计上比随机价位好` : "没有一种在统计上比随机价位好";
  return {
    tf,
    methods: methods.length,
    better,
    worse,
    reach2: r2,
    reach2Random: rr,
    text: `${methods.length} 种找位方法里，价格回到位上之后，在止损（位外 0.85 倍 ATR）之前先走到 2R 的比例是 ${r2 ? `${r2[0]}%–${r2[1]}%` : "—"}，随机画的价位是 ${rr ?? "—"}%；守到止损来算，${judged}${worse ? `，${worse} 种更差` : ""}。`,
    short: `关键位只是沿途可能停顿的地方：研究里 ${methods.length} 种找位方法守到止损，${better ? `只有 ${better} 种` : "没有一种"}比守在随机价位上更好（E16）。`,
  };
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
    forming: formingBar,
    costPct: ep.stats.costPct,
    funding,
  });

  const { report, rows } = research(F.tf);
  for (const p of [plans.long, plans.short]) {
    const key = evidenceKey(p);
    const r = key ? rows.get(key) : undefined;
    p.evidence = r ? evidenceOf(r) : null;
  }

  // near stops and defended levels: researched for 4-hour entries with the hour chart only (E17, E18)
  const dRep = latestReport("defend");
  const dRows = new Map((dRep?.rows ?? []).filter((r) => r.tf === F.tf).map((r) => [r.key, r]));
  const measuredRules = dRep?.rules ?? DEFAULT_ENGINE_PARAMS.defend;
  // numbers measured with other settings describe another rule: hidden until the next report
  const rulesChanged = (Object.keys(ep.defend) as (keyof EngineParams["defend"])[]).some((k) => measuredRules[k] !== ep.defend[k]);
  const dRow = (k: string) => (rulesChanged ? undefined : dRows.get(k));
  const since = dRep?.coverage.find((c) => c.tf === "1h")?.from;
  const sinceText = since ? new Date((since + LOWER_WARMUP * 3600) * 1000).toISOString().slice(0, 7) : null;
  const nearFar = {
    plans: nearFarOf(dRow("stop2:near:plans")),
    defend: nearFarOf(dRow("stop2:near:defend")),
    since: sinceText,
    note: rulesChanged ? "守位和近止损的参数改过，等下一份研究报告再显示历史数字。" : dRep ? null : "近止损和守位的研究数字会在服务器生成研究报告后显示。",
  };
  const H1 = F.tf === "4h" ? frames.get("1h") : undefined;
  const lower: LowerFrame | null =
    H1 && byTf.get("1h")!.source === main.source && H1.c.length > LOWER_WARMUP
      ? { c: H1.c, atr: H1.atr, ss: H1.ss, buf: bufferAtr(replayEnd == null ? getCalibration(coin, "1h") : null, 80) }
      : null;
  const lowerTimes = lower ? lower.c.map((x) => x.t) : [];
  const defends = F.tf === "4h"
    ? liveDefends({ tf: F.tf, c: E.c, atr: E.atr, ss: E.ss, filterAt, buf: plans.buffers.p80, lower, oi: openInterestSeries(coin, end, end - 40 * 86400), rules: ep.defend, forming: formingBar, livePrice: live, cal, costPct: ep.stats.costPct, funding })
    : { long: null, short: null };
  for (const p of [plans.long, plans.short]) {
    const dir = p.side === "long" ? 1 : -1;
    const lo = dir > 0 ? "低" : "高";
    if (p.invalidation && p.entry != null) {
      if (F.tf !== "4h") p.nearNote = "这个节奏没有近止损的研究，只给结构认错位";
      else if (p.status === "watch") p.nearNote = `触发后按 1 小时结构算：1 小时最近${lo}点之外再留扫损缓冲（至少 ${ep.defend.minNearAtr} 倍 ATR），比上面的认错位近时才有这一档`;
      else if (!lower) p.nearNote = "没有可用的 1 小时数据，只有结构认错位一档";
      else {
        const i = E.c.findIndex((x) => x.t === p.entryT);
        const r = i >= 0 ? planNearStop({ lower, times: lowerTimes, tf: F.tf, c: E.c, atr: E.atr, i, dir, far: p.invalidation.stop, forming: formingBar, minAtr: ep.defend.minNearAtr }) : { stop: null, note: null };
        p.near = r.stop != null ? stopOption({ entry: E.c[i].c, stop: r.stop, dir, atr: E.atr[i], cal, tf: F.tf, costPct: ep.stats.costPct, funding }) : null;
        p.nearNote = r.note;
      }
      if (F.tf === "4h") {
        // the research measured near stops on plans with the daily direction that are not reversals
        const measured = p.alignment === "with" && p.kind !== "reversal";
        p.nearStats = measured ? nearFar.plans : null;
        p.nearText = !measured ? "这类计划（不顺日线方向，或是反转）没有单独测过近止损。" : nearFar.note ?? nearFarText(nearFar.plans, dRow("stop2:near:plans"), sinceText);
      }
    }
    const d: DefendPlan | null = defends[p.side];
    if (d) {
      const r = dRow(DEFEND_ROW[d.levelKind === "pivot" ? `pivot:${d.shape}` : d.levelKind]) ?? dRow("defend:all");
      d.evidence = r ? evidenceOf(r) : null;
      d.verdictText = nearFar.note ?? verdictWords(r, "plan");
      d.stats = nearFar.defend;
      d.statsText = nearFar.note ?? nearFarText(nearFar.defend, dRow("stop2:near:defend"), sinceText);
      p.defend = d;
    }
  }
  const evRow = (k: keyof typeof CHECK_NAME) => dRow(`defend:ev:${k}:far`);
  const defendChecks =
    F.tf === "4h" && dRep && !rulesChanged
      ? (Object.fromEntries(
          (Object.keys(CHECK_NAME) as (keyof typeof CHECK_NAME)[]).map((k) => {
            const r = evRow(k);
            const text = r
              ? `有这一项的守位平均每笔 ${signedR(r.cells.is.meanR)}，没有的 ${signedR(r.cells.is.meanR != null && r.cells.is.edgeR != null ? r.cells.is.meanR - r.cells.is.edgeR : null)}（样本内 ${r.cells.is.n} 笔有）。${r.verdict === "有优势" || r.verdict === "比随机差" ? "差别在统计上站得住。" : r.verdict === "样本不足" ? "样本还不够。" : "有没有这一项，历史上结果的差别不能确定。"}`
              : "研究数字会在服务器生成研究报告后显示。";
            return [k, `${CHECK_NAME[k]}：${text}`];
          }),
        ) as Record<keyof typeof CHECK_NAME, string>)
      : null;

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
    levels: [...all.supports.slice(0, 4), ...all.resistances.slice(0, 4)].map((l) => ({ price: l.price, side: l.side, strength: l.strength, methods: l.methods.slice(0, 3), methodCount: l.methods.length, tfs: [...l.timeframes].sort((a, b) => TF_SECONDS[b] - TF_SECONDS[a]).map((t) => TF_LABEL[t]) })),
    candles: formingBar ? [...E.c.slice(-CHART_BARS), formingBar] : E.c.slice(-CHART_BARS),
    forming: !!formingBar,
    daily: daily.slice(-91).map((x) => x.c),
    costPct: ep.stats.costPct,
    scorecard: report ? scorecardOf(report, rows, F.tf) : null,
    lessons: LESSON_KEYS.map((k) => rows.get(k)).filter((x): x is ResearchRow => !!x).map(scoreRow),
    week50: weekLine((frames.get("1w")?.c ?? []).map((x) => x.c)),
    big: frames.get("1w") && frames.get("1d") ? bigTrendOf({ w: frames.get("1w")!, d: frames.get("1d")! }, mult) : null,
    defenses: (() => {
      const tierIn = { tf: F.tf, c: E.c, atr: E.atr, sw: E.sw, higherTf: F.filter, higher: H.ss[H.ss.length - 1] ?? null, daily: frames.get("1d")?.c ?? [], endSec: E.c[L].t + TF_SECONDS[F.tf], live };
      return { long: defenseTiers(tierIn, 1), short: defenseTiers(tierIn, -1) };
    })(),
    defendLessons: ["defend:all", "stop2:near:plans"].map((k) => dRow(k)).filter((x): x is ResearchRow => !!x).map(scoreRow),
    defendChecks,
    nearFar,
    levelReach: levelReachOf(F.tf),
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
    const run = (i: number, dir: 1 | -1, stop: number): StopResult => {
      const entry = full[i].c;
      const res = simulate(ctx, i, dir, stop, "structure");
      if (res) return { stop, status: "closed", r: r3(res.r), exit: res.exit, exitT: full[i + res.bars].t, mfe: r3(res.mfe) };
      // still open at the end of the stored bars: marked at the last close
      const last = full[full.length - 1].c;
      const R = (entry - stop) * dir;
      return { stop, status: "open", r: r3((dir * (last - entry) - (ep.stats.costPct / 100) * entry) / R), exit: null, exitT: null, mfe: null };
    };
    // the hour chart with what came after the moment, for plans that trigger later (as the research placed their near stop)
    const hAfter = lower ? byTf.get("1h")!.candles.filter((x) => x.t + 3600 <= closedThrough(byTf.get("1h")!)) : [];
    const lowerAfter: LowerFrame | null = lower ? { ...frame("1h", hAfter, mult), buf: lower.buf } : null;
    const timesAfter = lowerAfter ? lowerAfter.c.map((x) => x.t) : [];
    const nearAt = (i: number, dir: 1 | -1, far: number): number | null => {
      if (!lowerAfter || !lowerReady(timesAfter, full[i].t + secE)) return null;
      const n = nearStop(lowerAfter, timesAfter, dir, full[i].t + secE, full[i].c, fe.atr[i], undefined, ep.defend.minNearAtr);
      return n != null && (n - far) * dir > 0 ? n : null;
    };
    const outcome = (p: SidePlan): PlanOutcome | null => {
      if (!p.kind || p.status === "none") return null;
      const dir = p.side === "long" ? 1 : -1;
      const base = { kind: p.kind, watchBars: WATCH_BARS };
      let i = -1, stop = NaN, near: number | null = null;
      if (p.status === "active" && p.entryT != null && p.invalidation) {
        i = full.findIndex((x) => x.t === p.entryT);
        stop = p.invalidation.stop;
        near = p.near?.stop ?? null;
      } else {
        const ev = later.find((e) => e.dir === dir && e.kind === p.kind);
        if (ev) {
          i = ev.i;
          stop = ev.stop;
          near = F.tf === "4h" ? nearAt(i, dir, stop) : null;
        }
      }
      if (i < 0) return { ...base, status: "none", entryT: null, entry: null, stop: null, r: null, exit: null, exitT: null, mfe: null, near: null };
      const r = run(i, dir, stop);
      return { ...base, status: r.status, entryT: full[i].t, entry: full[i].c, stop, r: r.r, exit: r.exit, exitT: r.exitT, mfe: r.mfe, near: near != null ? run(i, dir, near) : null };
    };
    const defendOutcome = (d: DefendPlan | null): DefendOutcome | null => {
      if (!d) return null;
      const i = full.findIndex((x) => x.t === d.entryT);
      if (i < 0) return null;
      const dir = d.side === "long" ? 1 : -1;
      return { entryT: d.entryT, entry: d.entry, far: run(i, dir, d.far.stop), near: d.near ? run(i, dir, d.near.stop) : null };
    };
    out.replay = {
      end: replayEnd,
      future: full.slice(L + 1, L + 1 + 200),
      long: outcome(plans.long),
      short: outcome(plans.short),
      defend: { long: defendOutcome(plans.long.defend), short: defendOutcome(plans.short.defend) },
    };
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
