import { analyze, multiTimeframe } from "../src/lib/analysis.ts";
import { getKlines } from "../src/lib/data/klines.ts";
import { computeTd } from "../src/lib/ta/td.ts";
import { computeIndicators } from "../src/lib/ta/indicators.ts";
import * as ta from "../src/lib/ta/core.ts";
const a = await analyze("BTC", "4h");
const c = a.candles;
console.log("price", a.price, "bar", new Date(c[c.length-1].t*1000).toISOString());
const cur = a.td.current;
console.log("TD 4h setup", cur.setupSide, cur.setupCount, "next", cur.nextCloseNeeded, "TDST", cur.tdstResistance, "last", cur.lastSignal?.kind, cur.lastSignal?.side, cur.lastSignal?.price, cur.lastSignal?.barsAgo, "risk", cur.lastSignal?.riskLevel);
const last9 = [...a.td.events].reverse().find(e => e.kind === "setup9");
console.log("bars since last 9", last9 ? c.length - 1 - c.findIndex(x => x.t === last9.t) : null);
for (const tf of ["15m","1h","4h","1d"] as const) {
  const k = (await getKlines("BTC", tf)).candles;
  const td = computeTd(k);
  const evs = td.events; const L = k.length-1;
  const last13 = [...evs].reverse().find(e=>e.kind==="countdown13");
  console.log(tf, "setup", td.current.setupSide, td.current.setupCount, "countdown", JSON.stringify(td.current.countdown), "last13", last13 && `${last13.side} ${L-last13.i} bars ago`);
}
const r = a.indicators.resonance.at(-1)!;
console.log("resonance latest", r);
console.log("trend", a.trend.current, a.trend.label, "adx", a.trend.adx);
console.log(a.indicators.readings.filter(x=>x.category==="trend").map(x=>`${x.id}:${x.bias}`).join(" "));
const k4 = (await getKlines("BTC","4h")).candles;
const d = ta.adx(k4); const L=k4.length-1;
console.log("adx", d.adx[L].toFixed(1), "+di", d.pdi[L].toFixed(1), "-di", d.mdi[L].toFixed(1));
console.log("levels R", a.levels.resistances.map(l=>Math.round(l.price)), "S", a.levels.supports.map(l=>Math.round(l.price)));
