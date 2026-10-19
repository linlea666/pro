import { snapshot, type CoinSnapshot } from "./analysis.ts";
import { COIN_IDS } from "./symbols.ts";
import { logger } from "./server/log.ts";

export interface Overview {
  coins: CoinSnapshot[];
  failed: string[];
  updatedAt: number;
}

/** All tracked coins; one failing coin never blanks the whole page. */
export async function getOverview(): Promise<Overview> {
  const settled = await Promise.allSettled(COIN_IDS.map((id) => snapshot(id)));
  const coins: CoinSnapshot[] = [];
  const failed: string[] = [];
  settled.forEach((r, k) => {
    if (r.status === "fulfilled") coins.push(r.value);
    else {
      failed.push(COIN_IDS[k]);
      logger.error("engine", `总览中 ${COIN_IDS[k]} 计算失败`, { error: r.reason });
    }
  });
  if (coins.length === 0) throw new Error("all coins failed");
  return { coins, failed, updatedAt: Date.now() };
}
