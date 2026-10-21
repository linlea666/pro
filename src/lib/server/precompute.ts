import { multiTimeframe } from "../analysis.ts";
import { coinIds } from "./coins.ts";
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
  /** coin being computed right now, and since when (null between passes) */
  current: string | null;
  currentSince: number | null;
  /** coins given up on because they ran past COIN_TIMEOUT_MS */
  timeouts: number;
}

/** one coin (all its timeframes) normally takes a few seconds; past this it is given up on so the pass can't hang */
export const COIN_TIMEOUT_MS = 2 * 60_000;

/** `p`, or a rejection after `ms` (the work itself keeps running; the caller just stops waiting). */
export function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(message), { timeout: true })), ms);
  });
  return Promise.race([p, limit]).finally(() => clearTimeout(timer));
}

const g = globalThis as unknown as { __slPre?: { stats: PrecomputeStats; timer?: NodeJS.Timeout; running: boolean } };
const state = (g.__slPre ??= { stats: { lastRunAt: null, lastDurationMs: null, runs: 0, failures: 0, lastError: null, current: null, currentSince: null, timeouts: 0 }, running: false });
/** passes in a row in which every coin failed */
let failedPasses = 0;

export const precomputeStats = () => state.stats;

async function pass() {
  if (state.running || !getSetting("precompute.enabled")) return;
  state.running = true;
  const t0 = Date.now();
  let failed = 0;
  try {
    const ids = coinIds();
    for (const coin of ids) {
      state.stats.current = coin;
      state.stats.currentSince = Date.now();
      try {
        await withTimeout(multiTimeframe(coin), COIN_TIMEOUT_MS, `超过 ${COIN_TIMEOUT_MS / 60_000} 分钟没有完成`);
      } catch (e) {
        failed++;
        state.stats.failures++;
        state.stats.lastError = `${coin}: ${(e as Error).message}`.slice(0, 300);
        if ((e as { timeout?: boolean }).timeout) {
          state.stats.timeouts++;
          logger.error("engine", `预计算卡住，跳过 ${coin}`, { coin, waitedMs: COIN_TIMEOUT_MS, pass: state.stats.runs + 1 });
          raiseAlert("job", "预计算卡住", { 币种: coin, 已等: `${COIN_TIMEOUT_MS / 60_000} 分钟`, 说明: "已跳过这个币，下一轮会重新计算" });
        }
      }
      // let queued requests run between coins
      await new Promise((r) => setImmediate(r));
    }
    failedPasses = failed === ids.length ? failedPasses + 1 : 0;
    if (failedPasses === 3) raiseAlert("job", "预计算连续 3 轮全部失败", { 最近错误: state.stats.lastError ?? "" });
    state.stats.runs++;
    state.stats.lastRunAt = Date.now();
    state.stats.lastDurationMs = Date.now() - t0;
    if (state.stats.lastDurationMs > 45_000) logger.warn("engine", "预计算一轮耗时过长", { durationMs: state.stats.lastDurationMs });
  } finally {
    state.running = false;
    state.stats.current = null;
    state.stats.currentSince = null;
  }
}

export function startPrecompute() {
  if (state.timer) return;
  setTimeout(pass, 5_000);
  state.timer = setInterval(pass, 60_000);
  state.timer.unref?.();
}
