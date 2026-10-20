import type { Timeframe } from "../types.ts";
import { TF_SECONDS } from "../types.ts";
import { COIN_IDS } from "../symbols.ts";
import { getDb } from "../server/db.ts";
import { raiseAlert } from "../server/alert.ts";
import { logger } from "../server/log.ts";
import { getState, setState } from "../server/settings.ts";
import { binancePage, KEEP_DAYS, MARK_SOURCE, PRIMARY_SOURCE, store } from "./klines.ts";

/**
 * Long local history. The live analysis only needs the newest ~2000 bars, but
 * statistics, the scorecard and research need years. In the background each
 * stored series is walked back to its retention target (KEEP_DAYS) page by page,
 * and holes inside it are fetched again. Only the primary source's series is kept
 * long; fallback sources only hold about the analysis window.
 *
 * Two additions: bars stored before taker buy volume was kept are fetched once more
 * to fill it in (the `tbv` cursor), and a few mark-price series used by research are
 * kept the same way (`source: MARK_SOURCE`, seeded and extended forward here, since no
 * page loads them).
 */

type LongSource = typeof PRIMARY_SOURCE | typeof MARK_SOURCE;
/** mark-price series kept for research: stop hits on the mark price, BTC and ETH */
export const MARK_SERIES: { coins: string[]; tfs: Timeframe[] } = { coins: ["BTC", "ETH"], tfs: ["1h", "4h"] };

/** most useful first: when the time budget runs out, 1h and 4h are already done */
export const HISTORY_TFS: Timeframe[] = ["1h", "4h", "1d", "1w", "15m", "5m"];
const PAGE = 1000;

/** Per-series bookkeeping: where the exchange's own history starts, and holes the exchange itself has. */
interface SeriesState {
  start: number | null;
  holes: [number, number][];
  /** taker volume was asked for every stored bar before this time (null: not started) */
  tbvFrom: number | null;
}

const stateKey = (coin: string, tf: Timeframe, source: LongSource) => `klineHistory.${source}.${coin}.${tf}`;

function readState(coin: string, tf: Timeframe, source: LongSource = PRIMARY_SOURCE): SeriesState {
  try {
    const v = JSON.parse(getState(stateKey(coin, tf, source)) || "{}");
    return { start: v.start ?? null, holes: Array.isArray(v.holes) ? v.holes : [], tbvFrom: v.tbvFrom ?? null };
  } catch {
    return { start: null, holes: [], tbvFrom: null };
  }
}

const writeState = (coin: string, tf: Timeframe, s: SeriesState, source: LongSource = PRIMARY_SOURCE) => setState(stateKey(coin, tf, source), JSON.stringify(s));

/** Oldest bar time this timeframe should reach (0 = all history). */
export function targetStart(tf: Timeframe, nowSec = Date.now() / 1000): number {
  const days = KEEP_DAYS[tf];
  return days == null ? 0 : Math.floor(nowSec - days * 86400);
}

/** Missing stretches inside a stored series: each pair is the stored bars on either side. */
export function findGaps(coin: string, tf: Timeframe, source: LongSource = PRIMARY_SOURCE): [number, number][] {
  const rows = getDb()
    .prepare("SELECT prev, t FROM (SELECT t, LAG(t) OVER (ORDER BY t) prev FROM candles WHERE coin = ? AND tf = ? AND source = ?) WHERE t - prev > ?")
    .all(coin, tf, source, TF_SECONDS[tf]) as { prev: number; t: number }[];
  return rows.map((r) => [r.prev, r.t]);
}

function span(coin: string, tf: Timeframe, source: LongSource = PRIMARY_SOURCE) {
  return getDb().prepare("SELECT MIN(t) first, MAX(t) last, COUNT(*) n FROM candles WHERE coin = ? AND tf = ? AND source = ?").get(coin, tf, source) as {
    first: number | null;
    last: number | null;
    n: number;
  };
}

/** Oldest stored primary bar at or after `from` still without taker volume (null: none). */
function firstWithoutTbv(coin: string, tf: Timeframe, from: number): number | null {
  const r = getDb().prepare("SELECT MIN(t) t FROM candles WHERE coin = ? AND tf = ? AND source = ? AND tbv IS NULL AND t >= ?").get(coin, tf, PRIMARY_SOURCE, from) as { t: number | null };
  return r.t;
}

/** Whether a series reaches its target: no bar wanted before its first one, or as far back as the exchange goes. */
function reached(first: number, tf: Timeframe, st: SeriesState, nowSec: number) {
  return first - TF_SECONDS[tf] < targetStart(tf, nowSec) || (st.start != null && first <= st.start);
}

export interface SyncResult {
  requests: number;
  /** bars added before the oldest stored one */
  added: number;
  /** bars fetched into holes */
  filled: number;
  /** bars fetched again for their taker volume */
  tbv: number;
  /** every series reaches its target and has no unknown holes */
  complete: boolean;
  durationMs: number;
  error?: string;
}

/**
 * Extend each series backwards, then patch holes inside it, then fill in taker volume,
 * until `budgetMs` is spent. Primary series not stored yet are skipped: the live loader
 * creates them first. Mark-price series are created and kept up to date here.
 * Stops at the first failed request and carries on next run.
 */
export async function syncHistory(
  opts: { budgetMs?: number; pauseMs?: number; nowSec?: number; coins?: string[]; tfs?: Timeframe[]; source?: LongSource } = {},
): Promise<SyncResult> {
  const { budgetMs = 60_000, pauseMs = 200, nowSec = Date.now() / 1000, source = PRIMARY_SOURCE } = opts;
  const mark = source === MARK_SOURCE;
  const { coins = mark ? MARK_SERIES.coins : COIN_IDS, tfs = mark ? MARK_SERIES.tfs : HISTORY_TFS } = opts;
  const t0 = Date.now();
  const r: SyncResult = { requests: 0, added: 0, filled: 0, tbv: 0, complete: true, durationMs: 0 };
  const left = () => Date.now() - t0 < budgetMs;
  // be gentle with the exchange and keep the event loop free for visitors
  const page = async (coin: string, tf: Timeframe, q: Parameters<typeof binancePage>[3]) => {
    if (r.requests++ && pauseMs) await new Promise((ok) => setTimeout(ok, pauseMs));
    return binancePage(source, coin, tf, q);
  };

  try {
    for (const tf of tfs) {
      const sec = TF_SECONDS[tf];
      const target = targetStart(tf, nowSec);
      for (const coin of coins) {
        const st = readState(coin, tf, source);
        let s0 = span(coin, tf, source);
        if (mark && left()) {
          // no page loads mark prices: start the series here and keep its newest bars current
          let next = s0.n ? s0.last! + sec : null;
          if (next == null) {
            const bars = await page(coin, tf, { limit: PAGE });
            store(coin, tf, source, bars);
            r.added += bars.length;
          } else {
            while (next <= nowSec - sec && left()) {
              const bars = await page(coin, tf, { startTime: next, limit: PAGE });
              if (!bars.length) break;
              store(coin, tf, source, bars);
              r.added += bars.length;
              if (bars.length < PAGE) break;
              next = bars[bars.length - 1].t + sec;
            }
          }
          s0 = span(coin, tf, source);
        }
        if (!s0.n) {
          r.complete = false;
          continue;
        }

        // 1. older history, newest page first
        let first = s0.first!;
        while (!reached(first, tf, st, nowSec)) {
          if (!left()) {
            r.complete = false;
            break;
          }
          const bars = (await page(coin, tf, { endTime: first - 1, limit: PAGE })).filter((x) => x.t < first);
          // a short page means the exchange has nothing older
          if (bars.length < PAGE) st.start = bars.length ? bars[0].t : first;
          if (!bars.length) break;
          const kept = bars.filter((x) => x.t >= target);
          store(coin, tf, source, kept);
          r.added += kept.length;
          first = bars[0].t;
        }

        // 2. holes inside the stored range (an outage, or bars deleted by hand)
        const known = (a: number, b: number) => st.holes.some(([x, y]) => x <= a && b <= y);
        const gaps = findGaps(coin, tf, source).filter(([a, b]) => !known(a, b));
        let newHoles = 0;
        let filled = 0;
        for (const [a, b] of gaps) {
          if (!left()) {
            r.complete = false;
            break;
          }
          const missing = (b - a) / sec - 1;
          let got = 0;
          for (let from = a + sec; from < b; ) {
            const bars = (await page(coin, tf, { startTime: from, endTime: b - sec, limit: PAGE })).filter((x) => x.t > a && x.t < b);
            if (!bars.length) break;
            store(coin, tf, source, bars);
            got += bars.length;
            if (bars.length < PAGE) break;
            from = bars[bars.length - 1].t + sec;
          }
          filled += got;
          // whatever is still missing is missing on the exchange too: remember it, don't ask again
          if (got < missing) {
            st.holes.push([a, b]);
            newHoles++;
          }
        }
        r.filled += filled;
        if (gaps.length) {
          const msg = filled ? `本地 K 线有缺口，已补拉 ${filled} 根：${coin} ${tf}` : `交易所本身缺少这段 K 线，已记录：${coin} ${tf}`;
          if (filled) raiseAlert("gap", "本地 K 线出现缺口，已自动补拉", { 币种: coin, 周期: tf, 缺口: gaps.length, 补回根数: filled });
          logger[filled ? "warn" : "info"]("datasource", msg, {
            gaps: gaps.length,
            filled,
            exchangeHoles: newHoles,
            first: new Date(gaps[0][0] * 1000).toISOString(),
          });
        }

        // 3. taker volume for bars stored before it was kept: each bar is asked for once,
        // oldest first; a bar the exchange returns without it stays without it
        let tbvDone = mark;
        if (!mark) {
          let from = st.tbvFrom ?? 0;
          for (;;) {
            const missing = firstWithoutTbv(coin, tf, from);
            if (missing == null) {
              tbvDone = true;
              break;
            }
            if (!left()) break;
            const bars = (await page(coin, tf, { startTime: missing, limit: PAGE })).filter((x) => x.t >= missing);
            store(coin, tf, source, bars);
            r.tbv += bars.length;
            from = bars.length ? bars[bars.length - 1].t + sec : missing + PAGE * sec;
            st.tbvFrom = from;
          }
        }

        // holes that fell out of the retention window no longer matter
        st.holes = st.holes.filter(([, b]) => b >= target);
        writeState(coin, tf, st, source);
        if (!reached(first, tf, st, nowSec) || !tbvDone) r.complete = false;
      }
    }
  } catch (e) {
    r.complete = false;
    r.error = (e as Error).message;
  }
  r.durationMs = Date.now() - t0;
  return r;
}

export interface SeriesCoverage {
  coin: string;
  tf: Timeframe;
  bars: number;
  first: number | null;
  last: number | null;
  /** oldest bar wanted (0 = everything) */
  target: number;
  /** first bar the exchange has, once the walk back reached it */
  exchangeStart: number | null;
  /** stretches the exchange itself has no bars for */
  exchangeHoles: number;
  /** holes not looked into yet */
  gaps: number;
  /** stored bars still to be asked for their taker volume (primary source) */
  tbvPending: number;
  complete: boolean;
}

/** Coverage of every coin and timeframe, for the CLI and the health report. */
export function historyCoverage(nowSec = Date.now() / 1000, coins = COIN_IDS, tfs = HISTORY_TFS, source: LongSource = PRIMARY_SOURCE): SeriesCoverage[] {
  const out: SeriesCoverage[] = [];
  for (const tf of tfs) {
    for (const coin of coins) {
      const st = readState(coin, tf, source);
      const s = span(coin, tf, source);
      const known = (a: number, b: number) => st.holes.some(([x, y]) => x <= a && b <= y);
      const gaps = s.n ? findGaps(coin, tf, source).filter(([a, b]) => !known(a, b)).length : 0;
      const tbvPending =
        source === PRIMARY_SOURCE
          ? (getDb().prepare("SELECT COUNT(*) n FROM candles WHERE coin = ? AND tf = ? AND source = ? AND tbv IS NULL AND t >= ?").get(coin, tf, source, st.tbvFrom ?? 0) as { n: number }).n
          : 0;
      out.push({
        coin,
        tf,
        bars: s.n,
        first: s.first,
        last: s.last,
        target: targetStart(tf, nowSec),
        exchangeStart: st.start,
        exchangeHoles: st.holes.length,
        gaps,
        tbvPending,
        complete: s.n > 0 && gaps === 0 && tbvPending === 0 && reached(s.first!, tf, st, nowSec),
      });
    }
  }
  return out;
}
