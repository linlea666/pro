import type { Candle, Timeframe } from "../types.ts";
import { recordSource } from "../server/health.ts";
import { logger } from "../server/log.ts";

/**
 * Public market data with source fallback. Binance's public data mirror first
 * (1000 bars per call), OKX second. Results are cached per symbol/timeframe.
 */

const TTL_MS: Record<Timeframe, number> = {
  "15m": 30_000,
  "1h": 60_000,
  "4h": 120_000,
  "1d": 300_000,
  "1w": 600_000,
};

const BINANCE_INTERVAL: Record<Timeframe, string> = { "15m": "15m", "1h": "1h", "4h": "4h", "1d": "1d", "1w": "1w" };
const OKX_BAR: Record<Timeframe, string> = { "15m": "15m", "1h": "1H", "4h": "4H", "1d": "1Dutc", "1w": "1Wutc" };

export interface KlineResult {
  candles: Candle[];
  source: "binance" | "okx";
  fetchedAt: number;
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

export async function getKlines(coin: string, tf: Timeframe, limit = 2000): Promise<KlineResult> {
  const key = `${coin}:${tf}:${limit}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit?.value && now - hit.at < TTL_MS[tf]) return hit.value;
  if (hit?.pending) return hit.pending;

  const pending = (async (): Promise<KlineResult> => {
    try {
      return { candles: await fromBinance(coin, tf, limit), source: "binance", fetchedAt: Date.now() };
    } catch (e) {
      logger.warn("datasource", `Binance 获取失败，切换到 OKX：${coin} ${tf}`, { error: (e as Error).message });
      return { candles: await fromOkx(coin, tf, limit), source: "okx", fetchedAt: Date.now() };
    }
  })();

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
