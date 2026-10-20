import type { TrendPlan } from "@/lib/trendplan";
import { noiseProb } from "@/lib/ta/risk";
import type { Candle } from "@/lib/types";

/** Shared helpers of the trend-and-plan page and the position check. */

export const fmtR = (x: number | null | undefined, d = 2) =>
  x == null || !Number.isFinite(x) ? "—" : Math.abs(x) < 0.5 * 10 ** -d ? `${(0).toFixed(d)}R` : `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(d)}R`;

/** Local month-day and time, e.g. "09-23 20:00". */
export function fmtWhen(sec: number) {
  const d = new Date(sec * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** % chance plain noise touches a stop `k` ATR away within the calibrated horizon (null when not calibrated). */
export const noiseAt = (p: TrendPlan, k: number) => (p.noise ? noiseProb({ probe: {}, noise: p.noise, horizon: 0, samples: 0 }, k) : null);

/** Closed bars only (the plan's candles end with the forming bar when there is one). */
export const closedBars = (p: TrendPlan): Candle[] => (p.forming ? p.candles.slice(0, -1) : p.candles);

/**
 * The stop the plan's rules would use now for a position in `dir`: beyond the lowest low (highest high)
 * since the entry timeframe's last confirmed swing on that side, by the p80 sweep buffer.
 */
export function structureStop(p: TrendPlan, dir: 1 | -1): { stop: number; anchor: number } | null {
  const view = p.map.find((m) => m.role === "entry")?.view;
  const sw = dir > 0 ? view?.lastLow : view?.lastHigh;
  if (!sw || !(p.atr > 0)) return null;
  let anchor = sw.price;
  for (const c of closedBars(p)) if (c.t >= sw.t) anchor = dir > 0 ? Math.min(anchor, c.l) : Math.max(anchor, c.h);
  return { anchor, stop: anchor - dir * p.buffers.p80 * p.atr };
}

/**
 * Two-level state of a price level against the latest closes (E9): coming from one side, a close
 * 0.1 ATR beyond it is "pierced", 0.8 ATR beyond is "broken". Wicks do not count.
 */
export function levelState(price: number, bars: Candle[], atr: number, look = 6): "none" | "pierced" | "broken" {
  const n = bars.length - 1;
  if (n < look || !(atr > 0)) return "none";
  const from = Math.sign(bars[n - look].c - price);
  if (!from) return "none";
  const depth = ((price - bars[n].c) * from) / atr;
  return depth >= 0.8 ? "broken" : depth >= 0.1 ? "pierced" : "none";
}

/** Correlation of daily log returns over the closes both series have (aligned at the end). */
export function returnCorrelation(a: number[], b: number[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n < 30) return null;
  const ra: number[] = [], rb: number[] = [];
  for (let k = 1; k < n; k++) {
    ra.push(Math.log(a[a.length - n + k] / a[a.length - n + k - 1]));
    rb.push(Math.log(b[b.length - n + k] / b[b.length - n + k - 1]));
  }
  const mean = (x: number[]) => x.reduce((s, v) => s + v, 0) / x.length;
  const ma = mean(ra), mb = mean(rb);
  let sab = 0, saa = 0, sbb = 0;
  for (let k = 0; k < ra.length; k++) {
    sab += (ra[k] - ma) * (rb[k] - mb);
    saa += (ra[k] - ma) ** 2;
    sbb += (rb[k] - mb) ** 2;
  }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : null;
}

/** Chance of at least one run of `k` losses in a row within `n` trades, for a win rate (0–1). */
export function lossStreakProb(win: number, n = 20, k = 5): number {
  const q = 1 - win;
  let dp = new Array(k).fill(0);
  dp[0] = 1;
  for (let i = 0; i < n; i++) {
    const nx = new Array(k).fill(0);
    for (let r = 0; r < k; r++) {
      nx[0] += dp[r] * win;
      if (r + 1 < k) nx[r + 1] += dp[r] * q;
    }
    dp = nx;
  }
  return 1 - dp.reduce((s, v) => s + v, 0);
}

const STORE = { capital: "sl-capital", risk: "sl-risk-pct", lev: "sl-leverage" };

/** Per-viewer defaults for the calculators (browser only; missing or blocked storage falls back). */
export function readPref(key: keyof typeof STORE, fallback: number): number {
  try {
    const v = Number(localStorage.getItem(STORE[key]));
    return Number.isFinite(v) && v > 0 ? v : fallback;
  } catch {
    return fallback;
  }
}

export function writePref(key: keyof typeof STORE, v: number) {
  try {
    if (Number.isFinite(v) && v > 0) localStorage.setItem(STORE[key], String(v));
  } catch {}
}
