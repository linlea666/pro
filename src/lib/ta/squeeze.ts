import { quietStats } from "./impulse.ts";
import type { Candle } from "../types.ts";

/**
 * 波动压缩（2026-11-07，E46；用户看完结果在决策卡上定“加，写明不是变盘信号”）：之前 7 天的 1 小时波动压到一年里最低 10% 以内时，
 * 实时盯盘页签加一行、行情导视加一句。口径和放量冲击的“之前 7 天”同一份（`quietStats`，impulse.ts）。
 *
 * 只描述，不是信号：E46 里压到这么低之后，接下来一周通常仍然安静（之后一周的波动约平时 0.7 倍），一周内走出大行情的比例
 * 反而略低（段 6%，所有日子 11%），涨跌各半；8/19 那种压到最低后大涨是少数。页面能说的话只有 `SQUEEZE_FACTS` 和这里的模板。
 * ATR 那一句是机械的提醒（按 ATR 算的止损距离和仓位），没有单独研究过。
 */
export const SQUEEZE_RULES = {
  /** 分位在它以内才显示（0–1） */
  maxQ: 0.1,
  /** E46 只测了这两个币 */
  coins: ["BTC", "ETH"] as readonly string[],
} as const;

export interface Squeeze {
  coin: string;
  /** UTC 日 0 点（秒）：分位按这一天开始之前的 7 天算 */
  day: number;
  /** 之前 7 天的波动在之前 365 天里的分位（0–1） */
  q: number;
  /** 之前 7 天的波动是之前 365 天中位的几倍 */
  sdX: number | null;
}

const median = (a: number[]) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/**
 * 今天（`lastHourT` 所在的 UTC 日，传最后一根已收盘 1 小时 K 线的开盘时刻）是不是波动压缩。
 * `stats` = `quietStats(一年多的 1 小时 K 线)`。只给 BTC / ETH；不够低或数据不够时为 null。
 */
export function squeezeAt(coin: string, stats: ReturnType<typeof quietStats>, lastHourT: number): Squeeze | null {
  if (!SQUEEZE_RULES.coins.includes(coin)) return null;
  const day = Math.floor(lastHourT / 86400) * 86400;
  const q = stats.rank.get(day);
  if (q == null || q > SQUEEZE_RULES.maxQ) return null;
  const now = stats.sd.get(day)!;
  const prev = [...stats.sd.keys()].filter((d) => d < day && d >= day - 365 * 86400).map((d) => stats.sd.get(d)!);
  const base = median(prev);
  const sdX = Number.isFinite(base) && base > 0 ? Math.round((now / base) * 100) / 100 : null;
  return { coin, day, q, sdX };
}

/** 研究数字（BTC / ETH 永续 1 小时，2021 年起，E46），页面唯一能说的话 */
export const SQUEEZE_FACTS = {
  after:
    "压到这么低之后，接下来一周通常仍然安静（幅度约平时 0.7 倍），一周内走出大行情（幅度到平时 2 倍以上）的比例反而略低（6%，所有日子 11%），涨跌各半：这不是变盘信号（BTC / ETH 2021 年起，E46）。",
  atr: "现在 ATR 很小，按它算出的止损偏紧、仓位偏大，波动一放大就容易被扫。",
  short: "历史上之后一周通常仍然安静，大行情反而略少、涨跌各半，不是变盘信号（E46）。",
  pro:
    "波动分位 = 当天（UTC 0 点，北京 8 点）之前 168 根 1 小时收益的标准差，在之前 365 天里的位置，和放量冲击那一行的“之前 7 天”同一口径。最低 5% 的日子里一周内有大行情 12%，和所有日子 11% 一样，8/19 那种压到最低后大涨是少数；看 30 天是 11% 对 9%，前后两半不一致，最近 12 个月 9 段 0 次。",
} as const;

/** “之前 7 天的波动排在过去一年最低的 3%” */
export function squeezeHeadline(x: Squeeze): string {
  if (x.q === 0) return "之前 7 天的波动比过去一年的每一天都低";
  return `之前 7 天的波动排在过去一年最低的 ${Math.max(1, Math.round(x.q * 100))}%`;
}

/** ATR 那一句（带倍数） */
export function squeezeAtr(x: Squeeze): string {
  return x.sdX == null ? SQUEEZE_FACTS.atr : `${SQUEEZE_FACTS.atr.replace(/。$/, "")}（之前 7 天的 1 小时波动约是一年中位的 ${x.sdX} 倍）。`;
}

/** 行情导视里的一句 */
export function squeezeBrief(x: Squeeze): string {
  return `波动压缩：${squeezeHeadline(x)}。${SQUEEZE_FACTS.short}`;
}

/** 命令行用的几行 */
export function squeezeLines(x: Squeeze): string[] {
  return [`波动压缩：${squeezeHeadline(x)}`, `  ${SQUEEZE_FACTS.after}`, `  ${squeezeAtr(x)}`];
}
