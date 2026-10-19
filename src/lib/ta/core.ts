import type { Candle } from "../types.ts";

/**
 * Plain indicator math. Every function returns an array aligned with its
 * input; warm-up values are NaN.
 */

export type Series = number[];

const nan = (n: number): Series => new Array(n).fill(NaN);

export function sma(src: Series, n: number): Series {
  const out = nan(src.length);
  let sum = 0;
  let count = 0;
  for (let i = 0; i < src.length; i++) {
    const v = src[i];
    if (Number.isNaN(v)) {
      sum = 0;
      count = 0;
      continue;
    }
    sum += v;
    count++;
    if (count > n) sum -= src[i - n];
    if (count >= n) out[i] = sum / n;
  }
  return out;
}

/** EMA seeded with the SMA of the first n valid values. */
export function ema(src: Series, n: number, alpha = 2 / (n + 1)): Series {
  const out = nan(src.length);
  let prev = NaN;
  let seedSum = 0;
  let seedCount = 0;
  for (let i = 0; i < src.length; i++) {
    const v = src[i];
    if (Number.isNaN(v)) continue;
    if (Number.isNaN(prev)) {
      seedSum += v;
      seedCount++;
      if (seedCount === n) {
        prev = seedSum / n;
        out[i] = prev;
      }
      continue;
    }
    prev = alpha * v + (1 - alpha) * prev;
    out[i] = prev;
  }
  return out;
}

/** Wilder's smoothing (RMA). */
export const rma = (src: Series, n: number): Series => ema(src, n, 1 / n);

export function stdev(src: Series, n: number): Series {
  const out = nan(src.length);
  const mean = sma(src, n);
  for (let i = n - 1; i < src.length; i++) {
    if (Number.isNaN(mean[i])) continue;
    let s = 0;
    for (let j = i - n + 1; j <= i; j++) s += (src[j] - mean[i]) ** 2;
    out[i] = Math.sqrt(s / n);
  }
  return out;
}

export function highest(src: Series, n: number): Series {
  const out = nan(src.length);
  for (let i = n - 1; i < src.length; i++) {
    let m = -Infinity;
    for (let j = i - n + 1; j <= i; j++) if (src[j] > m) m = src[j];
    out[i] = m;
  }
  return out;
}

export function lowest(src: Series, n: number): Series {
  const out = nan(src.length);
  for (let i = n - 1; i < src.length; i++) {
    let m = Infinity;
    for (let j = i - n + 1; j <= i; j++) if (src[j] < m) m = src[j];
    out[i] = m;
  }
  return out;
}

export const closes = (c: Candle[]) => c.map((x) => x.c);
export const highs = (c: Candle[]) => c.map((x) => x.h);
export const lows = (c: Candle[]) => c.map((x) => x.l);
export const volumes = (c: Candle[]) => c.map((x) => x.v);
export const typical = (c: Candle[]) => c.map((x) => (x.h + x.l + x.c) / 3);

export function trueRange(c: Candle[]): Series {
  return c.map((x, i) =>
    i === 0 ? x.h - x.l : Math.max(x.h - x.l, Math.abs(x.h - c[i - 1].c), Math.abs(x.l - c[i - 1].c)),
  );
}

export const atr = (c: Candle[], n = 14) => rma(trueRange(c), n);

export function rsi(src: Series, n = 14): Series {
  const up = nan(src.length);
  const dn = nan(src.length);
  for (let i = 1; i < src.length; i++) {
    const d = src[i] - src[i - 1];
    up[i] = Math.max(d, 0);
    dn[i] = Math.max(-d, 0);
  }
  const au = rma(up, n);
  const ad = rma(dn, n);
  return au.map((u, i) => (Number.isNaN(u) ? NaN : ad[i] === 0 ? 100 : 100 - 100 / (1 + u / ad[i])));
}

export function macd(src: Series, fast = 12, slow = 26, signal = 9) {
  const f = ema(src, fast);
  const s = ema(src, slow);
  const line = f.map((v, i) => v - s[i]);
  const sig = ema(line, signal);
  const hist = line.map((v, i) => v - sig[i]);
  return { line, signal: sig, hist };
}

export function bollinger(src: Series, n = 20, k = 2) {
  const mid = sma(src, n);
  const sd = stdev(src, n);
  return {
    mid,
    upper: mid.map((m, i) => m + k * sd[i]),
    lower: mid.map((m, i) => m - k * sd[i]),
    width: mid.map((m, i) => (2 * k * sd[i]) / m),
  };
}

export function stochastic(c: Candle[], n = 14, smoothK = 3, smoothD = 3) {
  const hh = highest(highs(c), n);
  const ll = lowest(lows(c), n);
  const raw = c.map((x, i) => (hh[i] === ll[i] ? 50 : ((x.c - ll[i]) / (hh[i] - ll[i])) * 100));
  const k = sma(raw.map((v, i) => (i < n - 1 ? NaN : v)), smoothK);
  const d = sma(k, smoothD);
  return { k, d };
}

export function cci(c: Candle[], n = 20): Series {
  const tp = typical(c);
  const m = sma(tp, n);
  const out = nan(c.length);
  for (let i = n - 1; i < c.length; i++) {
    let md = 0;
    for (let j = i - n + 1; j <= i; j++) md += Math.abs(tp[j] - m[i]);
    md /= n;
    out[i] = md === 0 ? 0 : (tp[i] - m[i]) / (0.015 * md);
  }
  return out;
}

export function williamsR(c: Candle[], n = 14): Series {
  const hh = highest(highs(c), n);
  const ll = lowest(lows(c), n);
  return c.map((x, i) => (hh[i] === ll[i] ? -50 : ((hh[i] - x.c) / (hh[i] - ll[i])) * -100));
}

export function roc(src: Series, n = 12): Series {
  return src.map((v, i) => (i < n ? NaN : ((v - src[i - n]) / src[i - n]) * 100));
}

export function adx(c: Candle[], n = 14) {
  const plusDM = nan(c.length);
  const minusDM = nan(c.length);
  for (let i = 1; i < c.length; i++) {
    const up = c[i].h - c[i - 1].h;
    const dn = c[i - 1].l - c[i].l;
    plusDM[i] = up > dn && up > 0 ? up : 0;
    minusDM[i] = dn > up && dn > 0 ? dn : 0;
  }
  const tr = trueRange(c).map((v, i) => (i === 0 ? NaN : v));
  const atrN = rma(tr, n);
  const pdi = rma(plusDM, n).map((v, i) => (100 * v) / atrN[i]);
  const mdi = rma(minusDM, n).map((v, i) => (100 * v) / atrN[i]);
  const dx = pdi.map((p, i) => (p + mdi[i] === 0 ? 0 : (100 * Math.abs(p - mdi[i])) / (p + mdi[i])));
  return { adx: rma(dx, n), pdi, mdi };
}

/** Parabolic SAR. Returns sar values and trend direction (+1 / -1). */
export function psar(c: Candle[], step = 0.02, max = 0.2) {
  const sar = nan(c.length);
  const dir = new Array<number>(c.length).fill(0);
  if (c.length < 2) return { sar, dir };
  let up = c[1].c >= c[0].c;
  let af = step;
  let ep = up ? c[0].h : c[0].l;
  let s = up ? c[0].l : c[0].h;
  for (let i = 1; i < c.length; i++) {
    s = s + af * (ep - s);
    if (up) {
      s = Math.min(s, c[i - 1].l, i > 1 ? c[i - 2].l : c[i - 1].l);
      if (c[i].l < s) {
        up = false;
        s = ep;
        ep = c[i].l;
        af = step;
      } else if (c[i].h > ep) {
        ep = c[i].h;
        af = Math.min(af + step, max);
      }
    } else {
      s = Math.max(s, c[i - 1].h, i > 1 ? c[i - 2].h : c[i - 1].h);
      if (c[i].h > s) {
        up = true;
        s = ep;
        ep = c[i].h;
        af = step;
      } else if (c[i].l < ep) {
        ep = c[i].l;
        af = Math.min(af + step, max);
      }
    }
    sar[i] = s;
    dir[i] = up ? 1 : -1;
  }
  return { sar, dir };
}

export function aroon(c: Candle[], n = 25) {
  const upArr = nan(c.length);
  const dnArr = nan(c.length);
  for (let i = n; i < c.length; i++) {
    let hi = i, lo = i;
    for (let j = i - n; j <= i; j++) {
      if (c[j].h >= c[hi].h) hi = j;
      if (c[j].l <= c[lo].l) lo = j;
    }
    upArr[i] = ((n - (i - hi)) / n) * 100;
    dnArr[i] = ((n - (i - lo)) / n) * 100;
  }
  return { up: upArr, down: dnArr };
}

export function obv(c: Candle[]): Series {
  const out = new Array<number>(c.length).fill(0);
  for (let i = 1; i < c.length; i++) {
    const d = Math.sign(c[i].c - c[i - 1].c);
    out[i] = out[i - 1] + d * c[i].v;
  }
  return out;
}

export function mfi(c: Candle[], n = 14): Series {
  const tp = typical(c);
  const out = nan(c.length);
  for (let i = n; i < c.length; i++) {
    let pos = 0, neg = 0;
    for (let j = i - n + 1; j <= i; j++) {
      const flow = tp[j] * c[j].v;
      if (tp[j] > tp[j - 1]) pos += flow;
      else if (tp[j] < tp[j - 1]) neg += flow;
    }
    out[i] = neg === 0 ? 100 : 100 - 100 / (1 + pos / neg);
  }
  return out;
}

const mfm = (x: Candle) => (x.h === x.l ? 0 : ((x.c - x.l) - (x.h - x.c)) / (x.h - x.l));

/** Chaikin Money Flow. */
export function cmf(c: Candle[], n = 20): Series {
  const out = nan(c.length);
  for (let i = n - 1; i < c.length; i++) {
    let mv = 0, vv = 0;
    for (let j = i - n + 1; j <= i; j++) {
      mv += mfm(c[j]) * c[j].v;
      vv += c[j].v;
    }
    out[i] = vv === 0 ? 0 : mv / vv;
  }
  return out;
}

/** Accumulation / Distribution line. */
export function adl(c: Candle[]): Series {
  const out = new Array<number>(c.length).fill(0);
  for (let i = 0; i < c.length; i++) out[i] = (i ? out[i - 1] : 0) + mfm(c[i]) * c[i].v;
  return out;
}

export function forceIndex(c: Candle[], n = 13): Series {
  const raw = c.map((x, i) => (i === 0 ? NaN : (x.c - c[i - 1].c) * x.v));
  return ema(raw, n);
}

/** Rolling VWAP over n bars. */
export function rollingVwap(c: Candle[], n = 20): Series {
  const tp = typical(c);
  const out = nan(c.length);
  for (let i = n - 1; i < c.length; i++) {
    let pv = 0, vv = 0;
    for (let j = i - n + 1; j <= i; j++) {
      pv += tp[j] * c[j].v;
      vv += c[j].v;
    }
    out[i] = vv === 0 ? c[i].c : pv / vv;
  }
  return out;
}

export function ichimoku(c: Candle[], conv = 9, base = 26, spanB = 52) {
  const mid = (n: number) => {
    const hh = highest(highs(c), n);
    const ll = lowest(lows(c), n);
    return hh.map((h, i) => (h + ll[i]) / 2);
  };
  const tenkan = mid(conv);
  const kijun = mid(base);
  const spanBraw = mid(spanB);
  // Cloud value that applies to bar i was computed `base` bars earlier.
  const senkouA = nan(c.length);
  const senkouB = nan(c.length);
  for (let i = base; i < c.length; i++) {
    senkouA[i] = (tenkan[i - base] + kijun[i - base]) / 2;
    senkouB[i] = spanBraw[i - base];
  }
  return { tenkan, kijun, senkouA, senkouB };
}

export function keltner(c: Candle[], n = 20, mult = 2) {
  const mid = ema(closes(c), n);
  const a = atr(c, n);
  return { mid, upper: mid.map((m, i) => m + mult * a[i]), lower: mid.map((m, i) => m - mult * a[i]) };
}

/** Least-squares slope of the last n values, normalised to % of price per bar. */
export function regressionSlope(src: Series, n = 20): Series {
  const out = nan(src.length);
  const xm = (n - 1) / 2;
  let den = 0;
  for (let x = 0; x < n; x++) den += (x - xm) ** 2;
  for (let i = n - 1; i < src.length; i++) {
    let ym = 0;
    for (let j = 0; j < n; j++) ym += src[i - n + 1 + j];
    ym /= n;
    let num = 0;
    for (let j = 0; j < n; j++) num += (j - xm) * (src[i - n + 1 + j] - ym);
    out[i] = (num / den / ym) * 100;
  }
  return out;
}

export const last = <T>(arr: T[], back = 0): T => arr[arr.length - 1 - back];
