import { binancePage, closedThrough, PRIMARY_SOURCE, type KlineResult } from "./data/klines.ts";
import { openInterestSeries } from "./data/perp.ts";
import { cutoff, ReplayError, seriesAt } from "./analysis.ts";
import { bigTrendAt } from "./bigtrend.ts";
import type { BigTrend } from "./ta/bigtrend.ts";
import { logger } from "./server/log.ts";
import { getDb } from "./server/db.ts";
import { currentParams } from "./server/params-store.ts";
import { getCalibration } from "./server/riskcalib.ts";
import { DEFAULT_ENGINE_PARAMS, type EngineParams } from "./params.ts";
import { fundingFuel } from "./research/defend.ts";
import { loadHistory, type ResearchRow } from "./research/run.ts";
import { coinIds } from "./server/coins.ts";
import * as ta from "./ta/core.ts";
import { alignHigher } from "./ta/plan.ts";
import { atrSeries, bufferAtr } from "./ta/risk.ts";
import { BREAK_ATR, PIERCE_ATR, structureSeries, type StructureState } from "./ta/structure.ts";
import { BEYOND_ATR, FRESH_BARS, keyLevelName, levelSource, pickLevels, turnAt, watchState, type KeyLevelKind, type WatchInput, type WatchLevel, type WatchSide, type WatchStateName } from "./ta/watch.ts";
import { EARLY_FACT, EARLY_SWING_ATR, PHASE_NAMES, phaseAt, phaseFact, type Phase, type PhaseDir } from "./ta/phase.ts";
import { SIGN_SHORT, SIGNS, signsAt, type SignData, type SignKey } from "./ta/watchsigns.ts";
import { latestReport, scoreRow, type ScoreRow } from "./trendplan.ts";
import { TF_SECONDS, type Candle, type Timeframe } from "./types.ts";

/**
 * Watching key levels live: for one coin, whether price is near a key low (high), has touched it and is still
 * falling (别接), has stalled there (观察), or the 15-minute chart has turned (已转强) — with the stop beyond the
 * newest extreme. E19 found that buying the touch does worse than random entries and waiting for the turn does
 * better than buying the touch, but no better than random: the page gives a discipline, not a forecast.
 * Only closed 15-minute bars decide the state; the bar still forming only gives the live price.
 */

export interface WatchSign {
  key: SignKey;
  name: string;
  /** null: the data is missing */
  value: boolean | null;
  /** what the research found for this sign (null: no report yet) */
  text: string | null;
}

export interface WatchSideView extends WatchSide {
  /** the bar still forming has traded beyond the level (live only; never changes the state) */
  piercing: boolean;
  /** the seven signs, while an event is in progress */
  signs: WatchSign[] | null;
}

export interface WatchLevelRow extends WatchLevel {
  side: "low" | "high";
  /** (price − close) / hour ATR */
  distAtr: number;
  /** two-level close rule against the last 15-minute closes: 0.1 ATR beyond pierced, 0.8 broken */
  state: "none" | "pierced" | "broken";
}

export interface Move24 {
  /** last closed hour's close against 24 hours earlier, % */
  changePct: number | null;
  /** share of the coin's stored hours whose 24-hour move was smaller in size, % */
  pctRank: number | null;
  /** after the biggest 24-hour drops (rallies), the next 72 hours moved this many times the usual (research) */
  volRatio: number | null;
  /** what the same research row says about direction (worded from its verdict); null without a report */
  dirNote: string | null;
  /** the biggest daily drops in the stored history, at least 3 days apart: the bar's open time and the change, % */
  topDrops: { t: number; pct: number }[];
}

export interface WatchResearch {
  reportId: number;
  createdAt: number;
  source: string;
  /** buying the touch, waiting for the 15-minute turn (against random entries), and waiting against buying the touch */
  rows: ScoreRow[];
  /** share run over (a further 1 hour ATR against the entry within 24 hours), waiting and buying the touch, % */
  halfwayPct: number | null;
  halfwayA: number | null;
  /** the pre-registered test on being run over passed */
  halfwayPassed: boolean;
  text: string;
}

export type PhaseTf = "15m" | "1h" | "4h";

export interface PhaseRow extends Phase {
  tf: PhaseTf;
  /** the five cells' names for this ladder */
  names: readonly string[];
  /** what history says after this cell (1h / 4h only, null otherwise) */
  fact: string | null;
}

export interface PhaseLeg {
  dir: PhaseDir;
  /** the swing the leg started from (the high before the low, for dir 1) and its bar's open time */
  from: number;
  fromT: number;
  /** the leg's extreme so far */
  extreme: number;
  /** key levels between the two that a 15-minute close went through by 0.1 hour ATR, nearest the start first */
  through: { price: number; name: string }[];
}

export interface PhaseEarly {
  dir: PhaseDir;
  /** open time of the 15-minute bar whose close gave the hint, and that close */
  t: number;
  price: number;
  /** the stop the watch would use now (beyond the newest extreme) */
  stop: number;
  text: string;
}

/** While the watch waits for the turn: the turn's two conditions as they stand now (the same as `turnAt`). */
export interface PhaseAhead {
  dir: PhaseDir;
  /** a 15-minute close beyond this turns it (the last swing on the other side + 0.1 ATR) */
  trigger: number;
  /** the last close is beyond it already */
  closedPast: boolean;
  /** the higher low (lower high) after the newest extreme is there */
  haveBetter: boolean;
  /** the stop the watch would use now */
  stop: number;
}

/** 行情阶段：15 分钟 / 1 小时 / 4 小时各在梯子的哪一格（src/lib/ta/phase.ts），和页首一句话。 */
export interface PhaseView {
  rows: PhaseRow[];
  headline: string;
  /** the hour chart's current leg while it is at ① – ③ */
  leg: PhaseLeg | null;
  /** E33a: the finer 15-minute turn while the watch is still waiting for the turn */
  early: PhaseEarly | null;
  ahead: PhaseAhead | null;
}

export interface WatchView {
  coin: string;
  source: string;
  updatedAt: number;
  /** close of the last closed 15-minute bar (Unix seconds), and its open time */
  end: number;
  lastClosedT: number;
  /** latest traded price (live: the forming bar), and the last close */
  price: number;
  closedPrice: number;
  forming: boolean;
  /** the last CHART_BARS closed 15-minute bars, plus the bar still forming when live (for the chart) */
  candles: Candle[];
  atr1h: number;
  /** sweep buffer behind the extreme, hour ATR (calibrated: measured on this coin) */
  buf: number;
  calibrated: boolean;
  /** one sentence on the side that matters most now */
  headline: string;
  side: "long" | "short" | null;
  state: WatchStateName;
  long: WatchSideView;
  short: WatchSideView;
  /** the nearest three key levels below and above the last close, lowest first */
  levels: WatchLevelRow[];
  move24: Move24 | null;
  /** null: not enough closed bars on the hour chart */
  phases: PhaseView | null;
  research: WatchResearch | null;
  /** why research numbers are missing, when they are */
  researchNote: string | null;
  /** 周线、日线的大趋势（只描述）；数据不够时为 null */
  big: BigTrend | null;
  replay: boolean;
}

const TFS: Timeframe[] = ["15m", "1h", "4h", "1d"];
/** closed 15-minute bars sent for the chart */
const CHART_BARS = 150;
const r2 = (x: number) => Math.round(x * 100) / 100;

/** Prices as people read them: thousands separated, small coins with enough digits. */
export function fmtPrice(x: number | null | undefined): string {
  if (x == null || !Number.isFinite(x)) return "—";
  if (Math.abs(x) >= 1000) return Math.round(x).toLocaleString("en-US");
  if (Math.abs(x) >= 1) return String(Math.round(x * 100) / 100);
  return String(Number(x.toPrecision(4)));
}

const signedR = (x: number | null) => (x == null ? "—" : `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(2)}R`);
const absR = (x: number | null) => (x == null ? "—" : `${Math.abs(x).toFixed(2)}R`);

// ---------------------------------------------------------------- research

/** The pre-registered test on being run over (E19): at least 5 points fewer, q < 0.05, consistent everywhere. */
function halfwayPassed(r: ResearchRow | undefined): boolean {
  const e = r?.extra ?? {};
  return e.halfwayDiff != null && e.halfwayDiff <= -5 && e.halfwayQ != null && e.halfwayQ < 0.05 && e.halfwayConsistent === 1;
}

/** What E19 says about catching the touch and waiting for the turn, worded from the verdicts; null: no rows. */
export function watchResearchText(a: ResearchRow | undefined, c: ResearchRow | undefined, cva: ResearchRow | undefined): string | null {
  if (!a && !c && !cva) return null;
  const parts: string[] = [];
  if (a) {
    const e = a.cells.is.edgeR;
    parts.push(
      a.verdict === "有优势"
        ? `历史上，碰到关键位就接，平均每笔比同方向随机入场好 ${absR(e)}`
        : a.verdict === "比随机差"
          ? `历史上，碰到关键位就接，平均每笔比同方向随机入场差 ${absR(e)}`
          : a.verdict === "样本不足"
            ? "碰到关键位就接的样本还不够，下不了结论"
            : `历史上，碰到关键位就接，和同方向随机入场比差别不能确定（平均每笔 ${signedR(e)}）`,
    );
  }
  let wait = "";
  if (cva) {
    const e = cva.cells.is.edgeR;
    const x = cva.extra ?? {};
    const hw = x.halfwayA != null && x.halfwayPct != null ? `（接到半山腰——入场后又被反向打出 1 倍 1 小时 ATR——的比例 ${x.halfwayA}% → ${x.halfwayPct}%${halfwayPassed(cva) ? "" : "，这个差别还不能算可靠"}）` : "";
    wait =
      cva.verdict === "有优势"
        ? `等 15 分钟转强再进，比碰到就接好 ${absR(e)}${hw}`
        : cva.verdict === "比随机差"
          ? `等 15 分钟转强再进，比碰到就接差 ${absR(e)}${hw}`
          : cva.verdict === "样本不足"
            ? `等 15 分钟转强和碰到就接的比较，样本还不够${hw}`
            : `等 15 分钟转强再进和碰到就接比，平均每笔的差别不能确定（${signedR(e)}）${hw}`;
  }
  if (c) {
    const e = c.cells.is.edgeR;
    const self =
      c.verdict === "有优势"
        ? `本身也比同方向随机入场好 ${absR(e)}`
        : c.verdict === "比随机差"
          ? `本身仍比同方向随机入场差 ${absR(e)}`
          : c.verdict === "样本不足"
            ? "本身的样本还不够"
            : "本身和同方向随机入场比没有可证明的优势";
    wait = wait ? `${wait}，${self}` : `等 15 分钟转强再进，${self}`;
  }
  if (wait) parts.push(wait);
  const helps = cva?.verdict === "有优势" || halfwayPassed(cva);
  return `${parts.join("；")}。${helps ? "转强不预测方向，它只是让你少接飞刀。" : "转强不预测方向，只是一条纪律：等它出现再进，止损放在最新的低点（高点）之外。"}`;
}

/** One sign's research row in words. */
function signText(r: ResearchRow | undefined): string | null {
  if (!r) return null;
  const { is } = r.cells;
  const ctl = is.meanR != null && is.edgeR != null ? is.meanR - is.edgeR : null;
  const head = `历史上有这一项的转强入场平均每笔 ${signedR(is.meanR)}，没有的 ${signedR(ctl)}（样本内 ${is.n} 笔有）。`;
  if (r.verdict === "有优势") return `${head}有这一项的明显更好，统计上站得住。`;
  if (r.verdict === "比随机差") return `${head}有这一项的明显更差，统计上站得住。`;
  if (r.verdict === "样本不足") return `${head}样本还不够。`;
  return `${head}有没有这一项，历史上结果的差别不能确定。`;
}

function researchOf(ep: EngineParams): { rows: Map<string, ResearchRow>; view: WatchResearch | null; note: string | null } {
  const rep = latestReport("watch");
  if (!rep) return { rows: new Map(), view: null, note: "盯盘的研究数字会在服务器生成研究报告后显示。" };
  // numbers measured with another window describe another rule: hidden until the next report
  const measured = rep.rules?.windowBars ?? DEFAULT_ENGINE_PARAMS.watch.windowBars;
  if (measured !== ep.watch.windowBars) return { rows: new Map(), view: null, note: "盯盘的观察窗口改过，等下一份研究报告再显示历史数字。" };
  const rows = new Map(rep.rows.map((r) => [r.key, r]));
  const a = rows.get("watch:A"), c = rows.get("watch:C"), cva = rows.get("watch:C_vs_A");
  const text = watchResearchText(a, c, cva);
  const view: WatchResearch | null = text
    ? {
        reportId: rep.id,
        createdAt: rep.createdAt,
        source: rep.source,
        rows: [a, c, cva].filter((x): x is ResearchRow => !!x).map(scoreRow),
        halfwayPct: cva?.extra?.halfwayPct ?? null,
        halfwayA: cva?.extra?.halfwayA ?? null,
        halfwayPassed: halfwayPassed(cva),
        text,
      }
    : null;
  return { rows, view, note: null };
}

// ---------------------------------------------------------------- data around the state

const SPOT_TTL_MS = 60_000;
const spotCache = new Map<string, { at: number; value: Candle[] | null }>();

/** Recent spot 15-minute bars with taker volume (live only), cached a minute; null when they cannot be had. */
async function spotBars(coin: string): Promise<Candle[] | null> {
  const hit = spotCache.get(coin);
  if (hit && Date.now() - hit.at < SPOT_TTL_MS) return hit.value;
  let value: Candle[] | null = null;
  try {
    value = await binancePage("binance-spot", coin, "15m", { limit: 40 });
  } catch {
    value = null;
  }
  spotCache.set(coin, { at: Date.now(), value });
  return value;
}

function fundingRows(coin: string, end: number): { t: number[]; rate: number[] } | null {
  try {
    const fr = getDb().prepare("SELECT t, rate FROM funding_rates WHERE coin = ? AND source = ? AND t <= ? AND t >= ? ORDER BY t").all(coin, PRIMARY_SOURCE, end, end - 100 * 86400) as { t: number; rate: number }[];
    return { t: fr.map((x) => x.t), rate: fr.map((x) => x.rate) };
  } catch {
    return null;
  }
}

/** First index of a sorted array with value ≥ x. */
function lowerBound(arr: number[], x: number): number {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const baseCache = new Map<string, { abs: number[]; topDrops: { t: number; pct: number }[] }>();

/** The stored history up to `end`: every hour's 24-hour move (sorted, in size) and the biggest daily drops; per hour. */
function moveBase(coin: string, end: number) {
  const key = `${coin}:${Math.floor(end / 3600)}`;
  const hit = baseCache.get(key);
  if (hit) return hit;
  const h = loadHistory(coin, "1h", end);
  const abs: number[] = [];
  for (let i = 24; i < h.length; i++) if (h[i].t - h[i - 24].t === 24 * 3600) abs.push(Math.abs(h[i].c / h[i - 24].c - 1));
  abs.sort((a, b) => a - b);
  const d = loadHistory(coin, "1d", end);
  const drops: { t: number; pct: number }[] = [];
  for (let i = 1; i < d.length; i++) if (d[i].t - d[i - 1].t === 86400) drops.push({ t: d[i].t, pct: (d[i].c / d[i - 1].c - 1) * 100 });
  drops.sort((a, b) => a.pct - b.pct);
  const topDrops: { t: number; pct: number }[] = [];
  for (const x of drops) {
    if (topDrops.length >= 5 || x.pct >= 0) break;
    if (topDrops.some((y) => Math.abs(y.t - x.t) < 3 * 86400)) continue;
    topDrops.push({ t: x.t, pct: r2(x.pct) });
  }
  const value = { abs, topDrops };
  baseCache.set(key, value);
  if (baseCache.size > 64) baseCache.delete(baseCache.keys().next().value!);
  return value;
}

function move24Of(coin: string, h: Candle[], end: number, rows: Map<string, ResearchRow>): Move24 | null {
  const n = h.length - 1;
  if (n < 24) return null;
  const chg = h[n].t - h[n - 24].t === 24 * 3600 ? h[n].c / h[n - 24].c - 1 : null;
  const base = moveBase(coin, end);
  const rank = chg != null && base.abs.length ? Math.round((lowerBound(base.abs, Math.abs(chg)) / base.abs.length) * 1000) / 10 : null;
  const row = chg == null ? undefined : rows.get(chg < 0 ? "move24:drop:long" : "move24:rise:short");
  return { changePct: chg == null ? null : r2(chg * 100), pctRank: rank, volRatio: row?.extra?.volRatio ?? null, dirNote: chg == null ? null : moveDirNote(row, chg < 0 ? 1 : -1), topDrops: base.topDrops };
}

/** The direction half of a move24 row: holding against the move (long after a drop, short after a rally) for 72 hours against random holds. */
function moveDirNote(r: ResearchRow | undefined, dir: 1 | -1): string | null {
  if (!r) return null;
  const what = `${dir > 0 ? "大跌之后做多" : "大涨之后做空"}持有 3 天`;
  switch (r.verdict) {
    case "有优势":
      return `${what}，比平时随机持有好，统计上站得住`;
    case "比随机差":
      return `${what}，比平时随机持有差，统计上站得住`;
    case "样本不足":
      return "之后的方向样本还不够，下不了结论";
    default:
      return "之后往哪走没有可证明的规律";
  }
}

/** Mirror of levelState in the plan page: coming from the side the close was on `look` bars ago, closes beyond. */
function levelState(price: number, c: Candle[], atr: number, look = 6): WatchLevelRow["state"] {
  const n = c.length - 1;
  if (n < look || !(atr > 0)) return "none";
  const from = Math.sign(c[n - look].c - price);
  if (!from) return "none";
  const depth = ((price - c[n].c) * from) / atr;
  return depth >= BREAK_ATR ? "broken" : depth >= PIERCE_ATR ? "pierced" : "none";
}

// ---------------------------------------------------------------- headline

function headlineOf(coin: string, s: WatchSide): string {
  const dir = s.dir;
  // a name starting with a digit ("4 小时摆动低点") gets a space after the verb before it
  const L = s.level ? `${/^\d/.test(s.level.name) ? " " : ""}${s.level.name} ${fmtPrice(s.level.price)}` : "";
  const w =
    dir > 0
      ? { through: "跌破", newX: "创新低", dont: "别接", turn: "转强", x: "低点", wait: "等 15 分钟先走出更高的低点、再收盘站上反弹高点", beyond: "下方", act: "接" }
      : { through: "涨破", newX: "创新高", dont: "别急着空", turn: "转弱", x: "高点", wait: "等 15 分钟先走出更低的高点、再收盘跌破回落低点", beyond: "上方", act: "空" };
  const ev = s.event;
  if (s.state === "near") return `${coin} 靠近${L}（${Math.abs(s.distAtr ?? 0).toFixed(1)} 倍 1 小时 ATR）：碰到别急着${w.act}，等 15 分钟${w.turn}。`;
  if (!ev) return `${coin} ${s.level ? `离最近的关键位还远（${L}，${Math.abs(s.distAtr ?? 0).toFixed(1)} 倍 1 小时 ATR）` : "附近没有要盯的关键位"}：先不用盯。`;
  const bounce = ev.bounce != null ? `（${dir > 0 ? "反弹高点" : "回落低点"} ${fmtPrice(ev.bounce)}）` : "";
  if (s.state === "turned" && ev.turn) return `${coin} 在${L} 一带 15 分钟已${w.turn}：最新${w.x} ${fmtPrice(ev.turn.extreme)}，止损放在 ${fmtPrice(ev.turn.stop)}（${w.x}之外留了扫损缓冲），按风险算仓位。`;
  if (s.state === "watching")
    return `${coin} 在${L} 一带${ev.reclaimed ? "扫过后收回" : `暂时没有${w.newX}`}（最新${w.x} ${fmtPrice(ev.extreme)}）：还没${w.turn}，${w.dont}；${w.wait}${bounce}。`;
  // falling: a close through the level, or a new extreme within the last few bars (as watchState decided)
  const beyond = s.distAtr != null && s.distAtr * dir > BEYOND_ATR;
  const fresh = ev.extremeT > s.t - FRESH_BARS * 900;
  const what =
    ev.attempt > 1
      ? `15 分钟${w.turn}后又${w.newX}（${L}，第 ${ev.attempt} 次等待）`
      : beyond && fresh
        ? `${w.through}${L} 后还在${w.newX}`
        : beyond
          ? `收在${L} ${w.beyond}`
          : `碰到${L} 后还在${w.newX}`;
  return `${coin} ${what}：${w.dont}，${w.wait}${bounce}。`;
}

// ---------------------------------------------------------------- 行情阶段

const PHASE_TF_WORD: Record<PhaseTf, string> = { "15m": "15 分钟", "1h": "1 小时", "4h": "4 小时" };

const phaseWords = (dir: PhaseDir) =>
  dir > 0
    ? { x: "低", newX: "创新低", move: "反弹", up: "站上", down: "跌破", better: "更高的低点", bounce: "反弹高点", fix: "修复" }
    : { x: "高", newX: "创新高", move: "回落", up: "跌破", down: "涨破", better: "更低的高点", bounce: "回落低点", fix: "转弱" };

/** One cell in words: where it is, what is still missing (with prices) and what undoes it. */
export function phaseSummary(p: Phase, tf: PhaseTf): string {
  const t = PHASE_TF_WORD[tf];
  const names = PHASE_NAMES[p.dir];
  const w = phaseWords(p.dir);
  const back = `${w.down} ${fmtPrice(p.invalid)} 就回到${names[0]}`;
  if (p.stage === 1) return `${t}还在${names[0]}：最近 ${FRESH_BARS} 根里还在${w.newX}（最${w.x} ${fmtPrice(p.low)}）。`;
  if (p.stage === 2) return `${t}在${names[1]}：${fmtPrice(p.low)} 之后没有再${w.newX}；还要${w.move}到 ${fmtPrice(p.heldAt)}，这个${w.x}点才算站住。${back}。`;
  if (p.stage === 4) return `${t}已${names[3]}：${w.better} ${fmtPrice(p.higherLow)}，收盘已${w.up}${w.bounce} ${fmtPrice(p.bounce)}。${w.down} ${fmtPrice(p.invalid)} 就算${names[3]}失败。`;
  const need: string[] = [];
  if (!p.checks[2]) need.push(p.candidate != null ? `${fmtPrice(p.candidate)} 确认成${w.better}（现在还没确认）` : `${w.move === "反弹" ? "回踩" : "反抽"}出一个${w.better}`);
  if (!p.checks[3]) need.push(`收盘${w.up} ${fmtPrice(p.trigger)}（${w.bounce} ${fmtPrice(p.bounce)} 外 0.1 倍 ATR）`);
  const v = p.vShape ? `已经收盘${w.up}${w.bounce} ${fmtPrice(p.bounce)}，但还没有${w.better}；` : "";
  return `${t}是${names[2]}，还没${w.fix}：${v}还差${/^\d/.test(need[0] ?? "") ? " " : ""}${need.join("，再")}。${back}。`;
}

interface PhaseInput {
  c: Candle[];
  atr15: number[];
  ss: StructureState[];
  h: Candle[];
  hatr: number[];
  hss: StructureState[];
  c4: Candle[];
  atr4: number[];
  w: WatchInput;
  mult: number;
  long: WatchSide;
  short: WatchSide;
}

/** The three ladders, the headline (the hour chart first), the hour chart's leg, and E33a's early hint. */
function phasesOf(x: PhaseInput): PhaseView | null {
  const { c, atr15, ss, h, hatr, hss, c4, atr4, w, mult } = x;
  const n = c.length - 1;
  const row = (tf: PhaseTf, cc: Candle[], at: number[], s: StructureState[]): PhaseRow | null => {
    const p = cc.length ? phaseAt(cc, at, s, cc.length - 1, mult) : null;
    return p ? { ...p, tf, names: PHASE_NAMES[p.dir], fact: tf === "15m" ? null : phaseFact(tf, p) } : null;
  };
  const r15 = row("15m", c, atr15, ss);
  const r1 = row("1h", h, hatr, hss);
  const r4 = c4.length > 50 ? row("4h", c4, atr4, structureSeries(c4, atr4, mult)) : null;
  if (!r1) return null;
  const rows = [r15, r1, r4].filter((r): r is PhaseRow => !!r);

  const others = [r4, r15].filter((r): r is PhaseRow => !!r).map((r) => `${PHASE_TF_WORD[r.tf]}${r.names[r.stage - 1]}`);
  const headline = `${phaseSummary(r1, "1h")}${others.length ? `（${others.join("，")}）` : ""}`;

  // the hour chart's leg: from the swing before its extreme, and the key levels a 15-minute close went through on the way
  let leg: PhaseLeg | null = null;
  if (r1.stage < 4) {
    const j = h.findIndex((b) => b.t === r1.lowT);
    const s = j >= 0 ? hss[j] : null;
    const o = s ? (r1.dir > 0 ? s.lastHigh : s.lastLow) : null;
    const a = w.atr[n];
    if (o && o.i < j && a > 0) {
      const k0 = c.findIndex((b) => b.t >= o.t);
      const cands = k0 >= 0 ? pickLevels(w.levels(k0, r1.dir), r1.dir, o.price, a, 0).filter((l) => (l.price - r1.low) * r1.dir > 0) : [];
      const through = cands.filter((l) => {
        for (let k = k0; k <= n; k++) if ((l.price - c[k].c) * r1.dir > BEYOND_ATR * (w.atr[k] > 0 ? w.atr[k] : a)) return true;
        return false;
      });
      leg = { dir: r1.dir, from: o.price, fromT: o.t, extreme: r1.low, through: through.map((l) => ({ price: l.price, name: keyLevelName(l.kind, r1.dir) })) };
    }
  }

  const waiting = [x.long, x.short].filter((s) => s.event && !s.event.turn).sort((p, q) => q.event!.startT - p.event!.startT);
  // what the watch's turn still needs, for the newest event still waiting
  let ahead: PhaseAhead | null = null;
  // only once the 15-minute chart has stopped making new extremes that way: while it still does, the stop keeps moving
  if (waiting.length && atr15[n] > 0 && r15 && r15.dir === waiting[0].dir && r15.stage >= 2) {
    const s = waiting[0], ev = s.event!, st = ss[n];
    const other = s.dir > 0 ? st.lastHigh : st.lastLow, sw = s.dir > 0 ? st.lastLow : st.lastHigh;
    if (other) {
      const trigger = other.price + s.dir * BEYOND_ATR * atr15[n];
      ahead = { dir: s.dir, trigger, closedPast: (c[n].c - trigger) * s.dir > 0, haveBetter: !!sw && sw.t > ev.extremeT && sw.label === (s.dir > 0 ? "HL" : "LH"), stop: ev.stop };
    }
  }
  // E33a: while the watch waits for the turn, the same turn on a finer 15-minute structure (swings at 1 ATR)
  let early: PhaseEarly | null = null;
  if (waiting.length) {
    const fast = structureSeries(c, atr15, EARLY_SWING_ATR);
    for (const s of waiting) {
      const ev = s.event!;
      const xi = c.findIndex((b) => b.t === ev.extremeT);
      if (xi < 0) continue;
      for (let k = xi + 1; k <= n; k++)
        if (turnAt(fast[k], s.dir, ev.extremeT)) {
          early = { dir: s.dir, t: c[k].t, price: c[k].c, stop: ev.stop, text: EARLY_FACT };
          break;
        }
      if (early) break;
    }
  }
  return { rows, headline, leg, early, ahead };
}

// ---------------------------------------------------------------- the view

/**
 * The watch at the close of the last 15-minute bar finished by `replayEnd` (null: live).
 * `ep` defaults to the saved engine parameters.
 */
export async function computeWatch(coin: string, ep: EngineParams = DEFAULT_ENGINE_PARAMS, replayEnd: number | null = null): Promise<WatchView> {
  const live = replayEnd == null;
  const [raw, big] = await Promise.all([Promise.all(TFS.map((tf) => seriesAt(coin, tf, replayEnd))), bigTrendAt(coin, replayEnd, ep.structure.swingAtr).catch(() => null)]);
  const byTf = new Map<Timeframe, KlineResult>(TFS.map((tf, k) => [tf, raw[k]]));
  const main = byTf.get("15m")!;
  const nowSec = closedThrough(main);
  const closedBy = (tf: Timeframe) => cutoff(byTf.get(tf)!.candles, tf, replayEnd ?? closedThrough(byTf.get(tf)!));
  const c = closedBy("15m"), h = closedBy("1h"), c4 = closedBy("4h"), d1 = closedBy("1d");
  if (c.length < 300 || h.length < 100) {
    if (!live) throw new ReplayError("这个时间点之前的数据不足以盯盘，请选择更近的时间");
    throw new Error(`${coin} 15m 已收盘的 K 线太少（${c.length} 根）`);
  }
  const n = c.length - 1;
  const end = c[n].t + TF_SECONDS["15m"];
  const formingBar = live ? (main.candles.find((x) => x.t + TF_SECONDS["15m"] > nowSec) ?? null) : null;
  const mult = ep.structure.swingAtr;

  const hatr = atrSeries(h);
  const hss = structureSeries(h, hatr, mult);
  const hIdx = alignHigher(c, "15m", h, "1h");
  const atr = hIdx.map((j) => (j >= 0 ? hatr[j] : NaN));
  const atr15 = atrSeries(c);
  const ss = structureSeries(c, atr15, mult);
  const atr4 = atrSeries(c4);
  const idx4 = alignHigher(c, "15m", c4, "4h"), idx1 = alignHigher(c, "15m", d1, "1d");
  const w: WatchInput = { c, atr, ss, h, hss, hIdx, levels: levelSource(c, d1, atrSeries(d1), idx1, c4, atr4, idx4) };
  // the stored calibration is measured on the whole history: a replay uses the defaults
  const cal = live ? getCalibration(coin, "1h") : null;
  const buf = bufferAtr(cal, 80);
  const input = { ...w, buf, rules: ep.watch };
  const sides = { long: watchState(input, 1), short: watchState(input, -1) };
  const a = atr[n];
  const close = c[n].c;

  const research = researchOf(ep);
  // the signs, only while an event is in progress (spot bars live only: a replay has none)
  let sd: SignData | null = null;
  if (sides.long.event || sides.short.event) {
    const fr = fundingRows(coin, end);
    const spot = live ? ((await spotBars(coin)) ?? []).filter((x) => x.t + 900 <= nowSec) : [];
    sd = {
      c,
      times: c.map((x) => x.t),
      ss,
      rsi: ta.rsi(c.map((x) => x.c), 14),
      spot,
      spotTimes: spot.map((x) => x.t),
      oi: openInterestSeries(coin, end, end - 40 * 86400),
      hss,
      hIdx,
      funding: (dir, at) => (fr ? fundingFuel(fr, dir, at) : null),
    };
  }
  const view = (s: WatchSide): WatchSideView => {
    const L = s.level?.price;
    const piercing = !!formingBar && L != null && (s.dir > 0 ? formingBar.l < L : formingBar.h > L);
    if (!s.event || !sd) return { ...s, piercing, signs: null };
    const e = c.findIndex((x) => x.t === s.event!.extremeT);
    const v = signsAt(sd, e, n, s.event.extreme, s.dir);
    return { ...s, piercing, signs: SIGNS.map((k) => ({ key: k, name: SIGN_SHORT[k], value: v[k], text: signText(research.rows.get(`watch_sign:${k}`)) })) };
  };
  const long = view(sides.long), short = view(sides.short);

  // the side that matters most: an event (the newest), else the nearer level being approached
  const events = [long, short].filter((s) => s.event).sort((x, y) => y.event!.startT - x.event!.startT);
  const nears = [long, short].filter((s) => s.state === "near").sort((x, y) => Math.abs(x.distAtr!) - Math.abs(y.distAtr!));
  const pick = events[0] ?? nears[0] ?? null;
  const farSide = [long, short].filter((s) => s.level).sort((x, y) => Math.abs(x.distAtr!) - Math.abs(y.distAtr!))[0] ?? long;

  // key levels on both sides of the last close, nearest three each
  const known = (dir: 1 | -1) => w.levels(n, dir).map((x) => ({ ...x, name: keyLevelName(x.kind, dir), side: (dir > 0 ? "low" : "high") as WatchLevelRow["side"] }));
  const all = [...known(1), ...known(-1)];
  const row = (x: { price: number; kind: KeyLevelKind; name: string; side: WatchLevelRow["side"] }): WatchLevelRow => ({ ...x, distAtr: r2((x.price - close) / a), state: levelState(x.price, c, a) });
  const levels = a > 0 ? [...pickLevels(all.filter((x) => x.price < close), 1, close, a, 0).slice(0, 3).reverse(), ...pickLevels(all.filter((x) => x.price > close), -1, close, a, 0).slice(0, 3)].map(row) : [];

  return {
    coin,
    source: main.source,
    updatedAt: main.fetchedAt,
    end,
    lastClosedT: c[n].t,
    price: formingBar ? formingBar.c : close,
    closedPrice: close,
    forming: !!formingBar,
    candles: formingBar ? [...c.slice(-CHART_BARS), formingBar] : c.slice(-CHART_BARS),
    atr1h: r2(a),
    buf: Math.round(buf * 1000) / 1000,
    calibrated: !!cal,
    headline: headlineOf(coin, pick ?? farSide),
    side: pick ? (pick.dir > 0 ? "long" : "short") : null,
    state: pick ? pick.state : "far",
    long,
    short,
    levels,
    move24: move24Of(coin, h, end, research.rows),
    phases: phasesOf({ c, atr15, ss, h, hatr, hss, c4, atr4, w, mult, long, short }),
    research: research.view,
    researchNote: research.note,
    big,
    replay: !live,
  };
}

// ---------------------------------------------------------------- cached entry points

const TTL_MS = 15_000;
const cache = new Map<string, { at: number; value?: WatchView; pending?: Promise<WatchView> }>();

/** The live watch, cached 15 seconds per coin (and per parameter version); one computation in flight per coin. */
export async function getWatch(coin: string): Promise<WatchView> {
  const params = currentParams();
  const key = `${coin}:${params.version}`;
  const hit = cache.get(key);
  if (hit?.value && Date.now() - hit.at < TTL_MS) return hit.value;
  if (hit?.pending) return hit.pending;
  for (const k of cache.keys()) if (!k.endsWith(`:${params.version}`)) cache.delete(k);
  const t0 = Date.now();
  const pending = computeWatch(coin, params.engine);
  cache.set(key, { at: hit?.at ?? 0, value: hit?.value, pending });
  try {
    const value = await pending;
    cache.set(key, { at: Date.now(), value });
    logger.debug("engine", `盯盘完成 ${coin}`, { durationMs: Date.now() - t0 });
    return value;
  } catch (e) {
    if (hit?.value) cache.set(key, { at: hit.at, value: hit.value });
    else cache.delete(key);
    throw e;
  }
}

const replayCache = new Map<string, Promise<WatchView>>();

/** Time machine: the watch as it stood when the 15-minute bar ending at `end` (Unix seconds) closed. */
export function watchAt(coin: string, end: number): Promise<WatchView> {
  const params = currentParams();
  const key = `${coin}:${end}:${params.version}`;
  const hit = replayCache.get(key);
  if (hit) return hit;
  const p = computeWatch(coin, params.engine, end).catch((e) => {
    replayCache.delete(key);
    throw e;
  });
  replayCache.set(key, p);
  if (replayCache.size > 300) replayCache.delete(replayCache.keys().next().value!);
  return p;
}

export interface WatchSummary {
  coin: string;
  state: WatchStateName;
  side: "long" | "short" | null;
  headline: string;
  level: WatchLevel | null;
  distAtr: number | null;
  /** the hour chart's cell on the ladder, e.g. "反弹"（null: not enough data） */
  phase1h: { dir: PhaseDir; stage: number; name: string } | null;
  updatedAt: number;
}

/** Every coin's live watch in one line each; coins one after another, so a cold start does not load all at once. */
export async function watchOverview(): Promise<WatchSummary[]> {
  const out: WatchSummary[] = [];
  for (const coin of coinIds()) {
    try {
      const v = await getWatch(coin);
      const s = v.side ? v[v.side] : [v.long, v.short].filter((x) => x.level).sort((x, y) => Math.abs(x.distAtr!) - Math.abs(y.distAtr!))[0];
      const r1 = v.phases?.rows.find((r) => r.tf === "1h");
      const phase1h = r1 ? { dir: r1.dir, stage: r1.stage, name: r1.names[r1.stage - 1] } : null;
      out.push({ coin, state: v.state, side: v.side, headline: v.headline, level: s?.level ?? null, distAtr: s?.distAtr ?? null, phase1h, updatedAt: v.updatedAt });
    } catch (e) {
      logger.warn("engine", `盯盘失败 ${coin}`, { error: (e as Error).message });
    }
  }
  return out;
}
