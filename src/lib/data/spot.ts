import { getDb } from "../server/db.ts";
import { logger } from "../server/log.ts";
import { raiseAlert } from "../server/alert.ts";
import { getJson } from "./klines.ts";
import { dayNum, dayStr, type FngPoint, type SpotSeries } from "../spot/valuation.ts";

/**
 * Daily inputs of the 现货囤币 page: BTC price, supply and MVRV from the Coin Metrics community API,
 * and the crypto Fear & Greed index from alternative.me, in the `spot_daily` table (one row per UTC day).
 * Both sources are free and keyless; each is synced on its own, so one failing does not block the other.
 */

const CM = "https://community-api.coinmetrics.io/v4/timeseries/asset-metrics";
const FNG = "https://api.alternative.me/fng/";
const CM_FIRST_DAY = "2010-07-18";
/** Coin Metrics revises recent values: refetch this many days before the last stored one */
const CM_OVERLAP_DAYS = 3;
const TIMEOUT_MS = 30_000;

export const SPOT_SOURCES = { cm: "coinmetrics", fng: "alternative-me" } as const;

const num = (x: unknown) => (x == null || x === "" ? null : Number.isFinite(Number(x)) ? Number(x) : null);

export interface SpotSyncResult {
  cmDays: number;
  fngDays: number;
  /** last day with a price */
  lastDay: string | null;
  error?: string;
}

/** Fetch new days from both sources and upsert them (CM fills price/supply/mvrv, alternative.me fills fng). */
export async function syncSpotDaily(opts: { asset?: string } = {}): Promise<SpotSyncResult> {
  const asset = opts.asset ?? "BTC";
  const d = getDb();
  const now = Date.now();
  const r: SpotSyncResult = { cmDays: 0, fngDays: 0, lastDay: null };
  const errors: string[] = [];

  try {
    const last = (d.prepare("SELECT MAX(day) day FROM spot_daily WHERE asset = ? AND price IS NOT NULL").get(asset) as { day: string | null }).day;
    const startDay = last ? dayStr(dayNum(last) - CM_OVERLAP_DAYS) : CM_FIRST_DAY;
    const up = d.prepare(
      `INSERT INTO spot_daily (asset, day, price, supply, mvrv, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(asset, day) DO UPDATE SET price = excluded.price, supply = excluded.supply, mvrv = excluded.mvrv, updated_at = excluded.updated_at`,
    );
    let url: string | null = `${CM}?assets=${asset.toLowerCase()}&metrics=PriceUSD,SplyCur,CapMVRVCur&frequency=1d&page_size=10000&start_time=${startDay}`;
    for (let page = 0; url && page < 50; page++) {
      const body = (await getJson(SPOT_SOURCES.cm, url, TIMEOUT_MS)) as {
        data?: { time: string; PriceUSD?: string; SplyCur?: string; CapMVRVCur?: string }[];
        next_page_url?: string;
      };
      const rows = (body.data ?? []).filter((x) => num(x.PriceUSD) != null && typeof x.time === "string");
      d.transaction(() => {
        for (const x of rows) up.run(asset, x.time.slice(0, 10), num(x.PriceUSD), num(x.SplyCur), num(x.CapMVRVCur), now);
      })();
      r.cmDays += rows.length;
      url = body.next_page_url ?? null;
    }
  } catch (e) {
    errors.push((e as Error).message);
  }

  try {
    const hasFng = d.prepare("SELECT 1 FROM spot_daily WHERE asset = ? AND fng IS NOT NULL LIMIT 1").get(asset);
    const body = (await getJson(SPOT_SOURCES.fng, `${FNG}?limit=${hasFng ? 10 : 0}&format=json`, TIMEOUT_MS)) as { data?: { value: string; timestamp: string }[] };
    if (!Array.isArray(body.data)) throw new Error(`${SPOT_SOURCES.fng}: no data`);
    const up = d.prepare(
      `INSERT INTO spot_daily (asset, day, fng, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(asset, day) DO UPDATE SET fng = excluded.fng, updated_at = excluded.updated_at`,
    );
    const rows = body.data
      .map((x) => ({ day: Number.isFinite(Number(x.timestamp)) ? new Date(Number(x.timestamp) * 1000).toISOString().slice(0, 10) : null, v: num(x.value) }))
      .filter((x): x is { day: string; v: number } => x.day != null && x.v != null);
    d.transaction(() => {
      for (const x of rows) up.run(asset, x.day, Math.round(x.v), now);
    })();
    r.fngDays = rows.length;
  } catch (e) {
    errors.push((e as Error).message);
  }

  r.lastDay = (d.prepare("SELECT MAX(day) day FROM spot_daily WHERE asset = ? AND price IS NOT NULL").get(asset) as { day: string | null }).day;
  if (errors.length) {
    r.error = errors.join("; ");
    logger.warn("datasource", "现货估值数据更新失败", { ...r });
    raiseAlert("datasource", "现货估值数据更新失败", { 错误: r.error, 最新一天: r.lastDay ?? "无" });
  }
  return r;
}

/**
 * The stored days with a price, as contiguous arrays (index = day offset). A missing day (Coin Metrics has none,
 * but a partial download could leave one) carries the previous day's price, supply and MVRV forward with no
 * Fear & Greed value, so the 200-week average still steps back whole weeks. Null when nothing is stored.
 */
export function spotSeries(asset = "BTC"): SpotSeries | null {
  const rows = getDb()
    .prepare("SELECT day, price, supply, mvrv, fng FROM spot_daily WHERE asset = ? AND price IS NOT NULL ORDER BY day")
    .all(asset) as { day: string; price: number; supply: number | null; mvrv: number | null; fng: number | null }[];
  if (!rows.length) return null;
  const s: SpotSeries = { day: [], price: [], supply: [], mvrv: [], fng: [] };
  let prev = dayNum(rows[0].day) - 1;
  for (const x of rows) {
    const n = dayNum(x.day);
    for (let k = prev + 1; k < n; k++) {
      s.day.push(dayStr(k));
      s.price.push(s.price[s.price.length - 1]);
      s.supply.push(s.supply[s.supply.length - 1]);
      s.mvrv.push(s.mvrv[s.mvrv.length - 1]);
      s.fng.push(null);
    }
    s.day.push(x.day);
    s.price.push(x.price);
    s.supply.push(x.supply);
    s.mvrv.push(x.mvrv);
    s.fng.push(x.fng);
    prev = n;
  }
  return s;
}

/** Every stored Fear & Greed value, oldest first (it can run a day past the last price). */
export function fngPoints(asset = "BTC"): FngPoint[] {
  return getDb().prepare("SELECT day, fng value FROM spot_daily WHERE asset = ? AND fng IS NOT NULL ORDER BY day").all(asset) as FngPoint[];
}

/** Last stored day with a price and with a Fear & Greed value, and when anything was last written (cache key, CLI). */
export function spotFreshness(asset = "BTC"): { lastDay: string | null; lastFngDay: string | null; updatedAt: number | null; days: number } {
  return getDb()
    .prepare("SELECT MAX(CASE WHEN price IS NOT NULL THEN day END) lastDay, MAX(CASE WHEN fng IS NOT NULL THEN day END) lastFngDay, MAX(updated_at) updatedAt, COUNT(price) days FROM spot_daily WHERE asset = ?")
    .get(asset) as { lastDay: string | null; lastFngDay: string | null; updatedAt: number | null; days: number };
}
