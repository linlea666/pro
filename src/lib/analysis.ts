import { getKlines, ttlFor } from "./data/klines.ts";
import { logger } from "./server/log.ts";
import { currentParams } from "./server/params-store.ts";
import { DEFAULT_ENGINE_PARAMS, type EngineParams } from "./params.ts";
import { TF_SECONDS } from "./types.ts";
import type { Candle, Timeframe } from "./types.ts";
import { BEGINNER_TIMEFRAMES, TIMEFRAMES } from "./types.ts";
import * as ta from "./ta/core.ts";
import { computeIndicators, type IndicatorReading } from "./ta/indicators.ts";
import { computeTd, type TdEvent, type TdState } from "./ta/td.ts";
import { computeTrend } from "./ta/trend.ts";
import { clusterLevels, levelCandidates, periodCandidates, type Level } from "./ta/levels.ts";
import { zigzag } from "./ta/zigzag.ts";
import { autoFib, type FibResult } from "./ta/fib.ts";
import { computeChan, type ChanResult } from "./ta/chan.ts";
import { forwardStats, type SignalStats } from "./ta/stats.ts";
import { buildVerdict, type Verdict } from "./ta/verdict.ts";

/**
 * Everything the coin page needs for one symbol/timeframe, computed on the
 * server. Only display-ready results leave the server.
 */

const DISPLAY_BARS = 600;

/** Higher timeframes that also feed the support/resistance cluster. */
const LEVEL_TFS: Record<Timeframe, Timeframe[]> = {
  "5m": ["5m", "15m", "1h"],
  "15m": ["15m", "1h", "4h"],
  "1h": ["15m", "1h", "4h", "1d"],
  "4h": ["15m", "1h", "4h", "1d"],
  "1d": ["4h", "1d", "1w"],
  "1w": ["1d", "1w"],
};

async function keyLevels(coin: string, tf: Timeframe, price: number, atr: number, lp: EngineParams["levels"]) {
  const tfs = LEVEL_TFS[tf];
  const [series, daily] = await Promise.all([Promise.all(tfs.map((x) => getKlines(coin, x))), getKlines(coin, "1d")]);
  const cands = [...series.flatMap((s, k) => levelCandidates(s.candles, tfs[k], lp)), ...periodCandidates(daily.candles, price, lp)];
  return clusterLevels(cands, price, Math.max(atr * lp.bandAtr, (price * lp.bandMinPct) / 100), 5, lp);
}

/** Human description of "N bars later" on a timeframe, e.g. 18 × 4h → "3 天". */
export function horizonText(tf: Timeframe, bars: number): string {
  const sec = bars * TF_SECONDS[tf];
  const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
  if (sec < 3600) return `${Math.round(sec / 60)} 分钟`;
  if (sec < 86400) return `${fmt(sec / 3600)} 小时`;
  if (sec < 14 * 86400) return `${fmt(sec / 86400)} 天`;
  return `${fmt(sec / 604800)} 周`;
}

export interface TdMarker {
  t: number;
  side: "buy" | "sell";
  /** 1–9 setup counts, or 13 */
  n: number;
  kind: "setup" | "countdown";
  /** completes the setup (9) or countdown (13) */
  final: boolean;
  perfected?: boolean;
}

export interface ActiveSignal {
  key: string;
  name: string;
  side: "bull" | "bear";
  barsAgo: number;
  stats: SignalStats;
}

export interface Analysis {
  coin: string;
  tf: Timeframe;
  source: string;
  updatedAt: number;
  price: number;
  change24h: number;
  candles: Candle[];
  verdict: Verdict;
  indicators: {
    readings: IndicatorReading[];
    summary: ReturnType<typeof computeIndicators>["summary"];
    total: number;
    resonance: { t: number; net: number; bull: number; bear: number }[];
    overlays: { ema20: (number | null)[]; ema50: (number | null)[]; sma200: (number | null)[]; bbUpper: (number | null)[]; bbLower: (number | null)[] };
    rsi: (number | null)[];
    macd: { line: (number | null)[]; signal: (number | null)[]; hist: (number | null)[] };
  };
  td: {
    markers: TdMarker[];
    events: TdEvent[];
    current: TdState["current"];
  };
  trend: { series: (number | null)[]; current: number; label: string; adx: number; explain: string; barsInState: number };
  levels: { supports: Level[]; resistances: Level[] };
  fib: FibResult | null;
  chan: ChanResult;
  stats: SignalStats[];
  /** per indicator: how price moved after it turned bullish / bearish */
  indicatorStats: Record<string, { bull: IndicatorStat; bear: IndicatorStat }>;
  active: ActiveSignal[];
  horizonText: string;
}

export type IndicatorStat = Pick<SignalStats, "samples" | "winRate" | "avgReturn" | "baseWinRate" | "reliability">;

const clean = (arr: number[]) => arr.map((v) => (Number.isFinite(v) ? Math.round(v * 1e6) / 1e6 : null));

function change24h(c: Candle[]): number {
  const last = c[c.length - 1];
  const target = last.t + (c[1] ? c[1].t - c[0].t : 0) - 86400;
  let ref = c[0];
  for (let i = c.length - 1; i >= 0; i--) {
    if (c[i].t <= target) {
      ref = c[i];
      break;
    }
  }
  return ((last.c - ref.c) / ref.c) * 100;
}

function tdMarkers(td: TdState, c: Candle[], from: number): TdMarker[] {
  const out: TdMarker[] = [];
  const perfect = new Map(td.events.filter((e) => e.kind === "setup9").map((e) => [e.i, e.perfected]));
  for (let i = from; i < c.length; i++) {
    const b = td.buySetup[i], s = td.sellSetup[i];
    const S = td.current.setupLength, CD = td.current.countdownLength;
    if (b >= 1 && b <= S) out.push({ t: c[i].t, side: "buy", n: b, kind: "setup", final: b === S, perfected: b === S ? perfect.get(i) : undefined });
    if (s >= 1 && s <= S) out.push({ t: c[i].t, side: "sell", n: s, kind: "setup", final: s === S, perfected: s === S ? perfect.get(i) : undefined });
    if (td.buyCountdown[i] > 0) out.push({ t: c[i].t, side: "buy", n: td.buyCountdown[i], kind: "countdown", final: td.buyCountdown[i] === CD });
    if (td.sellCountdown[i] > 0) out.push({ t: c[i].t, side: "sell", n: td.sellCountdown[i], kind: "countdown", final: td.sellCountdown[i] === CD });
  }
  return out;
}

function crossUps(a: number[], b: number[]) {
  const out: number[] = [];
  for (let i = 1; i < a.length; i++) if (a[i] > b[i] && a[i - 1] <= b[i - 1]) out.push(i);
  return out;
}

// Results are cached for as long as the underlying candles are.
const cache = new Map<string, { at: number; value?: Analysis; pending?: Promise<Analysis> }>();

export async function analyze(coin: string, tf: Timeframe): Promise<Analysis> {
  // the parameter version is part of the key, so saving new parameters takes effect at once
  const params = currentParams();
  const key = `${coin}:${tf}:${params.version}`;
  const hit = cache.get(key);
  if (hit?.value && Date.now() - hit.at < ttlFor(tf)) return hit.value;
  if (hit?.pending) return hit.pending;
  for (const k of cache.keys()) if (!k.endsWith(`:${params.version}`)) cache.delete(k);
  const pending = analyzeLogged(coin, tf, params.engine);
  cache.set(key, { at: hit?.at ?? 0, value: hit?.value, pending });
  try {
    const value = await pending;
    cache.set(key, { at: Date.now(), value });
    return value;
  } catch (e) {
    if (hit?.value) cache.set(key, { at: hit.at, value: hit.value });
    else cache.delete(key);
    throw e;
  }
}

/** Uncached analysis with explicit parameters (used by the admin's trial run). */
export async function analyzeWith(coin: string, tf: Timeframe, ep: EngineParams): Promise<Analysis> {
  return analyzeInner(coin, tf, ep);
}

async function analyzeLogged(coin: string, tf: Timeframe, ep: EngineParams): Promise<Analysis> {
  const t0 = Date.now();
  try {
    const a = await analyzeInner(coin, tf, ep);
    const ms = Date.now() - t0;
    logger[ms > 3000 ? "warn" : "debug"]("engine", `分析完成 ${coin} ${tf}${ms > 3000 ? "（偏慢）" : ""}`, { durationMs: ms, bars: a.candles.length });
    return a;
  } catch (e) {
    logger.error("engine", `分析失败 ${coin} ${tf}`, { error: e, durationMs: Date.now() - t0 });
    throw e;
  }
}

async function analyzeInner(coin: string, tf: Timeframe, ep: EngineParams = DEFAULT_ENGINE_PARAMS): Promise<Analysis> {
  const [main, hourly] = await Promise.all([getKlines(coin, tf), getKlines(coin, "1h")]);
  const c = main.candles;
  const L = c.length - 1;
  const price = c[L].c;
  const close = ta.closes(c);
  const atr = ta.atr(c, 14);

  const panel = computeIndicators(c, undefined, ep.indicators);
  const td = computeTd(c, ep.td);
  const trend = computeTrend(c, panel, ep.trend);

  const { supports, resistances } = await keyLevels(coin, tf, price, atr[L], ep.levels);

  // major swings only, so the retracement describes a move a beginner would notice
  const fib = autoFib(c, zigzag(c, atr, 5));
  const chan = computeChan(c.slice(-DISPLAY_BARS));

  const verdict = buildVerdict({ tf, price, atr: atr[L], trend, panel, td, supports, resistances, lastIdx: L, vp: ep.verdict });

  // ---------------- historical stats
  const H = ep.horizon[tf];
  const { rsiLow, rsiHigh } = ep.indicators;
  const ev = (side: "buy" | "sell", kind: TdEvent["kind"]) => td.events.filter((e) => e.side === side && e.kind === kind).map((e) => e.i);
  const e12 = ta.ema(close, 12), e26 = ta.ema(close, 26);
  const r = ta.rsi(close);
  const rsiIn = (below: boolean) => {
    const out: number[] = [];
    for (let i = 1; i < r.length; i++) {
      if (below ? r[i] < rsiLow && r[i - 1] >= rsiLow : r[i] > rsiHigh && r[i - 1] <= rsiHigh) out.push(i);
    }
    return out;
  };
  const strong = Math.max(1, Math.round((panel.readings.length * ep.indicators.strongPct) / 100));
  const S = ep.td.setupLength, CD = ep.td.countdownLength;
  const resoBull: number[] = [], resoBear: number[] = [];
  for (let i = 1; i < c.length; i++) {
    if (panel.net[i] >= strong && panel.net[i - 1] < strong) resoBull.push(i);
    if (panel.net[i] <= -strong && panel.net[i - 1] > -strong) resoBear.push(i);
  }
  const defs: [string, string, "bull" | "bear", number[]][] = [
    ["td_buy9", `TD 买入 ${S}`, "bull", ev("buy", "setup9")],
    ["td_buy13", `TD 买入 ${CD}`, "bull", ev("buy", "countdown13")],
    ["td_sell9", `TD 卖出 ${S}`, "bear", ev("sell", "setup9")],
    ["td_sell13", `TD 卖出 ${CD}`, "bear", ev("sell", "countdown13")],
    ["ema_golden", "EMA 金叉", "bull", crossUps(e12, e26)],
    ["ema_death", "EMA 死叉", "bear", crossUps(e26, e12)],
    ["rsi_oversold", "RSI 进入超卖", "bull", rsiIn(true)],
    ["rsi_overbought", "RSI 进入超买", "bear", rsiIn(false)],
    ["reso_bull", `多指标共振看多（≥${strong}）`, "bull", resoBull],
    ["reso_bear", `多指标共振看空（≥${strong}）`, "bear", resoBear],
  ];
  const stats = defs.map(([key, name, side, idx]) => forwardStats(c, key, name, side, idx, H));

  // each indicator's own track record: bars where it flipped to bullish / bearish
  const indicatorStats: Analysis["indicatorStats"] = {};
  const lite = (s: SignalStats): IndicatorStat => ({ samples: s.samples, winRate: s.winRate, avgReturn: s.avgReturn, baseWinRate: s.baseWinRate, reliability: s.reliability });
  for (const [id, bias] of panel.byId) {
    const up: number[] = [], dn: number[] = [];
    for (let i = 1; i < bias.length; i++) {
      if (bias[i] === 1 && bias[i - 1] !== 1) up.push(i);
      if (bias[i] === -1 && bias[i - 1] !== -1) dn.push(i);
    }
    indicatorStats[id] = { bull: lite(forwardStats(c, id, id, "bull", up, H)), bear: lite(forwardStats(c, id, id, "bear", dn, H)) };
  }

  // signals that fired recently
  const recentWindow = Math.max(3, Math.round(H / 3));
  const active: ActiveSignal[] = [];
  defs.forEach(([key, name, side, idx], k) => {
    const lastI = idx[idx.length - 1];
    if (lastI !== undefined && L - lastI <= recentWindow) active.push({ key, name, side, barsAgo: L - lastI, stats: stats[k] });
  });

  const from = Math.max(0, c.length - DISPLAY_BARS);
  const slice = <T,>(a: T[]) => a.slice(from);
  const ema20 = ta.ema(close, 20), ema50 = ta.ema(close, 50), sma200 = ta.sma(close, 200);
  const bb = ta.bollinger(close);
  const m = ta.macd(close);

  return {
    coin,
    tf,
    source: main.source,
    updatedAt: main.fetchedAt,
    price,
    change24h: change24h(hourly.candles),
    candles: slice(c),
    verdict,
    indicators: {
      readings: panel.readings,
      summary: panel.summary,
      total: panel.readings.length,
      resonance: slice(c.map((x, i) => ({ t: x.t, net: panel.net[i], bull: panel.bullCount[i], bear: panel.bearCount[i] }))),
      overlays: {
        ema20: clean(slice(ema20)),
        ema50: clean(slice(ema50)),
        sma200: clean(slice(sma200)),
        bbUpper: clean(slice(bb.upper)),
        bbLower: clean(slice(bb.lower)),
      },
      rsi: clean(slice(r)),
      macd: { line: clean(slice(m.line)), signal: clean(slice(m.signal)), hist: clean(slice(m.hist)) },
    },
    td: { markers: tdMarkers(td, c, from), events: td.events.filter((e) => e.i >= from), current: td.current },
    trend: { series: clean(slice(trend.score)), current: trend.current, label: trend.label, adx: Math.round(trend.adx), explain: trend.explain, barsInState: trend.barsInState },
    levels: { supports, resistances },
    fib,
    chan,
    stats,
    indicatorStats,
    active,
    horizonText: horizonText(tf, H),
  };
}

// ------------------------------------------------------------------ per-timeframe summaries

/** Compact state of every module on one timeframe, for the multi-timeframe strips. */
export interface LightSummary {
  tf: Timeframe;
  light: Verdict["light"];
  lightText: string;
  score: number;
  trend: string;
  trendScore: number;
  /** short TD text, e.g. "涨 5/9" */
  td: string;
  tdDetail: {
    setupSide: TdState["current"]["setupSide"];
    setupCount: number;
    setupLength: number;
    countdownLength: number;
    countdown: { side: "buy" | "sell"; count: number } | null;
    last: { side: "buy" | "sell"; kind: TdEvent["kind"]; barsAgo: number; invalidated: boolean } | null;
  };
  votes: { bull: number; bear: number; total: number };
  s1: { price: number; distancePct: number } | null;
  r1: { price: number; distancePct: number } | null;
  fib: { direction: "up" | "down"; ratio: number } | null;
  chan: { last: { type: string; barsAgo: number } | null; pos: "above" | "inside" | "below" | null };
}

export function summarize(a: Analysis): LightSummary {
  const cur = a.td.current;
  const s = a.indicators.summary;
  const cats = Object.values(s);
  const z = a.chan.zhongshus[a.chan.zhongshus.length - 1];
  const lastPoint = a.chan.points[a.chan.points.length - 1];
  const lvl = (l?: Level) => (l ? { price: l.price, distancePct: Math.round(l.distancePct * 100) / 100 } : null);
  return {
    tf: a.tf,
    light: a.verdict.light,
    lightText: a.verdict.lightText,
    score: a.verdict.score,
    trend: a.trend.label,
    trendScore: a.trend.current,
    td: cur.setupSide ? `${cur.setupSide === "buy" ? "跌" : "涨"} ${Math.min(cur.setupCount, cur.setupLength)}/${cur.setupLength}` : "—",
    tdDetail: {
      setupSide: cur.setupSide,
      setupCount: cur.setupCount,
      setupLength: cur.setupLength,
      countdownLength: cur.countdownLength,
      countdown: cur.countdown ? { side: cur.countdown.side, count: cur.countdown.count } : null,
      last: cur.lastSignal ? { side: cur.lastSignal.side, kind: cur.lastSignal.kind, barsAgo: cur.lastSignal.barsAgo, invalidated: cur.lastSignal.invalidated } : null,
    },
    votes: { bull: cats.reduce((x, k) => x + k.bull, 0), bear: cats.reduce((x, k) => x + k.bear, 0), total: a.indicators.total },
    s1: lvl(a.levels.supports[0]),
    r1: lvl(a.levels.resistances[0]),
    fib: a.fib ? { direction: a.fib.direction, ratio: Math.round(a.fib.currentRatio * 1000) / 1000 } : null,
    chan: {
      last: lastPoint ? { type: lastPoint.type, barsAgo: a.candles.length - 1 - a.candles.findIndex((x) => x.t === lastPoint.t) } : null,
      pos: z ? (a.price > z.zg ? "above" : a.price < z.zd ? "below" : "inside") : null,
    },
  };
}

export interface CoinSnapshot {
  coin: string;
  price: number;
  change24h: number;
  spark: number[];
  lights: LightSummary[];
}

export async function snapshot(coin: string, tfs: Timeframe[] = ["1h", "4h", "1d"]): Promise<CoinSnapshot> {
  const [res, hourly] = await Promise.all([Promise.all(tfs.map((tf) => analyze(coin, tf))), getKlines(coin, "1h")]);
  const h = hourly.candles;
  return {
    coin,
    price: h[h.length - 1].c,
    change24h: change24h(h),
    spark: h.slice(-48).map((x) => x.c),
    lights: res.map(summarize),
  };
}

export async function multiTimeframe(coin: string, withFiveMinute = false): Promise<LightSummary[]> {
  const res = await Promise.all((withFiveMinute ? TIMEFRAMES : BEGINNER_TIMEFRAMES).map((tf) => analyze(coin, tf)));
  return res.map(summarize);
}
