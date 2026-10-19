import { snapshot, type CoinSnapshot } from "./analysis.ts";
import { COIN_IDS } from "./symbols.ts";

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
      console.error("[overview]", COIN_IDS[k], r.reason);
    }
  });
  if (coins.length === 0) throw new Error("all coins failed");
  return { coins, failed, updatedAt: Date.now() };
}
