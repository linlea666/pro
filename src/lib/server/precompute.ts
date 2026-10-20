import { multiTimeframe } from "../analysis.ts";
import { COIN_IDS } from "../symbols.ts";
import { logger } from "./log.ts";
import { getSetting } from "./settings.ts";
import { raiseAlert } from "./alert.ts";

/**
 * Keeps every coin × timeframe analysis warm so visitors never wait for a
 * cold computation. Each pass only recomputes what has expired (analyses are
 * cached per timeframe), so most passes are cheap.
 */

export interface PrecomputeStats {
  lastRunAt: number | null;
  lastDurationMs: number | null;
  runs: number;
  failures: number;
  lastError: string | null;
}

const g = globalThis as unknown as { __slPre?: { stats: PrecomputeStats; timer?: NodeJS.Timeout; running: boolean } };
const state = (g.__slPre ??= { stats: { lastRunAt: null, lastDurationMs: null, runs: 0, failures: 0, lastError: null }, running: false });
/** passes in a row in which every coin failed */
let failedPasses = 0;

export const precomputeStats = () => state.stats;

async function pass() {
  if (state.running || !getSetting("precompute.enabled")) return;
  state.running = true;
  const t0 = Date.now();
  let failed = 0;
  try {
    for (const coin of COIN_IDS) {
      try {
        await multiTimeframe(coin);
      } catch (e) {
        failed++;
        state.stats.failures++;
        state.stats.lastError = `${coin}: ${(e as Error).message}`.slice(0, 300);
      }
      // let queued requests run between coins
      await new Promise((r) => setImmediate(r));
    }
    failedPasses = failed === COIN_IDS.length ? failedPasses + 1 : 0;
    if (failedPasses === 3) raiseAlert("job", "预计算连续 3 轮全部失败", { 最近错误: state.stats.lastError ?? "" });
    state.stats.runs++;
    state.stats.lastRunAt = Date.now();
    state.stats.lastDurationMs = Date.now() - t0;
    if (state.stats.lastDurationMs > 45_000) logger.warn("engine", "预计算一轮耗时过长", { durationMs: state.stats.lastDurationMs });
  } finally {
    state.running = false;
  }
}

export function startPrecompute() {
  if (state.timer) return;
  setTimeout(pass, 5_000);
  state.timer = setInterval(pass, 60_000);
  state.timer.unref?.();
}
