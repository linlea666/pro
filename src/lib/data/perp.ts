import { getDb } from "../server/db.ts";
import { logger } from "../server/log.ts";
import { COIN_IDS } from "../symbols.ts";
import { getJson, PRIMARY_SOURCE } from "./klines.ts";

/**
 * Perpetual-contract data beside the candles: the funding rate (what longs pay
 * shorts, or the reverse, every few hours) and open interest. The live snapshot
 * comes from Binance with OKX as fallback; the history (funding since 2 years
 * back, open interest hourly) is kept from the primary source only.
 */

const FAPI = "https://fapi.binance.com";
const OKX = "https://www.okx.com/api/v5/public";
const HOUR = 3600;
const FUNDING_KEEP_DAYS = 730;
/** Binance only serves the last 30 days of open-interest history */
const OI_HISTORY_DAYS = 29;

export interface PerpSnapshot {
  source: "binance-futures" | "okx-swap";
  markPrice: number | null;
  /** rate of the period now running, as a fraction (0.0001 = 0.01%); positive: longs pay shorts */
  fundingRate: number;
  /** Unix seconds when it is settled */
  nextFundingTime: number;
  /** hours between settlements, from the stored history (most coins: 8) */
  intervalHours: number | null;
  /** mean of the settled rates over the last 7 days */
  avgRate7d: number | null;
  /** open contracts, in the coin */
  openInterest: number | null;
  /** change of open interest over 24 hours, %, from the stored hourly history */
  oiChange24hPct: number | null;
  fetchedAt: number;
}

const num = (x: unknown) => (x == null || x === "" ? null : Number.isFinite(Number(x)) ? Number(x) : null);

async function fromBinance(coin: string) {
  const [p, oi] = await Promise.all([
    getJson(PRIMARY_SOURCE, `${FAPI}/fapi/v1/premiumIndex?symbol=${coin}USDT`) as Promise<{ markPrice: string; lastFundingRate: string; nextFundingTime: number }>,
    getJson(PRIMARY_SOURCE, `${FAPI}/fapi/v1/openInterest?symbol=${coin}USDT`).catch(() => null) as Promise<{ openInterest: string } | null>,
  ]);
  const rate = num(p.lastFundingRate);
  if (rate == null) throw new Error(`${PRIMARY_SOURCE}: no funding rate`);
  return { source: PRIMARY_SOURCE, markPrice: num(p.markPrice), fundingRate: rate, nextFundingTime: Math.floor(Number(p.nextFundingTime) / 1000), openInterest: num(oi?.openInterest) } as const;
}

async function fromOkx(coin: string) {
  const id = `${coin}-USDT-SWAP`;
  type Body<T> = { code: string; data: T[] };
  const [f, oi, mk] = await Promise.all([
    getJson("okx-swap", `${OKX}/funding-rate?instId=${id}`) as Promise<Body<{ fundingRate: string; fundingTime: string }>>,
    getJson("okx-swap", `${OKX}/open-interest?instType=SWAP&instId=${id}`).catch(() => null) as Promise<Body<{ oiCcy: string }> | null>,
    getJson("okx-swap", `${OKX}/mark-price?instType=SWAP&instId=${id}`).catch(() => null) as Promise<Body<{ markPx: string }> | null>,
  ]);
  const rate = num(f.data?.[0]?.fundingRate);
  if (f.code !== "0" || rate == null) throw new Error("okx-swap: no funding rate");
  return {
    source: "okx-swap",
    markPrice: num(mk?.data?.[0]?.markPx),
    fundingRate: rate,
    nextFundingTime: Math.floor(Number(f.data[0].fundingTime) / 1000),
    openInterest: num(oi?.data?.[0]?.oiCcy),
  } as const;
}

/** What the stored history adds: settlement interval, 7-day mean rate, 24-hour open-interest change. */
export function perpHistoryStats(coin: string, nowSec = Date.now() / 1000) {
  const d = getDb();
  const last = d.prepare("SELECT t FROM funding_rates WHERE coin = ? AND source = ? ORDER BY t DESC LIMIT 2").all(coin, PRIMARY_SOURCE) as { t: number }[];
  const intervalHours = last.length === 2 ? Math.round((last[0].t - last[1].t) / HOUR) : null;
  const avg = d.prepare("SELECT AVG(rate) a, COUNT(*) n FROM funding_rates WHERE coin = ? AND source = ? AND t > ?").get(coin, PRIMARY_SOURCE, nowSec - 7 * 24 * HOUR) as {
    a: number | null;
    n: number;
  };
  const oi = (t: number) =>
    d.prepare("SELECT oi FROM open_interest WHERE coin = ? AND source = ? AND t <= ? ORDER BY t DESC LIMIT 1").get(coin, PRIMARY_SOURCE, t) as { oi: number } | undefined;
  const now = oi(nowSec);
  const before = oi(nowSec - 24 * HOUR);
  const fresh = d.prepare("SELECT MAX(t) t FROM open_interest WHERE coin = ? AND source = ?").get(coin, PRIMARY_SOURCE) as { t: number | null };
  // only a recent history says anything about the last 24 hours
  const usable = now && before && fresh.t != null && fresh.t >= nowSec - 3 * HOUR;
  return {
    intervalHours,
    avgRate7d: avg.n ? avg.a : null,
    oiChange24hPct: usable ? Math.round(((now.oi - before.oi) / before.oi) * 1000) / 10 : null,
  };
}

const cache = new Map<string, { at: number; value: PerpSnapshot }>();
const TTL_MS = 60_000;

export async function getPerpSnapshot(coin: string): Promise<PerpSnapshot> {
  const hit = cache.get(coin);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  let live;
  try {
    live = await fromBinance(coin);
  } catch (e) {
    logger.debug("datasource", `Binance 资金费率获取失败，改用 OKX：${coin}`, { error: (e as Error).message });
    live = await fromOkx(coin);
  }
  let stats: ReturnType<typeof perpHistoryStats> = { intervalHours: null, avgRate7d: null, oiChange24hPct: null };
  try {
    stats = perpHistoryStats(coin);
  } catch {
    // no database: the live numbers alone
  }
  const value: PerpSnapshot = { ...live, ...stats, fetchedAt: Date.now() };
  cache.set(coin, { at: Date.now(), value });
  return value;
}

/**
 * Fetch new funding settlements and hourly open interest for every coin (run hourly).
 * Stops at the first failure and carries on next run.
 */
export async function syncPerpHistory(opts: { nowSec?: number; coins?: string[]; pauseMs?: number } = {}) {
  const { nowSec = Date.now() / 1000, coins = COIN_IDS, pauseMs = 200 } = opts;
  const d = getDb();
  const insF = d.prepare("INSERT OR REPLACE INTO funding_rates (coin, source, t, rate, mark_price) VALUES (?, ?, ?, ?, ?)");
  const insO = d.prepare("INSERT OR REPLACE INTO open_interest (coin, source, t, oi, oi_value) VALUES (?, ?, ?, ?, ?)");
  const lastT = (table: string, coin: string) =>
    (d.prepare(`SELECT MAX(t) t FROM ${table} WHERE coin = ? AND source = ?`).get(coin, PRIMARY_SOURCE) as { t: number | null }).t;
  const r = { requests: 0, funding: 0, openInterest: 0, error: undefined as string | undefined };
  const get = async (url: string) => {
    if (r.requests++ && pauseMs) await new Promise((ok) => setTimeout(ok, pauseMs));
    return getJson(PRIMARY_SOURCE, url);
  };
  try {
    for (const coin of coins) {
      // funding settlements, oldest first, 1000 per page
      let from = Math.max((lastT("funding_rates", coin) ?? 0) + 1, Math.floor(nowSec - FUNDING_KEEP_DAYS * 86400));
      for (;;) {
        const rows = (await get(`${FAPI}/fapi/v1/fundingRate?symbol=${coin}USDT&startTime=${from * 1000}&limit=1000`)) as {
          fundingTime: number;
          fundingRate: string;
          markPrice?: string;
        }[];
        if (!Array.isArray(rows) || !rows.length) break;
        d.transaction(() => {
          for (const x of rows) insF.run(coin, PRIMARY_SOURCE, Math.floor(Number(x.fundingTime) / 1000), Number(x.fundingRate), num(x.markPrice));
        })();
        r.funding += rows.length;
        if (rows.length < 1000) break;
        from = Math.floor(Number(rows[rows.length - 1].fundingTime) / 1000) + 1;
      }
      // hourly open interest, oldest first, 500 per page
      from = Math.max((lastT("open_interest", coin) ?? 0) + HOUR, Math.floor(nowSec - OI_HISTORY_DAYS * 86400));
      while (from <= nowSec - HOUR) {
        const rows = (await get(`${FAPI}/futures/data/openInterestHist?symbol=${coin}USDT&period=1h&limit=500&startTime=${from * 1000}`)) as {
          timestamp: number;
          sumOpenInterest: string;
          sumOpenInterestValue: string;
        }[];
        if (!Array.isArray(rows) || !rows.length) break;
        d.transaction(() => {
          for (const x of rows) insO.run(coin, PRIMARY_SOURCE, Math.floor(Number(x.timestamp) / 1000), Number(x.sumOpenInterest), num(x.sumOpenInterestValue));
        })();
        r.openInterest += rows.length;
        if (rows.length < 500) break;
        from = Math.floor(Number(rows[rows.length - 1].timestamp) / 1000) + HOUR;
      }
    }
  } catch (e) {
    r.error = (e as Error).message;
  }
  // funding older than the retention
  d.prepare("DELETE FROM funding_rates WHERE t < ?").run(Math.floor(nowSec - FUNDING_KEEP_DAYS * 86400));
  return r;
}
