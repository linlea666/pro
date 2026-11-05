import type { Candle } from "../types.ts";

/**
 * 昨天是大波动日（2026-11-05，E42 D1，研究脚本和页面共用这一份规则）：昨天（UTC 日线，北京 8 点收盘）的振幅
 * ≥ 之前 20 天振幅中位的 2 倍，今天全天显示一行背景。按昨天收在全天的上 1/3、中间、下 1/3 给第二天的历史比例
 * （越过前高、跌破前低、inside day），过了亚洲时段（UTC 0–8 点，北京 8–16 点）再补一句亚洲有没有越过。
 *
 * 只描述，不是信号：这些是 BTC / ETH 2020 年起日线的比例，不是对随机入场的优势；页面能说的话只有 `BIGDAY_FACTS` 和这里的模板。
 * 只给有数字的币（BTC / ETH）。
 */
export const BIGDAY_RULES = {
  /** 振幅至少是之前 `base` 天中位的几倍 */
  ratio: 2,
  base: 20,
  /** 亚洲时段到 UTC 几点（小时） */
  asiaEndH: 8,
} as const;

export type DayPos = "top" | "mid" | "bottom";
export const POS_NAME: Record<DayPos, string> = { top: "收在全天的上 1/3", mid: "收在全天中间", bottom: "收在全天的下 1/3" };

/** `daily[i]` 的振幅是之前 20 天中位的几倍、收在哪一段；数据不够为 null。E42 的 D1 也用它。 */
export function dayShape(daily: Candle[], i: number): { ratio: number; pos: DayPos; rangePct: number } | null {
  const R = BIGDAY_RULES;
  if (i < R.base || i >= daily.length) return null;
  const s = daily.slice(i - R.base, i).map((b) => b.h - b.l).sort((a, b) => a - b);
  const med = s[s.length >> 1];
  const x = daily[i], range = x.h - x.l;
  if (!(med > 0) || !(range > 0)) return null;
  const at = (x.c - x.l) / range;
  return { ratio: range / med, pos: at >= 2 / 3 ? "top" : at <= 1 / 3 ? "bottom" : "mid", rangePct: (range / x.o) * 100 };
}

interface PosFact {
  /** 样本天数 */
  n: number;
  /** 第二天 inside day / 越过前高 / 跌破前低的比例，% */
  inside: number;
  upH: number;
  dnL: number;
  /** 收在上 / 下 1/3 时：亚洲没越过前高（下 1/3：没跌破前低）的天数，和之后当天还越过的比例，% */
  asia?: { n: number; later: number };
}

/**
 * E42 D1 的数字（Binance 永续日线 2020-01 起到 2026-11-04，`scripts/research-data/e42.ts`），页面唯一能说的话。
 * `base` = 所有日子第二天 inside day 的比例。
 */
export const BIGDAY_FACTS: Record<string, { base: number; pos: Record<DayPos, PosFact> }> = {
  BTC: {
    base: 21,
    pos: {
      top: { n: 109, inside: 28, upH: 70, dnL: 7, asia: { n: 59, later: 44 } },
      mid: { n: 71, inside: 72, upH: 14, dnL: 15 },
      bottom: { n: 68, inside: 35, upH: 3, dnL: 63, asia: { n: 43, later: 42 } },
    },
  },
  ETH: {
    base: 20,
    pos: {
      top: { n: 104, inside: 26, upH: 72, dnL: 5, asia: { n: 56, later: 48 } },
      mid: { n: 71, inside: 58, upH: 24, dnL: 21 },
      bottom: { n: 75, inside: 35, upH: 7, dnL: 60, asia: { n: 45, later: 33 } },
    },
  },
};

export interface BigDay {
  coin: string;
  /** 昨天那根日线的开盘时刻 */
  t: number;
  high: number;
  low: number;
  close: number;
  /** 振幅，% */
  rangePct: number;
  /** 是之前 20 天中位的几倍（一位小数） */
  ratio: number;
  pos: DayPos;
  /** 今天到现在（已收盘的 1 小时 K 线）有没有越过前高 / 跌破前低 */
  aboveHigh: boolean;
  belowLow: boolean;
  /** 亚洲时段已经走完；走完时亚洲有没有越过前高 / 跌破前低 */
  asiaDone: boolean;
  asiaAbove: boolean;
  asiaBelow: boolean;
}

/**
 * 今天要不要显示：`daily` 是已收盘的日线，`hourly` 是已收盘的 1 小时 K 线，`nowSec` 是最后收盘的时刻（秒）。
 * 昨天那根要正好是今天 0 点之前的一根；不够 2 倍、或这个币没有研究数字时为 null。
 */
export function bigDayAt(coin: string, daily: Candle[], hourly: Candle[], nowSec: number): BigDay | null {
  if (!BIGDAY_FACTS[coin]) return null;
  const today = Math.floor(nowSec / 86400) * 86400;
  const i = daily.length - 1;
  if (i < 0 || daily[i].t + 86400 !== today) return null;
  const s = dayShape(daily, i);
  if (!s || s.ratio < BIGDAY_RULES.ratio) return null;
  const y = daily[i];
  const hs = hourly.filter((b) => b.t >= today && b.t + 3600 <= nowSec);
  const asiaEnd = today + BIGDAY_RULES.asiaEndH * 3600;
  const asia = hs.filter((b) => b.t < asiaEnd);
  return {
    coin,
    t: y.t,
    high: y.h,
    low: y.l,
    close: y.c,
    rangePct: Math.round(s.rangePct * 10) / 10,
    ratio: Math.round(s.ratio * 10) / 10,
    pos: s.pos,
    aboveHigh: hs.some((b) => b.h > y.h),
    belowLow: hs.some((b) => b.l < y.l),
    asiaDone: nowSec >= asiaEnd,
    asiaAbove: asia.some((b) => b.h > y.h),
    asiaBelow: asia.some((b) => b.l < y.l),
  };
}

const fmt = (x: number) => (Math.abs(x) >= 1000 ? Math.round(x).toLocaleString("en-US") : String(Number(x.toPrecision(5))));

/** 标题：“昨天是大波动日：振幅 7.0%，是平时的 2.6 倍，收在全天的上 1/3” */
export function bigDayHeadline(x: BigDay): string {
  return `昨天是大波动日：振幅 ${x.rangePct}%，是之前 20 天中位的 ${x.ratio} 倍，${POS_NAME[x.pos]}（高 ${fmt(x.high)} / 低 ${fmt(x.low)}）`;
}

/** 历史比例一句（只描述） */
export function bigDayFact(x: BigDay): string {
  const F = BIGDAY_FACTS[x.coin], p = F.pos[x.pos];
  const head = `${x.coin} 2020 年起这种日子（${p.n} 天）的第二天：`;
  if (x.pos === "mid") return `${head}${p.inside}% 是 inside day（没越过前高、也没跌破前低，平时 ${F.base}%），越过前高 ${p.upH}%、跌破前低 ${p.dnL}%。`;
  const up = x.pos === "top";
  return `${head}${up ? `越过前高 ${p.upH}%` : `跌破前低 ${p.dnL}%`}，inside day ${p.inside}%（平时 ${F.base}%），${up ? `跌破前低 ${p.dnL}%` : `越过前高 ${p.upH}%`}。`;
}

/** 今天的进展一句：已经越过 / 跌破了没有，亚洲走完后再按亚洲补一句；没什么可说时为 null */
export function bigDayToday(x: BigDay): string | null {
  const done: string[] = [];
  if (x.aboveHigh) done.push(`已越过前高 ${fmt(x.high)}`);
  if (x.belowLow) done.push(`已跌破前低 ${fmt(x.low)}`);
  if (done.length) return `今天${done.join("，也")}${done.length === 2 ? "，已经不是 inside day" : ""}。`;
  const p = BIGDAY_FACTS[x.coin].pos[x.pos];
  if (x.asiaDone && p.asia) {
    const up = x.pos === "top";
    return `今天亚洲时段（北京 8–16 点）没有${up ? "越过前高" : "跌破前低"}；历史上这样的日子（${p.asia.n} 天），之后当天还${up ? "越过" : "跌破"}的有 ${p.asia.later}%。`;
  }
  return `今天到现在还在前一天的高低点之间（${fmt(x.low)}–${fmt(x.high)}）。`;
}

/** 命令行和行情导视用的一句 */
export function bigDayLine(x: BigDay): string {
  const t = bigDayToday(x);
  return `${bigDayHeadline(x)}。${bigDayFact(x)}${t ? ` ${t}` : ""} 只描述，不是信号。`;
}
