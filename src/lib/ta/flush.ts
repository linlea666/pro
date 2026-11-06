import type { Candle } from "../types.ts";
import type { OiSeries } from "./defend.ts";

/**
 * 扫低后的合约状态（2026-11-06，E43，研究脚本和页面共用这一份规则）：1 小时最低价跌破之前 7 天最低价（“扫低”）之后
 * 24 小时内，按那根收盘时的资金费率和持仓量分五种状态，给 E43 的历史比例。起因是博主说“费率还是正的、持仓量也没怎么掉，
 * 说明多头没被洗出去，磨底可能更久；费率转负、持仓量一口气砍掉一截，才更像黄金坑”。
 *
 * 只描述，不是信号：E43 里没有一种状态达到优势标准；BTC 扫低之后 30 天内 97% 又跌破那个低点，不管费率和持仓怎样。
 * 页面能说的话只有 `FLUSH_FACTS` 和这里的模板。只给有数字的币（BTC / ETH），只看扫低（扫高没有测）。
 */
export const FLUSH_RULES = {
  /** 扫的是之前多少根 1 小时的最低价（7 天） */
  win: 168,
  /** 扫低之后显示多少小时 */
  showHours: 24,
  /** 持仓量变化看多少小时 */
  oiHours: 24,
  /** 持仓量变化的分位和过去多少天比 */
  rankDays: 365,
  /** 分位 ≤ 这个算“骤降”，> keep 算“没怎么掉” */
  flushPct: 0.1,
  keepPct: 0.5,
  /** 分位要有多于多少个过去的数（约 42 天） */
  minHist: 1000,
} as const;

export type FlushState = "golden" | "neg" | "flush" | "kept" | "mid";
export const FLUSH_NAME: Record<FlushState, string> = {
  golden: "费率转负 + 持仓骤降（博主说的“黄金坑”）",
  neg: "资金费率转负",
  flush: "持仓量骤降",
  kept: "费率为正、持仓没怎么掉（博主说的“多头还没被洗出去”）",
  mid: "费率为正，持仓变化在中间",
};

/** `h[i]` 的最低价跌破之前 `win` 根的最低价时，返回之前的最低价；没扫为 null。E43 的事件也用它。 */
export function sweptLow(h: Candle[], i: number, win: number = FLUSH_RULES.win): number | null {
  if (i < win || i >= h.length) return null;
  let prev = Infinity;
  for (let j = i - win; j < i; j++) prev = Math.min(prev, h[j].l);
  return h[i].l < prev ? prev : null;
}

/** 时刻 `at` 已经结算的最近一次资金费率（`t` 升序）；没有为 null */
export function settledFunding(f: { t: number[]; rate: number[] }, at: number): number | null {
  let lo = 0, hi = f.t.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (f.t[mid] <= at) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 ? f.rate[lo - 1] : null;
}

/**
 * 持仓量到 `at`（整点）为止 `hours` 小时的变化，和它在之前 `days` 天里同长度变化中的分位（比它小的占几成）。
 * 只用正好在整点上的持仓量；缺数据为 null。
 */
export function oiChangeRank(oi: OiSeries, at: number, hours: number = FLUSH_RULES.oiHours, days: number = FLUSH_RULES.rankDays): { chg: number; pct: number } | null {
  const m = new Map<number, number>();
  for (let k = 0; k < oi.t.length; k++) m.set(oi.t[k], oi.oi[k]);
  const span = hours * 3600;
  const chgAt = (T: number) => {
    const a = m.get(T - span), b = m.get(T);
    return a && b ? b / a - 1 : null;
  };
  const chg = chgAt(at);
  if (chg == null) return null;
  let n = 0, below = 0;
  for (let T = at - 3600; T >= at - days * 86400; T -= 3600) {
    const x = chgAt(T);
    if (x == null) continue;
    n++;
    if (x < chg) below++;
  }
  if (n <= FLUSH_RULES.minHist) return null;
  return { chg, pct: below / n };
}

/** 费率和持仓分位 → 状态（E43 的分组：G 黄金坑、F 只费率转负、O 只持仓骤降、N 没洗出去、其他） */
export function flushState(rate: number, oiPct: number): FlushState {
  const neg = rate < 0, flushed = oiPct <= FLUSH_RULES.flushPct;
  if (neg) return flushed ? "golden" : "neg";
  if (flushed) return "flush";
  return rate > 0 && oiPct > FLUSH_RULES.keepPct ? "kept" : "mid";
}

interface Pair {
  n: number;
  /** 30 天内又跌破这个低点的比例，% */
  brk30: number;
  /** 其他扫低的同一比例，% */
  other: number;
}

/**
 * E43 的数字（Binance 永续，1 小时 + 资金费率 + 每小时持仓量，BTC 2021-09 / ETH 2022-12 起到 2026-10-31，
 * 同一币 7 天只算第一次扫低，`scripts/research-data/e43.ts`，COINS=BTC / ETH 各跑一次），页面唯一能说的话。
 * `n` 是有 30 天结果的次数（`all.n` 是全部次数）；`golden`（GOLDEN_FACT）是两个币合计，只有 3 次。
 */
export const FLUSH_FACTS: Record<string, { since: string; all: { n: number; brk7: number; brk30: number; fall: number }; kept: Pair & { fall: number }; neg: Pair; flush: Pair }> = {
  BTC: {
    since: "2021 年 9 月",
    all: { n: 122, brk7: 89, brk30: 97, fall: 8 },
    kept: { n: 69, brk30: 97, other: 96, fall: 11 },
    neg: { n: 11, brk30: 91, other: 97 },
    flush: { n: 14, brk30: 93, other: 97 },
  },
  ETH: {
    since: "2022 年 12 月",
    all: { n: 87, brk7: 76, brk30: 84, fall: 9 },
    kept: { n: 40, brk30: 93, other: 76, fall: 10 },
    neg: { n: 17, brk30: 65, other: 88 },
    flush: { n: 7, brk30: 100, other: 82 },
  },
};
export const GOLDEN_FACT = { n: 3, brk30: 100 } as const;

export interface Flush {
  coin: string;
  /** 扫低那根 1 小时 K 线的开盘时刻、最低价、扫掉的之前 7 天最低价 */
  t: number;
  low: number;
  prevLow: number;
  /** 那根收盘时已结算的资金费率（小数）、持仓量 24 小时变化（小数）和分位（0–1） */
  rate: number;
  oiChg: number;
  oiPct: number;
  state: FlushState;
  /** 最新一根已收盘 1 小时的同样数字（只在专业模式写）；缺数据、或最新一根就是扫低那根时为 null */
  now: { rate: number | null; oiChg: number | null; oiPct: number | null };
  /** 扫低之后又创了更低的价（还是同一次扫低之后 24 小时内） */
  lower: number;
}

/**
 * 最近 24 根已收盘 1 小时 K 线里最新的一次扫低（`h` 只含已收盘的），按那根收盘时的费率和持仓分状态；
 * 没扫、过了 24 小时、这个币没有研究数字或缺数据时为 null。
 */
export function flushAt(coin: string, h: Candle[], funding: { t: number[]; rate: number[] } | null, oi: OiSeries | null): Flush | null {
  if (!FLUSH_FACTS[coin] || !funding || !oi || !h.length) return null;
  const last = h.length - 1;
  for (let i = last; i >= Math.max(0, last - FLUSH_RULES.showHours + 1); i--) {
    const prevLow = sweptLow(h, i);
    if (prevLow == null) continue;
    const close = h[i].t + 3600;
    const rate = settledFunding(funding, close);
    const r = oiChangeRank(oi, close);
    if (rate == null || !r) return null;
    const endT = h[last].t + 3600;
    const nr = oiChangeRank(oi, endT);
    let lower = h[i].l;
    for (let j = i + 1; j <= last; j++) lower = Math.min(lower, h[j].l);
    return {
      coin,
      t: h[i].t,
      low: h[i].l,
      prevLow,
      rate,
      oiChg: r.chg,
      oiPct: r.pct,
      state: flushState(rate, r.pct),
      // 还是扫低那根刚收盘：现在的数字就是上面那组，不再重复
      now: endT === close ? { rate: null, oiChg: null, oiPct: null } : { rate: settledFunding(funding, endT), oiChg: nr?.chg ?? null, oiPct: nr?.pct ?? null },
      lower,
    };
  }
  return null;
}

const fmt = (x: number) => (Math.abs(x) >= 1000 ? Math.round(x).toLocaleString("en-US") : String(Number(x.toPrecision(5))));
const rateText = (r: number) => `${r > 0 ? "+" : r < 0 ? "−" : ""}${Math.abs(r * 100).toFixed(4)}%`;
const chgText = (c: number) => `${c > 0 ? "+" : c < 0 ? "−" : ""}${Math.abs(c * 100).toFixed(1)}%`;
const pctText = (p: number) => `过去一年第 ${Math.round(p * 100)} 百分位`;

/** 标题：“扫过 7 天低点 75,158 之后：费率为正、持仓没怎么掉（……）” */
export function flushHeadline(x: Flush): string {
  return `扫过 7 天低点 ${fmt(x.prevLow)} 之后：${FLUSH_NAME[x.state]}`;
}

/** 那根收盘时的数字一句 */
export function flushNumbers(x: Flush): string {
  return `扫低那根收盘时，资金费率 ${rateText(x.rate)}，持仓量 24 小时 ${chgText(x.oiChg)}（${pctText(x.oiPct)}）。`;
}

/** 这个状态的历史比例一句（只描述） */
export function flushFact(x: Flush): string {
  const F = FLUSH_FACTS[x.coin];
  const head = `${x.coin} ${F.since}起扫 7 天低点时`;
  switch (x.state) {
    case "kept":
      return `${head}是这种状态的 ${F.kept.n} 次：30 天内 ${F.kept.brk30}% 又跌破了这个低点（其他状态 ${F.kept.other}%），中位又跌 ${F.kept.fall}%。`;
    case "neg":
      return `${head}费率已转负的 ${F.neg.n} 次：30 天内 ${F.neg.brk30}% 又跌破了这个低点（费率不负 ${F.neg.other}%）；之后 1–3 天平均比其他扫低好一些，但样本少，没有达到优势标准。`;
    case "flush":
      return `${head}持仓量骤降的 ${F.flush.n} 次：30 天内 ${F.flush.brk30}% 又跌破了这个低点（没骤降 ${F.flush.other}%）；持仓骤降本身和没骤降差不多。`;
    case "golden":
      return `BTC / ETH 有持仓数据以来扫 7 天低点时费率转负、持仓骤降同时出现只有 ${GOLDEN_FACT.n} 次，30 天内都又跌破了这个低点。`;
    default:
      return `${head}所有状态合计：30 天内 ${F.all.brk30}% 又跌破了这个低点。`;
  }
}

/** 所有扫低的底数一句 */
export function flushBase(x: Flush): string {
  const A = FLUSH_FACTS[x.coin].all;
  return `${x.coin} 所有扫 7 天低点（${A.n} 次）：7 天内 ${A.brk7}%、30 天内 ${A.brk30}% 又跌破这根低点，中位又跌 ${A.fall}%。扫一下不等于见底。`;
}

/** 专业模式：现在的数字、扫低之后又创的新低 */
export function flushNow(x: Flush): string | null {
  const parts: string[] = [];
  if (x.lower < x.low) parts.push(`扫低之后又跌到 ${fmt(x.lower)}`);
  const n = x.now;
  if (n.rate != null && n.oiChg != null && n.oiPct != null) parts.push(`现在资金费率 ${rateText(n.rate)}，持仓量 24 小时 ${chgText(n.oiChg)}（${pctText(n.oiPct)}）`);
  return parts.length ? `${parts.join("；")}。` : null;
}

/** 规则说明（专业模式） */
export const FLUSH_RULE_TEXT = `扫低 = 1 小时最低价跌破之前 7 天最低价，之后 ${FLUSH_RULES.showHours} 小时内显示；费率看那根收盘时已结算的最近一次，转负 = 低于 0；持仓骤降 = 24 小时变化在过去一年最低 ${FLUSH_RULES.flushPct * 100}%，没怎么掉 = 高于中位。E43 里这几种状态都没有达到优势标准，只是历史比例；入场纪律还是等 15 分钟转强。`;

/** 命令行一段 */
export function flushLines(x: Flush): string[] {
  return [flushHeadline(x), flushNumbers(x), flushFact(x), flushBase(x), ...(flushNow(x) ? [flushNow(x)!] : [])];
}
