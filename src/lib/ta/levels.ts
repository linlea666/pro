import type { Candle, Timeframe } from "../types.ts";
import * as ta from "./core.ts";
import { zigzag } from "./zigzag.ts";
import { DEFAULT_ENGINE_PARAMS, type EngineParams } from "../params.ts";

type LP = EngineParams["levels"];

/**
 * Support / resistance confluence. Many independent, public methods each
 * propose price levels; levels are clustered by price and a cluster scores
 * higher the more methods, contributions and timeframes agree on it.
 */

export type Method =
  | "swing"
  | "fractal"
  | "volume"
  | "pivot"
  | "camarilla"
  | "fibPivot"
  | "fib"
  | "prevHL"
  | "donchian"
  | "keltner"
  | "bollinger"
  | "ma"
  | "avwap"
  | "round";

export const METHOD_NAME: Record<Method, string> = {
  swing: "摆动高低",
  fractal: "Williams Fractals",
  volume: "成交量分布",
  pivot: "经典 Pivot",
  camarilla: "Camarilla",
  fibPivot: "Fibonacci Pivot",
  fib: "Fibonacci 回撤",
  prevHL: "前日/周/月高低",
  donchian: "Donchian 通道",
  keltner: "Keltner 通道",
  bollinger: "布林带",
  ma: "均线",
  avwap: "锚定 VWAP",
  round: "整数关口",
};

const TF_NAME: Record<Timeframe, string> = { "5m": "5分钟", "15m": "15分钟", "1h": "1小时", "4h": "4小时", "1d": "日线", "1w": "周线" };

export interface LevelCandidate {
  price: number;
  weight: number;
  method: Method;
  label: string;
  tf: Timeframe;
}

export interface Level {
  price: number;
  /** 0–100 relative to the strongest cluster */
  strength: number;
  /** raw confluence score */
  score: number;
  side: "support" | "resistance";
  /** distinct methods, strongest first */
  methods: string[];
  methodIds: Method[];
  /** contributing labels grouped by method, e.g. { swing: ["日线摆动高点"] } */
  labelsByMethod: Partial<Record<Method, string[]>>;
  /** number of individual contributions in the cluster */
  contributions: number;
  labels: string[];
  timeframes: Timeframe[];
  distancePct: number;
}

// ---------------------------------------------------------------- helpers

function volumeProfile(c: Candle[], bins = 48) {
  let lo = Infinity, hi = -Infinity;
  for (const x of c) {
    lo = Math.min(lo, x.l);
    hi = Math.max(hi, x.h);
  }
  const step = (hi - lo) / bins || 1;
  const vol = new Array(bins).fill(0);
  for (const x of c) {
    const a = Math.max(0, Math.floor((x.l - lo) / step));
    const b = Math.min(bins - 1, Math.floor((x.h - lo) / step));
    const share = x.v / (b - a + 1);
    for (let k = a; k <= b; k++) vol[k] += share;
  }
  const total = vol.reduce((s, v) => s + v, 0);
  let poc = 0;
  for (let k = 1; k < bins; k++) if (vol[k] > vol[poc]) poc = k;
  let a = poc, b = poc, acc = vol[poc];
  while (acc < total * 0.7 && (a > 0 || b < bins - 1)) {
    const left = a > 0 ? vol[a - 1] : -1;
    const right = b < bins - 1 ? vol[b + 1] : -1;
    if (right >= left) acc += vol[++b];
    else acc += vol[--a];
  }
  // high-volume nodes: local maxima well above average
  const avg = total / bins;
  const hvn: number[] = [];
  for (let k = 1; k < bins - 1; k++) if (k !== poc && vol[k] > vol[k - 1] && vol[k] >= vol[k + 1] && vol[k] > avg * 1.5) hvn.push(lo + (k + 0.5) * step);
  return { poc: lo + (poc + 0.5) * step, val: lo + a * step, vah: lo + (b + 1) * step, hvn };
}

export function roundStep(price: number): number {
  const mag = 10 ** Math.floor(Math.log10(price));
  const lead = price / mag;
  return lead < 2 ? mag / 10 : lead < 5 ? mag / 4 : mag / 2;
}

/** Group candles into calendar periods (UTC) and return completed periods' H/L/C. */
function periods(daily: Candle[], key: (d: Date) => string) {
  const out: { key: string; h: number; l: number; c: number }[] = [];
  for (const x of daily) {
    const k = key(new Date(x.t * 1000));
    const cur = out[out.length - 1];
    if (cur && cur.key === k) {
      cur.h = Math.max(cur.h, x.h);
      cur.l = Math.min(cur.l, x.l);
      cur.c = x.c;
    } else out.push({ key: k, h: x.h, l: x.l, c: x.c });
  }
  return out.slice(0, -1); // drop the period still in progress
}

const monthKey = (d: Date) => `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
/** Monday-based week key (UTC) */
const weekKey = (d: Date) => {
  const day = (d.getUTCDay() + 6) % 7;
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
  return monday.toISOString().slice(0, 10);
};

/**
 * High and low of the last complete week (month) before `endSec`, from daily bars (UTC calendar): the period
 * containing `endSec` is left out whatever the bars hold, so nothing after `endSec` is read.
 */
export function prevPeriodHL(daily: Candle[], endSec: number, period: "week" | "month"): { h: number; l: number } | null {
  const key = period === "week" ? weekKey : monthKey;
  const now = key(new Date(endSec * 1000));
  let cur: { k: string; h: number; l: number } | null = null;
  for (const x of daily) {
    if (x.t >= endSec) break;
    const k = key(new Date(x.t * 1000));
    if (k === now) continue;
    if (cur && cur.k === k) {
      cur.h = Math.max(cur.h, x.h);
      cur.l = Math.min(cur.l, x.l);
    } else cur = { k, h: x.h, l: x.l };
  }
  return cur ? { h: cur.h, l: cur.l } : null;
}

// ---------------------------------------------------------------- per-timeframe methods

export function levelCandidates(c: Candle[], tf: Timeframe, lp: LP = DEFAULT_ENGINE_PARAMS.levels, lookback = 300): LevelCandidate[] {
  const w = lp.tfWeight[tf];
  if (!w) return [];
  const n = c.length;
  const L = n - 1;
  const recent = c.slice(-lookback);
  const close = ta.closes(c);
  const atr = ta.atr(c, 14);
  const tfn = TF_NAME[tf];
  const out: LevelCandidate[] = [];
  const add = (price: number, method: Method, label: string, mult = 1) => {
    const mw = lp.methodWeight[method];
    if (mw > 0 && Number.isFinite(price) && price > 0) out.push({ price, method, label: `${tfn}${label}`, tf, weight: mw * w * mult });
  };

  // swing highs/lows (zigzag), newer swings weigh more
  const piv = zigzag(c, atr, 2.5).filter((p) => p.i >= n - lookback && !p.provisional);
  piv.forEach((p, k) => add(p.price, "swing", p.kind === "high" ? "摆动高点" : "摆动低点", 0.5 + (0.5 * (k + 1)) / piv.length));

  // Williams fractals (5-bar), last 6 of each kind
  const fu: number[] = [], fd: number[] = [];
  for (let i = Math.max(2, n - lookback); i < n - 2; i++) {
    if (c[i].h > c[i - 1].h && c[i].h > c[i - 2].h && c[i].h > c[i + 1].h && c[i].h > c[i + 2].h) fu.push(c[i].h);
    if (c[i].l < c[i - 1].l && c[i].l < c[i - 2].l && c[i].l < c[i + 1].l && c[i].l < c[i + 2].l) fd.push(c[i].l);
  }
  fu.slice(-6).forEach((p) => add(p, "fractal", "分形高点"));
  fd.slice(-6).forEach((p) => add(p, "fractal", "分形低点"));

  // volume profile
  const vp = volumeProfile(recent);
  add(vp.poc, "volume", "成交最密集价 POC", 1.3);
  add(vp.vah, "volume", "价值区上沿 VAH", 0.8);
  add(vp.val, "volume", "价值区下沿 VAL", 0.8);
  vp.hvn.slice(0, 4).forEach((p) => add(p, "volume", "高成交量节点", 0.6));

  // channels
  const dc = c.slice(-21, -1);
  if (dc.length) {
    add(Math.max(...dc.map((x) => x.h)), "donchian", "Donchian 上轨");
    add(Math.min(...dc.map((x) => x.l)), "donchian", "Donchian 下轨");
  }
  const kc = ta.keltner(c);
  add(kc.upper[L], "keltner", "Keltner 上轨");
  add(kc.lower[L], "keltner", "Keltner 下轨");
  const bb = ta.bollinger(close);
  add(bb.upper[L], "bollinger", "布林上轨");
  add(bb.lower[L], "bollinger", "布林下轨");
  add(bb.mid[L], "bollinger", "布林中轨", 0.6);

  // moving averages
  add(ta.ema(close, 20)[L], "ma", "EMA20", 0.7);
  add(ta.ema(close, 50)[L], "ma", "EMA50");
  add(ta.ema(close, 100)[L], "ma", "EMA100");
  add(ta.sma(close, 200)[L], "ma", "MA200", 1.3);

  // anchored VWAP from the last major swing high and low
  const major = zigzag(c, atr, 5).filter((p) => !p.provisional);
  for (const kind of ["high", "low"] as const) {
    const anchor = [...major].reverse().find((p) => p.kind === kind);
    if (!anchor) continue;
    let pv = 0, vv = 0;
    for (let i = anchor.i; i < n; i++) {
      const tp = (c[i].h + c[i].l + c[i].c) / 3;
      pv += tp * c[i].v;
      vv += c[i].v;
    }
    if (vv > 0) add(pv / vv, "avwap", kind === "high" ? "锚定前高的 VWAP" : "锚定前低的 VWAP");
  }

  // Fibonacci retracement of the last major swing
  if (major.length >= 2) {
    const a = major[major.length - 2], b = major[major.length - 1];
    for (const r of [0.382, 0.5, 0.618, 0.786]) add(b.price - (b.price - a.price) * r, "fib", `斐波那契 ${r}`);
  }

  return out;
}

/** Calendar-period methods computed from daily candles: pivots and prior day/week/month highs & lows. */
export function periodCandidates(daily: Candle[], price: number, lp: LP = DEFAULT_ENGINE_PARAMS.levels): LevelCandidate[] {
  const out: LevelCandidate[] = [];
  if (daily.length < 3) return out;
  const add = (p: number, method: Method, label: string, tf: Timeframe, mult = 1) => {
    // a zero method or timeframe weight turns the contribution off
    const w = lp.methodWeight[method] * lp.tfWeight[tf];
    if (w > 0 && Number.isFinite(p) && p > 0) out.push({ price: p, method, label, tf, weight: w * mult });
  };
  const prevDay = daily[daily.length - 2];
  const weeks = periods(daily, weekKey);
  const months = periods(daily, monthKey);
  const prevWeek = weeks[weeks.length - 1];
  const prevMonth = months[months.length - 1];

  const pivotSet = (h: number, l: number, cl: number, tf: Timeframe, name: string) => {
    const p = (h + l + cl) / 3;
    const r = h - l;
    add(p, "pivot", `${name} Pivot P`, tf);
    add(2 * p - l, "pivot", `${name} Pivot R1`, tf, 0.8);
    add(2 * p - h, "pivot", `${name} Pivot S1`, tf, 0.8);
    add(p + r, "pivot", `${name} Pivot R2`, tf, 0.6);
    add(p - r, "pivot", `${name} Pivot S2`, tf, 0.6);
    add(cl + (r * 1.1) / 4, "camarilla", `${name} Camarilla H3`, tf);
    add(cl - (r * 1.1) / 4, "camarilla", `${name} Camarilla L3`, tf);
    add(cl + (r * 1.1) / 2, "camarilla", `${name} Camarilla H4`, tf, 0.8);
    add(cl - (r * 1.1) / 2, "camarilla", `${name} Camarilla L4`, tf, 0.8);
    for (const k of [0.382, 0.618]) {
      add(p + k * r, "fibPivot", `${name} Fib Pivot R${k}`, tf);
      add(p - k * r, "fibPivot", `${name} Fib Pivot S${k}`, tf);
    }
  };
  pivotSet(prevDay.h, prevDay.l, prevDay.c, "1d", "日");
  if (prevWeek) pivotSet(prevWeek.h, prevWeek.l, prevWeek.c, "1w", "周");

  add(prevDay.h, "prevHL", "昨日最高 PDH", "1d");
  add(prevDay.l, "prevHL", "昨日最低 PDL", "1d");
  if (prevWeek) {
    add(prevWeek.h, "prevHL", "上周最高", "1w");
    add(prevWeek.l, "prevHL", "上周最低", "1w");
  }
  if (prevMonth) {
    add(prevMonth.h, "prevHL", "上月最高", "1w", 1.2);
    add(prevMonth.l, "prevHL", "上月最低", "1w", 1.2);
  }

  const step = roundStep(price);
  const base = Math.round(price / step) * step;
  for (let k = -4; k <= 4; k++) {
    const p = base + k * step;
    const big = Math.abs(p / (step * 2) - Math.round(p / (step * 2))) < 1e-9;
    add(p, "round", "整数关口", "1d", big ? 1 : 0.6);
  }
  return out;
}

// ---------------------------------------------------------------- clustering

/** Cluster candidates within `tol` (absolute price) and rank. */
export function clusterLevels(cands: LevelCandidate[], price: number, tol: number, maxPerSide = 5, lp: LP = DEFAULT_ENGINE_PARAMS.levels): { supports: Level[]; resistances: Level[] } {
  const sorted = [...cands].sort((a, b) => a.price - b.price);
  const clusters: LevelCandidate[][] = [];
  for (const cand of sorted) {
    const cur = clusters[clusters.length - 1];
    if (cur && cand.price - cur[0].price <= tol) cur.push(cand);
    else clusters.push([cand]);
  }
  const raw = clusters.map((g) => {
    const wsum = g.reduce((s, x) => s + x.weight, 0);
    const p = g.reduce((s, x) => s + x.price * x.weight, 0) / wsum;
    const byMethod = new Map<Method, number>();
    for (const x of g) byMethod.set(x.method, (byMethod.get(x.method) ?? 0) + x.weight);
    const tfs = [...new Set(g.map((x) => x.tf))];
    const labelsByMethod: Partial<Record<Method, string[]>> = {};
    for (const x of g) {
      const arr = (labelsByMethod[x.method] ??= []);
      if (!arr.includes(x.label)) arr.push(x.label);
    }
    // independent methods and timeframes agreeing matter more than repeats of one method
    const score = wsum * (1 + lp.methodBonus * (byMethod.size - 1)) * (1 + lp.tfBonus * (tfs.length - 1));
    return {
      price: p,
      score,
      methodIds: [...byMethod.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m),
      contributions: g.length,
      labelsByMethod,
      labels: [...new Set(g.map((x) => x.label))],
      timeframes: tfs,
    };
  });
  const toLevel = (r: (typeof raw)[number], max: number): Level => ({
    price: r.price,
    strength: Math.round((r.score / max) * 100),
    score: Math.round(r.score * 10) / 10,
    side: r.price < price ? "support" : "resistance",
    methods: r.methodIds.map((m) => METHOD_NAME[m]),
    methodIds: r.methodIds,
    labelsByMethod: r.labelsByMethod,
    contributions: r.contributions,
    labels: r.labels,
    timeframes: r.timeframes,
    distancePct: ((r.price - price) / price) * 100,
  });
  // ignore levels that sit on the current price or are very far away
  const usable = raw.filter((r) => Math.abs(r.price - price) > tol && Math.abs(r.price - price) / price < lp.maxDistancePct / 100);
  const pick = (side: "support" | "resistance") =>
    usable
      .filter((r) => (side === "support" ? r.price < price : r.price > price))
      // prefer strong levels, but discount ones far from price
      .map((r) => ({ r, rank: r.score / (1 + (Math.abs(r.price - price) / price) * 8) }))
      .sort((a, b) => b.rank - a.rank)
      // keep picked levels apart so a beginner sees distinct zones, not a crowd
      .reduce<(typeof raw)[number][]>((acc, x) => {
        if (acc.length < maxPerSide && acc.every((y) => Math.abs(y.price - x.r.price) > tol * lp.spacing)) acc.push(x.r);
        return acc;
      }, []);
  const sup = pick("support"), res = pick("resistance");
  const max = Math.max(...sup.map((r) => r.score), ...res.map((r) => r.score), 1e-9);
  return {
    supports: sup.map((r) => toLevel(r, max)).sort((a, b) => b.price - a.price),
    resistances: res.map((r) => toLevel(r, max)).sort((a, b) => a.price - b.price),
  };
}
