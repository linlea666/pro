import { closedThrough, type KlineResult } from "./data/klines.ts";
import { cutoff, ReplayError, seriesAt } from "./analysis.ts";
import { logger } from "./server/log.ts";
import { currentParams } from "./server/params-store.ts";
import { DEFAULT_ENGINE_PARAMS, type EngineParams } from "./params.ts";
import type { ResearchReport, ResearchRow } from "./research/run.ts";
import { prevPeriodHL } from "./ta/levels.ts";
import {
  findPatterns,
  LOCATED,
  PA_HIGHER,
  PA_PERIODS,
  PA_RULES,
  paLevelSource,
  PATTERN_NAME,
  PATTERNS,
  type PaFrame,
  type PaInput,
  type PaLevel,
  type PaLoc,
  type PaSetup,
  type PaTrend,
  type PatternKind,
} from "./ta/patterns.ts";
import { alignHigher } from "./ta/plan.ts";
import { atrSeries, bufferAtr, intactPivots, PIVOT_K } from "./ta/risk.ts";
import { describeStructure, structureSeries, swings, type Breach, type StructureState, type TrendState } from "./ta/structure.ts";
import { latestReport, scoreRow, type ScoreRow } from "./trendplan.ts";
import { TF_SECONDS, type Candle, type Timeframe } from "./types.ts";

/**
 * The naked-K page (裸 K): three steps a beginner can read on one screen — ① the trend on the chosen chart
 * (structure), ② where price is (at a support, at a resistance, or in the middle), ③ a confirming bar at a key level
 * within the last three bars (ta/patterns.ts, the same detector the E20 research measured), with the buy point, the
 * stop beyond the pattern's extreme and the risk in ATR. E20 found no pattern beats random entries with the same stop:
 * the page teaches that a pattern gives a clear entry and a clear place to be wrong, not a forecast.
 * Only closed bars decide anything; the bar still forming only gives the live price.
 */

export type PaTf = "15m" | "1h" | "4h" | "1d";
export const PA_TFS: PaTf[] = ["15m", "1h", "4h", "1d"];
/** the timeframes the research report covers (research/patterns.ts PA_TFS) */
const RESEARCHED: PaTf[] = ["4h", "1d"];

export const TF_CN: Record<Timeframe, string> = { "5m": "5 分钟", "15m": "15 分钟", "1h": "1 小时", "4h": "4 小时", "1d": "日线", "1w": "周线" };
/** closed bars sent for the chart and scanned for recent patterns */
const CHART_BARS = 150;
/** a confirming bar counts for step 3 when its close is one of the last this many closed bars */
export const RECENT_BARS = 3;
/** levels closer than this many ATR are one level */
export const LEVEL_MERGE_ATR = 0.25;
const LEVELS_PER_SIDE = 3;

const r2 = (x: number) => Math.round(x * 100) / 100;
const r3 = (x: number) => Math.round(x * 1000) / 1000;

export interface PaTrendView {
  state: TrendState;
  breach: Breach;
  /** the structure engine's label, e.g. "上升趋势" or "上升结构被打破（转向下跌中）" */
  label: string;
  /** one plain sentence, e.g. "4 小时上升：更高的高点和更高的低点" */
  sentence: string;
  /** where price is within the structure (structure engine) */
  detail: string;
}

export interface PaLevelRow {
  price: number;
  kind: PaLevel["kind"];
  name: string;
  side: "support" | "resistance";
  /** (price − close) / ATR */
  distAtr: number;
}

export type PaLocation = "support" | "resistance" | "mid";

export interface PaLocationView {
  loc: PaLocation;
  /** the level price is at (support / resistance) */
  level: PaLevelRow | null;
  sentence: string;
}

export interface PaSetupView {
  kind: PatternKind;
  name: string;
  dir: 1 | -1;
  status: PaSetup["status"];
  /** the price a close must get beyond to enter (above it for longs) */
  trigger: number;
  entry: number | null;
  extreme: number;
  stop: number;
  riskAtr: number;
  /** the risk is within PA_RULES.minRiskAtr … maxRiskAtr */
  ok: boolean;
  trend: PaTrend;
  loc: PaLoc | null;
  /** open times of the pattern's first bar, the bar it was classified on and the entry bar */
  startT: number;
  sT: number;
  eT: number | null;
  /** closed bars since the entry bar (0: the last closed bar) */
  barsAgo: number | null;
  /** entered, and a bar after the entry (the forming one included) has traded through the stop */
  stopped: boolean;
}

export interface PaResearchItem {
  kind: PatternKind;
  name: string;
  /** what the research says, worded from the verdicts */
  sentence: string;
  all: ScoreRow | null;
  text: ScoreRow | null;
  /** the textbook row's name: "关键位 + 顺势" (pin, engulf, inside) or "顺势" (2B, retest) */
  textName: string;
  /** share that reached 2R before the stop, and stopped out at a loss within 6 bars (in-sample, all trades), % */
  reach2: number | null;
  quickStopPct: number | null;
  /** patterns formed and the share confirmed (in-sample) */
  setups: number | null;
  triggerPct: number | null;
}

export interface PaResearch {
  reportId: number;
  createdAt: number;
  source: string;
  items: PaResearchItem[];
}

export interface PaView {
  coin: string;
  pf: PaTf;
  source: string;
  updatedAt: number;
  /** close of the last closed bar (Unix seconds), and its open time */
  end: number;
  lastClosedT: number;
  /** latest traded price (live: the forming bar), and the last close */
  price: number;
  closedPrice: number;
  forming: boolean;
  /** the last CHART_BARS closed bars, plus the bar still forming when live */
  candles: Candle[];
  atr: number;
  /** sweep buffer beyond the extreme, ATR (uncalibrated p80, as the research) */
  buf: number;
  trend: PaTrendView;
  levels: PaLevelRow[];
  location: PaLocationView;
  /** step 3: key-level setups entered within the last RECENT_BARS closed bars, or still waiting; null: none */
  confirm: PaSetupView[] | null;
  /** every entered or waiting setup on the chart's bars, any location (pro mode, chart markers) */
  recent: PaSetupView[];
  research: PaResearch | null;
  /** the next higher timeframe's structure at the last closed bar (15m, 1h → 4h; 4h → 1d; 1d → 1w); null: too few bars */
  higher: PaHigherView | null;
  /** the entry checklist: one per step-3 setup (same order as `confirm`), or one without a setup when there is none */
  checklists: PaChecklist[];
  /** the next key level beyond the entry, in R, per step-3 setup (same order as `confirm`) */
  nextLevels: PaNextLevel[];
  /** why research numbers are missing, when they are */
  researchNote: string | null;
  replay: boolean;
}

export interface PaHigherView {
  tf: Timeframe;
  state: TrendState;
  breach: Breach;
  /** e.g. "日线上升" */
  label: string;
}

export interface PaCheckItem {
  key: "higher" | "key" | "pattern" | "closed" | "risk";
  label: string;
  ok: boolean;
  /** what was found, e.g. "日线上升" or "等收盘高于 81,500" */
  detail: string;
}

export interface PaChecklist {
  /** the step-3 setup it is for (null: no setup yet) */
  kind: PatternKind | null;
  dir: 1 | -1 | null;
  items: PaCheckItem[];
  /** items ticked, of 5 */
  score: number;
  /** always says that 5/5 is not a forecast; adds what the research says when there is a report for this timeframe */
  footer: string;
}

export interface PaNextLevel {
  level: PaLevelRow | null;
  /** |level − entry| / |entry − stop|, one decimal */
  r: number | null;
  text: string;
}

// ---------------------------------------------------------------- pure pieces (tested in tests/pa.test.ts)

/** The higher frame's structure as a short label, e.g. "日线上升" or "周线区间". */
export function higherLabel(tf: Timeframe, s: Pick<StructureState, "state" | "breach">): PaHigherView {
  const word = s.state === "up" ? "上升" : s.state === "down" ? "下降" : "区间";
  return { tf, state: s.state, breach: s.breach, label: `${TF_CN[tf]}${word}` };
}

const CHECK_FOOTER = "5/5 只说明按规则可以做，不说明会涨或会跌。";

/** What the textbook rows say, appended to the checklist footer (nothing for 有优势, nor without research). */
function checklistResearchLine(research: PaResearch | null, kind: PatternKind | null): string {
  if (!research) return "";
  const rows = (kind ? research.items.filter((x) => x.kind === kind) : research.items).map((x) => x.text).filter((x): x is ScoreRow => !!x);
  if (!rows.length || rows.some((x) => x.verdict === "有优势")) return "";
  if (rows.every((x) => x.verdict === "样本不足")) return "历史样本太少，还不能下结论。";
  return "历史上在关键位、顺势时也没有比随机入场更好。";
}

/**
 * The five-item entry checklist, filled in from the page's own data (the user does not tick anything):
 * ① the higher frame points the trade's way, ② at a key level, ③ a pattern under the rules, ④ confirmed by a close,
 * ⑤ a clear stop with the risk within PA_RULES. Without a setup, ① only asks that the higher frame has a direction
 * and ② reads the location; ③–⑤ are not met.
 */
export function entryChecklist(
  setup: PaSetupView | null,
  ctx: { higher: PaHigherView | null; location: PaLocation; research: PaResearch | null },
): PaChecklist {
  const h = ctx.higher;
  const items: PaCheckItem[] = [];
  if (setup) {
    const hd = h ? (h.state === "up" ? 1 : h.state === "down" ? -1 : 0) : null;
    items.push({
      key: "higher",
      label: "大周期方向和交易同向",
      ok: hd === setup.dir,
      detail: hd == null ? "大周期数据不足" : hd === 0 ? `大周期区间（${TF_CN[h!.tf]}）` : hd === setup.dir ? h!.label : `逆大周期（${h!.label}）`,
    });
    items.push({ key: "key", label: "在关键位", ok: setup.loc === "key", detail: setup.loc === "key" ? "在关键位上" : "在中间位置" });
    items.push({ key: "pattern", label: "出现符合规则的形态", ok: true, detail: `${setup.name}${setup.dir > 0 ? "做多" : "做空"}` });
    const entered = setup.status === "entered";
    items.push({
      key: "closed",
      label: "K 线已收盘确认",
      ok: entered,
      detail: entered ? `已收盘${setup.dir > 0 ? "站上" : "跌破"} ${fmtPrice(setup.trigger)}` : `等收盘${setup.dir > 0 ? "高于" : "低于"} ${fmtPrice(setup.trigger)}`,
    });
    items.push({
      key: "risk",
      label: `止损明确、风险在 ${PA_RULES.minRiskAtr}–${PA_RULES.maxRiskAtr} 倍 ATR`,
      ok: setup.ok,
      detail: `止损 ${fmtPrice(setup.stop)}，风险 ${setup.riskAtr.toFixed(1)} 倍 ATR${setup.ok ? "" : "，超出范围不做"}`,
    });
  } else {
    const dirOk = !!h && h.state !== "range";
    items.push({ key: "higher", label: "大周期方向明确", ok: dirOk, detail: !h ? "大周期数据不足" : dirOk ? h.label : `大周期区间（${TF_CN[h.tf]}）` });
    const at = ctx.location !== "mid";
    items.push({ key: "key", label: "在关键位", ok: at, detail: ctx.location === "support" ? "在支撑区" : ctx.location === "resistance" ? "在阻力区" : "在中间位置" });
    items.push({ key: "pattern", label: "出现符合规则的形态", ok: false, detail: "还没有确认形态" });
    items.push({ key: "closed", label: "K 线已收盘确认", ok: false, detail: "还没有确认形态" });
    items.push({ key: "risk", label: `止损明确、风险在 ${PA_RULES.minRiskAtr}–${PA_RULES.maxRiskAtr} 倍 ATR`, ok: false, detail: "还没有确认形态" });
  }
  const extra = checklistResearchLine(ctx.research, setup?.kind ?? null);
  return { kind: setup?.kind ?? null, dir: setup?.dir ?? null, items, score: items.filter((x) => x.ok).length, footer: extra ? `${CHECK_FOOTER}${extra}` : CHECK_FOOTER };
}

/**
 * The nearest key level beyond the entry (the trigger while waiting) in the trade's direction — a resistance above
 * for longs, a support below for shorts — in R of the setup's stop distance. Only a reference: the page exits by the
 * trailing stop, not at a fixed target. `reach2` (research, %) adds how often this pattern reached 2R first.
 */
export function nextLevelR(setup: PaSetupView, levels: PaLevelRow[], reach2: number | null = null): PaNextLevel {
  const long = setup.dir > 0;
  const entry = setup.status === "entered" && setup.entry != null ? setup.entry : setup.trigger;
  const risk = Math.abs(entry - setup.stop);
  const level =
    levels
      .filter((x) => (long ? x.side === "resistance" && x.price > entry : x.side === "support" && x.price < entry))
      .sort((a, b) => Math.abs(a.price - entry) - Math.abs(b.price - entry))[0] ?? null;
  const tail = reach2 != null ? `历史上这种形态先到 2R 的约 ${Math.round(reach2)}%。` : "";
  if (!level) return { level: null, r: null, text: `${long ? "上方" : "下方"} ${LEVELS_PER_SIDE} 个关键位以内没有${long ? "阻力位" : "支撑位"}。${tail}` };
  const r = risk > 0 ? Math.round((Math.abs(level.price - entry) / risk) * 10) / 10 : null;
  const word = long ? "阻力位" : "支撑位";
  const text =
    r == null
      ? `下一个${word} ${fmtPrice(level.price)}（${level.name}），只作参考：按移动认错位离场，不设固定止盈。${tail}`
      : `离下一个${word} ${fmtPrice(level.price)}（${level.name}）约 ${r.toFixed(1)}R，只作参考：按移动认错位离场，不设固定止盈。${tail}`;
  return { level, r, text };
}

/** Step 1 in one sentence. */
export function trendSentence(tf: Timeframe, state: TrendState, breach: Breach, label: string): string {
  const T = TF_CN[tf];
  if (state === "up") {
    const tail = breach === "broken" ? "，但收盘已跌破保护低点（转折中）" : breach === "pierced" ? "，保护低点被刺穿，先观察" : "";
    return `${T}上升：更高的高点和更高的低点${tail}`;
  }
  if (state === "down") {
    const tail = breach === "broken" ? "，但收盘已站上保护高点（转折中）" : breach === "pierced" ? "，保护高点被刺穿，先观察" : "";
    return `${T}下降：更低的高点和更低的低点${tail}`;
  }
  if (label.includes("被打破")) return `${T}区间：${label}`;
  return `${T}区间（没有明确方向）：高低点方向不一致`;
}

/**
 * The nearest levels on both sides of the close: sorted by distance, a level within LEVEL_MERGE_ATR × ATR of a
 * nearer one on the same side is the same level; up to LEVELS_PER_SIDE each. Lowest first.
 */
export function nearbyLevels(all: { price: number; kind: PaLevel["kind"]; name: string }[], close: number, atr: number, per = LEVELS_PER_SIDE): PaLevelRow[] {
  if (!(atr > 0)) return [];
  const pick = (side: PaLevelRow["side"]) => {
    const list = all.filter((x) => (side === "support" ? x.price <= close : x.price > close)).sort((a, b) => Math.abs(a.price - close) - Math.abs(b.price - close));
    const out: PaLevelRow[] = [];
    for (const x of list) {
      if (out.some((y) => Math.abs(y.price - x.price) <= LEVEL_MERGE_ATR * atr)) continue;
      out.push({ price: x.price, kind: x.kind, name: x.name, side, distAtr: r2((x.price - close) / atr) });
      if (out.length >= per) break;
    }
    return out;
  };
  return [...pick("support").reverse(), ...pick("resistance")];
}

/**
 * Step 2: at a support when the close is within PA_RULES.keyAtr × ATR of one, at a resistance likewise; the
 * nearer one wins when both are; otherwise in the middle.
 */
export function classifyLocation(levels: PaLevelRow[], close: number, atr: number): PaLocationView {
  const near = (side: PaLevelRow["side"]) =>
    atr > 0
      ? (levels
          .filter((x) => x.side === side && Math.abs(x.price - close) <= PA_RULES.keyAtr * atr)
          .sort((a, b) => Math.abs(a.price - close) - Math.abs(b.price - close))[0] ?? null)
      : null;
  const s = near("support"), r = near("resistance");
  const best = s && r ? (Math.abs(s.price - close) <= Math.abs(r.price - close) ? s : r) : (s ?? r);
  if (!best) return { loc: "mid", level: null, sentence: `收盘离最近的支撑和阻力都超过 ${PA_RULES.keyAtr} 倍 ATR，在中间：中间位置不做。` };
  const fmt = fmtPrice(best.price);
  return best.side === "support"
    ? { loc: "support", level: best, sentence: `在支撑区：收盘离${spaced(best.name)} ${fmt} 不到 ${PA_RULES.keyAtr} 倍 ATR。` }
    : { loc: "resistance", level: best, sentence: `在阻力区：收盘离${spaced(best.name)} ${fmt} 不到 ${PA_RULES.keyAtr} 倍 ATR。` };
}

/** Step 3: the key-level setups entered on one of the last RECENT_BARS closed bars (newest first), then the waiting ones. */
export function pickConfirm(setups: PaSetupView[]): PaSetupView[] | null {
  const recentEntered = setups.filter((x) => x.loc === "key" && x.status === "entered" && !x.stopped && x.barsAgo != null && x.barsAgo >= 0 && x.barsAgo < RECENT_BARS);
  const waiting = setups.filter((x) => x.loc === "key" && x.status === "waiting");
  const out = [...recentEntered.sort((a, b) => a.barsAgo! - b.barsAgo!), ...waiting.sort((a, b) => b.sT - a.sT)];
  return out.length ? out : null;
}

/** The report's rules are the current ones (the same keys and values). */
export function rulesMatch(rules: Record<string, number> | undefined, current: Record<string, number> = PA_RULES): boolean {
  if (!rules) return false;
  const a = Object.keys(rules).sort(), b = Object.keys(current).sort();
  if (a.length !== b.length || a.some((k, i) => k !== b[i])) return false;
  return b.every((k) => Math.abs(rules[k] - current[k]) < 1e-9);
}

const absR = (x: number | null) => (x == null ? "—" : `${Math.abs(x).toFixed(2)}R`);

/** One verdict in words, against random entries with the same stop distance. */
function verdictWords(r: ResearchRow): string {
  switch (r.verdict) {
    case "有优势":
      return `历史上平均每笔比同止损距离的随机入场好 ${absR(r.cells.is.edgeR)}，达到了研究标准（不保证下一次）`;
    case "比随机差":
      return `历史上平均每笔比同止损距离的随机入场差 ${absR(r.cells.is.edgeR)}，统计上站得住`;
    case "样本不足":
      return "样本太少，还不能下结论";
    default:
      return "历史上和同止损距离的随机入场差不多，没有可证明的优势";
  }
}

/** What the research says about one pattern on one timeframe, from its two rows. */
export function patternSentence(kind: PatternKind, all: ResearchRow | undefined, text: ResearchRow | undefined): string {
  if (!all) return "研究报告里没有这一行。";
  const head = verdictWords(all);
  if (!text) return `${head}。`;
  const where = LOCATED.includes(kind) ? "在关键位、顺势时" : "顺势时";
  const tail =
    text.verdict === all.verdict && text.verdict !== "样本不足"
      ? `${where}也一样`
      : text.verdict === "样本不足"
        ? `${where}的样本太少，还不能下结论`
        : `${where}：${verdictWords(text)}`;
  return `${head}；${tail}。`;
}

type Report = ResearchReport & { id: number };

/** The research block for one timeframe, from the latest patterns report (or why there are no numbers). */
export function paResearchOf(rep: Report | null, pf: PaTf): { view: PaResearch | null; note: string | null } {
  if (!RESEARCHED.includes(pf)) return { view: null, note: "这个周期还没有研究数字。" };
  if (!rep) return { view: null, note: "裸 K 的研究数字会在服务器生成研究报告后显示。" };
  if (!rulesMatch(rep.rules)) return { view: null, note: "研究规则已更新，等新的研究报告。" };
  const rows = new Map(rep.rows.map((r) => [r.key, r]));
  const items: PaResearchItem[] = [];
  for (const kind of PATTERNS) {
    const a = rows.get(`pa:${pf}:${kind}:all`), t = rows.get(`pa:${pf}:${kind}:text`);
    if (!a && !t) continue;
    const e = a?.extra ?? {};
    items.push({
      kind,
      name: PATTERN_NAME[kind],
      sentence: patternSentence(kind, a, t),
      all: a ? scoreRow(a) : null,
      text: t ? scoreRow(t) : null,
      textName: LOCATED.includes(kind) ? "关键位 + 顺势" : "顺势",
      reach2: e.reach2 ?? null,
      quickStopPct: e.quickStopPct ?? null,
      setups: e.setups ?? null,
      triggerPct: e.triggerPct ?? null,
    });
  }
  if (!items.length) return { view: null, note: "研究报告里还没有这个周期的数字。" };
  return { view: { reportId: rep.id, createdAt: rep.createdAt, source: rep.source, items }, note: null };
}

/** Prices as people read them (the same as the watch page). */
export function fmtPrice(x: number): string {
  if (!Number.isFinite(x)) return "—";
  if (Math.abs(x) >= 1000) return Math.round(x).toLocaleString("en-US");
  if (Math.abs(x) >= 1) return String(Math.round(x * 100) / 100);
  return String(Number(x.toPrecision(4)));
}

/** a name starting with a digit ("4 小时摆动低点") gets a space before it */
const spaced = (name: string) => (/^\d/.test(name) ? ` ${name}` : name);

// ---------------------------------------------------------------- the view

const PERIOD_CN: Record<"day" | "week" | "month", string> = { day: "前一日", week: "上周", month: "上月" };

/** The frames to load for a timeframe: itself, the higher frames of its key levels and the daily bars. */
function framesOf(pf: PaTf): Timeframe[] {
  return [...new Set<Timeframe>([pf, ...(PA_HIGHER[pf] ?? []), "1d"])];
}

/**
 * The naked-K view at the close of the last `pf` bar finished by `replayEnd` (null: live).
 * `ep` defaults to the saved engine parameters.
 */
export async function computePa(coin: string, pf: PaTf, ep: EngineParams = DEFAULT_ENGINE_PARAMS, replayEnd: number | null = null): Promise<PaView> {
  const live = replayEnd == null;
  const tfs = framesOf(pf);
  const raw = await Promise.all(tfs.map((tf) => seriesAt(coin, tf, replayEnd)));
  const byTf = new Map<Timeframe, KlineResult>(tfs.map((tf, k) => [tf, raw[k]]));
  const main = byTf.get(pf)!;
  const nowSec = closedThrough(main);
  const closedBy = (tf: Timeframe) => cutoff(byTf.get(tf)!.candles, tf, replayEnd ?? closedThrough(byTf.get(tf)!));
  const c = closedBy(pf);
  const sec = TF_SECONDS[pf];
  if (c.length < 200) {
    if (!live) throw new ReplayError("这个时间点之前的数据不足以看裸 K，请选择更近的时间");
    throw new Error(`${coin} ${pf} 已收盘的 K 线太少（${c.length} 根）`);
  }
  const n = c.length - 1;
  const formingBar = live ? (main.candles.find((x) => x.t + sec > nowSec) ?? null) : null;
  const mult = ep.structure.swingAtr;

  const atr = atrSeries(c);
  const ss = structureSeries(c, atr, mult);
  const higher: PaFrame[] = (PA_HIGHER[pf] ?? []).map((tf) => {
    const hc = closedBy(tf);
    return { tf, c: hc, atr: atrSeries(hc) };
  });
  const daily = pf === "1d" ? c : closedBy("1d");
  const buf = bufferAtr(null, PA_RULES.stopQ);
  const inp: PaInput = { tf: pf, c, atr, ss, levels: paLevelSource(pf, c, atr, higher, daily), buf };
  const a = atr[n];
  const close = c[n].c;

  // ① trend
  const sv = describeStructure(c, atr, ss, swings(c, atr, mult), n);
  const trend: PaTrendView = { state: sv.state, breach: sv.breach, label: sv.label, sentence: trendSentence(pf, sv.state, sv.breach, sv.label), detail: sv.position };

  // ② levels at the last close, named
  const names = levelNamer(pf, c, higher, daily, n);
  const known = ([1, -1] as const).flatMap((dir) => inp.levels!(n, dir).map((L) => ({ price: L.price, kind: L.kind, name: names(L, dir) })));
  const levels = nearbyLevels(known, close, a);
  const location = classifyLocation(levels, close, a);

  // ③ setups on the chart's bars
  const first = Math.max(0, c.length - CHART_BARS);
  const setups = findPatterns(inp, { from: Math.max(0, first - 10) }).filter((x) => (x.status === "entered" || x.status === "waiting") && (x.e ?? x.s) >= first);
  const recent = setups.map((x) => setupView(x, c, n, formingBar)).sort((x, y) => (x.eT ?? x.sT) - (y.eT ?? y.sT));
  const confirm = pickConfirm(recent);

  // the next higher frame's structure at the last closed bar (closed bars only, as step 1)
  const hf = higher[0];
  let higherView: PaHigherView | null = null;
  if (hf) {
    const k = alignHigher(c, pf, hf.c, hf.tf)[n];
    if (k >= 0) higherView = higherLabel(hf.tf, structureSeries(hf.c, hf.atr, mult)[k]);
  }

  const research = paResearchOf(latestReport("patterns"), pf);
  const ctx = { higher: higherView, location: location.loc, research: research.view };
  const checklists = confirm ? confirm.map((x) => entryChecklist(x, ctx)) : [entryChecklist(null, ctx)];
  const nextLevels = (confirm ?? []).map((x) => nextLevelR(x, levels, research.view?.items.find((it) => it.kind === x.kind)?.reach2 ?? null));
  return {
    coin,
    pf,
    source: main.source,
    updatedAt: main.fetchedAt,
    end: c[n].t + sec,
    lastClosedT: c[n].t,
    price: formingBar ? formingBar.c : close,
    closedPrice: close,
    forming: !!formingBar,
    candles: formingBar ? [...c.slice(-CHART_BARS), formingBar] : c.slice(-CHART_BARS),
    atr: r2(a),
    buf: r3(buf),
    trend,
    levels,
    location,
    confirm,
    recent,
    research: research.view,
    higher: higherView,
    checklists,
    nextLevels,
    researchNote: research.note,
    replay: !live,
  };
}

function setupView(x: PaSetup, c: Candle[], n: number, forming: Candle | null = null): PaSetupView {
  // as the plan page: once any later bar's wick reaches the stop, the setup is no longer shown as live
  const after = x.e != null ? [...c.slice(x.e + 1, n + 1), ...(forming ? [forming] : [])] : [];
  const stopped = after.some((b) => (x.dir > 0 ? b.l <= x.stop : b.h >= x.stop));
  return {
    kind: x.kind,
    name: PATTERN_NAME[x.kind],
    dir: x.dir,
    status: x.status,
    trigger: x.trigger,
    entry: x.entry,
    extreme: x.extreme,
    stop: x.stop,
    riskAtr: r2(x.riskAtr),
    ok: x.ok,
    trend: x.trend,
    loc: x.loc,
    startT: c[x.start].t,
    sT: c[x.s].t,
    eT: x.e != null ? c[x.e].t : null,
    barsAgo: x.e != null ? n - x.e : null,
    stopped,
  };
}

/**
 * Names for the levels paLevelSource gives at bar n: which higher frame a higher swing is from and which period a
 * period level is, matched by price against the same computations.
 */
function levelNamer(pf: PaTf, c: Candle[], higher: PaFrame[], daily: Candle[], n: number) {
  const T = TF_CN[pf];
  const highTf = new Map<string, Timeframe>();
  for (const f of higher) {
    const k = alignHigher(c, pf, f.c, f.tf)[n];
    if (k < 0) continue;
    for (const side of ["low", "high"] as const) for (const p of intactPivots(f.c, f.atr, k, PIVOT_K[f.tf], side, 300)) if (!highTf.has(`${side}|${p.price}`)) highTf.set(`${side}|${p.price}`, f.tf);
  }
  const period = new Map<string, string>();
  const jd = alignHigher(c, pf, daily, "1d")[n];
  if (jd >= 0) {
    const endSec = c[n].t + TF_SECONDS[pf];
    const upTo = daily.slice(Math.max(0, jd - 70), jd + 1);
    for (const p of PA_PERIODS[pf] ?? []) {
      const hl = prevPeriodHL(upTo, endSec, p);
      if (!hl) continue;
      if (!period.has(`low|${hl.l}`)) period.set(`low|${hl.l}`, PERIOD_CN[p]);
      if (!period.has(`high|${hl.h}`)) period.set(`high|${hl.h}`, PERIOD_CN[p]);
    }
  }
  return (L: PaLevel, dir: 1 | -1): string => {
    const side = dir > 0 ? "low" : "high";
    const x = dir > 0 ? "低点" : "高点";
    switch (L.kind) {
      case "pivot":
        return `${T}摆动${x}`;
      case "flip":
        return dir > 0 ? `${T}被突破过的前高` : `${T}被跌破过的前低`;
      case "higher": {
        const tf = highTf.get(`${side}|${L.price}`);
        return `${tf ? TF_CN[tf] : "大周期"}摆动${x}`;
      }
      default:
        return `${period.get(`${side}|${L.price}`) ?? "前一周期"}${x}`;
    }
  };
}

// ---------------------------------------------------------------- cached entry points

const TTL_MS = 60_000;
const cache = new Map<string, { at: number; value?: PaView; pending?: Promise<PaView> }>();

/** The live view, cached a minute per coin, timeframe and parameter version; one computation in flight per key. */
export async function getPa(coin: string, pf: PaTf): Promise<PaView> {
  const params = currentParams();
  const key = `${coin}:${pf}:${params.version}`;
  const hit = cache.get(key);
  if (hit?.value && Date.now() - hit.at < TTL_MS) return hit.value;
  if (hit?.pending) return hit.pending;
  for (const k of cache.keys()) if (!k.endsWith(`:${params.version}`)) cache.delete(k);
  const t0 = Date.now();
  const pending = computePa(coin, pf, params.engine);
  cache.set(key, { at: hit?.at ?? 0, value: hit?.value, pending });
  try {
    const value = await pending;
    cache.set(key, { at: Date.now(), value });
    logger.debug("engine", `裸 K 完成 ${coin} ${pf}`, { durationMs: Date.now() - t0 });
    return value;
  } catch (e) {
    if (hit?.value) cache.set(key, { at: hit.at, value: hit.value });
    else cache.delete(key);
    throw e;
  }
}

const replayCache = new Map<string, Promise<PaView>>();

/** Time machine: the view as it stood at `end` (Unix seconds): the last `pf` bar closed by then. */
export function paAt(coin: string, pf: PaTf, end: number): Promise<PaView> {
  const params = currentParams();
  const key = `${coin}:${pf}:${end}:${params.version}`;
  const hit = replayCache.get(key);
  if (hit) return hit;
  const p = computePa(coin, pf, params.engine, end).catch((e) => {
    replayCache.delete(key);
    throw e;
  });
  replayCache.set(key, p);
  if (replayCache.size > 120) replayCache.delete(replayCache.keys().next().value!);
  return p;
}
