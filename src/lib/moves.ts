import { getKlines, PRIMARY_SOURCE } from "./data/klines.ts";
import { loadHistory } from "./research/run.ts";
import { logger } from "./server/log.ts";
import {
  after,
  atLeast,
  bandOf,
  bucketTable,
  changes,
  dailyRanges,
  leverageTable,
  pctRank,
  sortedAbs,
  swingAfter,
  topMoves,
  typical,
  worstSpan,
  type BucketRow,
  type Freq,
  type LevRow,
  type Move,
  type MoveBand,
  type Typical,
} from "./ta/moves.ts";
import type { Candle } from "./types.ts";

/**
 * The 涨跌统计 page: for BTC and ETH, the move now over 1 hour, 4 hours, 24 hours and 7 days, ranked against the
 * coin's stored history, plus the frequency table, the extremes and the leverage table. The history part is
 * rebuilt once an hour; the live part (latest price) at most every 15 seconds.
 */

/** Only BTC and ETH (decided 2026-10-22): the two with the longest history. */
export const MOVE_COINS = ["BTC", "ETH"];

export type WindowKey = "1h" | "4h" | "24h" | "7d";
const WINDOWS: { key: WindowKey; hours: number }[] = [
  { key: "1h", hours: 1 },
  { key: "4h", hours: 4 },
  { key: "24h", hours: 24 },
  { key: "7d", hours: 168 },
];
const DAY = 86400;
const YEAR = 365 * DAY;
const AFTER_DAYS = [1, 3, 7];

export interface WindowNow {
  key: WindowKey;
  /** change now against the price this long ago, %; null when the data is missing */
  pct: number | null;
  /** share of the stored history with a smaller move in size, %: all of it and the last 12 months */
  rankAll: number | null;
  rankYear: number | null;
  band: MoveBand | null;
  /** how often a move at least this big, the same way, happened */
  freq: Freq | null;
  typical: Typical;
  /** history: what bars the distribution is measured on */
  basis: string;
}

export interface ExtremeRow extends Move {
  /** change over the next 1 / 3 / 7 days, % */
  after: (number | null)[];
}

export type Period = "all" | "year" | "d90";

export interface MovesView {
  coin: string;
  source: string;
  updatedAt: number;
  price: number | null;
  /** the live price came from the exchange (false: the last stored close) */
  live: boolean;
  windows: WindowNow[];
  /** high to low over the last 24 hours against the price 24 hours ago, and its rank among daily ranges */
  range24: { pct: number; rank: number | null; band: MoveBand | null; p50: number | null } | null;
  /** from the highest price of the last 30 days */
  fromHigh30: { pct: number; high: number; t: number } | null;
  /** daily (UTC) frequency table over three periods, with the number of days in each */
  buckets: Record<Period, { days: number; from: number | null; rows: BucketRow[] }>;
  /** the day's move bucket now falls in: index into rows, and its side */
  bucketNow: { index: number; side: "down" | "up" } | null;
  topDrops: ExtremeRow[];
  topRises: ExtremeRow[];
  worst7: { pct: number; from: number; to: number } | null;
  worst30: { pct: number; from: number; to: number } | null;
  leverage: LevRow[];
  /** after the biggest 5% of daily drops / rises: the next 3 days' average size against the usual */
  swing: { down: { ratio: number; n: number } | null; up: { ratio: number; n: number } | null };
  afterDays: number[];
}

interface Base {
  at: number;
  h1: Candle[];
  d1: Candle[];
  dist: Record<WindowKey, { moves: Move[]; step: number; basis: string; sAll: number[]; sYear: number[]; typical: Typical }>;
  ranges: number[];
  rangeP50: number | null;
  buckets: MovesView["buckets"];
  topDrops: ExtremeRow[];
  topRises: ExtremeRow[];
  worst7: MovesView["worst7"];
  worst30: MovesView["worst30"];
  leverage: LevRow[];
  swing: MovesView["swing"];
}

const baseCache = new Map<string, Base>();

function buildBase(coin: string, nowSec: number): Base {
  const h1 = loadHistory(coin, "1h", nowSec);
  const h4 = loadHistory(coin, "4h", nowSec);
  const d1 = loadHistory(coin, "1d", nowSec);
  const lastT = d1.length ? d1[d1.length - 1].t : nowSec;
  const mk = (moves: Move[], step: number, basis: string) => ({
    moves,
    step,
    basis,
    sAll: sortedAbs(moves),
    sYear: sortedAbs(moves.filter((x) => x.t > nowSec - YEAR)),
    typical: typical(moves),
  });
  const daily = changes(d1, 1, DAY);
  const dist = {
    "1h": mk(changes(h1, 1, 3600), 3600, "1 小时 K 线"),
    "4h": mk(changes(h4, 1, 4 * 3600), 4 * 3600, "4 小时 K 线"),
    "24h": mk(daily, DAY, "日线（UTC 0 点，北京时间 8 点收盘）"),
    "7d": mk(changes(d1, 7, DAY), DAY, "日线，每天往回看 7 天"),
  };
  const period = (since: number) => {
    const m = daily.filter((x) => x.t > since);
    return { days: m.length, from: m.length ? m[0].t : null, rows: bucketTable(m, DAY) };
  };
  const ext = (m: Move[]): ExtremeRow[] => m.map((x) => ({ t: x.t, pct: x.pct, after: after(d1, x.t, AFTER_DAYS) }));
  const ranges = sortedAbs(dailyRanges(d1));
  return {
    at: nowSec,
    h1,
    d1,
    dist,
    ranges,
    rangeP50: ranges.length ? ranges[Math.floor(ranges.length / 2)] : null,
    buckets: { all: period(-Infinity), year: period(lastT - YEAR), d90: period(lastT - 90 * DAY) },
    topDrops: ext(topMoves(daily, 10, -1, 3 * DAY)),
    topRises: ext(topMoves(daily, 10, 1, 3 * DAY)),
    worst7: worstSpan(d1, 7),
    worst30: worstSpan(d1, 30),
    leverage: leverageTable(d1),
    swing: { down: swingAfter(daily, -1), up: swingAfter(daily, 1) },
  };
}

function baseOf(coin: string, nowSec: number): Base {
  const key = `${coin}:${Math.floor(nowSec / 3600)}`;
  let b = baseCache.get(key);
  if (!b) {
    b = buildBase(coin, nowSec);
    for (const k of baseCache.keys()) if (k.startsWith(`${coin}:`)) baseCache.delete(k);
    baseCache.set(key, b);
  }
  return b;
}

/** The open of the bar that contains `t` (bars of `sec` seconds, ascending); null outside the series. */
function priceAt(c: Candle[], t: number, sec: number): number | null {
  for (let i = c.length - 1; i >= 0; i--) if (c[i].t <= t) return t < c[i].t + sec ? c[i].o : null;
  return null;
}

const r2 = (x: number) => Math.round(x * 100) / 100;

async function liveBars(coin: string): Promise<{ m5: Candle[]; h1: Candle[]; source: string } | null> {
  try {
    const [m5, h1] = await Promise.all([getKlines(coin, "5m"), getKlines(coin, "1h")]);
    if (m5.source === "local" || !m5.candles.length) return null;
    return { m5: m5.candles, h1: h1.candles, source: m5.source };
  } catch (e) {
    logger.warn("datasource", "涨跌统计：实时 K 线获取失败，改用本地历史", { coin, error: e });
    return null;
  }
}

export async function movesView(coin: string, nowMs = Date.now()): Promise<MovesView> {
  const nowSec = Math.floor(nowMs / 1000);
  const b = baseOf(coin, nowSec);
  const live = await liveBars(coin);
  // live: the latest traded price and rolling windows from 5-minute bars (7 days from hourly bars);
  // otherwise the last stored hourly close and windows from stored hours
  const h1 = live?.h1.length ? live.h1 : b.h1;
  const price = live ? live.m5[live.m5.length - 1].c : h1.length ? h1[h1.length - 1].c : null;
  const at = live ? Math.min(nowSec, live.m5[live.m5.length - 1].t + 299) : h1.length ? h1[h1.length - 1].t + 3600 : nowSec;
  const refOf = (hours: number) => {
    const t = at - hours * 3600;
    return (live && hours <= 24 ? priceAt(live.m5, t, 300) : null) ?? priceAt(h1, t, 3600);
  };
  const windows: WindowNow[] = WINDOWS.map(({ key, hours }) => {
    const d = b.dist[key];
    const ref = refOf(hours);
    const pct = price != null && ref ? (price / ref - 1) * 100 : null;
    const rankAll = pct == null ? null : pctRank(d.sAll, Math.abs(pct));
    return {
      key,
      pct: pct == null ? null : r2(pct),
      rankAll,
      rankYear: pct == null ? null : pctRank(d.sYear, Math.abs(pct)),
      band: bandOf(rankAll),
      freq: pct == null || pct === 0 ? null : atLeast(d.moves, pct, d.step),
      typical: d.typical,
      basis: d.basis,
    };
  });

  let range24: MovesView["range24"] = null;
  const ref24 = refOf(24);
  const recent = live ? live.m5.filter((x) => x.t + 300 > at - DAY) : h1.filter((x) => x.t + 3600 > at - DAY);
  if (ref24 && recent.length) {
    const pct = ((Math.max(...recent.map((x) => x.h)) - Math.min(...recent.map((x) => x.l))) / ref24) * 100;
    const rank = pctRank(b.ranges, pct);
    range24 = { pct: r2(pct), rank, band: bandOf(rank), p50: b.rangeP50 == null ? null : r2(b.rangeP50) };
  }

  let fromHigh30: MovesView["fromHigh30"] = null;
  const month = [...b.d1.filter((x) => x.t > at - 30 * DAY), ...h1.filter((x) => x.t > (b.d1.length ? b.d1[b.d1.length - 1].t + DAY : 0))];
  if (price != null && month.length) {
    const top = month.reduce((m, x) => (x.h > m.h ? x : m));
    const high = Math.max(top.h, price);
    fromHigh30 = { pct: r2((price / high - 1) * 100), high, t: top.h >= price ? top.t : at };
  }

  const w24 = windows.find((w) => w.key === "24h")!;
  let bucketNow: MovesView["bucketNow"] = null;
  if (w24.pct != null && w24.pct !== 0) {
    const size = Math.abs(w24.pct);
    const rows = b.buckets.all.rows;
    const index = rows.findIndex((r) => size >= r.lo && (r.hi == null || size < r.hi));
    if (index >= 0) bucketNow = { index, side: w24.pct < 0 ? "down" : "up" };
  }

  return {
    coin,
    source: live?.source ?? PRIMARY_SOURCE,
    updatedAt: nowSec,
    price,
    live: !!live,
    windows,
    range24,
    fromHigh30,
    buckets: b.buckets,
    bucketNow,
    topDrops: b.topDrops,
    topRises: b.topRises,
    worst7: b.worst7,
    worst30: b.worst30,
    leverage: b.leverage,
    swing: b.swing,
    afterDays: AFTER_DAYS,
  };
}

const viewCache = new Map<string, { at: number; value?: MovesView; pending?: Promise<MovesView> }>();
const TTL_MS = 15_000;

/** Both coins, cached 15 seconds per coin and computed once at a time. */
export async function movesPage(): Promise<{ coins: MovesView[] }> {
  const now = Date.now();
  const coins = await Promise.all(
    MOVE_COINS.map((coin) => {
      const hit = viewCache.get(coin);
      if (hit?.value && now - hit.at < TTL_MS) return hit.value;
      if (hit?.pending) return hit.pending;
      const pending = movesView(coin, now)
        .then((value) => {
          viewCache.set(coin, { at: Date.now(), value });
          return value;
        })
        .catch((e) => {
          viewCache.delete(coin);
          throw e;
        });
      viewCache.set(coin, { at: now, value: hit?.value, pending });
      return pending;
    }),
  );
  return { coins };
}
