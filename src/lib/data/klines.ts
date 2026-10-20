import type { Candle, Timeframe } from "../types.ts";
import { TF_SECONDS } from "../types.ts";
import { getDb } from "../server/db.ts";
import { recordSource } from "../server/health.ts";
import { logger } from "../server/log.ts";

/**
 * Public market data with source fallback. Binance's public data mirror first
 * (1000 bars per call), OKX second. Results are cached per symbol/timeframe.
 */

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
  source: "binance" | "okx" | "local";
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

async function getJson(source: "binance" | "okx", url: string, timeoutMs = 10_000): Promise<unknown> {
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

async function fromBinance(coin: string, tf: Timeframe, limit: number): Promise<Candle[]> {
  const out: Candle[] = [];
  let endTime = "";
  // newest page first, walking back with endTime
  while (out.length < limit) {
    const size = Math.min(1000, limit - out.length);
    const url = `https://data-api.binance.vision/api/v3/klines?symbol=${coin}USDT&interval=${BINANCE_INTERVAL[tf]}&limit=${size}${endTime ? `&endTime=${endTime}` : ""}`;
    const rows = (await getJson("binance", url)) as unknown[][];
    if (!Array.isArray(rows) || rows.length === 0) break;
    const page = rows.map((r) => ({
      t: Math.floor(Number(r[0]) / 1000),
      o: Number(r[1]),
      h: Number(r[2]),
      l: Number(r[3]),
      c: Number(r[4]),
      v: Number(r[5]),
    }));
    out.unshift(...page);
    if (rows.length < size) break;
    endTime = String(Number(rows[0][0]) - 1);
  }
  if (out.length === 0) throw new Error("binance: empty");
  return out;
}

async function fromOkx(coin: string, tf: Timeframe, limit: number): Promise<Candle[]> {
  const out: Candle[] = [];
  let after = "";
  // OKX returns newest first, at most 300 (recent) / 100 (history) per call.
  for (let page = 0; page < 20 && out.length < limit; page++) {
    const endpoint = page === 0 ? "candles" : "history-candles";
    const url = `https://www.okx.com/api/v5/market/${endpoint}?instId=${coin}-USDT&bar=${OKX_BAR[tf]}&limit=${page === 0 ? 300 : 100}${after ? `&after=${after}` : ""}`;
    const body = (await getJson("okx", url)) as { code: string; data: string[][] };
    if (body.code !== "0" || !Array.isArray(body.data) || body.data.length === 0) break;
    for (const r of body.data) {
      out.push({ t: Math.floor(Number(r[0]) / 1000), o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] });
    }
    after = body.data[body.data.length - 1][0];
  }
  if (out.length === 0) throw new Error("okx: empty");
  out.sort((a, b) => a.t - b.t);
  return out.slice(-limit);
}

// ---------------------------------------------------------------- local history

const KEEP_BARS = 5000;
/** how many recent bars to re-fetch once the local history is complete */
const INCREMENTAL_BARS = 100;

function readStored(coin: string, tf: Timeframe, limit: number): Candle[] {
  try {
    const rows = getDb().prepare("SELECT t, o, h, l, c, v FROM klines WHERE coin = ? AND tf = ? ORDER BY t DESC LIMIT ?").all(coin, tf, limit) as Candle[];
    return rows.reverse();
  } catch {
    return []; // no database available: behave as before
  }
}

function store(coin: string, tf: Timeframe, candles: Candle[]) {
  try {
    const d = getDb();
    const ins = d.prepare("INSERT OR REPLACE INTO klines (coin, tf, t, o, h, l, c, v) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    d.transaction(() => {
      for (const x of candles) ins.run(coin, tf, x.t, x.o, x.h, x.l, x.c, x.v);
    })();
  } catch (e) {
    logger.warn("datasource", `保存 K 线到本地失败：${coin} ${tf}`, { error: (e as Error).message });
  }
}

/** Trim stored history to the newest KEEP_BARS per coin/timeframe (run daily). */
export function pruneStoredKlines(): number {
  const d = getDb();
  const pairs = d.prepare("SELECT coin, tf, COUNT(*) n FROM klines GROUP BY coin, tf").all() as { coin: string; tf: string; n: number }[];
  let removed = 0;
  for (const p of pairs) {
    if (p.n <= KEEP_BARS) continue;
    const cut = d.prepare("SELECT t FROM klines WHERE coin = ? AND tf = ? ORDER BY t DESC LIMIT 1 OFFSET ?").get(p.coin, p.tf, KEEP_BARS - 1) as { t: number };
    removed += d.prepare("DELETE FROM klines WHERE coin = ? AND tf = ? AND t < ?").run(p.coin, p.tf, cut.t).changes;
  }
  return removed;
}

async function fetchRemote(coin: string, tf: Timeframe, limit: number): Promise<{ candles: Candle[]; source: "binance" | "okx" }> {
  try {
    return { candles: await fromBinance(coin, tf, limit), source: "binance" };
  } catch (e) {
    logger.warn("datasource", `Binance 获取失败，切换到 OKX：${coin} ${tf}`, { error: (e as Error).message });
    return { candles: await fromOkx(coin, tf, limit), source: "okx" };
  }
}

/**
 * Once the local history is complete and recent, only the newest bars are
 * fetched and merged; otherwise the full window is downloaded. If every
 * exchange fails, the stored history is served instead.
 */
async function load(coin: string, tf: Timeframe, limit: number): Promise<KlineResult> {
  const stored = readStored(coin, tf, limit);
  const sec = TF_SECONDS[tf];
  const recent = stored.length >= limit * 0.98 && stored[stored.length - 1].t >= Date.now() / 1000 - INCREMENTAL_BARS * 0.5 * sec;
  try {
    if (recent) {
      const fresh = await fetchRemote(coin, tf, INCREMENTAL_BARS);
      // the fresh window must overlap or touch the stored history, otherwise fall back to a full download
      if (fresh.candles.length && fresh.candles[0].t <= stored[stored.length - 1].t + sec) {
        store(coin, tf, fresh.candles);
        const merged = stored.filter((x) => x.t < fresh.candles[0].t).concat(fresh.candles).slice(-limit);
        return { candles: merged, source: fresh.source, fetchedAt: Date.now() };
      }
    }
    const full = await fetchRemote(coin, tf, limit);
    store(coin, tf, full.candles);
    return { candles: full.candles, source: full.source, fetchedAt: Date.now() };
  } catch (e) {
    if (stored.length >= 300) {
      logger.error("datasource", `所有数据源都失败，使用本地存储的 K 线：${coin} ${tf}`, { error: (e as Error).message, lastBar: new Date(stored[stored.length - 1].t * 1000).toISOString() });
      return { candles: stored, source: "local", fetchedAt: Date.now() };
    }
    throw e;
  }
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
