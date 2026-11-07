import type { Candle } from "../types.ts";

/**
 * 放量冲击（2026-11-05，E41 / E41b / E41c，研究脚本和页面共用这一份规则）：1 小时收盘，最近 12 根收盘涨跌 ≥ 5 倍
 * “冲击之前”的 ATR、走得干脆（效率 ≥ 0.4）、这 12 根平均成交量 ≥ 之前 120 根平均的 1.5 倍，只在第一次成立的那根算一次。
 * 之后用 3 倍 1 小时 ATR 吊灯跟着（从冲击后的最高价回落 3 倍 ATR，只在收盘后上移；影线碰到就算结束），最长 240 根。
 * “之前 7 天”= 当天（UTC 0 点）之前 168 根 1 小时收益的标准差，在之前 365 天里的分位：最低 1/3 安静、最高 1/3 动荡。
 *
 * 只描述，不是信号：BTC 2020 年起，冲击后顺着追对随机只 +0.08R、不显著、最近 12 个月约 0；反着做 −0.14R，各段都更差。
 * 页面能说的话只有 `IMPULSE_FACTS`。
 */
export const IMPULSE_RULES = {
  /** 冲击窗口（1 小时根数） */
  bars: 12,
  /** 至少走了几倍冲击之前的 ATR */
  atr: 5,
  /** 效率 = |净涨跌| ÷ 每根涨跌绝对值之和 */
  er: 0.4,
  /** 成交量是之前 `volBase` 根平均的几倍 */
  volX: 1.5,
  volBase: 120,
  /** 吊灯：从冲击后的极点回落几倍 ATR */
  trailAtr: 3,
  /** 最长跟多少根（之后不再显示） */
  maxBars: 240,
  /** “之前 7 天”的窗口和比较的天数 */
  quietBars: 168,
  quietDays: 365,
} as const;

export type QuietLabel = "安静" | "正常" | "动荡";

export interface Impulse {
  dir: 1 | -1;
  /** 触发那根 1 小时 K 线的开盘时刻 */
  t: number;
  /** 这 12 根的涨跌，% */
  movePct: number;
  /** 涨跌是冲击之前 ATR 的几倍 */
  moveAtr: number;
  /** 成交量是之前的几倍 */
  volX: number;
  /** 入场参考 = 触发后下一根开盘（下一根还没收盘时 = 触发那根收盘） */
  entry: number;
  /** 入场之后的最高价 / 最低价（还没有下一根时 = 入场参考） */
  extreme: number;
  /** 现在的移动止损 */
  trail: number;
  /** 还没被吊灯扫掉、也没超过 240 根 */
  active: boolean;
  /** 被扫掉的那根的开盘时刻 */
  endedT: number | null;
  /** 之前 7 天的波动分位（0–1），数据不够时为 null */
  quiet: number | null;
  quietLabel: QuietLabel | null;
}

/** 第 k 根收盘时，冲击条件是否成立（方向 d） */
export function impulseHolds(c: Candle[], atr: number[], k: number, d: 1 | -1): boolean {
  const R = IMPULSE_RULES, n = R.bars;
  if (k < n + R.volBase || k >= c.length) return false;
  const a = atr[k - n];
  if (!(a > 0)) return false;
  const move = c[k].c - c[k - n].c;
  if (d * move < R.atr * a) return false;
  let path = 0;
  for (let j = k - n + 1; j <= k; j++) path += Math.abs(c[j].c - c[j - 1].c);
  if (!(path > 0) || Math.abs(move) / path < R.er) return false;
  return volRatio(c, k) >= R.volX;
}

/** 最近 12 根平均成交量 ÷ 之前 120 根平均 */
export function volRatio(c: Candle[], k: number): number {
  const R = IMPULSE_RULES, n = R.bars;
  let vw = 0, vb = 0;
  for (let j = k - n + 1; j <= k; j++) vw += c[j].v;
  for (let j = k - n - R.volBase + 1; j <= k - n; j++) vb += c[j].v;
  return vb > 0 ? vw / n / (vb / R.volBase) : 0;
}

/** 第 k 根是不是新触发（这一根成立、上一根不成立）；返回方向 */
export function impulseTrigger(c: Candle[], atr: number[], k: number): 1 | -1 | 0 {
  for (const d of [1, -1] as const) if (impulseHolds(c, atr, k, d) && !impulseHolds(c, atr, k - 1, d)) return d;
  return 0;
}

/**
 * 从触发那根 k 起跟吊灯，看到 `last`（含）为止：返回入场参考、极点、现在的止损、被扫掉的那根。
 * 和研究（E41 的 settle）一样：同一根先看止损，再更新极点和止损。
 */
export function trailFrom(c: Candle[], atr: number[], k: number, d: 1 | -1, last = c.length - 1) {
  const R = IMPULSE_RULES;
  const entry = k + 1 <= last ? c[k + 1].o : c[k].c;
  let stop = entry - d * R.trailAtr * atr[k], ext = entry;
  let endIdx = -1;
  const maxI = Math.min(last, k + R.maxBars);
  for (let j = k + 1; j <= maxI; j++) {
    const x = c[j];
    if (d > 0 ? x.l <= stop : x.h >= stop) {
      endIdx = j;
      break;
    }
    ext = d > 0 ? Math.max(ext, x.h) : Math.min(ext, x.l);
    stop = d > 0 ? Math.max(stop, ext - R.trailAtr * atr[j]) : Math.min(stop, ext + R.trailAtr * atr[j]);
  }
  const expired = endIdx < 0 && last - k >= R.maxBars;
  return { entry, extreme: ext, trail: stop, endIdx, active: endIdx < 0 && !expired };
}

/**
 * 每个 UTC 日开始时，之前 168 根 1 小时收益的标准差（`sd`），以及它在之前 365 天里的分位（`rank`，0–1）。
 * `h` 是 1 小时 K 线（要有一年多）。键都是 UTC 日 0 点（秒）。波动压缩（squeeze.ts）也用这一份。
 */
export function quietStats(h: Candle[]): { sd: Map<number, number>; rank: Map<number, number> } {
  const R = IMPULSE_RULES;
  const sd = new Map<number, number>();
  let cur = -1;
  for (let i = R.quietBars; i < h.length; i++) {
    const day = Math.floor(h[i].t / 86400) * 86400;
    if (day === cur) continue;
    cur = day;
    let s = 0, s2 = 0, m = 0;
    for (let j = i - R.quietBars + 1; j < i; j++) {
      const r = Math.log(h[j].c / h[j - 1].c);
      s += r;
      s2 += r * r;
      m++;
    }
    sd.set(day, Math.sqrt(Math.max(0, (s2 - (s * s) / m) / (m - 1))));
  }
  const days = [...sd.keys()].sort((a, b) => a - b);
  const rank = new Map<number, number>();
  days.forEach((d, k) => {
    if (k < R.quietDays) return;
    const v = sd.get(d)!;
    let lo = 0;
    for (let j = k - R.quietDays; j < k; j++) if (sd.get(days[j])! < v) lo++;
    rank.set(d, lo / R.quietDays);
  });
  return { sd, rank };
}

/** 每个 UTC 日开始时，之前 168 根 1 小时收益的标准差在之前 365 天里的分位（0–1） */
export function quietRanks(h: Candle[]): Map<number, number> {
  return quietStats(h).rank;
}

export const quietLabelOf = (q: number | null): QuietLabel | null => (q == null ? null : q < 1 / 3 ? "安静" : q >= 2 / 3 ? "动荡" : "正常");

/**
 * 最近一次放量冲击（`c` 是已收盘的 1 小时 K 线，`atr` 同长度）：只看最近 240 根里最新的一次触发；没有就是 null。
 * `quiet` = `quietRanks` 的结果（可省略）。
 */
export function latestImpulse(c: Candle[], atr: number[], quiet?: Map<number, number>): Impulse | null {
  const R = IMPULSE_RULES, last = c.length - 1;
  for (let k = last; k >= Math.max(R.bars + R.volBase + 1, last - R.maxBars); k--) {
    const d = impulseTrigger(c, atr, k);
    if (!d) continue;
    const tr = trailFrom(c, atr, k, d, last);
    const q = quiet?.get(Math.floor(c[k].t / 86400) * 86400) ?? null;
    return {
      dir: d,
      t: c[k].t,
      movePct: Math.round((c[k].c / c[k - R.bars].c - 1) * 1000) / 10,
      moveAtr: Math.round(((c[k].c - c[k - R.bars].c) / atr[k - R.bars]) * 10) / 10,
      volX: Math.round(volRatio(c, k) * 10) / 10,
      entry: tr.entry,
      extreme: tr.extreme,
      trail: tr.trail,
      active: tr.active,
      endedT: tr.endIdx >= 0 ? c[tr.endIdx].t : null,
      quiet: q,
      quietLabel: quietLabelOf(q),
    };
  }
  return null;
}

/** 研究数字（BTC 1 小时，2020-01 起，E41 / E41b，`COINS=BTC`），页面唯一能说的话 */
export const IMPULSE_FACTS = {
  fade: "BTC 2020 年起，放量冲击之后反着做（接飞刀做多 / 摸顶做空），比同方向、同止损的随机入场每笔差 0.14R，前后两半和最近 12 个月都一样（E41）。",
  chase: "顺着追只比随机好 0.08R，不显著，最近 12 个月约为 0；之前 7 天已经很动荡时顺着追反而差 0.21R，之前安静时好 0.16R（事后分组，还要验证）。",
  short: "放量冲击：历史上反着做每笔比随机差 0.14R，顺着追也证明不了能赚。",
  what: "放量冲击 = 1 小时收盘，12 小时内走了 5 倍 ATR 以上，成交量是之前 5 天平均的 1.5 倍以上。只描述，不是入场信号。",
} as const;

const fmt = (x: number) => (Math.abs(x) >= 1000 ? Math.round(x).toLocaleString("en-US") : String(Number(x.toPrecision(5))));

/** 一句话：“放量冲击向上：12 小时 +3.8%（5.6 倍 ATR），成交量是之前的 2.4 倍” */
export function impulseHeadline(x: Impulse): string {
  return `放量冲击${x.dir > 0 ? "向上" : "向下"}：12 小时 ${x.movePct >= 0 ? "+" : "−"}${Math.abs(x.movePct)}%（${Math.abs(x.moveAtr)} 倍 1 小时 ATR），成交量是之前的 ${x.volX} 倍`;
}

export function quietText(x: Impulse): string | null {
  if (x.quiet == null) return null;
  return `之前 7 天：${x.quietLabel}（波动排在过去一年的 ${Math.round(x.quiet * 100)}%）`;
}

/** 移动止损一句 */
export function trailText(x: Impulse): string {
  const up = x.dir > 0;
  return `顺势持仓的移动止损参考：${fmt(x.trail)}（冲击后${up ? "最高" : "最低"} ${fmt(x.extreme)} ${up ? "回落" : "反弹"} 3 倍 1 小时 ATR，只往${up ? "上" : "下"}移）；${up ? "跌破" : "涨破"}它，这次冲击就算结束。`;
}

/** 命令行 / 邮件用的几行 */
export function impulseLines(x: Impulse, at: (sec: number) => string): string[] {
  const out = [`${impulseHeadline(x)}（${at(x.t + 3600)} 收盘${x.active ? "" : `，${x.endedT != null ? `${at(x.endedT)} 已结束` : "已超过 10 天"}`}）`];
  const q = quietText(x);
  if (q) out.push(q);
  if (x.active) out.push(trailText(x));
  out.push(`别逆着做：${IMPULSE_FACTS.fade}`, IMPULSE_FACTS.chase);
  return out;
}
