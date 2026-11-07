import { loadHistory } from "./research/run.ts";
import { logger } from "./server/log.ts";
import { quietStats } from "./ta/impulse.ts";
import { squeezeAt, type Squeeze } from "./ta/squeeze.ts";
import type { Candle } from "./types.ts";

const cache = new Map<string, ReturnType<typeof quietStats>>();

/**
 * 每个 UTC 日“之前 7 天”的波动和它在一年里的分位（读本地存的 1 小时历史，要一年多），每币每小时算一次。
 * 盯盘（放量冲击、波动压缩）和计划页的行情导视共用。
 */
export function quietOf(coin: string, end: number): ReturnType<typeof quietStats> {
  const key = `${coin}:${Math.floor(end / 3600)}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const m = quietStats(loadHistory(coin, "1h", end));
  for (const k of cache.keys()) if (k.startsWith(`${coin}:`)) cache.delete(k);
  if (cache.size > 50) cache.clear();
  cache.set(key, m);
  return m;
}

/** 波动压缩（E46）：`hourly` 是已收盘的 1 小时 K 线，按最后一根所在的 UTC 日算；盯盘和行情导视共用 */
export function squeezeOf(coin: string, hourly: Candle[] | undefined, end: number): Squeeze | null {
  const last = hourly?.at(-1);
  if (!last) return null;
  try {
    return squeezeAt(coin, quietOf(coin, end), last.t);
  } catch (e) {
    logger.warn("engine", `波动压缩计算失败 ${coin}`, { error: (e as Error).message });
    return null;
  }
}
