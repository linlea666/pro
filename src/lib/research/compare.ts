import { analyzeWith } from "../analysis.ts";
import type { EngineParams } from "../params.ts";
import { COIN_IDS } from "../symbols.ts";
import { TF_SECONDS, type Timeframe } from "../types.ts";
import { lightRows, loadHistory, type LightPoint, type ResearchRow } from "./run.ts";

/**
 * Before / after for an engine change: replay the traffic light under both
 * parameter sets at the same past moments (the scorecard's grid, every
 * `step`-th point) and report both against the same random control.
 */

export interface Comparison {
  points: number;
  /** share of points where the light differs, % */
  changedPct: number;
  before: ResearchRow[];
  after: ResearchRow[];
  durationMs: number;
}

export async function compareEngines(
  before: EngineParams,
  after: EngineParams,
  opts: { coins?: string[]; tfs?: Timeframe[]; step?: number; nowSec?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<Comparison> {
  const t0 = Date.now();
  const { coins = COIN_IDS, tfs = ["1h", "4h", "1d"], step = 1, nowSec = Date.now() / 1000 } = opts;
  const jobs: { coin: string; tf: Timeframe; t: number; closePct: number }[] = [];
  for (const tf of tfs) {
    const H = before.horizon[tf];
    const sec = TF_SECONDS[tf];
    for (const coin of coins) {
      const c = loadHistory(coin, tf, nowSec);
      let k = 0;
      for (let i = 300; i + H < c.length; i++) {
        if (Math.floor(c[i].t / sec) % H !== 0 || c[i + H].t !== c[i].t + H * sec) continue;
        if (k++ % step === 0) jobs.push({ coin, tf, t: c[i].t, closePct: ((c[i + H].c - c[i].c) / c[i].c) * 100 });
      }
    }
  }
  const a: LightPoint[] = [], b: LightPoint[] = [];
  let changed = 0;
  for (const [n, j] of jobs.entries()) {
    try {
      const [x, y] = await Promise.all([analyzeWith(j.coin, j.tf, before, j.t), analyzeWith(j.coin, j.tf, after, j.t)]);
      a.push({ ...j, light: x.verdict.light, atrPct: x.verdict.atrPct });
      b.push({ ...j, light: y.verdict.light, atrPct: x.verdict.atrPct });
      if (x.verdict.light !== y.verdict.light) changed++;
    } catch {
      // a point the replay can't rebuild (too early, a hole): left out of both
    }
    if (n % 50 === 0) {
      opts.onProgress?.(n, jobs.length);
      await new Promise((r) => setImmediate(r));
    }
  }
  return {
    points: a.length,
    changedPct: a.length ? Math.round((changed / a.length) * 1000) / 10 : 0,
    before: lightRows(a, before, nowSec).rows,
    after: lightRows(b, after, nowSec).rows,
    durationMs: Date.now() - t0,
  };
}
