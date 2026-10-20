// E1: replay the product's own verdict at many historical bars using analyzeAt (no code changes)
import fs from "node:fs";
import { analyzeAt } from "../src/lib/analysis.ts";
import { getKlines } from "../src/lib/data/klines.ts";
const [coin, tf, step, outFile] = [process.argv[2], process.argv[3] as any, Number(process.argv[4]), process.argv[5]];
const all = (await getKlines(coin, tf)).candles;
const H = tf === "4h" ? 18 : tf === "1d" ? 10 : 24;
const rows: any[] = [];
const t0 = Date.now();
for (let i = 300; i < all.length - 1 - H; i += step) {
  const a = await analyzeAt(coin, tf, all[i].t);
  const v = a.verdict, o = a.replay!.outcome!;
  const atr = (v.atrPct / 100) * a.price;
  rows.push({ t: all[i].t, light: v.light, score: v.score, conf: v.confidence, close: o.closePct, max: o.maxPct, min: o.minPct, correct: o.correct, stopHit: o.stopHit,
    stopAtr: v.stopRef ? Math.abs(v.stopRef - a.price) / atr : null, atrPct: v.atrPct,
    s1: a.levels.supports[0]?.distancePct ?? null, r1: a.levels.resistances[0]?.distancePct ?? null, nlev: a.levels.supports.length + a.levels.resistances.length, trend: a.trend.label, tscore: a.trend.current, adx: a.trend.adx });
  if (rows.length === 3) console.error("ms/run", (Date.now() - t0) / 3);
}
fs.writeFileSync(outFile, JSON.stringify(rows));
console.error(coin, tf, rows.length, "runs", ((Date.now() - t0) / 1000).toFixed(0), "s");
process.exit(0);
