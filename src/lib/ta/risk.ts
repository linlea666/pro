import type { Candle, Timeframe } from "../types.ts";

/**
 * Where to be proven wrong, and how likely plain noise is to get there first.
 *
 * - Structural anchors: confirmed swing highs / lows that price has never
 *   closed through since they formed.
 * - Sweep depth: when such a level held, how far past it price still poked
 *   (in ATR). A stop inside that depth gets swept even when the level holds.
 * - Noise curve: from a random entry, the share of times price touches a stop
 *   k ATR away within the holding horizon.
 *
 * Measured on BTC/ETH 2017–2026 (see docs): held levels were poked 0.35–0.48 ATR
 * at the median and 0.67–0.84 ATR at p80; a 1.5 ATR stop on 4h was touched by
 * noise ~56% of the time within 3 days.
 */

/** Bars on each side that confirm a swing point, by timeframe. */
export const PIVOT_K: Record<Timeframe, number> = { "5m": 5, "15m": 5, "1h": 5, "4h": 5, "1d": 3, "1w": 2 };

export const NOISE_KS = [0.5, 1, 1.5, 2, 3, 4, 6];
export const PROBE_QS = [50, 55, 60, 65, 70, 75, 80, 85, 90, 95];
/** Used until a coin/timeframe has been calibrated: roughly the measured p80 on BTC/ETH. */
export const DEFAULT_BUFFER_ATR = 0.8;
/**
 * The whole sweep-depth curve used until then: p50 and p80 as measured on BTC/ETH
 * (E4: 0.35–0.48 and 0.67–0.84 ATR), the tail above p80 extended conservatively.
 */
const DEFAULT_PROBE: Record<string, number> = { "50": 0.42, "55": 0.47, "60": 0.53, "65": 0.6, "70": 0.67, "75": 0.73, "80": 0.8, "85": 0.9, "90": 1.0, "95": 1.2 };

export interface Calibration {
  /** sweep depth (ATR) by quantile, keys "50" … "95" */
  probe: Record<string, number>;
  /** [k ATR, % touched within the horizon] */
  noise: [number, number][];
  horizon: number;
  samples: number;
}

export interface Anchor {
  i: number;
  t: number;
  price: number;
  tests: number;
}

export function atrSeries(c: Candle[], n = 14): number[] {
  const a = new Array(c.length).fill(NaN);
  let s = 0;
  for (let i = 1; i < c.length; i++) {
    const tr = Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c));
    if (i <= n) {
      s += tr;
      if (i === n) a[i] = s / n;
    } else a[i] = (a[i - 1] * (n - 1) + tr) / n;
  }
  return a;
}

/**
 * Intact swing points known at the close of bar `t` (confirmed `K` bars later,
 * never closed through by more than 0.1 ATR since), within `look` bars.
 */
export function intactPivots(c: Candle[], atr: number[], t: number, K: number, side: "high" | "low", look = 400): Anchor[] {
  const sg = side === "high" ? 1 : -1;
  const out: Anchor[] = [];
  for (let i = Math.max(K, t - look); i <= t - K; i++) {
    let ok = true;
    for (let j = i - K; j <= i + K && ok; j++) if (j !== i && (side === "high" ? c[j].h > c[i].h : c[j].l < c[i].l)) ok = false;
    if (!ok) continue;
    const L = side === "high" ? c[i].h : c[i].l;
    let tests = 0, lastTest = -99, broken = false;
    for (let j = i + K + 1; j <= t; j++) {
      const a = atr[j] || atr[t];
      if ((c[j].c - L) * sg > 0.1 * a) {
        broken = true;
        break;
      }
      if ((L - (side === "high" ? c[j].h : c[j].l)) * sg <= 0.3 * a && j - lastTest >= 3) {
        tests++;
        lastTest = j;
      }
    }
    if (!broken) out.push({ i, t: c[i].t, price: L, tests });
  }
  return out;
}

/**
 * Structural anchors on one side of the last close, nearest first, at least
 * `minAtr` away so a stop is not sitting on the price.
 */
export function structureAnchors(c: Candle[], tf: Timeframe, side: "below" | "above", minAtr = 0.3, atr = atrSeries(c)): Anchor[] {
  const t = c.length - 1;
  const p = c[t].c, a = atr[t];
  if (!Number.isFinite(a)) return [];
  const list = intactPivots(c, atr, t, PIVOT_K[tf], side === "below" ? "low" : "high");
  return list
    .filter((x) => (side === "below" ? p - x.price : x.price - p) >= minAtr * a)
    .sort((x, y) => (side === "below" ? y.price - x.price : x.price - y.price));
}

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * Sweep depth of held levels and the noise curve, from one candle history.
 * `step` samples every few bars to keep it cheap (results barely change).
 */
export function calibrate(c: Candle[], tf: Timeframe, horizon: number, step = 3): Calibration {
  const atr = atrSeries(c);
  const K = PIVOT_K[tf];
  const probes: number[] = [];
  for (let t = 300; t < c.length - horizon; t += step) {
    const a = atr[t], p = c[t].c;
    if (!Number.isFinite(a)) continue;
    for (const side of ["high", "low"] as const) {
      const sg = side === "high" ? 1 : -1;
      const near = intactPivots(c, atr, t, K, side, 300)
        .filter((x) => (x.price - p) * sg > 0.5 * a && (x.price - p) * sg < 6 * a)
        .sort((x, y) => (x.price - y.price) * sg)[0];
      if (!near) continue;
      // touched within 0.3 ATR, never closed more than 0.3 ATR beyond → held; record how far it poked
      let touched = false, broke = false, poke = 0;
      for (let j = t + 1; j <= t + horizon; j++) {
        const ext = side === "high" ? c[j].h : c[j].l;
        if ((near.price - ext) * sg <= 0.3 * a) touched = true;
        if (touched && (c[j].c - near.price) * sg > 0.3 * a) {
          broke = true;
          break;
        }
        poke = Math.max(poke, ((ext - near.price) * sg) / a);
      }
      if (touched && !broke && poke > 0) probes.push(poke);
    }
  }
  probes.sort((x, y) => x - y);
  const probe = Object.fromEntries(PROBE_QS.map((q) => [String(q), probes.length >= 30 ? Math.round(quantile(probes, q / 100) * 100) / 100 : DEFAULT_BUFFER_ATR]));

  const hits = NOISE_KS.map(() => 0);
  let n = 0;
  for (let t = 20; t < c.length - horizon; t++) {
    const a = atr[t], p = c[t].c;
    if (!Number.isFinite(a)) continue;
    let up = 0, down = 0;
    for (let j = t + 1; j <= t + horizon; j++) {
      up = Math.max(up, c[j].h - p);
      down = Math.max(down, p - c[j].l);
    }
    for (const ext of [up, down]) {
      n++;
      NOISE_KS.forEach((k, q) => {
        if (ext >= k * a) hits[q]++;
      });
    }
  }
  const noise = NOISE_KS.map((k, q) => [k, n ? Math.round((hits[q] / n) * 1000) / 10 : 0] as [number, number]);
  return { probe, noise, horizon, samples: probes.length };
}

/** Sweep buffer (ATR) at a quantile between 50 and 95, interpolating the stored steps. */
export function bufferAtr(cal: Calibration | null, q: number): number {
  const probe = cal?.probe ?? DEFAULT_PROBE;
  const lo = Math.max(50, Math.min(95, Math.floor(q / 5) * 5)), hi = Math.min(95, lo + 5);
  const a = probe[String(lo)] ?? DEFAULT_BUFFER_ATR, b = probe[String(hi)] ?? a;
  return lo === hi ? a : a + ((b - a) * (q - lo)) / 5;
}

/** % chance noise touches a stop `k` ATR away within the calibrated horizon. */
export function noiseProb(cal: Calibration | null, k: number): number | null {
  if (!cal || !cal.noise.length) return null;
  const pts: [number, number][] = [[0, 100], ...cal.noise];
  if (k >= pts[pts.length - 1][0]) return pts[pts.length - 1][1];
  for (let q = 1; q < pts.length; q++) {
    const [k1, p1] = pts[q];
    if (k <= k1) {
      const [k0, p0] = pts[q - 1];
      return Math.round(p0 + ((p1 - p0) * (k - k0)) / (k1 - k0));
    }
  }
  return null;
}
