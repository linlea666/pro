import type { Candle } from "../types.ts";
import { relVolume } from "./plan.ts";
import { PA_RULES } from "./patterns.ts";

/**
 * 最近一根已收盘 K 线的影线和量能（2026-11-01，盯盘页专业模式的描述行）。只描述，不是信号：E40 测过“碰到关键位时的
 * 长影线 + 放量 / 缩量”，没有优势（见 `WICK_FACT`）。长影线的标准和裸 K、E40 同一条（`PA_RULES.pinWick / pinClose`），
 * 量能 = 这根的量 ÷ 前 20 根的中位数（`relVolume`），放量 ≥ 1.5 倍、缩量 ≤ 0.8 倍（E40 的主口径）。
 */
export interface BarShape {
  /** 这根 K 线的开盘时刻 */
  t: number;
  /** 上影线、下影线占全长的比例，% */
  upperPct: number;
  lowerPct: number;
  /** 量是前 20 根中位数的几倍 */
  volX: number;
  /** 按裸 K 的标准算不算长影线（收盘也要在另一头 1/3 里） */
  longWick: "lower" | "upper" | null;
  vol: "up" | "down" | "normal";
}

export const VOL_UP = 1.5;
export const VOL_DOWN = 0.8;

export function barShape(c: Candle[], i: number): BarShape | null {
  const b = c[i];
  if (!b) return null;
  const range = b.h - b.l;
  const upper = range > 0 ? (b.h - Math.max(b.o, b.c)) / range : 0;
  const lower = range > 0 ? (Math.min(b.o, b.c) - b.l) / range : 0;
  const closeUp = range > 0 ? (b.c - b.l) / range : 0;
  const longWick = range > 0 && lower >= PA_RULES.pinWick && closeUp >= PA_RULES.pinClose ? "lower" : range > 0 && upper >= PA_RULES.pinWick && 1 - closeUp >= PA_RULES.pinClose ? "upper" : null;
  const volX = i > 0 ? relVolume(c, i) : 1;
  return { t: b.t, upperPct: Math.round(upper * 100), lowerPct: Math.round(lower * 100), volX: Math.round(volX * 100) / 100, longWick, vol: volX >= VOL_UP ? "up" : volX <= VOL_DOWN ? "down" : "normal" };
}

/** 一句话：“长下影（下影 62%）、放量 1.8 倍” */
export function barShapeText(s: BarShape): string {
  const wick = s.longWick === "lower" ? `长下影（下影 ${s.lowerPct}%）` : s.longWick === "upper" ? `长上影（上影 ${s.upperPct}%）` : `没有长影线（上影 ${s.upperPct}%、下影 ${s.lowerPct}%）`;
  const vol = s.vol === "up" ? `放量 ${s.volX} 倍` : s.vol === "down" ? `缩量 ${s.volX} 倍` : `量 ${s.volX} 倍（平常）`;
  return `${wick}、${vol}`;
}

/** E40 的结论，页面唯一能说的“影线 + 量能”的话（两种模式都显示） */
export const WICK_FACT =
  "碰到关键位后出现长影线很常见：BTC / ETH 2022 年起的盯盘事件里，3 天内 75–89% 都会出现一根，不管放量还是缩量。看到就进和随便进差不多，24 小时内约一半被扫（等转强 / 转弱再进约三成）；转强之前有没有这种 K 线，转强的结果也没有差别（E40）。所以影线和量能只是描述，入场仍等转强（做空等转弱）。";
