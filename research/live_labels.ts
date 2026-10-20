// E2b: label distribution of the live "灵不灵" stats across coins × timeframes, by sample size
import fs from "node:fs";
import { analyze } from "../src/lib/analysis.ts";
import { COINS } from "../src/lib/symbols.ts";
const rows: any[] = [];
for (const coin of COINS.map((c) => c.id)) for (const tf of ["1h", "4h", "1d"] as const) {
  const a = await analyze(coin, tf);
  for (const s of a.stats) rows.push({ coin, tf, kind: "signal", key: s.key, n: s.samples, win: s.winRate, base: s.baseWinRate, avg: s.avgReturn, rel: s.reliability });
  for (const [id, v] of Object.entries<any>(a.indicatorStats)) for (const side of ["bull", "bear"]) { const s = v[side]; rows.push({ coin, tf, kind: "indicator", key: `${id}:${side}`, n: s.samples, win: s.winRate, base: s.baseWinRate, avg: s.avgReturn, rel: s.reliability }); }
}
fs.writeFileSync(process.argv[2], JSON.stringify(rows));
const by = (f: (r: any) => boolean) => { const r = rows.filter(f); const k = r.filter((x) => x.rel === "靠谱").length; return `${r.length} stats, 靠谱 ${k} (${(k / r.length * 100).toFixed(0)}%)`; };
console.log("all", by(() => true));
console.log("n<25", by((r) => r.n >= 8 && r.n < 25), "| 25-50", by((r) => r.n >= 25 && r.n < 50), "| ≥50", by((r) => r.n >= 50));
console.log("signals only", by((r) => r.kind === "signal"), "indicators only", by((r) => r.kind === "indicator"));
const nn = rows.map((r) => r.n).sort((a, b) => a - b); console.log("samples median", nn[nn.length >> 1], "p10", nn[Math.floor(nn.length * 0.1)], "p90", nn[Math.floor(nn.length * 0.9)]);
process.exit(0);
