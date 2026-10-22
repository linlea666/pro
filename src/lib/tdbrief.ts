import type { TdEvent, TdState } from "./ta/td.ts";
import type { SignalStats } from "./ta/stats.ts";
import type { Candle, Timeframe } from "./types.ts";
import { TF_LABEL, TF_SECONDS } from "./types.ts";

/**
 * TD 解读：把多周期的 TD 计数写成四段人话（结论 / 多周期 / 复盘 / 提醒）。
 * 纯函数，页面和 AI 快照共用。只描述计数进度、失败与否和下一根的关键收盘价，
 * 不预测涨跌：研究里 TD 没有可证明的方向优势。
 */

export type TdSide = "buy" | "sell";

/** One timeframe's TD state, as the multi-timeframe table shows it. */
export interface TdDetail {
  setupSide: TdSide | null;
  setupCount: number;
  setupLength: number;
  countdownLength: number;
  countdown: { side: TdSide; count: number } | null;
  last: { side: TdSide; kind: TdEvent["kind"]; barsAgo: number; invalidated: boolean } | null;
  /** close the next bar needs to keep the current setup counting */
  nextCloseNeeded: number | null;
  tdstResistance: number | null;
  tdstSupport: number | null;
  /** the latest 9 (either side) and what its countdown did since: still counting, a 13 (failed once a close passed its risk level), or neither (cancelled) */
  nine: {
    side: TdSide;
    barsAgo: number;
    perfected: boolean;
    countdown: number | null;
    thirteen: { barsAgo: number; riskLevel: number; invalidated: boolean } | null;
  } | null;
}

/** `closed`: completed bars only (the forming bar left out). */
export function tdDetailOf(td: { events: TdEvent[]; current: TdState["current"] }, closed: Candle[]): TdDetail {
  const cur = td.current;
  const barsSince = (t: number) => closed.length - 1 - closed.findIndex((x) => x.t === t);
  const nineEv = td.events.findLast((e) => e.kind === "setup9");
  const thirteenEv = nineEv && td.events.findLast((e) => e.kind === "countdown13" && e.side === nineEv.side && e.i >= nineEv.i);
  return {
    setupSide: cur.setupSide,
    setupCount: cur.setupCount,
    setupLength: cur.setupLength,
    countdownLength: cur.countdownLength,
    countdown: cur.countdown ? { side: cur.countdown.side, count: cur.countdown.count } : null,
    last: cur.lastSignal ? { side: cur.lastSignal.side, kind: cur.lastSignal.kind, barsAgo: cur.lastSignal.barsAgo, invalidated: cur.lastSignal.invalidated } : null,
    nextCloseNeeded: cur.nextCloseNeeded,
    tdstResistance: cur.tdstResistance,
    tdstSupport: cur.tdstSupport,
    nine: nineEv
      ? {
          side: nineEv.side,
          barsAgo: barsSince(nineEv.t),
          perfected: nineEv.perfected,
          countdown: cur.countdown && cur.countdown.side === nineEv.side ? cur.countdown.count : null,
          thirteen: thirteenEv
            ? {
                barsAgo: barsSince(thirteenEv.t),
                riskLevel: thirteenEv.riskLevel,
                invalidated: closed.some((x) => x.t > thirteenEv.t && (thirteenEv.side === "buy" ? x.c < thirteenEv.riskLevel : x.c > thirteenEv.riskLevel)),
              }
            : null,
        }
      : null,
  };
}

export interface TdBriefRow {
  tf: Timeframe;
  d: TdDetail;
}

/** The focus timeframe's last 9 / 13 and what price did since (from the analysis of that timeframe). */
export interface TdLastSignal {
  side: TdSide;
  kind: TdEvent["kind"];
  barsAgo: number;
  price: number;
  riskLevel: number;
  invalidated: boolean;
  changePct: number;
}

export type TdStat = Pick<SignalStats, "key" | "name" | "samples" | "winRate" | "baseWinRate" | "reliability">;

export interface TdBrief {
  conclusion: string;
  timeframes: { tf: Timeframe; text: string }[];
  /** cross-timeframe sentence, or null when there is only one timeframe or nothing to compare */
  alignment: string | null;
  review: string[];
  watch: string[];
  research: string;
}

const price = (v: number) => (v >= 1000 ? v.toLocaleString("en-US", { maximumFractionDigits: 1 }) : v >= 1 ? v.toFixed(v >= 100 ? 2 : 3) : v.toPrecision(4));
const pct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
const ago = (sec: number) => (sec <= 0 ? "刚收盘这根" : sec < 3600 ? `${Math.round(sec / 60)} 分钟前` : sec < 48 * 3600 ? `${Math.round(sec / 3600)} 小时前` : `${Math.round(sec / 86400)} 天前`);
/** "buy" / "sell" are DeMark's names; the page describes what happened: a run of lower (higher) closes */
const sideName = (s: TdSide) => (s === "buy" ? "跌势" : "涨势");
/** what a side's count is measuring, in plain words */
const runName = (s: TdSide) => (s === "buy" ? "连跌" : "连涨");
const crossWord = (s: TdSide) => (s === "buy" ? "跌破" : "突破");

/** A 13 counts as "fresh" for this many bars. */
const FRESH13 = 13;
/** Other timeframes' failed 13s are worth a review line for this many bars. */
const REVIEW_BARS = 48;
/** A 9 counts as "fresh" for this many bars. */
const FRESH9 = 4;

/** Which way a timeframe's TD is "tired": the side whose 9 / 13 is still live, else the side being counted (≥ 5). */
function leaning(d: TdDetail): TdSide | null {
  const n = d.nine;
  if (n && ((n.thirteen && !n.thirteen.invalidated && n.thirteen.barsAgo <= FRESH13) || n.countdown != null)) return n.side;
  if (d.setupSide && d.setupCount >= 5) return d.setupSide;
  return null;
}

function rowText(r: TdBriefRow): string {
  const { d, tf } = r;
  const sec = TF_SECONDS[tf];
  const n = d.nine;
  const parts: string[] = [];
  if (n) {
    const nine = `${sideName(n.side)} 9${n.perfected ? "★" : ""}（${ago(n.barsAgo * sec)}）`;
    if (n.thirteen) {
      parts.push(
        n.thirteen.invalidated
          ? `${nine}之后的 13 已出现但失败了（收盘${crossWord(n.side)}风险位 ${price(n.thirteen.riskLevel)}）`
          : `${nine}之后的 13 已出现（${ago(n.thirteen.barsAgo * sec)}），风险位 ${price(n.thirteen.riskLevel)} 还没被收盘越过`,
      );
    } else if (n.countdown != null) parts.push(n.countdown > 0 ? `${nine}之后 13 数到 ${n.countdown}/${d.countdownLength}` : `${nine}之后 13 计数刚开始`);
    else parts.push(`${nine}之后的 13 计数已取消`);
  }
  if (d.setupSide && d.setupCount < d.setupLength) parts.push(`正在${runName(d.setupSide)}计数 ${d.setupCount}/${d.setupLength}`);
  else if (d.setupSide && (!n || n.barsAgo > 0)) parts.push(`${runName(d.setupSide)}已满 ${d.setupLength} 根还在延续（第 ${d.setupCount} 根）`);
  return parts.length ? parts.join("；") : "最近没有完整的 9，也没有在计数";
}

function conclusionOf(r: TdBriefRow): string {
  const { d, tf } = r;
  const label = TF_LABEL[tf];
  const n = d.nine;
  if (n?.thirteen && !n.thirteen.invalidated && n.thirteen.barsAgo <= FRESH13)
    return `${label}出现了${sideName(n.side)} 13：这段${n.side === "buy" ? "跌势" : "涨势"}已经数满衰竭计数，风险位 ${price(n.thirteen.riskLevel)} 是它的认错线；它说明“走了很久”，不说明马上反转。`;
  if (n?.thirteen && n.thirteen.invalidated && n.thirteen.barsAgo <= FRESH13)
    return `${label}的${sideName(n.side)} 13 已经失败：收盘${crossWord(n.side)}了风险位 ${price(n.thirteen.riskLevel)}，原来的${n.side === "buy" ? "跌势" : "涨势"}还在走。`;
  if (n && n.countdown != null && n.countdown >= d.countdownLength - 3)
    return `${label}的${sideName(n.side)} 13 已数到 ${n.countdown}/${d.countdownLength}，${n.side === "buy" ? "跌势" : "涨势"}已经持续很久；数满也只是“走了很久”的提示，不是${n.side === "buy" ? "买点" : "卖点"}。`;
  if (n && n.barsAgo <= FRESH9)
    return `${label}刚出现${sideName(n.side)} 9${n.perfected ? "★" : ""}：${runName(n.side)}满 9 根，常见的是歇一歇，不等于反转。`;
  if (d.setupSide && d.setupCount >= 6 && d.setupCount < d.setupLength)
    return `${label}${runName(d.setupSide)}计数 ${d.setupCount}/${d.setupLength}，再 ${d.setupLength - d.setupCount} 根就满 9。`;
  return `${label}目前没有接近完成的计数，TD 这时没什么可说的。`;
}

function alignmentOf(rows: TdBriefRow[]): string | null {
  const lean = rows.map((r) => ({ tf: r.tf, s: leaning(r.d) })).filter((x): x is { tf: Timeframe; s: TdSide } => x.s != null);
  if (rows.length < 2 || lean.length < 2) return null;
  const sells = lean.filter((x) => x.s === "sell").map((x) => TF_LABEL[x.tf]);
  const buys = lean.filter((x) => x.s === "buy").map((x) => TF_LABEL[x.tf]);
  if (!buys.length) return `${sells.join("、")}都在数“涨了很久”。几个周期同时数到 9 或 13 是否更灵，还没有研究数字。`;
  if (!sells.length) return `${buys.join("、")}都在数“跌了很久”。几个周期同时数到 9 或 13 是否更灵，还没有研究数字。`;
  return `周期之间不一致：${sells.join("、")}在数“涨了很久”，${buys.join("、")}在数“跌了很久”。小周期的计数只说明最近几根，先看大周期在走什么。`;
}

function reviewOf(focus: TdBriefRow, rows: TdBriefRow[], last: TdLastSignal | null): string[] {
  const out: string[] = [];
  const sec = TF_SECONDS[focus.tf];
  if (last) {
    const kind = last.kind === "setup9" ? "9" : "13";
    const went = last.invalidated
      ? `收盘已${crossWord(last.side)}风险位 ${price(last.riskLevel)}，这个信号失败了`
      : (last.side === "buy") === last.changePct > 0
        ? `风险位 ${price(last.riskLevel)} 没被收盘越过，目前按它的方向在走`
        : `暂时没按它的方向走，但风险位 ${price(last.riskLevel)} 还没被收盘越过`;
    out.push(`${TF_LABEL[focus.tf]}上一个信号是${sideName(last.side)} ${kind}（${ago(last.barsAgo * sec)}，${price(last.price)}），之后 ${pct(last.changePct)}，${went}。`);
  }
  for (const r of rows) {
    const t = r.d.nine?.thirteen;
    if (r.tf === focus.tf || !t || !t.invalidated || t.barsAgo > REVIEW_BARS) continue;
    out.push(`${TF_LABEL[r.tf]}的${sideName(r.d.nine!.side)} 13 失败了（收盘${crossWord(r.d.nine!.side)} ${price(t.riskLevel)}）：13 出现之后原方向继续走，并不少见。`);
  }
  if (!out.length) out.push(`${TF_LABEL[focus.tf]}最近没有完整的 9 或 13 可以复盘。`);
  return out;
}

function watchOf(r: TdBriefRow): string[] {
  const { d } = r;
  const out: string[] = [];
  const n = d.nine;
  if (n?.thirteen && !n.thirteen.invalidated && n.thirteen.barsAgo <= FRESH13)
    out.push(`收盘${crossWord(n.side)} ${price(n.thirteen.riskLevel)}（13 的风险位），这个 13 就算失败。`);
  if (n && n.countdown != null) {
    const cancel = n.side === "sell" ? d.tdstSupport : d.tdstResistance;
    out.push(
      `${n.countdown === 0 ? `${sideName(n.side)} 13 计数刚开始，要数满 ${d.countdownLength} 根` : `${sideName(n.side)} 13 计数还差 ${d.countdownLength - n.countdown} 根`}${cancel != null ? `；收盘${n.side === "sell" ? "跌破" : "突破"} TDST ${price(cancel)} 会取消这次计数` : ""}。`,
    );
  }
  if (d.setupSide && d.setupCount < d.setupLength && d.nextCloseNeeded != null)
    out.push(`下一根收盘${d.setupSide === "buy" ? "低于" : "高于"} ${price(d.nextCloseNeeded)}，${runName(d.setupSide)}计数才继续（现在 ${d.setupCount}/${d.setupLength}），否则中断。`);
  if (!out.length) out.push("现在没有快要完成或快要失败的计数，等下一个 9 出现再看。");
  return out;
}

function researchOf(stats: TdStat[], tf: Timeframe): string {
  const tail = "TD 计数描述的是一段涨跌走了多久，不预测方向；出现 9 或 13 不等于该买或该卖。";
  const rows = stats.filter((s) => s.key.startsWith("td_") && s.samples > 0 && s.winRate != null);
  if (!rows.length) return `这个周期还没有足够的历史样本。${tail}`;
  const strong = rows.filter((s) => s.reliability === "证据较强");
  const bad = rows.filter((s) => s.reliability === "历史上不利");
  const list = rows.map((s) => `${s.name} ${s.winRate}%（随机 ${s.baseWinRate}%，${s.reliability}）`).join("，");
  const verdict = strong.length
    ? `其中${strong.map((s) => s.name).join("、")}标“证据较强”，但这只是本币本周期的历史，换个币或周期不一定成立。`
    : bad.length
      ? `${bad.map((s) => s.name).join("、")}历史上反而不利，其余也没有可靠地好于随机。`
      : "没有一个可靠地好于随机。";
  return `${TF_LABEL[tf]}历史上“对”的比例：${list}。${verdict}${tail}`;
}

/**
 * `rows`: every timeframe to describe (the focus one included). `last`: the focus timeframe's
 * last 9 / 13. `stats`: the focus timeframe's TD rows from the page statistics.
 */
export function tdBrief(rows: TdBriefRow[], focus: Timeframe, last: TdLastSignal | null, stats: TdStat[]): TdBrief {
  const f = rows.find((r) => r.tf === focus) ?? rows[0];
  return {
    conclusion: conclusionOf(f),
    timeframes: rows.map((r) => ({ tf: r.tf, text: rowText(r) })),
    alignment: alignmentOf(rows),
    review: reviewOf(f, rows, last),
    watch: watchOf(f),
    research: researchOf(stats, f.tf),
  };
}

/**
 * Phrases a TD write-up must not use: price calls the research can't back.
 * The AI version is rejected (and the template shown) when it contains one.
 */
const FORBIDDEN = [
  /(?<!(不|不说明|不等于|不代表|不是|并不|未必|不能说明)\s*)(即将|马上|一定|必然|大概率|很可能|有望|将会|将要|会)(迎来)?(反转|反弹|回调|下跌|上涨|见顶|见底|拉升|冲上|突破|跌破|暴跌|暴涨)/,
  /一大波|拉一波|冲上|见顶了|见底了|抄底|逃顶|目标价|目标位|必涨|必跌|稳赚|翻倍|更大一级的反转|大级别(的)?(反转|调整)/,
];

export function forbiddenPhrase(text: string): string | null {
  for (const re of FORBIDDEN) {
    const m = text.match(re);
    if (m) return m[0];
  }
  return null;
}
