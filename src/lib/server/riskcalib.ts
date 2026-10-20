import { closedThrough, getKlines } from "../data/klines.ts";
import { COIN_IDS } from "../symbols.ts";
import { calibrate, type Calibration } from "../ta/risk.ts";
import { TF_SECONDS, type Timeframe } from "../types.ts";
import { getDb } from "./db.ts";
import { logger } from "./log.ts";
import { currentParams } from "./params-store.ts";

/**
 * Stop-loss calibration (sweep depth + noise curve) per coin and timeframe,
 * recomputed weekly from the stored candle history.
 */

export const CALIBRATED_TFS: Timeframe[] = ["15m", "1h", "4h", "1d", "1w"];

const memo = new Map<string, { at: number; value: Calibration | null }>();
const MEMO_MS = 10 * 60 * 1000;

export function getCalibration(coin: string, tf: Timeframe): Calibration | null {
  const key = `${coin}:${tf}`;
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < MEMO_MS) return hit.value;
  let value: Calibration | null = null;
  try {
    const r = getDb().prepare("SELECT probe, noise, horizon, samples FROM risk_calib WHERE coin = ? AND tf = ?").get(coin, tf) as
      | { probe: string; noise: string; horizon: number; samples: number }
      | undefined;
    if (r) value = { probe: JSON.parse(r.probe), noise: JSON.parse(r.noise), horizon: r.horizon, samples: r.samples };
  } catch {
    // no database (unit tests, CLI): fall back to defaults
  }
  memo.set(key, { at: Date.now(), value });
  return value;
}

export async function runCalibration(): Promise<{ done: number; failed: number; durationMs: number }> {
  const t0 = Date.now();
  const H = currentParams().engine.horizon;
  const ins = getDb().prepare(
    "INSERT OR REPLACE INTO risk_calib (coin, tf, probe, noise, horizon, samples, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  let done = 0, failed = 0;
  for (const coin of COIN_IDS) {
    for (const tf of CALIBRATED_TFS) {
      try {
        const k = await getKlines(coin, tf);
        // drop the bar still forming
        const until = closedThrough(k);
        const closed = k.candles.filter((x) => x.t + TF_SECONDS[tf] <= until);
        if (closed.length < 400) continue;
        const cal = calibrate(closed, tf, H[tf]);
        ins.run(coin, tf, JSON.stringify(cal.probe), JSON.stringify(cal.noise), cal.horizon, cal.samples, Date.now());
        memo.delete(`${coin}:${tf}`);
        done++;
      } catch (e) {
        failed++;
        logger.warn("engine", `止损校准失败 ${coin} ${tf}`, { error: (e as Error).message });
      }
      // keep the event loop responsive for visitors
      await new Promise((r) => setImmediate(r));
    }
  }
  return { done, failed, durationMs: Date.now() - t0 };
}
