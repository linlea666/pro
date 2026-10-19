import type { Candle } from "../types.ts";
import type { Pivot } from "./zigzag.ts";

export const RETRACE_RATIOS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
export const EXTENSION_RATIOS = [1.272, 1.618, 2.618];

export interface FibLevel {
  ratio: number;
  price: number;
  kind: "retrace" | "extension";
}

export interface FibResult {
  /** swing start (A) and end (B) */
  a: Pivot;
  b: Pivot;
  direction: "up" | "down";
  levels: FibLevel[];
  /** where price sits now, as a retracement ratio of A→B (0 = at B, 1 = back at A) */
  currentRatio: number;
  zoneText: string;
}

export function fibFromSwing(a: Pivot, b: Pivot, lastClose: number): FibResult {
  const up = b.price > a.price;
  const span = b.price - a.price;
  const levels: FibLevel[] = [
    ...RETRACE_RATIOS.map((r) => ({ ratio: r, price: b.price - span * r, kind: "retrace" as const })),
    ...EXTENSION_RATIOS.map((r) => ({ ratio: r, price: a.price + span * r, kind: "extension" as const })),
  ];
  const currentRatio = span === 0 ? 0 : (b.price - lastClose) / span;
  let zoneText: string;
  if (currentRatio < 0) zoneText = up ? "价格已经突破这段上涨的高点，进入延伸区" : "价格已经跌破这段下跌的低点，进入延伸区";
  else if (currentRatio < 0.236) zoneText = up ? "几乎没有回调，上涨势头很强" : "几乎没有反弹，下跌势头很强";
  else if (currentRatio < 0.382) zoneText = up ? "浅回调（< 38.2%），强势整理" : "弱反弹（< 38.2%），仍偏弱";
  else if (currentRatio < 0.618) zoneText = up ? "正常回调区（38.2%–61.8%），常见的“上车”观察区" : "正常反弹区（38.2%–61.8%），常见的反弹压力区";
  else if (currentRatio < 1) zoneText = up ? "深度回调（> 61.8%），上涨结构有被破坏的风险" : "深度反弹（> 61.8%），下跌结构可能被扭转";
  else zoneText = up ? "已经回吐整段涨幅，原上涨结构失效" : "已经收复整段跌幅，原下跌结构失效";
  return { a, b, direction: up ? "up" : "down", levels, currentRatio, zoneText };
}

/** Pick the most recent significant swing from zigzag pivots. */
export function autoFib(c: Candle[], pivots: Pivot[]): FibResult | null {
  if (pivots.length < 2) return null;
  // Use the last confirmed swing (second-to-last → last pivot), but if the
  // final leg is tiny compared to the one before, anchor on the bigger leg.
  let a = pivots[pivots.length - 2];
  let b = pivots[pivots.length - 1];
  if (pivots.length >= 3) {
    const prevA = pivots[pivots.length - 3];
    if (Math.abs(b.price - a.price) < 0.5 * Math.abs(a.price - prevA.price)) {
      b = a;
      a = prevA;
    }
  }
  return fibFromSwing(a, b, c[c.length - 1].c);
}
