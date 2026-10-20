import type { Candle, Timeframe } from "../types.ts";
import { TF_SECONDS } from "../types.ts";
import { getDb } from "../server/db.ts";
import { recordSource } from "../server/health.ts";
import { raiseAlert } from "../server/alert.ts";
import { logger } from "../server/log.ts";

/**
 * Public market data with source fallback: Binance USDⓈ-M perpetuals first (users trade
 * contracts), OKX perpetuals second, Binance spot third. Every source is stored as its own
 * series, so one series never mixes two exchanges. Results are cached per symbol/timeframe.
 */

export type SourceId = "binance-futures" | "okx-swap" | "binance-spot";
export const SOURCES: SourceId[] = ["binance-futures", "okx-swap", "binance-spot"];
/** the only source whose history is kept long (history.ts); must be a Binance one */
export const PRIMARY_SOURCE = "binance-futures" as const;
export const SOURCE_LABEL: Record<SourceId, string> = {
  "binance-futures": "Binance 永续合约",
  "okx-swap": "OKX 永续合约",
  "binance-spot": "Binance 现货",
};
const BINANCE_KLINES: Record<"binance-futures" | "binance-spot", string> = {
  "binance-futures": "https://fapi.binance.com/fapi/v1/klines",
  "binance-spot": "https://data-api.binance.vision/api/v3/klines",
};


const TTL_MS: Record<Timeframe, number> = {
  "5m": 20_000,
  "15m": 30_000,
  "1h": 60_000,
  "4h": 120_000,
  "1d": 300_000,
  "1w": 600_000,
};

const BINANCE_INTERVAL: Record<Timeframe, string> = { "5m": "5m", "15m": "15m", "1h": "1h", "4h": "4h", "1d": "1d", "1w": "1w" };
const OKX_BAR: Record<Timeframe, string> = { "5m": "5m", "15m": "15m", "1h": "1H", "4h": "4H", "1d": "1Dutc", "1w": "1Wutc" };

export const ttlFor = (tf: Timeframe) => TTL_MS[tf];

export interface KlineResult {
  candles: Candle[];
  /** "local" = served from the stored history because every exchange failed */
  source: SourceId | "local";
  /** with "local": which stored series */
  stored?: SourceId;
  fetchedAt: number;
}

/**
 * Unix seconds up to which this data is final: a bar counts as closed only if it ended
 * before the data was fetched (not merely before "now" — the cache can be minutes old).
 * Stored history served while every exchange is down may end mid-bar, so its last bar never counts.
 */
export function closedThrough(k: KlineResult, nowMs = Date.now()): number {
  if (k.source === "local") return k.candles.length ? k.candles[k.candles.length - 1].t : 0;
  return Math.floor(Math.min(nowMs, k.fetchedAt) / 1000);
}

type Entry = { at: number; value?: KlineResult; pending?: Promise<KlineResult> };
const cache = new Map<string, Entry>();

export async function getJson(source: string, url: string, timeoutMs = 10_000): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const start = Date.now();
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: "no-store", headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const ms = Date.now() - start;
    recordSource(source, true, ms);
    logger.debug("datasource", `${source} 请求成功`, { url, durationMs: ms });
    return body;
  } catch (e) {
    const ms = Date.now() - start;
    const msg = (e as Error).name === "AbortError" ? `超时 ${timeoutMs}ms` : (e as Error).message;
    recordSource(source, false, ms, msg);
    logger.warn("datasource", `${source} 请求失败：${msg}`, { url, durationMs: ms });
    throw new Error(`${source}: ${msg}`);
  } finally {
    clearTimeout(timer);
  }
}

/** One page of Binance klines (at most 1000 bars). Times in Unix seconds, both ends inclusive. */
export async function binancePage(
  source: keyof typeof BINANCE_KLINES,
  coin: string,
  tf: Timeframe,
  q: { startTime?: number; endTime?: number; limit: number },
): Promise<Candle[]> {
  const range = `${q.startTime != null ? `&startTime=${q.startTime * 1000}` : ""}${q.endTime != null ? `&endTime=${q.endTime * 1000}` : ""}`;
  const url = `${BINANCE_KLINES[source]}?symbol=${coin}USDT&interval=${BINANCE_INTERVAL[tf]}&limit=${q.limit}${range}`;
  const rows = (await getJson(source, url)) as unknown[][];
  if (!Array.isArray(rows)) throw new Error(`${source}: unexpected response`);
  return rows.map((r) => ({
    t: Math.floor(Number(r[0]) / 1000),
    o: Number(r[1]),
    h: Number(r[2]),
    l: Number(r[3]),
    c: Number(r[4]),
    v: Number(r[5]),
  }));
}

async function fromBinance(source: keyof typeof BINANCE_KLINES, coin: string, tf: Timeframe, limit: number): Promise<Candle[]> {
  const out: Candle[] = [];
  let endTime: number | undefined;
  // newest page first, walking back with endTime
  while (out.length < limit) {
    const size = Math.min(1000, limit - out.length);
    const page = await binancePage(source, coin, tf, { endTime, limit: size });
    if (page.length === 0) break;
    out.unshift(...page);
    if (page.length < size) break;
    endTime = page[0].t - 1;
  }
  if (out.length === 0) throw new Error(`${source}: empty`);
  return out;
}

/** OKX perpetual swaps (volume in the base coin, like Binance). */
async function fromOkxSwap(coin: string, tf: Timeframe, limit: number): Promise<Candle[]> {
  const out: Candle[] = [];
  let after = "";
  // OKX returns newest first, at most 300 (recent) / 100 (history) per call.
  for (let page = 0; page < 20 && out.length < limit; page++) {
    const endpoint = page === 0 ? "candles" : "history-candles";
    const url = `https://www.okx.com/api/v5/market/${endpoint}?instId=${coin}-USDT-SWAP&bar=${OKX_BAR[tf]}&limit=${page === 0 ? 300 : 100}${after ? `&after=${after}` : ""}`;
    const body = (await getJson("okx-swap", url)) as { code: string; data: string[][] };
    if (body.code !== "0" || !Array.isArray(body.data) || body.data.length === 0) break;
    for (const r of body.data) {
      out.push({ t: Math.floor(Number(r[0]) / 1000), o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[6] });
    }
    after = body.data[body.data.length - 1][0];
  }
  if (out.length === 0) throw new Error("okx-swap: empty");
  out.sort((a, b) => a.t - b.t);
  return out.slice(-limit);
}

// ---------------------------------------------------------------- local history

/**
 * Days of history kept per timeframe (null = everything the exchange has). The live
 * analysis reads only the newest ~2000 bars; the rest feeds statistics and research
 * and is filled in the background (see history.ts).
 */
export const KEEP_DAYS: Record<Timeframe, number | null> = {
  "5m": 30,
  "15m": 365,
  "1h": 730,
  "4h": 1826,
  "1d": null,
  "1w": null,
};
/** fallback sources only keep about the analysis window */
const FALLBACK_KEEP_BARS = 2500;
/** how many recent bars to re-fetch once the local history is complete */
const INCREMENTAL_BARS = 100;
/** a source that just failed is skipped for this long, unless every source is failing */
const COOLDOWN_MS = 60_000;

export function readStored(coin: string, tf: Timeframe, source: SourceId, limit: number): Candle[] {
  try {
    const rows = getDb()
      .prepare("SELECT t, o, h, l, c, v FROM candles WHERE coin = ? AND tf = ? AND source = ? ORDER BY t DESC LIMIT ?")
      .all(coin, tf, source, limit) as Candle[];
    return rows.reverse();
  } catch {
    return []; // no database available: behave as before
  }
}

export function store(coin: string, tf: Timeframe, source: SourceId, candles: Candle[]) {
  try {
    const d = getDb();
    const ins = d.prepare("INSERT OR REPLACE INTO candles (coin, tf, source, t, o, h, l, c, v) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    d.transaction(() => {
      for (const x of candles) ins.run(coin, tf, source, x.t, x.o, x.h, x.l, x.c, x.v);
    })();
  } catch (e) {
    logger.warn("datasource", `保存 K 线到本地失败：${coin} ${tf} ${source}`, { error: (e as Error).message });
  }
}

/** Drop stored bars older than the retention: KEEP_DAYS for the primary source, the newest bars for the others (run daily). */
export function pruneStoredKlines(nowSec = Date.now() / 1000): number {
  const d = getDb();
  const series = d.prepare("SELECT coin, tf, source, MAX(t) last FROM candles GROUP BY coin, tf, source").all() as {
    coin: string;
    tf: Timeframe;
    source: string;
    last: number;
  }[];
  const del = d.prepare("DELETE FROM candles WHERE coin = ? AND tf = ? AND source = ? AND t < ?");
  let removed = 0;
  for (const x of series) {
    const days = KEEP_DAYS[x.tf];
    if (x.source === PRIMARY_SOURCE) {
      if (days != null) removed += del.run(x.coin, x.tf, x.source, Math.floor(nowSec - days * 86400)).changes;
    } else {
      removed += del.run(x.coin, x.tf, x.source, x.last - FALLBACK_KEEP_BARS * TF_SECONDS[x.tf]).changes;
    }
  }
  // rows a rolled-back older release wrote to the old table
  removed += d.prepare("DELETE FROM klines").run().changes;
  return removed;
}

function fetchFrom(source: SourceId, coin: string, tf: Timeframe, limit: number): Promise<Candle[]> {
  return source === "okx-swap" ? fromOkxSwap(coin, tf, limit) : fromBinance(source, coin, tf, limit);
}

/**
 * Once the stored series is complete and recent, only the newest bars are
 * fetched and merged; otherwise the full window is downloaded.
 */
async function loadFrom(source: SourceId, coin: string, tf: Timeframe, limit: number): Promise<KlineResult> {
  const stored = readStored(coin, tf, source, limit);
  const sec = TF_SECONDS[tf];
  const recent = stored.length >= limit * 0.98 && stored[stored.length - 1].t >= Date.now() / 1000 - INCREMENTAL_BARS * 0.5 * sec;
  if (recent) {
    const fresh = await fetchFrom(source, coin, tf, INCREMENTAL_BARS);
    // the fresh window must overlap or touch the stored history, otherwise fall back to a full download
    if (fresh.length && fresh[0].t <= stored[stored.length - 1].t + sec) {
      store(coin, tf, source, fresh);
      const merged = stored.filter((x) => x.t < fresh[0].t).concat(fresh).slice(-limit);
      return { candles: merged, source, fetchedAt: Date.now() };
    }
  }
  const full = await fetchFrom(source, coin, tf, limit);
  store(coin, tf, source, full);
  return { candles: full, source, fetchedAt: Date.now() };
}

const downUntil = new Map<SourceId, number>();
/** source last served per coin/timeframe, so a switch is logged once rather than on every load */
const lastServed = new Map<string, SourceId | "local">();

function served(coin: string, tf: Timeframe, r: KlineResult, errors: string[]): KlineResult {
  const key = `${coin}:${tf}`;
  const prev = lastServed.get(key);
  lastServed.set(key, r.source);
  if (prev !== r.source && (prev !== undefined || r.source !== PRIMARY_SOURCE)) {
    const name = r.source === "local" ? "本地存储" : SOURCE_LABEL[r.source];
    if (r.source === PRIMARY_SOURCE) logger.info("datasource", `已恢复主数据源${name}：${coin} ${tf}`);
    else if (r.source !== "local") {
      logger.warn("datasource", `主数据源暂不可用，改用${name}：${coin} ${tf}`, { errors });
      raiseAlert("datasource", `主数据源不可用，已切换到${name}`, { 币种: coin, 周期: tf, 错误: errors.join("；") });
    }
  }
  return r;
}

/**
 * Sources in order of preference, skipping any that failed in the last minute. If every
 * exchange fails, the freshest stored series is served instead (the primary one on a tie).
 */
async function load(coin: string, tf: Timeframe, limit: number): Promise<KlineResult> {
  const now = Date.now();
  const up = SOURCES.filter((s) => (downUntil.get(s) ?? 0) <= now);
  const errors: string[] = [];
  for (const source of up.length ? up : SOURCES) {
    try {
      return served(coin, tf, await loadFrom(source, coin, tf, limit), errors);
    } catch (e) {
      downUntil.set(source, Date.now() + COOLDOWN_MS);
      errors.push((e as Error).message);
    }
  }
  let best: KlineResult | null = null;
  for (const source of SOURCES) {
    const stored = readStored(coin, tf, source, limit);
    if (stored.length >= 300 && (!best || stored[stored.length - 1].t > best.candles[best.candles.length - 1].t)) {
      best = { candles: stored, source: "local", stored: source, fetchedAt: Date.now() };
    }
  }
  if (best) {
    const last = best.candles[best.candles.length - 1].t;
    logger.error("datasource", `所有数据源都失败，使用本地存储的 K 线：${coin} ${tf}`, { errors, series: best.stored, lastBar: new Date(last * 1000).toISOString() });
    raiseAlert("datasource", "所有数据源都失败，正在使用本地存储的 K 线", { 币种: coin, 周期: tf, 错误: errors.join("；") });
    return served(coin, tf, best, errors);
  }
  raiseAlert("datasource", "所有数据源都失败，且本地没有可用的 K 线", { 币种: coin, 周期: tf, 错误: errors.join("；") });
  throw new Error(errors.join("; "));
}

/** Forget cached results and source failures (tests). */
export function resetDataSources() {
  cache.clear();
  downUntil.clear();
  lastServed.clear();
}

export async function getKlines(coin: string, tf: Timeframe, limit = 2000): Promise<KlineResult> {
  const key = `${coin}:${tf}:${limit}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit?.value && now - hit.at < TTL_MS[tf]) return hit.value;
  if (hit?.pending) return hit.pending;

  const pending = load(coin, tf, limit);

  cache.set(key, { at: hit?.at ?? 0, value: hit?.value, pending });
  try {
    const value = await pending;
    cache.set(key, { at: Date.now(), value });
    return value;
  } catch (e) {
    // Serve stale data rather than nothing if both sources are down.
    if (hit?.value) {
      logger.error("datasource", `所有数据源都失败，返回旧缓存：${coin} ${tf}`, { error: (e as Error).message, staleSec: Math.round((Date.now() - hit.at) / 1000) });
      cache.set(key, { at: hit.at, value: hit.value });
      return hit.value;
    }
    cache.delete(key);
    logger.error("datasource", `所有数据源都失败：${coin} ${tf}`, { error: (e as Error).message });
    throw e;
  }
}
