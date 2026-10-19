import type { Candle } from "../types.ts";

export interface Pivot {
  i: number;
  t: number;
  price: number;
  kind: "high" | "low";
  /** the last pivot is still forming and may move */
  provisional?: boolean;
}

/**
 * ATR-threshold ZigZag. A swing is confirmed once price reverses by at least
 * `mult` × ATR from the running extreme. The final pivot is provisional.
 */
export function zigzag(c: Candle[], atr: number[], mult = 3): Pivot[] {
  const out: Pivot[] = [];
  if (c.length < 3) return out;
  const th = (i: number) => (Number.isNaN(atr[i]) ? c[i].c * 0.01 : atr[i]) * mult;
  const high = (i: number): Pivot => ({ i, t: c[i].t, price: c[i].h, kind: "high" });
  const low = (i: number): Pivot => ({ i, t: c[i].t, price: c[i].l, kind: "low" });

  let dir: 1 | -1 | 0 = 0;
  let hi = 0, lo = 0;
  for (let i = 1; i < c.length; i++) {
    if (c[i].h >= c[hi].h) hi = i;
    if (c[i].l <= c[lo].l) lo = i;
    if (dir === 0) {
      if (c[hi].h - c[lo].l >= th(i)) {
        if (hi > lo) {
          out.push(low(lo));
          dir = 1;
        } else {
          out.push(high(hi));
          dir = -1;
        }
      }
    } else if (dir === 1) {
      if (c[hi].h - c[i].l >= th(i)) {
        out.push(high(hi));
        dir = -1;
        lo = i;
      }
    } else if (c[i].h - c[lo].l >= th(i)) {
      out.push(low(lo));
      dir = 1;
      hi = i;
    }
  }
  if (dir === 1) out.push({ ...high(hi), provisional: true });
  if (dir === -1) out.push({ ...low(lo), provisional: true });
  return out;
}
