import zlib from "node:zlib";
import { getDb } from "../server/db.ts";
import { getState, setState } from "../server/settings.ts";
import { COIN_IDS } from "../symbols.ts";
import { PRIMARY_SOURCE } from "./klines.ts";

/**
 * Binance's public data archive (data.binance.vision): one zip per symbol and day.
 * The live API only serves the last 30 days of open interest; the archive's daily
 * "metrics" files (5-minute rows) go back years (BTC from 2020-09, most coins from
 * 2021-12). They are reduced to the same hourly rows the live sync keeps (perp.ts),
 * in the same table, walking back day by day in the background.
 */

const BASE = "https://data.binance.vision/data/futures/um";
const DAY = 86400;
/** open interest is kept as far back as 4-hour bars (KEEP_DAYS["4h"]) */
const KEEP_DAYS = 1826;
/** this many missing days in a row means the archive has nothing older */
const END_MISSES = 14;
/** once complete, the last weeks are re-checked daily in case the live hourly sync missed some */
const RECHECK_DAYS = 35;

/** The single file inside a Binance archive zip, as text (stored or deflated). */
export function unzipSingle(buf: Uint8Array): string {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (b.length < 30 || b.readUInt32LE(0) !== 0x04034b50) throw new Error("not a zip file");
  const flags = b.readUInt16LE(6), method = b.readUInt16LE(8);
  let size = b.readUInt32LE(18);
  const start = 30 + b.readUInt16LE(26) + b.readUInt16LE(28);
  if (flags & 8 || !size) {
    // sizes written after the data: read them from the central directory
    const cd = b.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), start);
    if (cd < 0) throw new Error("zip without a central directory");
    size = b.readUInt32LE(cd + 20);
  }
  const data = b.subarray(start, start + size);
  if (method === 0) return data.toString("utf8");
  if (method === 8) return zlib.inflateRawSync(data).toString("utf8");
  throw new Error(`zip compression ${method} not supported`);
}

/** An archive file as text; null when the archive has no such file. */
export async function fetchArchive(path: string, timeoutMs = 20_000): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}/${path}`, { signal: ctrl.signal });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`data.binance.vision ${res.status}`);
    return unzipSingle(new Uint8Array(await res.arrayBuffer()));
  } finally {
    clearTimeout(timer);
  }
}

/** One day of 5-minute metrics → hourly open interest: the first row of each hour (UTC). */
export function hourlyOpenInterest(csv: string): { t: number; oi: number; value: number | null }[] {
  const byHour = new Map<number, { at: number; oi: number; value: number | null }>();
  for (const line of csv.split(/\r?\n/)) {
    const f = line.split(",");
    // create_time, symbol, sum_open_interest, sum_open_interest_value, …; the header and blank lines fail here
    const at = Date.parse(`${f[0]?.replace(" ", "T")}Z`) / 1000;
    const oi = Number(f[2]);
    if (!Number.isFinite(at) || !(oi > 0)) continue;
    const hour = Math.floor(at / 3600) * 3600;
    const prev = byHour.get(hour);
    if (!prev || at < prev.at) byHour.set(hour, { at, oi, value: f[3] === "" || f[3] == null || !Number.isFinite(Number(f[3])) ? null : Number(f[3]) });
  }
  return [...byHour.entries()].sort((a, b) => a[0] - b[0]).map(([t, x]) => ({ t, oi: x.oi, value: x.value }));
}

interface OiState {
  /** next day to fetch, walking back (YYYY-MM-DD) */
  next: string | null;
  /** missing days in a row at the far end */
  misses: number;
  /** the walk back reached the archive's first day (or the retention) */
  done: boolean;
}

const stateKey = (coin: string) => `oiArchive.${PRIMARY_SOURCE}.${coin}`;
const day = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10);
const daySec = (d: string) => Date.parse(`${d}T00:00:00Z`) / 1000;

function readState(coin: string): OiState {
  try {
    const v = JSON.parse(getState(stateKey(coin)) || "{}");
    return { next: v.next ?? null, misses: v.misses ?? 0, done: !!v.done };
  } catch {
    return { next: null, misses: 0, done: false };
  }
}

export interface OiArchiveResult {
  requests: number;
  days: number;
  rows: number;
  complete: boolean;
  error?: string;
}

/**
 * Walk each coin's open interest back to the archive's first day, a day per request,
 * skipping days already stored (the live sync keeps the last month). Stops at the first
 * failed request and carries on next run.
 */
export async function syncOpenInterestArchive(
  opts: { coins?: string[]; budgetMs?: number; pauseMs?: number; nowSec?: number } = {},
): Promise<OiArchiveResult> {
  const { coins = COIN_IDS, budgetMs = 60_000, pauseMs = 150, nowSec = Date.now() / 1000 } = opts;
  const t0 = Date.now();
  const left = () => Date.now() - t0 < budgetMs;
  const r: OiArchiveResult = { requests: 0, days: 0, rows: 0, complete: true };
  const d = getDb();
  const ins = d.prepare("INSERT OR IGNORE INTO open_interest (coin, source, t, oi, oi_value) VALUES (?, ?, ?, ?, ?)");
  const stored = d.prepare("SELECT COUNT(*) n FROM open_interest WHERE coin = ? AND source = ? AND t >= ? AND t < ?");
  // the archive publishes a day after it ends
  const newest = day(nowSec - 2 * DAY);
  const floor = day(nowSec - KEEP_DAYS * DAY);
  try {
    for (const coin of coins) {
      const st = readState(coin);
      // after the walk back, only the last weeks are looked at again
      let cur = st.done ? newest : (st.next ?? newest);
      const stop = st.done ? day(nowSec - RECHECK_DAYS * DAY) : floor;
      let misses = st.done ? 0 : st.misses;
      while (cur >= stop && left()) {
        const from = daySec(cur);
        if ((stored.get(coin, PRIMARY_SOURCE, from, from + DAY) as { n: number }).n < 20) {
          if (r.requests++ && pauseMs) await new Promise((ok) => setTimeout(ok, pauseMs));
          const csv = await fetchArchive(`daily/metrics/${coin}USDT/${coin}USDT-metrics-${cur}.zip`);
          if (csv == null) {
            if (!st.done && ++misses >= END_MISSES) {
              st.done = true;
              break;
            }
          } else {
            misses = 0;
            const rows = hourlyOpenInterest(csv);
            d.transaction(() => {
              for (const x of rows) ins.run(coin, PRIMARY_SOURCE, x.t, x.oi, x.value);
            })();
            r.days++;
            r.rows += rows.length;
          }
        }
        cur = day(daySec(cur) - DAY);
      }
      if (!st.done && cur < stop) st.done = true;
      if (!st.done) {
        st.next = cur;
        st.misses = misses;
        r.complete = false;
      }
      setState(stateKey(coin), JSON.stringify(st));
    }
  } catch (e) {
    r.complete = false;
    r.error = (e as Error).message;
  }
  return r;
}

/** First and last stored hour of open interest per coin, for the CLI. */
export function openInterestCoverage(coins = COIN_IDS) {
  const q = getDb().prepare("SELECT MIN(t) first, MAX(t) last, COUNT(*) n FROM open_interest WHERE coin = ? AND source = ?");
  return coins.map((coin) => ({ coin, ...(q.get(coin, PRIMARY_SOURCE) as { first: number | null; last: number | null; n: number }), done: readState(coin).done }));
}
