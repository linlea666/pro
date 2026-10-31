/**
 * 大趋势（2026-10-31）：周线、日线结构各自的方向、从哪根收盘开始、到什么收盘价才失效。只描述，不改任何规则。
 *
 * 用户 87k → 76k 一路接多：周线全程下降、日线 10/22 起下降，但盯盘、裸 K 页不显示大周期，计划页标题只写日线。
 * 判断日志（`signallight timeline`）显示：周线 + 日线合成一个方向，在日线区间里会来回变（10/9–10/22 变了 6 次），
 * 单看周线一次都没变，所以页面上把两个周期分开写。方向用 `structureDirection`（同计划页的大周期方向）。
 * 失效价 = 保护位外 0.8 倍 ATR 的收盘（E9 的“失效”），刺穿价 = 0.1 倍。
 * E37：逆大趋势的盯盘转强、计划入场和顺势没有可证明的差别，所以只写“按规则半仓”（计划页已定的规则），不说更差。
 */
import { BREAK_ATR, describeStructure, PIERCE_ATR, structureDirection, type StructureState, type Swing } from "./structure.ts";
import { TF_SECONDS, type Candle } from "../types.ts";


export interface TfTrend {
  tf: "1w" | "1d";
  /** 结构给下一级的方向（同计划页的大周期方向） */
  dir: 1 | -1 | 0;
  /** 结构的说法，如“下降趋势”“区间 / 转折中” */
  label: string;
  /** 这个方向从哪根 K 线收盘开始（收盘时刻）、那根的收盘价、到现在第几根；数据开头就是这个方向时为下限 */
  sinceT: number | null;
  sincePrice: number | null;
  bars: number;
  atLeast: boolean;
  /** 趋势的保护位（下降趋势为保护高点）、收盘越过多少算刺穿 / 失效；区间没有 */
  protective: number | null;
  pierceAt: number | null;
  flipAt: number | null;
}

export interface BigTrend {
  week: TfTrend;
  day: TfTrend;
  /** 周线和日线方向一致时为那个方向，否则 0（盯盘、计划的“逆大趋势”只在 ≠ 0 时成立） */
  dir: 1 | -1 | 0;
}

const r = (x: number) => (x >= 1000 ? Math.round(x) : Math.round(x * 100) / 100);

/** 一个周期的大趋势描述。c 只含已收盘的 K 线。 */
export function tfTrend(tf: "1w" | "1d", c: Candle[], atr: number[], ss: StructureState[], sw: Swing[]): TfTrend | null {
  const n = c.length - 1;
  if (n < 30 || !ss[n]) return null;
  const s = ss[n];
  const dir = structureDirection(s);
  const view = describeStructure(c, atr, ss, sw, n);
  let k = n;
  while (k > 0 && ss[k - 1] && structureDirection(ss[k - 1]) === dir) k--;
  const atLeast = k === 0;
  const trend = (s.state === "up" || s.state === "down") && s.breach !== "broken" && s.protective && atr[n] > 0;
  const sg = s.state === "up" ? -1 : 1;
  return {
    tf,
    dir,
    label: view.label,
    sinceT: c[k].t + TF_SECONDS[tf],
    sincePrice: c[k].c,
    bars: n - k + 1,
    atLeast,
    protective: trend ? s.protective!.price : null,
    pierceAt: trend ? r(s.protective!.price + sg * PIERCE_ATR * atr[n]) : null,
    flipAt: trend ? r(s.protective!.price + sg * BREAK_ATR * atr[n]) : null,
  };
}

export function bigTrend(week: TfTrend | null, day: TfTrend | null): BigTrend | null {
  if (!week || !day) return null;
  return { week, day, dir: week.dir !== 0 && week.dir === day.dir ? week.dir : 0 };
}

/** 交易方向相对大趋势：只在周线、日线方向一致且相反时算逆 */
export function againstBig(b: BigTrend | null | undefined, dir: 1 | -1): boolean {
  return !!b && b.dir !== 0 && b.dir !== dir;
}

const fmt = (x: number) => (x >= 1000 ? Math.round(x).toLocaleString("en-US") : String(x));
/** 北京时间的日期：日线 MM-DD，周线带年份 */
const day = (t: number, tf: "1w" | "1d") => new Date((t + 8 * 3600) * 1000).toISOString().slice(tf === "1w" ? 0 : 5, 10);
const DIR_WORD = { 1: "向上", [-1]: "向下", 0: "没有方向" } as const;
const UNIT = { "1w": "周", "1d": "天" } as const;
const NAME = { "1w": "周线", "1d": "日线" } as const;

/** 一个周期一句：“周线下降趋势，自 2025-10-27 那周收盘起第 53 周；周收盘站上 85,100 才算失效（保护高点 82,829）” */
export function tfTrendText(x: TfTrend): string {
  const since = x.sinceT == null ? "" : x.atLeast ? `，至少 ${x.bars} ${UNIT[x.tf]}` : `，${day(x.sinceT, x.tf)} 收盘起第 ${x.bars} ${UNIT[x.tf]}${x.tf === "1d" ? `（当时 ${fmt(r(x.sincePrice!))}）` : ""}`;
  const head = `${NAME[x.tf]}${x.label}${x.dir !== 0 && !/上升|下降/.test(x.label) ? `（${DIR_WORD[x.dir]}脱离中）` : ""}${since}`;
  if (x.flipAt == null) return x.dir === 0 ? `${head}；等${NAME[x.tf]}走出更高或更低的高低点` : head;
  const up = x.dir < 0;
  return `${head}；${x.tf === "1w" ? "周" : "日"}收盘${up ? "站上" : "跌破"} ${fmt(x.flipAt)} 才算失效（保护${up ? "高" : "低"}点 ${fmt(r(x.protective!))}）`;
}

/** 页首一句：两个周期各自的方向，加一句定位 */
export function bigTrendLine(b: BigTrend): string {
  const both = b.dir > 0 ? "周线、日线都向上" : b.dir < 0 ? "周线、日线都向下" : "周线、日线方向不一致";
  return `${both}。小周期的反弹、回调都在这个背景里看。`;
}

/** E37 的结论，页面唯一能说的“逆大趋势”的话 */
export const BIG_TREND_FACTS = {
  rule: "逆大趋势（周线、日线都和你的方向相反）按规则只用半仓，和计划页的逆大周期同一条规则。",
  e37: "研究（E37，10 个币，2022 年起）：逆大趋势的转强和顺势的转强没有可证明的差别；只有最近 12 个月，逆大趋势做多平均每笔 −0.19R。所以这只是提醒仓位，不是说它一定更差。",
} as const;

/** 已收盘的周线 / 日线 → 大趋势；不够 30 根时为 null */
export function bigTrendOf(frames: { w: { c: Candle[]; atr: number[]; ss: StructureState[]; sw: Swing[] }; d: { c: Candle[]; atr: number[]; ss: StructureState[]; sw: Swing[] } }): BigTrend | null {
  return bigTrend(tfTrend("1w", frames.w.c, frames.w.atr, frames.w.ss, frames.w.sw), tfTrend("1d", frames.d.c, frames.d.atr, frames.d.ss, frames.d.sw));
}

