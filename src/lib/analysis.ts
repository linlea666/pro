import { closedThrough, getKlines, PRIMARY_SOURCE, readWindow, ttlFor, type KlineResult } from "./data/klines.ts";
import { logger } from "./server/log.ts";
import { currentParams } from "./server/params-store.ts";
import { DEFAULT_ENGINE_PARAMS, type EngineParams } from "./params.ts";
import { TF_SECONDS } from "./types.ts";
import { closedBetween } from "./bars.ts";
import type { Candle, Timeframe } from "./types.ts";
import { BEGINNER_TIMEFRAMES, TIMEFRAMES } from "./types.ts";
import * as ta from "./ta/core.ts";
import { computeIndicators, familyVotes, type FamilyVote, type IndicatorReading } from "./ta/indicators.ts";
import { computeTd, type TdEvent, type TdState } from "./ta/td.ts";
import { computeTrend } from "./ta/trend.ts";
import { clusterLevels, levelCandidates, periodCandidates, type Level } from "./ta/levels.ts";
import { zigzag } from "./ta/zigzag.ts";
import { autoFib, type FibResult } from "./ta/fib.ts";
import { computeChan, type ChanResult } from "./ta/chan.ts";
import { forwardStats, labelStats, type SignalStats } from "./ta/stats.ts";
import { bufferAtr, structureAnchors } from "./ta/risk.ts";
import { getCalibration } from "./server/riskcalib.ts";
import { buildVerdict, type Verdict } from "./ta/verdict.ts";
import { indicatorFlips, signalEvents } from "./ta/signals.ts";
import { tdDetailOf, type TdDetail } from "./tdbrief.ts";

/**
 * Everything the coin page needs for one symbol/timeframe, computed on the
 * server. Only display-ready results leave the server.
 */

const DISPLAY_BARS = 600;
/** bars the live analysis works on (the default getKlines window) */
const WINDOW = 2000;
/** bars after a replay point kept for "what happened next" */
const FUTURE_BARS = 200;

/** Higher timeframes that also feed the support/resistance cluster. */
const LEVEL_TFS: Record<Timeframe, Timeframe[]> = {
  "5m": ["5m", "15m", "1h"],
  "15m": ["15m", "1h", "4h"],
  "1h": ["15m", "1h", "4h", "1d"],
  "4h": ["15m", "1h", "4h", "1d"],
  "1d": ["4h", "1d", "1w"],
  "1w": ["1d", "1w"],
};

/**
 * Replay cut-off. Candles of the analysed timeframe up to and including the
 * chosen bar; other timeframes only bars that had fully closed by the end of
 * that bar, so a replay never sees data from its future.
 */
export function cutoff(c: Candle[], tf: Timeframe, endSec: number | null): Candle[] {
  if (endSec == null) return c;
  const sec = TF_SECONDS[tf];
  return c.filter((x) => x.t + sec <= endSec);
}

/**
 * Candles as the page saw them: live, the latest window; in a replay (`replayEnd` set), the stored
 * long history around that moment when it reaches back far enough, so an old replay sees the
 * same window the live page had then, small timeframes included. Otherwise the live window.
 */
export async function seriesAt(coin: string, tf: Timeframe, replayEnd: number | null): Promise<KlineResult> {
  if (replayEnd == null) return getKlines(coin, tf);
  const stored = readWindow(coin, tf, replayEnd, WINDOW, FUTURE_BARS + 1);
  const sec = TF_SECONDS[tf];
  const before = stored.filter((x) => x.t + sec <= replayEnd).length;
  // no network needed: bars that ended before now are final (a bar still forming is left out of "what happened next")
  return before >= 300 ? { candles: stored, source: PRIMARY_SOURCE, fetchedAt: Date.now() } : getKlines(coin, tf);
}

export async function keyLevels(coin: string, tf: Timeframe, price: number, atr: number, lp: EngineParams["levels"], endSec: number | null = null, replay = false) {
  const tfs = LEVEL_TFS[tf];
  const at = replay ? endSec : null;
  const [series, daily] = await Promise.all([Promise.all(tfs.map((x) => seriesAt(coin, x, at))), seriesAt(coin, "1d", at)]);
  // calendar levels use the previous day/week/month; the day in progress at the cut-off is kept only as "today"
  const days = endSec == null ? daily.candles : daily.candles.filter((x) => x.t < endSec);
  const cands = [...series.flatMap((s, k) => levelCandidates(cutoff(s.candles, tfs[k], endSec), tfs[k], lp)), ...periodCandidates(days, price, lp)];
  return clusterLevels(cands, price, Math.max(atr * lp.bandAtr, (price * lp.bandMinPct) / 100), 5, lp);
}

/**
 * Levels are found on completed bars, but the list is read against the live price:
 * a support broken inside the forming bar is shown as resistance above it, with its live distance.
 */
export function relevel(all: Level[], live: number): { supports: Level[]; resistances: Level[] } {
  const at = (l: Level, side: Level["side"]): Level => ({ ...l, side, distancePct: ((l.price - live) / live) * 100 });
  return {
    supports: all.filter((l) => l.price <= live).map((l) => at(l, "support")).sort((x, y) => y.price - x.price),
    resistances: all.filter((l) => l.price > live).map((l) => at(l, "resistance")).sort((x, y) => x.price - y.price),
  };
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
  /** latest traded price (the bar still forming, if any) */
  price: number;
  /** close of the last completed bar — what every conclusion below is computed from */
  closedPrice: number;
  /** open time of the last completed bar */
  lastClosedT: number;
  /** the bar still forming: drawn on the chart, never analysed (null in a replay or right at a close) */
  forming: { t: number; closesAt: number } | null;
  change24h: number;
  /** completed bars, plus the forming bar at the end when there is one; series below stop one bar earlier then */
  candles: Candle[];
  verdict: Verdict;
  indicators: {
    readings: IndicatorReading[];
    summary: ReturnType<typeof computeIndicators>["summary"];
    /** the same votes merged into families of correlated indicators (one vote each) */
    families: FamilyVote[];
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
  /** present when this is a time-machine replay */
  replay?: Replay;
}

export interface Replay {
  /** open time of the bar the analysis was rewound to */
  asOf: number;
  /** what actually happened next (up to 200 bars) */
  future: Candle[];
  outcome: {
    bars: number;
    horizonText: string;
    closePct: number;
    maxPct: number;
    minPct: number;
    /** was a green/red light right over the stats horizon? null for yellow, or while not enough bars have passed */
    correct: boolean | null;
    stopHit: boolean | null;
  } | null;
}

export type IndicatorStat = Pick<SignalStats, "samples" | "winRate" | "winLo" | "winHi" | "avgReturn" | "baseWinRate" | "pValue" | "reliability">;

const clean = (arr: number[]) => arr.map((v) => (Number.isFinite(v) ? Math.round(v * 1e6) / 1e6 : null));

export function change24h(c: Candle[]): number {
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

/** 24h change from the analysed timeframe itself (daily and weekly bars: versus the previous bar). */
function changeOverDay(c: Candle[], tf: Timeframe): number {
  const L = c.length - 1;
  const back = Math.max(1, Math.round(86400 / TF_SECONDS[tf]));
  const ref = c[Math.max(0, L - back)];
  return ((c[L].c - ref.c) / ref.c) * 100;
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

// Results are cached for as long as the underlying candles are.
const cache = new Map<string, { at: number; value?: Analysis; pending?: Promise<Analysis>; since?: number }>();
/** a computation still pending after this long is treated as stuck: the next caller starts a fresh one instead of waiting on it */
export const STUCK_MS = 3 * 60_000;

export async function analyze(coin: string, tf: Timeframe): Promise<Analysis> {
  // the parameter version is part of the key, so saving new parameters takes effect at once
  const params = currentParams();
  const key = `${coin}:${tf}:${params.version}`;
  const hit = cache.get(key);
  if (hit?.value && Date.now() - hit.at < ttlFor(tf) && !closedBetween(tf, hit.at, Date.now())) return hit.value;
  if (hit?.pending) {
    if (Date.now() - (hit.since ?? 0) < STUCK_MS) return hit.pending;
    logger.warn("engine", `分析超过 ${STUCK_MS / 60_000} 分钟没有完成，重新计算：${coin} ${tf}`);
  }
  for (const k of cache.keys()) if (!k.endsWith(`:${params.version}`)) cache.delete(k);
  const pending = analyzeLogged(coin, tf, params.engine);
  cache.set(key, { at: hit?.at ?? 0, value: hit?.value, pending, since: Date.now() });
  try {
    const value = await pending;
    // a stuck run that finishes late must not overwrite the fresh one that replaced it
    if (cache.get(key)?.pending === pending) cache.set(key, { at: Date.now(), value });
    return value;
  } catch (e) {
    if (cache.get(key)?.pending === pending) {
      if (hit?.value) cache.set(key, { at: hit.at, value: hit.value });
      else cache.delete(key);
    }
    throw e;
  }
}

/** Uncached analysis with explicit parameters (the admin's trial run; the scorecard's history, with `asOf`). */
export async function analyzeWith(coin: string, tf: Timeframe, ep: EngineParams, asOf?: number): Promise<Analysis> {
  return analyzeInner(coin, tf, ep, asOf);
}

const replayCache = new Map<string, Promise<Analysis>>();

/** Time machine: the analysis exactly as it would have looked at the close of bar `asOf`. */
export async function analyzeAt(coin: string, tf: Timeframe, asOf: number): Promise<Analysis> {
  const params = currentParams();
  const key = `${coin}:${tf}:${asOf}:${params.version}`;
  const hit = replayCache.get(key);
  if (hit) return hit;
  const p = analyzeInner(coin, tf, params.engine, asOf).catch((e) => {
    replayCache.delete(key);
    throw e;
  });
  replayCache.set(key, p);
  if (replayCache.size > 300) replayCache.delete(replayCache.keys().next().value!);
  return p;
}

export class ReplayError extends Error {}

async function analyzeLogged(coin: string, tf: Timeframe, ep: EngineParams): Promise<Analysis> {
  const t0 = Date.now();
  try {
    const a = await analyzeInner(coin, tf, ep);
    const ms = Date.now() - t0;
    // right after a start every cache is cold and the background jobs run at once: slowness then is expected
    // at the top of each hour most caches expire together; on a 2-core server that alone takes ~3 s
    const slow = ms > 6000 && process.uptime() > 180 && !(globalThis as { __slJobBusy?: boolean }).__slJobBusy;
    logger[slow ? "warn" : "debug"]("engine", `分析完成 ${coin} ${tf}${slow ? "（偏慢）" : ""}`, { durationMs: ms, bars: a.candles.length });
    return a;
  } catch (e) {
    logger.error("engine", `分析失败 ${coin} ${tf}`, { error: e, durationMs: Date.now() - t0 });
    throw e;
  }
}

async function analyzeInner(coin: string, tf: Timeframe, ep: EngineParams = DEFAULT_ENGINE_PARAMS, asOf: number | null = null): Promise<Analysis> {
  const sec = TF_SECONDS[tf];
  const replayEnd = asOf == null ? null : asOf + sec;
  const [main, hourlyRaw] = await Promise.all([seriesAt(coin, tf, replayEnd), seriesAt(coin, "1h", replayEnd)]);
  // Everything is computed on completed bars only, so a conclusion cannot flip back and forth
  // inside one bar. Live: completed when the data was fetched; replay: completed by the end of the chosen bar.
  const nowSec = closedThrough(main);
  const endSec = asOf == null ? nowSec : asOf + sec;
  const allCandles = main.candles;
  const c = cutoff(allCandles, tf, endSec);
  const formingBar = asOf == null ? (allCandles.find((x) => x.t + sec > nowSec) ?? null) : null;
  if (asOf != null) {
    if (!allCandles.some((x) => x.t === asOf)) throw new ReplayError("找不到这根 K 线，请在图上重新选择");
    if (c.length < 300) throw new ReplayError("这根 K 线太早了，之前的数据不足以计算指标，请选择更近的时间");
    if (!allCandles.slice(c.length).some((x) => x.t + sec <= nowSec)) throw new ReplayError("这是最近一根已收盘的 K 线，后面还没有走势可看");
  }
  if (c.length < 60) throw new Error(`${coin} ${tf} 已收盘的 K 线太少（${c.length} 根）`);
  // the 24h change shown next to the price stays live
  const hourly = { candles: asOf == null ? hourlyRaw.candles : cutoff(hourlyRaw.candles, "1h", endSec) };
  const L = c.length - 1;
  const price = c[L].c;
  const close = ta.closes(c);
  const atr = ta.atr(c, 14);

  const panel = computeIndicators(c, undefined, ep.indicators);
  const td = computeTd(c, ep.td);
  const trend = computeTrend(c, panel, ep.trend);

  const { supports, resistances } = await keyLevels(coin, tf, price, atr[L], ep.levels, endSec, asOf != null);

  // major swings only, so the retracement describes a move a beginner would notice
  const fib = autoFib(c, zigzag(c, atr, 5));
  const chan = computeChan(c.slice(-DISPLAY_BARS));

  // ---------------- historical stats
  const H = ep.horizon[tf];

  // the stored calibration is measured on the whole history; a replay must not see bars after its own time
  const cal = asOf == null ? getCalibration(coin, tf) : null;
  const verdict = buildVerdict({
    tf, price, atr: atr[L], trend, panel, td, supports, resistances, lastIdx: L, vp: ep.verdict,
    risk: {
      buffer: bufferAtr(cal, ep.verdict.stopQuantile),
      below: structureAnchors(c, tf, "below", 0.3, atr).slice(0, 2).map((x) => x.price),
      above: structureAnchors(c, tf, "above", 0.3, atr).slice(0, 2).map((x) => x.price),
      cal,
      horizonText: horizonText(tf, cal?.horizon ?? H),
    },
  });
  const defs = signalEvents(c, panel, td, ep);
  const stats = defs.map((d) => forwardStats(c, d.key, d.name, d.side, d.idx, H, ep.stats));

  // each indicator's own track record: bars where it flipped to bullish / bearish
  const indicatorStats: Analysis["indicatorStats"] = {};
  const lite = (s: SignalStats): IndicatorStat => ({ samples: s.samples, winRate: s.winRate, winLo: s.winLo, winHi: s.winHi, avgReturn: s.avgReturn, baseWinRate: s.baseWinRate, pValue: s.pValue, reliability: s.reliability });
  const perIndicator: [string, SignalStats, SignalStats][] = indicatorFlips(panel).map(({ id, up, down }) => [
    id,
    forwardStats(c, id, id, "bull", up, H, ep.stats),
    forwardStats(c, id, id, "bear", down, H, ep.stats),
  ]);
  // every statistic on the page is one test among many: label them together
  labelStats([...stats, ...perIndicator.flatMap(([, b, s]) => [b, s])], ep.stats);
  for (const [id, b, s] of perIndicator) indicatorStats[id] = { bull: lite(b), bear: lite(s) };

  // signals that fired recently
  const recentWindow = Math.max(3, Math.round(H / 3));
  const active: ActiveSignal[] = [];
  defs.forEach(({ key, name, side, idx }, k) => {
    const lastI = idx[idx.length - 1];
    if (lastI !== undefined && L - lastI <= recentWindow) active.push({ key, name, side, barsAgo: L - lastI, stats: stats[k] });
  });

  const from = Math.max(0, c.length - DISPLAY_BARS);
  const slice = <T,>(a: T[]) => a.slice(from);
  const ema20 = ta.ema(close, 20), ema50 = ta.ema(close, 50), sma200 = ta.sma(close, 200);
  const bb = ta.bollinger(close);
  const m = ta.macd(close);
  const r = ta.rsi(close);

  return {
    coin,
    tf,
    source: main.source,
    updatedAt: main.fetchedAt,
    price: formingBar ? formingBar.c : price,
    closedPrice: price,
    lastClosedT: c[L].t,
    forming: formingBar ? { t: formingBar.t, closesAt: formingBar.t + sec } : null,
    // hourly history may not reach back to an old replay point; use this timeframe's own bars then
    change24h: hourly.candles.length > 25 ? change24h(hourly.candles) : changeOverDay(c, tf),
    candles: formingBar ? [...slice(c), formingBar] : slice(c),
    verdict,
    indicators: {
      readings: panel.readings,
      summary: panel.summary,
      families: familyVotes(panel, L),
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
    levels: formingBar ? relevel([...supports, ...resistances], formingBar.c) : { supports, resistances },
    fib,
    chan,
    stats,
    indicatorStats,
    active,
    horizonText: horizonText(tf, H),
    replay: asOf == null ? undefined : replayOutcome(asOf, allCandles.slice(c.length).filter((x) => x.t + sec <= nowSec).slice(0, 200), price, H, tf, verdict),
  };
}

function replayOutcome(asOf: number, future: Candle[], price: number, H: number, tf: Timeframe, v: Verdict): Replay {
  if (future.length === 0) return { asOf, future, outcome: null };
  const win = future.slice(0, H);
  const pct = (x: number) => Math.round(((x - price) / price) * 10000) / 100;
  const closePct = pct(win[win.length - 1].c);
  const maxPct = pct(Math.max(...win.map((x) => x.h)));
  const minPct = pct(Math.min(...win.map((x) => x.l)));
  const complete = win.length >= H;
  // only a directional call can be right or wrong; "wait" is judged by nothing (quiet markets are simply common)
  const correct = !complete || v.light === "yellow" ? null : v.light === "green" ? closePct > 0 : closePct < 0;
  let stopHit: boolean | null = null;
  if (v.stopRef != null) stopHit = v.stopRef < price ? win.some((x) => x.l <= v.stopRef!) : win.some((x) => x.h >= v.stopRef!);
  return { asOf, future, outcome: { bars: win.length, horizonText: horizonText(tf, win.length), closePct, maxPct, minPct, correct, stopHit } };
}

// ------------------------------------------------------------------ per-timeframe summaries

/** Compact state of every module on one timeframe, for the multi-timeframe strips. */
export interface LightSummary {
  tf: Timeframe;
  /** close of the latest completed bar, and when that bar closed (unix seconds) */
  close: number;
  closeAt: number;
  light: Verdict["light"];
  lightText: string;
  score: number;
  trend: string;
  trendScore: number;
  /** short TD text, e.g. "涨 5/9" */
  td: string;
  tdDetail: TdDetail;
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
  const closed = a.forming ? a.candles.slice(0, -1) : a.candles;
  const lastClosed = closed[closed.length - 1];
  return {
    tf: a.tf,
    close: lastClosed.c,
    closeAt: lastClosed.t + TF_SECONDS[a.tf],
    light: a.verdict.light,
    lightText: a.verdict.lightText,
    score: a.verdict.score,
    trend: a.trend.label,
    trendScore: a.trend.current,
    td: cur.setupSide ? `${cur.setupSide === "buy" ? "跌" : "涨"} ${Math.min(cur.setupCount, cur.setupLength)}/${cur.setupLength}` : "—",
    tdDetail: tdDetailOf(a.td, closed),
    votes: { bull: cats.reduce((x, k) => x + k.bull, 0), bear: cats.reduce((x, k) => x + k.bear, 0), total: a.indicators.total },
    s1: lvl(a.levels.supports[0]),
    r1: lvl(a.levels.resistances[0]),
    fib: a.fib ? { direction: a.fib.direction, ratio: Math.round(a.fib.currentRatio * 1000) / 1000 } : null,
    chan: {
      last: lastPoint ? { type: lastPoint.type, barsAgo: a.candles.length - (a.forming ? 2 : 1) - a.candles.findIndex((x) => x.t === lastPoint.t) } : null,
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
