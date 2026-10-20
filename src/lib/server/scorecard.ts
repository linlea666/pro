import { analyzeWith } from "../analysis.ts";
import { COIN_IDS } from "../symbols.ts";
import { wilson } from "../ta/stats.ts";
import { TF_SECONDS, type Timeframe } from "../types.ts";
import { closedThrough, getKlines } from "../data/klines.ts";
import { getDb } from "./db.ts";
import { logger } from "./log.ts";
import { currentParams } from "./params-store.ts";
import { getState, setState } from "./settings.ts";

/**
 * The traffic light's own track record ("成绩单"). For bars on a fixed grid
 * spaced one stats horizon apart (so samples never overlap), we replay what the
 * light said at that close and record where price was `horizon` bars later.
 * Filled newest-first in small time-boxed batches; cleared whenever the engine
 * parameters change, because the old record would describe a different engine.
 */

export const SCORECARD_TFS: Timeframe[] = ["1h", "4h", "1d"];
const MIN_HISTORY = 300;

export interface LightRecord {
  light: "green" | "red";
  samples: number;
  /** % of calls where price moved the light's way by more than the cost */
  hitRate: number | null;
  hitLo: number | null;
  hitHi: number | null;
  /** same measure over every recorded point, whatever the light said */
  baseRate: number | null;
  /** mean move in the light's direction after cost, % */
  avgReturn: number | null;
}

export interface Scorecard {
  coin: string | null;
  tf: Timeframe;
  horizon: number;
  costPct: number;
  points: number;
  from: number | null;
  to: number | null;
  green: LightRecord;
  red: LightRecord;
  /** yellow can't be right or wrong; we only show how much price moved afterwards vs. on average */
  yellow: { samples: number; avgAbsMove: number | null; allAvgAbsMove: number | null };
}

function ensureVersion() {
  const v = String(currentParams().version);
  if (getState("scorecard.version") !== v) {
    getDb().prepare("DELETE FROM scorecard_points").run();
    setState("scorecard.version", v);
    logger.info("engine", "引擎参数已变化，信号灯成绩单重新累计", { version: v });
  }
}

/** Add missing points, newest first, until `budgetMs` is spent. */
export async function runScorecard(budgetMs = 20_000): Promise<{ added: number; durationMs: number }> {
  const t0 = Date.now();
  ensureVersion();
  const { engine } = currentParams();
  const db = getDb();
  const has = db.prepare("SELECT 1 FROM scorecard_points WHERE coin = ? AND tf = ? AND t = ?");
  const ins = db.prepare("INSERT OR REPLACE INTO scorecard_points (coin, tf, t, light, score, close_pct, atr_pct) VALUES (?, ?, ?, ?, ?, ?, ?)");
  let added = 0;
  // round-robin so every coin/timeframe gets recent points before anyone gets old ones
  const queues: { coin: string; tf: Timeframe; ts: number[]; at: Map<number, number>; closes: number[] }[] = [];
  for (const tf of SCORECARD_TFS) {
    const H = engine.horizon[tf];
    const sec = TF_SECONDS[tf];
    for (const coin of COIN_IDS) {
      try {
        const k = await getKlines(coin, tf);
        const until = closedThrough(k);
        const closed = k.candles.filter((x) => x.t + sec <= until);
        const ts: number[] = [];
        for (let i = closed.length - 1 - H; i >= MIN_HISTORY; i--) {
          const t = closed[i].t;
          if (Math.floor(t / sec) % H === 0 && !has.get(coin, tf, t)) ts.push(t);
        }
        queues.push({ coin, tf, ts, at: new Map(closed.map((x, i) => [x.t, i])), closes: closed.map((x) => x.c) });
      } catch (e) {
        logger.warn("engine", `成绩单读取 K 线失败 ${coin} ${tf}`, { error: (e as Error).message });
      }
    }
  }
  while (Date.now() - t0 < budgetMs && queues.some((q) => q.ts.length)) {
    for (const q of queues) {
      const t = q.ts.shift();
      if (t == null) continue;
      const H = engine.horizon[q.tf];
      try {
        const a = await analyzeWith(q.coin, q.tf, engine, t);
        const i = q.at.get(t)!;
        const closePct = ((q.closes[i + H] - q.closes[i]) / q.closes[i]) * 100;
        ins.run(q.coin, q.tf, t, a.verdict.light, a.verdict.score, closePct, a.verdict.atrPct);
        added++;
      } catch (e) {
        logger.debug("engine", `成绩单回放失败 ${q.coin} ${q.tf}`, { t, error: (e as Error).message });
      }
      await new Promise((r) => setImmediate(r));
      if (Date.now() - t0 >= budgetMs) break;
    }
  }
  return { added, durationMs: Date.now() - t0 };
}

function record(light: "green" | "red", rows: { light: string; close_pct: number }[], cost: number): LightRecord {
  const dir = light === "green" ? 1 : -1;
  const net = (r: { close_pct: number }) => r.close_pct * dir - cost;
  const mine = rows.filter((r) => r.light === light);
  const wins = mine.filter((r) => net(r) > 0).length;
  const [lo, hi] = wilson(wins, mine.length);
  return {
    light,
    samples: mine.length,
    hitRate: mine.length ? Math.round((wins / mine.length) * 100) : null,
    hitLo: mine.length ? Math.round(lo) : null,
    hitHi: mine.length ? Math.round(hi) : null,
    baseRate: rows.length ? Math.round((rows.filter((r) => net(r) > 0).length / rows.length) * 100) : null,
    avgReturn: mine.length ? Math.round((mine.reduce((s, r) => s + net(r), 0) / mine.length) * 100) / 100 : null,
  };
}

/** Aggregate record for one timeframe, for one coin or all coins together. */
export function getScorecard(coin: string | null, tf: Timeframe): Scorecard {
  // right after a parameter change, don't show the old engine's record under the new horizon/cost
  ensureVersion();
  const { engine } = currentParams();
  const rows = (
    coin
      ? getDb().prepare("SELECT t, light, close_pct FROM scorecard_points WHERE coin = ? AND tf = ? ORDER BY t").all(coin, tf)
      : getDb().prepare("SELECT t, light, close_pct FROM scorecard_points WHERE tf = ? ORDER BY t").all(tf)
  ) as { t: number; light: string; close_pct: number }[];
  const cost = engine.stats.costPct;
  const avgAbs = (list: typeof rows) => (list.length ? Math.round((list.reduce((s, r) => s + Math.abs(r.close_pct), 0) / list.length) * 100) / 100 : null);
  const yellow = rows.filter((r) => r.light === "yellow");
  return {
    coin,
    tf,
    horizon: engine.horizon[tf],
    costPct: cost,
    points: rows.length,
    from: rows[0]?.t ?? null,
    to: rows[rows.length - 1]?.t ?? null,
    green: record("green", rows, cost),
    red: record("red", rows, cost),
    yellow: { samples: yellow.length, avgAbsMove: avgAbs(yellow), allAvgAbsMove: avgAbs(rows) },
  };
}
