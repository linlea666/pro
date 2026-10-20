import { PRIMARY_SOURCE } from "../data/klines.ts";
import { LEVEL_METHODS, type EngineParams } from "../params.ts";
import * as ta from "../ta/core.ts";
import { levelCandidates, periodCandidates } from "../ta/levels.ts";
import type { Timeframe } from "../types.ts";
import { bhAdjust, cells, judge, makeSplit, type Trade } from "./engine.ts";
import { loadHistory, type ResearchReport, type ResearchRow } from "./run.ts";

/**
 * Key levels (the E6 event study, on the stored history): every time price comes
 * back to a level known at that moment, trade against it — enter just before the
 * level, stop beyond the usual sweep depth (0.85 ATR), take profit at 2R or close
 * after the holding time — and compare with random price lines that live like
 * real ones. Also how often each kind of level is pierced (a close 0.1 ATR beyond)
 * or invalidated (0.8 ATR beyond) within the holding time: the two states v1.3 shows.
 */

const METHOD_NAME: Record<string, string> = {
  swing: "摆动高低",
  fractal: "Williams 分形",
  volume: "成交量分布",
  pivot: "经典 Pivot",
  camarilla: "Camarilla",
  fibPivot: "Fibonacci Pivot",
  fib: "Fibonacci 回撤",
  prevHL: "前日/周/月高低",
  donchian: "Donchian 通道",
  keltner: "Keltner 通道",
  bollinger: "布林带",
  ma: "均线",
  avwap: "锚定 VWAP",
  round: "整数关口",
};
const PLACEBO = "random";
const ENTRY_ATR = 0.1;
const STOP_ATR = 0.85;
const TARGET_R = 2;
const PIERCE_ATR = 0.1;
const BREAK_ATR = 0.8;
const SETUP: Partial<Record<Timeframe, { step: number; hold: number }>> = { "1h": { step: 6, hold: 72 }, "4h": { step: 3, hold: 60 }, "1d": { step: 1, hold: 30 } };

/** deterministic, so a report can be reproduced */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

interface LevelTrade extends Trade {
  pierced: boolean;
  broken: boolean;
}

export async function levelsReport(
  ep: EngineParams,
  opts: { paramsVersion: number; coins?: string[]; tfs?: Timeframe[]; nowSec?: number } = { paramsVersion: 0 },
): Promise<ResearchReport> {
  const t0 = Date.now();
  const { coins = ["BTC", "ETH"], tfs = ["4h", "1d"], nowSec = Date.now() / 1000 } = opts;
  const cost = ep.stats.costPct;
  const rows: Omit<ResearchRow, "q" | "consistent" | "verdict">[] = [];
  const coverage: ResearchReport["coverage"] = [];
  let holdoutFrom = 0;
  for (const tf of tfs) {
    const setup = SETUP[tf];
    if (!setup) continue;
    const { step, hold } = setup;
    const byMethod = new Map<string, LevelTrade[]>();
    let first = Infinity, last = 0, bars = 0, used = 0;
    for (const coin of coins) {
      const c = loadHistory(coin, tf, nowSec);
      const daily = loadHistory(coin, "1d", nowSec);
      if (c.length < 1200) continue;
      used++;
      bars += c.length;
      const atr = ta.atr(c, 14);
      const rnd = rng(20261020 + used);
      const placebo: { L: number; born: number; above: boolean }[] = [];
      const recent = new Map<string, { L: number; j: number }[]>();
      const fresh = (g: string, L: number, j: number, A: number) => {
        const arr = recent.get(g) ?? [];
        if (arr.some((x) => j - x.j < 12 && Math.abs(x.L - L) < 0.3 * A)) return false;
        arr.push({ L, j });
        if (arr.length > 50) arr.shift();
        recent.set(g, arr);
        return true;
      };
      let di = 0;
      first = Math.min(first, c[600].t);
      last = Math.max(last, c[c.length - 1].t);
      for (let t = 600; t < c.length - 2; t += step) {
        const A = atr[t], p = c[t].c;
        if (!(A > 0)) continue;
        // levels known at the close of bar t
        const lv: { g: string; L: number }[] = levelCandidates(c.slice(Math.max(0, t - 999), t + 1), tf, ep.levels).map((x) => ({ g: x.method, L: x.price }));
        while (di + 1 < daily.length && daily[di + 1].t <= c[t].t) di++;
        // the day in progress only marks where the current period starts
        for (const x of periodCandidates(daily.slice(Math.max(0, di - 70), di + 1), p, ep.levels)) lv.push({ g: x.method, L: x.price });
        // random lines that live until broken or 300 bars old
        for (let k = placebo.length - 1; k >= 0; k--) {
          const q = placebo[k];
          if (t - q.born > 300 || (q.above ? p > q.L : p < q.L)) placebo.splice(k, 1);
        }
        for (let k = 0; k < 2; k++) placebo.push({ L: p + (0.3 + rnd() * 5.7) * A, born: t, above: true }, { L: p - (0.3 + rnd() * 5.7) * A, born: t, above: false });
        for (const q of placebo) lv.push({ g: PLACEBO, L: q.L });

        for (const { g, L } of lv) {
          if (!(L > 0) || Math.abs(L - p) < 0.3 * A) continue;
          const sg = L > p ? 1 : -1; // +1: resistance above, trade short
          const E = L - sg * ENTRY_ATR * A, S = L + sg * STOP_ATR * A, R = Math.abs(S - E);
          for (let j = t + 1; j <= Math.min(t + step, c.length - 2); j++) {
            const x = c[j];
            if ((E - c[j - 1].c) * sg <= 0 || !(sg > 0 ? x.h >= E : x.l <= E) || !fresh(g, L, j, A)) continue;
            // conservative: a bar that reaches the stop as well counts as stopped
            let r = -1, pierced = false, broken = false;
            const end = Math.min(c.length - 1, j + hold);
            if (!(sg > 0 ? x.h >= S : x.l <= S)) {
              r = Number.NaN;
              for (let k = j + 1; k <= end; k++) {
                const y = c[k];
                if (sg > 0 ? y.h >= S : y.l <= S) { r = -1; break; }
                if ((sg > 0 ? E - y.l : y.h - E) / R >= TARGET_R) { r = TARGET_R; break; }
              }
              if (Number.isNaN(r)) r = Math.max(-1, ((E - c[end].c) * sg) / R);
            }
            for (let k = j; k <= end; k++) {
              const beyond = ((c[k].c - L) * sg) / atr[k];
              if (beyond > PIERCE_ATR) pierced = true;
              if (beyond > BREAK_ATR) { broken = true; break; }
            }
            const net = r - ((cost / 100) * E) / R;
            const list = byMethod.get(g) ?? [];
            list.push({ t: x.t, coin, r: net, pct: (net * R * 100) / E, pierced, broken });
            byMethod.set(g, list);
          }
        }
        if (t % 300 < step) await new Promise((ok) => setImmediate(ok));
      }
    }
    if (!used) continue;
    const split = makeSplit(first, nowSec);
    holdoutFrom = split.holdoutFrom;
    coverage.push({ tf, coins: used, bars: Math.round(bars / used), from: first, to: last, holdoutFrom: split.holdoutFrom });
    const control = byMethod.get(PLACEBO) ?? [];
    const share = (xs: LevelTrade[], f: (x: LevelTrade) => boolean) => (xs.length ? Math.round((xs.filter(f).length / xs.length) * 1000) / 10 : null);
    for (const g of [...LEVEL_METHODS, PLACEBO]) {
      const list = byMethod.get(g);
      if (!list?.length) continue;
      rows.push({
        family: "level",
        key: `level:${g}`,
        name: g === PLACEBO ? "随机价格线（对照）" : METHOD_NAME[g] ?? g,
        side: "bear",
        tf,
        horizon: hold,
        cells: cells(list, control, split, 1),
        extra: { piercedPct: share(list, (x) => x.pierced), brokenPct: share(list, (x) => x.broken) },
      });
    }
  }
  const q = bhAdjust(rows.map((r) => (r.key === `level:${PLACEBO}` || r.cells.is.n < ep.stats.minSamples ? null : r.cells.is.p)));
  return {
    kind: "levels",
    title: "关键位：触位反向交易对随机价格线，刺穿与失效比例",
    createdAt: Date.now(),
    source: PRIMARY_SOURCE,
    paramsVersion: opts.paramsVersion,
    costPct: cost,
    alpha: ep.stats.alpha,
    holdoutFrom,
    coins,
    coverage,
    rows: rows.map((r, k) => ({ ...r, q: q[k], ...judge(r.cells, q[k], ep.stats.alpha, ep.stats.minSamples) })),
    notes: [
      `每次价格回到当时已知的关键位，就在位前 ${ENTRY_ATR} 倍 ATR 处反向入场，止损放在位外 ${STOP_ATR} 倍 ATR（历史扫损深度约 p80），${TARGET_R}R 止盈，否则持有期结束时平仓；结果以 R（止损距离）计，已扣成本。`,
      "对照是随机价格线：和真实关键位一样，被收盘越过或满 300 根就作废。“优势”= 某种方法的平均 R 减去同币同期随机线的平均 R。",
      `“刺穿”= 持有期内收盘越过该位 ${PIERCE_ATR} 倍 ATR；“失效”= 越过 ${BREAK_ATR} 倍 ATR（v1.3 防守位页的两级状态）。`,
      "同一种方法、同一个价位附近 12 根内只算一次；被动态更新的位（均线、通道）按当时的价格记。",
    ],
    durationMs: Date.now() - t0,
  };
}
