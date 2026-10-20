import type { Candle } from "../types.ts";
import { normCdf, wilson } from "../ta/stats.ts";

/**
 * Research statistics, by the project's rules: samples never overlap, every
 * trade pays the round-trip cost, results are measured in R (1R = one ATR at
 * entry) and always against a random control on the same coins and dates,
 * the most recent 12 months are held out, and a result only counts when
 * BTC / ETH and both halves of the in-sample period agree.
 */

export interface Trade {
  t: number;
  coin: string;
  /** net move in the trade's direction after cost, % */
  pct: number;
  /** the same in ATR units */
  r: number;
}

/** Non-overlapping trades at the given bars, held `horizon` bars. */
export function trades(c: Candle[], atr: number[], idx: number[], dir: 1 | -1, horizon: number, costPct: number, coin: string): Trade[] {
  const out: Trade[] = [];
  let last = -Infinity;
  for (const i of idx) {
    if (i + horizon >= c.length || i - last < horizon || !(atr[i] > 0)) continue;
    last = i;
    const pct = ((c[i + horizon].c - c[i].c) / c[i].c) * 100 * dir - costPct;
    out.push({ t: c[i].t, coin, pct, r: pct / ((atr[i] / c[i].c) * 100) });
  }
  return out;
}

/** The random control: the same trade from every bar (overlapping; its effective size is counted per horizon). */
export function controlTrades(c: Candle[], atr: number[], dir: 1 | -1, horizon: number, costPct: number, coin: string, from = 0): Trade[] {
  const out: Trade[] = [];
  for (let i = from; i + horizon < c.length; i++) {
    if (!(atr[i] > 0)) continue;
    const pct = ((c[i + horizon].c - c[i].c) / c[i].c) * 100 * dir - costPct;
    out.push({ t: c[i].t, coin, pct, r: pct / ((atr[i] / c[i].c) * 100) });
  }
  return out;
}

export interface Group {
  n: number;
  /** % of trades with a positive net result, and its 95% interval */
  hit: number | null;
  hitLo: number | null;
  hitHi: number | null;
  /** same share for the control */
  baseHit: number | null;
  meanPct: number | null;
  meanR: number | null;
  /** mean R minus the control's mean R */
  edgeR: number | null;
  /** two-sided p-value of the edge */
  p: number | null;
}

const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
const variance = (xs: number[], m: number) => (xs.length > 1 ? xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1) : 0);
const round = (x: number, d = 3) => Math.round(x * 10 ** d) / 10 ** d;

/**
 * One cell of a report: the trades against the control over the same coins and dates.
 * `controlStep` is how many control trades make one independent one (the horizon).
 */
export function group(sig: Trade[], ctl: Trade[], controlStep: number): Group {
  const n = sig.length;
  const baseHit = ctl.length ? round((ctl.filter((x) => x.pct > 0).length / ctl.length) * 100, 1) : null;
  if (!n) return { n, hit: null, hitLo: null, hitHi: null, baseHit, meanPct: null, meanR: null, edgeR: null, p: null };
  const wins = sig.filter((x) => x.pct > 0).length;
  const [lo, hi] = wilson(wins, n);
  const mr = mean(sig.map((x) => x.r));
  const out: Group = { n, hit: round((wins / n) * 100, 1), hitLo: round(lo, 1), hitHi: round(hi, 1), baseHit, meanPct: round(mean(sig.map((x) => x.pct))), meanR: round(mr), edgeR: null, p: null };
  if (ctl.length) {
    const cr = ctl.map((x) => x.r);
    const cm = mean(cr);
    const se = Math.sqrt(variance(sig.map((x) => x.r), mr) / n + variance(cr, cm) / Math.max(1, ctl.length / controlStep));
    out.edgeR = round(mr - cm);
    out.p = se > 0 ? round(2 * (1 - normCdf(Math.abs(mr - cm) / se)), 4) : null;
  }
  return out;
}

/** Benjamini–Hochberg adjusted p-values (q), in the input order. */
export function bhAdjust(ps: (number | null)[]): (number | null)[] {
  const idx = ps.map((p, i) => [p, i] as const).filter(([p]) => p != null) as [number, number][];
  idx.sort((a, b) => a[0] - b[0]);
  const m = idx.length;
  const q: (number | null)[] = ps.map(() => null);
  let min = 1;
  for (let k = m - 1; k >= 0; k--) {
    min = Math.min(min, (idx[k][0] * m) / (k + 1));
    q[idx[k][1]] = round(min, 4);
  }
  return q;
}

export interface Split {
  /** start of the 12-month holdout, Unix seconds */
  holdoutFrom: number;
  /** middle of the in-sample period */
  mid: number;
}

export function makeSplit(firstT: number, nowSec: number, holdoutDays = 365): Split {
  const holdoutFrom = Math.floor(nowSec - holdoutDays * 86400);
  return { holdoutFrom, mid: Math.floor((Math.min(firstT, holdoutFrom) + holdoutFrom) / 2) };
}

export interface Cells {
  /** in-sample, all coins */
  is: Group;
  /** the held-out last 12 months, all coins */
  oos: Group;
  btc: Group;
  eth: Group;
  firstHalf: Group;
  secondHalf: Group;
}

export function cells(sig: Trade[], ctl: Trade[], split: Split, controlStep: number): Cells {
  const pick = (f: (x: Trade) => boolean) => group(sig.filter(f), ctl.filter(f), controlStep);
  const inS = (x: Trade) => x.t < split.holdoutFrom;
  return {
    is: pick(inS),
    oos: pick((x) => !inS(x)),
    btc: pick((x) => inS(x) && x.coin === "BTC"),
    eth: pick((x) => inS(x) && x.coin === "ETH"),
    firstHalf: pick((x) => inS(x) && x.t < split.mid),
    secondHalf: pick((x) => !(x.t < split.mid) && inS(x)),
  };
}

export type Verdict = "有优势" | "比随机差" | "无可证明的优势" | "样本不足";

/** The adoption bar: at least 0.1R, significant after BH, the same sign on BTC, ETH, both halves and the holdout. */
export const MIN_EDGE_R = 0.1;

export function judge(c: Cells, q: number | null, alpha: number, minSamples: number): { verdict: Verdict; consistent: boolean } {
  if (c.is.n < minSamples || c.is.edgeR == null) return { verdict: "样本不足", consistent: false };
  const sign = Math.sign(c.is.edgeR);
  const parts = [c.btc, c.eth, c.firstHalf, c.secondHalf, c.oos];
  const consistent = sign !== 0 && parts.every((g) => g.edgeR != null && Math.sign(g.edgeR) === sign);
  if (consistent && q != null && q <= alpha && Math.abs(c.is.edgeR) >= MIN_EDGE_R && Math.abs(c.oos.edgeR ?? 0) >= MIN_EDGE_R) {
    return { verdict: sign > 0 ? "有优势" : "比随机差", consistent };
  }
  return { verdict: "无可证明的优势", consistent };
}
