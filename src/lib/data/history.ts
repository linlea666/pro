import type { Timeframe } from "../types.ts";
import { TF_SECONDS } from "../types.ts";
import { COIN_IDS } from "../symbols.ts";
import { getDb } from "../server/db.ts";
import { raiseAlert } from "../server/alert.ts";
import { logger } from "../server/log.ts";
import { getState, setState } from "../server/settings.ts";
import { binancePage, KEEP_DAYS, PRIMARY_SOURCE, store } from "./klines.ts";

/**
 * Long local history. The live analysis only needs the newest ~2000 bars, but
 * statistics, the scorecard and research need years. In the background each
 * stored series is walked back to its retention target (KEEP_DAYS) page by page,
 * and holes inside it are fetched again. Only the primary source's series is kept
 * long; fallback sources only hold about the analysis window.
 */

/** most useful first: when the time budget runs out, 1h and 4h are already done */
export const HISTORY_TFS: Timeframe[] = ["1h", "4h", "1d", "1w", "15m", "5m"];
const PAGE = 1000;

/** Per-series bookkeeping: where the exchange's own history starts, and holes the exchange itself has. */
interface SeriesState {
  start: number | null;
  holes: [number, number][];
}

const stateKey = (coin: string, tf: Timeframe) => `klineHistory.${PRIMARY_SOURCE}.${coin}.${tf}`;

function readState(coin: string, tf: Timeframe): SeriesState {
  try {
    const v = JSON.parse(getState(stateKey(coin, tf)) || "{}");
    return { start: v.start ?? null, holes: Array.isArray(v.holes) ? v.holes : [] };
  } catch {
    return { start: null, holes: [] };
  }
}

const writeState = (coin: string, tf: Timeframe, s: SeriesState) => setState(stateKey(coin, tf), JSON.stringify(s));

/** Oldest bar time this timeframe should reach (0 = all history). */
export function targetStart(tf: Timeframe, nowSec = Date.now() / 1000): number {
  const days = KEEP_DAYS[tf];
  return days == null ? 0 : Math.floor(nowSec - days * 86400);
}

/** Missing stretches inside a stored series: each pair is the stored bars on either side. */
export function findGaps(coin: string, tf: Timeframe): [number, number][] {
  const rows = getDb()
    .prepare("SELECT prev, t FROM (SELECT t, LAG(t) OVER (ORDER BY t) prev FROM candles WHERE coin = ? AND tf = ? AND source = ?) WHERE t - prev > ?")
    .all(coin, tf, PRIMARY_SOURCE, TF_SECONDS[tf]) as { prev: number; t: number }[];
  return rows.map((r) => [r.prev, r.t]);
}

function span(coin: string, tf: Timeframe) {
  return getDb().prepare("SELECT MIN(t) first, MAX(t) last, COUNT(*) n FROM candles WHERE coin = ? AND tf = ? AND source = ?").get(coin, tf, PRIMARY_SOURCE) as {
    first: number | null;
    last: number | null;
    n: number;
  };
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
  /** every series reaches its target and has no unknown holes */
  complete: boolean;
  durationMs: number;
  error?: string;
}

/**
 * Extend each series backwards, then patch holes inside it, until `budgetMs` is spent.
 * Series not stored yet are skipped: the live loader creates them first.
 * Stops at the first failed request and carries on next run.
 */
export async function syncHistory(
  opts: { budgetMs?: number; pauseMs?: number; nowSec?: number; coins?: string[]; tfs?: Timeframe[] } = {},
): Promise<SyncResult> {
  const { budgetMs = 60_000, pauseMs = 200, nowSec = Date.now() / 1000, coins = COIN_IDS, tfs = HISTORY_TFS } = opts;
  const t0 = Date.now();
  const r: SyncResult = { requests: 0, added: 0, filled: 0, complete: true, durationMs: 0 };
  const left = () => Date.now() - t0 < budgetMs;
  // be gentle with the exchange and keep the event loop free for visitors
  const page = async (coin: string, tf: Timeframe, q: Parameters<typeof binancePage>[3]) => {
    if (r.requests++ && pauseMs) await new Promise((ok) => setTimeout(ok, pauseMs));
    return binancePage(PRIMARY_SOURCE, coin, tf, q);
  };

  try {
    for (const tf of tfs) {
      const sec = TF_SECONDS[tf];
      const target = targetStart(tf, nowSec);
      for (const coin of coins) {
        const st = readState(coin, tf);
        const s0 = span(coin, tf);
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
          store(coin, tf, PRIMARY_SOURCE, kept);
          r.added += kept.length;
          first = bars[0].t;
        }

        // 2. holes inside the stored range (an outage, or bars deleted by hand)
        const known = (a: number, b: number) => st.holes.some(([x, y]) => x <= a && b <= y);
        const gaps = findGaps(coin, tf).filter(([a, b]) => !known(a, b));
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
            store(coin, tf, PRIMARY_SOURCE, bars);
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

        // holes that fell out of the retention window no longer matter
        st.holes = st.holes.filter(([, b]) => b >= target);
        writeState(coin, tf, st);
        if (!reached(first, tf, st, nowSec)) r.complete = false;
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
  complete: boolean;
}

/** Coverage of every coin and timeframe, for the CLI and the health report. */
export function historyCoverage(nowSec = Date.now() / 1000, coins = COIN_IDS, tfs = HISTORY_TFS): SeriesCoverage[] {
  const out: SeriesCoverage[] = [];
  for (const tf of tfs) {
    for (const coin of coins) {
      const st = readState(coin, tf);
      const s = span(coin, tf);
      const known = (a: number, b: number) => st.holes.some(([x, y]) => x <= a && b <= y);
      const gaps = s.n ? findGaps(coin, tf).filter(([a, b]) => !known(a, b)).length : 0;
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
        complete: s.n > 0 && gaps === 0 && reached(s.first!, tf, st, nowSec),
      });
    }
  }
  return out;
}
