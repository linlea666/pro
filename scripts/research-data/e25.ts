/**
 * E25（2026-10-22）：TD 13 碰上大一级周期时（同方向还在数 = 接力、反方向 = 回调、都走完 13、单独）是否比单个 13 更灵。
 * 按 13 反着做、页面持有期，对同币同方向的随机入场；结果写在 src/lib/tdbrief.ts 的 E25_FACTS。
 *   DATA_DIR=<研究库> node --experimental-strip-types scripts/research-data/e25.ts
 */
import { loadHistory, finish, type ResearchRow } from "../../src/lib/research/run.ts";
import { cells, controlTrades, makeSplit, trades, type Trade } from "../../src/lib/research/engine.ts";
import { DEFAULT_ENGINE_PARAMS } from "../../src/lib/params.ts";
import { RESEARCH_COINS } from "../../src/lib/symbols.ts";
import { computeTd } from "../../src/lib/ta/td.ts";
import * as ta from "../../src/lib/ta/core.ts";
import { TF_SECONDS, type Timeframe } from "../../src/lib/types.ts";

const ep = DEFAULT_ENGINE_PARAMS;
const nowSec = Date.now() / 1000;
const WARM = 300;
const PAIRS: [Timeframe, Timeframe][] = [["15m", "1h"], ["1h", "4h"], ["4h", "1d"]];
const rows: Omit<ResearchRow, "q" | "consistent" | "verdict">[] = [];
const counts: string[] = [];
for (const [s, b] of PAIRS) {
  const H = ep.horizon[s];
  const groups = new Map<string, { name: string; side: "bull" | "bear"; list: Trade[] }>();
  const ctl = { bull: [] as Trade[], bear: [] as Trade[] };
  let first = Infinity;
  for (const coin of RESEARCH_COINS) {
    const c = loadHistory(coin, s, nowSec);
    const cb = loadHistory(coin, b, nowSec);
    if (c.length < WARM + 10 * H || cb.length < 100) continue;
    first = Math.min(first, c[WARM].t);
    const atr = ta.atr(c, 14);
    const td = computeTd(c, ep.td);
    for (const x of controlTrades(c, atr, 1, H, ep.stats.costPct, coin, WARM)) ctl.bull.push(x);
    for (const x of controlTrades(c, atr, -1, H, ep.stats.costPct, coin, WARM)) ctl.bear.push(x);
    // larger-timeframe bars closed by each small bar's close
    const idx = new Map<string, number[]>();
    let j = -1;
    for (const e of td.events) {
      if (e.kind !== "countdown13" || e.i < WARM) continue;
      const closeT = c[e.i].t + TF_SECONDS[s];
      while (j + 1 < cb.length && cb[j + 1].t + TF_SECONDS[b] <= closeT) j++;
      if (j < 60) continue;
      const tb = computeTd(cb.slice(Math.max(0, j - 1500), j + 1), ep.td);
      const L = Math.min(j, 1500);
      const cd = tb.current.countdown;
      const recent13 = tb.events.findLast((x) => x.kind === "countdown13" && L - x.i <= 13);
      const last9 = tb.events.findLast((x) => x.kind === "setup9");
      const same = (x: { side: string } | null | undefined) => x != null && x.side === e.side;
      const opp = (x: { side: string } | null | undefined) => x != null && x.side !== e.side;
      const dir: 1 | -1 = e.side === "buy" ? 1 : -1;
      const side = dir === 1 ? "bull" : "bear";
      const tag: string[] = ["all"];
      if (same(recent13)) tag.push("both13");
      else if (same(cd)) tag.push("relay");
      else if (opp(cd) || (opp(last9) && !cd)) tag.push("against");
      else tag.push("alone");
      for (const t of tag) {
        const key = `${t}:${e.side}`;
        if (!groups.has(key)) groups.set(key, { name: `${s} ${e.side === "buy" ? "跌势" : "涨势"} 13 · ${t}`, side, list: [] });
        idx.set(key, [...(idx.get(key) ?? []), e.i]);
      }
    }
    for (const [key, ix] of idx) groups.get(key)!.list.push(...trades(c, atr, ix, key.endsWith(":buy") ? 1 : -1, H, ep.stats.costPct, coin));
  }
  const split = makeSplit(first, nowSec);
  for (const [key, g] of groups) rows.push({ family: "signal", key: `e25:${s}:${key}`, name: g.name, side: g.side, tf: s, horizon: H, cells: cells(g.list, ctl[g.side], split, H) });
}
const f = (v: number | null | undefined, d = 2) => (v == null ? "—" : v.toFixed(d));
for (const x of finish(rows, ep.stats.alpha, ep.stats.minSamples))
  console.log(x.name.padEnd(28), "n", String(x.cells.is.n).padStart(4), "edgeR", f(x.cells.is.edgeR).padStart(6), "hit", f(x.cells.is.hit, 0), "/", f(x.cells.is.baseHit, 0), "| btc", f(x.cells.btc.edgeR), "eth", f(x.cells.eth.edgeR), "1st", f(x.cells.firstHalf.edgeR), "2nd", f(x.cells.secondHalf.edgeR), "| oos", x.cells.oos.n, f(x.cells.oos.edgeR), "| q", f(x.q, 3), x.verdict);
