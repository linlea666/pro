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
  excursions,
  leverageTable,
  pctRank,
  priceLadder,
  realizedVol,
  rebounds,
  sortedAbs,
  streaks,
  swingAfter,
  topMoves,
  typical,
  worstSpan,
  type BucketRow,
  type Excursion,
  type Freq,
  type LadderRow,
  type LevRow,
  type Move,
  type MoveBand,
  type ReboundRow,
  type Streak,
  type Typical,
} from "./ta/moves.ts";
import type { Candle } from "./types.ts";
import { periodName, periodStart, type Period } from "./ta/moves.ts";

export { PERIODS, periodName, type Period } from "./ta/moves.ts";

/**
 * The 涨跌统计 page: for BTC and ETH, the move now over 1 hour, 4 hours, 24 hours and 7 days, ranked against the
 * coin's stored history over a chosen period, plus the price ladder, the frequency table, the extremes, what came
 * after big days, the leverage table, volatility and streaks. The history part is rebuilt once an hour per coin
 * and period; the live part (latest price) at most every 15 seconds.
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
  /** share of the period with a smaller move in size, %; and of all stored history */
  rank: number | null;
  rankAll: number | null;
  band: MoveBand | null;
  /** how often a move at least this big, the same way, happened in the period */
  freq: Freq | null;
  typical: Typical;
  /** what bars the distribution is measured on */
  basis: string;
}

export interface ExtremeRow extends Move {
  /** change over the next 1 / 3 / 7 days, % */
  after: (number | null)[];
}

export interface Ladder {
  /** the price 24 hours ago the steps are measured from */
  ref: number;
  /** how far the market has gone from it so far in the last 24 hours (positive), %: down to the low, up to the high */
  sofarDn: number;
  sofarUp: number;
  down: LadderRow[];
  up: LadderRow[];
  /** how many days went at least as far as now, which the conditional shares are taken over */
  givenDn: number;
  givenUp: number;
}

export interface MovesView {
  coin: string;
  period: Period;
  periodName: string;
  /** first day of the period actually in the data */
  periodFrom: number | null;
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
  ladder: Ladder | null;
  /** daily (UTC) frequency table */
  buckets: { days: number; from: number | null; rows: BucketRow[] };
  /** the bucket the 24-hour move now falls in: index into rows, and its side */
  bucketNow: { index: number; side: "down" | "up" } | null;
  topDrops: ExtremeRow[];
  topRises: ExtremeRow[];
  /** the biggest daily drop in all stored history, for the warning when a calmer period is shown */
  allWorstDay: Move | null;
  worst7: { pct: number; from: number; to: number } | null;
  worst30: { pct: number; from: number; to: number } | null;
  /** after daily drops (rises) of at least 3 / 5 / 8 / 10%, and every day as the last row */
  afterDrops: ReboundRow[];
  afterRises: ReboundRow[];
  leverage: LevRow[];
  /** after the biggest 5% of daily drops / rises: the next 3 days' average size against the usual */
  swing: { down: { ratio: number; n: number } | null; up: { ratio: number; n: number } | null };
  /** 30-day realised volatility (annualised, %): now, its rank in the period, and a thinned series for the chart */
  vol: { now: number | null; rank: number | null; p50: number | null; series: Move[] };
  streak: { current: Streak | null; longestDown: Streak | null; longestUp: Streak | null };
  afterDays: number[];
}

interface Base {
  h1: Candle[];
  d1: Candle[];
  from: number | null;
  dist: Record<WindowKey, { moves: Move[]; step: number; basis: string; sorted: number[]; sortedAll: number[]; typical: Typical }>;
  ex: Excursion[];
  ranges: number[];
  rangeP50: number | null;
  buckets: MovesView["buckets"];
  topDrops: ExtremeRow[];
  topRises: ExtremeRow[];
  allWorstDay: Move | null;
  worst7: MovesView["worst7"];
  worst30: MovesView["worst30"];
  afterDrops: ReboundRow[];
  afterRises: ReboundRow[];
  leverage: LevRow[];
  swing: MovesView["swing"];
  vol: MovesView["vol"];
  streak: MovesView["streak"];
}

const baseCache = new Map<string, Base>();

function buildBase(coin: string, period: Period, nowSec: number): Base {
  const since = periodStart(coin, period, nowSec);
  const all = { h1: loadHistory(coin, "1h", nowSec), h4: loadHistory(coin, "4h", nowSec), d1: loadHistory(coin, "1d", nowSec) };
  const cut = (c: Candle[]) => c.filter((x) => x.t >= since);
  const h1 = cut(all.h1), h4 = cut(all.h4), d1 = cut(all.d1);
  const mk = (moves: Move[], allMoves: Move[], step: number, basis: string) => ({ moves, step, basis, sorted: sortedAbs(moves), sortedAll: sortedAbs(allMoves), typical: typical(moves) });
  const daily = changes(d1, 1, DAY);
  const dist = {
    "1h": mk(changes(h1, 1, 3600), changes(all.h1, 1, 3600), 3600, "1 小时 K 线"),
    "4h": mk(changes(h4, 1, 4 * 3600), changes(all.h4, 1, 4 * 3600), 4 * 3600, "4 小时 K 线"),
    "24h": mk(daily, changes(all.d1, 1, DAY), DAY, "日线（UTC 0 点，北京时间 8 点收盘）"),
    "7d": mk(changes(d1, 7, DAY), changes(all.d1, 7, DAY), DAY, "日线，每天往回看 7 天"),
  };
  const ext = (m: Move[]): ExtremeRow[] => m.map((x) => ({ t: x.t, pct: x.pct, after: after(all.d1, x.t, AFTER_DAYS) }));
  const ranges = sortedAbs(dailyRanges(d1));
  // volatility: the chart covers at least the last year, thinned to about 400 points
  const volAll = realizedVol(all.d1);
  const volIn = volAll.filter((x) => x.t >= since);
  const volChart = volAll.filter((x) => x.t >= Math.min(since, nowSec - YEAR));
  const stepV = Math.max(1, Math.ceil(volChart.length / 400));
  const volSorted = volIn.map((x) => x.pct).sort((a, b) => a - b);
  const volNow = volAll.length ? volAll[volAll.length - 1].pct : null;
  const st = streaks(d1);
  return {
    h1,
    d1,
    from: d1.length ? d1[0].t : null,
    dist,
    ex: excursions(d1),
    ranges,
    rangeP50: ranges.length ? ranges[Math.floor(ranges.length / 2)] : null,
    buckets: { days: daily.length, from: daily.length ? daily[0].t : null, rows: bucketTable(daily, DAY) },
    topDrops: ext(topMoves(daily, 10, -1, 3 * DAY)),
    topRises: ext(topMoves(daily, 10, 1, 3 * DAY)),
    allWorstDay: topMoves(changes(all.d1, 1, DAY), 1, -1, DAY)[0] ?? null,
    worst7: worstSpan(d1, 7),
    worst30: worstSpan(d1, 30),
    afterDrops: rebounds(d1, -1),
    afterRises: rebounds(d1, 1),
    leverage: leverageTable(d1),
    swing: { down: swingAfter(daily, -1), up: swingAfter(daily, 1) },
    vol: {
      now: volNow == null ? null : r2(volNow),
      rank: volNow == null ? null : pctRank(volSorted, volNow),
      p50: volSorted.length ? r2(volSorted[Math.floor(volSorted.length / 2)]) : null,
      series: volChart.filter((_, i) => i % stepV === 0 || i === volChart.length - 1).map((x) => ({ t: x.t, pct: r2(x.pct) })),
    },
    // the run going on now counts from all history (a period start must not cut it)
    streak: { current: streaks(all.d1).current, longestDown: st.longestDown, longestUp: st.longestUp },
  };
}

function baseOf(coin: string, period: Period, nowSec: number): Base {
  const key = `${coin}:${period}:${Math.floor(nowSec / 3600)}`;
  let b = baseCache.get(key);
  if (!b) {
    b = buildBase(coin, period, nowSec);
    for (const k of baseCache.keys()) if (k.startsWith(`${coin}:${period}:`)) baseCache.delete(k);
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

export async function movesView(coin: string, period: Period = "main", nowMs = Date.now()): Promise<MovesView> {
  const nowSec = Math.floor(nowMs / 1000);
  const b = baseOf(coin, period, nowSec);
  const live = await liveBars(coin);
  // live: the latest traded price and rolling windows from 5-minute bars (7 days from hourly bars);
  // otherwise the last stored hourly close and windows from stored hours
  const stored = loadHistory(coin, "1h", nowSec).slice(-200);
  const h1 = live?.h1.length ? live.h1 : stored;
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
    const rank = pct == null ? null : pctRank(d.sorted, Math.abs(pct));
    return {
      key,
      pct: pct == null ? null : r2(pct),
      rank,
      rankAll: pct == null ? null : pctRank(d.sortedAll, Math.abs(pct)),
      band: bandOf(rank),
      freq: pct == null || pct === 0 ? null : atLeast(d.moves, pct, d.step),
      typical: d.typical,
      basis: d.basis,
    };
  });

  const ref24 = refOf(24);
  const recent = live ? live.m5.filter((x) => x.t + 300 > at - DAY) : h1.filter((x) => x.t + 3600 > at - DAY);
  let range24: MovesView["range24"] = null;
  let ladder: Ladder | null = null;
  if (ref24 && recent.length) {
    const hi = Math.max(...recent.map((x) => x.h)), lo = Math.min(...recent.map((x) => x.l));
    const pct = ((hi - lo) / ref24) * 100;
    const rank = pctRank(b.ranges, pct);
    range24 = { pct: r2(pct), rank, band: bandOf(rank), p50: b.rangeP50 == null ? null : r2(b.rangeP50) };
    const sofarDn = Math.max(0, (1 - lo / ref24) * 100), sofarUp = Math.max(0, (hi / ref24 - 1) * 100);
    const dn = priceLadder(b.ex, ref24, sofarDn, -1), up = priceLadder(b.ex, ref24, sofarUp, 1);
    ladder = { ref: ref24, sofarDn: r2(sofarDn), sofarUp: r2(sofarUp), down: dn.rows, up: up.rows, givenDn: dn.givenN, givenUp: up.givenN };
  }

  let fromHigh30: MovesView["fromHigh30"] = null;
  const lastDay = b.d1.length ? b.d1[b.d1.length - 1].t : 0;
  const month = [...b.d1.filter((x) => x.t > at - 30 * DAY), ...h1.filter((x) => x.t >= lastDay + DAY)];
  if (price != null && month.length) {
    const top = month.reduce((m, x) => (x.h > m.h ? x : m));
    const high = Math.max(top.h, price);
    fromHigh30 = { pct: r2((price / high - 1) * 100), high, t: top.h >= price ? top.t : at };
  }

  const w24 = windows.find((w) => w.key === "24h")!;
  let bucketNow: MovesView["bucketNow"] = null;
  if (w24.pct != null && w24.pct !== 0) {
    const size = Math.abs(w24.pct);
    const index = b.buckets.rows.findIndex((r) => size >= r.lo && (r.hi == null || size < r.hi));
    if (index >= 0) bucketNow = { index, side: w24.pct < 0 ? "down" : "up" };
  }

  return {
    coin,
    period,
    periodName: periodName(coin, period),
    periodFrom: b.from,
    source: live?.source ?? PRIMARY_SOURCE,
    updatedAt: nowSec,
    price,
    live: !!live,
    windows,
    range24,
    fromHigh30,
    ladder,
    buckets: b.buckets,
    bucketNow,
    topDrops: b.topDrops,
    topRises: b.topRises,
    allWorstDay: b.allWorstDay,
    worst7: b.worst7,
    worst30: b.worst30,
    afterDrops: b.afterDrops,
    afterRises: b.afterRises,
    leverage: b.leverage,
    swing: b.swing,
    vol: b.vol,
    streak: b.streak,
    afterDays: AFTER_DAYS,
  };
}

const viewCache = new Map<string, { at: number; value?: MovesView; pending?: Promise<MovesView> }>();
const TTL_MS = 15_000;

/** Both coins for one period, cached 15 seconds per coin and period and computed once at a time. */
export async function movesPage(period: Period = "main"): Promise<{ coins: MovesView[] }> {
  const now = Date.now();
  const coins = await Promise.all(
    MOVE_COINS.map((coin) => {
      const key = `${coin}:${period}`;
      const hit = viewCache.get(key);
      if (hit?.value && now - hit.at < TTL_MS) return hit.value;
      if (hit?.pending) return hit.pending;
      const pending = movesView(coin, period, now)
        .then((value) => {
          viewCache.set(key, { at: Date.now(), value });
          return value;
        })
        .catch((e) => {
          viewCache.delete(key);
          throw e;
        });
      viewCache.set(key, { at: now, value: hit?.value, pending });
      return pending;
    }),
  );
  return { coins };
}
