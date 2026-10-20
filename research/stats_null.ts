// E2: how often does forwardStats label a RANDOM signal "靠谱"?  E3: are the 28 indicator votes independent?
import fs from "node:fs";
import { forwardStats } from "../src/lib/ta/stats.ts";
import { computeIndicators } from "../src/lib/ta/indicators.ts";
const S = process.argv[2];
let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const out: any = { null: [], corr: {} };
for (const [coin, tf, H] of [["BTC", "4h", 18], ["ETH", "4h", 18], ["BTC", "1d", 10], ["ETH", "1d", 10]] as const) {
  const all = JSON.parse(fs.readFileSync(`${S}/hist/${coin}_${tf}.json`, "utf8"));
  const c = all.slice(-2000); // the product analyses the newest 2000 bars
  for (const nSig of [12, 25, 50, 100]) {
    let lab: Record<string, number> = { 靠谱: 0, 一般: 0, 不靠谱: 0, 样本不足: 0 };
    const trials = 2000;
    for (let k = 0; k < trials; k++) {
      const idx = Array.from({ length: nSig }, () => Math.floor(rnd() * (c.length - H))).sort((a, b) => a - b);
      const side = rnd() < 0.5 ? "bull" : "bear";
      lab[forwardStats(c, "x", "x", side, idx, H).reliability]++;
    }
    out.null.push({ coin, tf, nSig, trials, ...lab, falseRate: +(lab["靠谱"] / (trials - lab["样本不足"]) * 100).toFixed(1) });
  }
  // E3 correlation of bias series (last 2000 bars, skip warm-up 250)
  const p = computeIndicators(c);
  const ids = [...p.byId.keys()];
  const X = ids.map((id) => p.byId.get(id)!.slice(250));
  const m = X.length, n = X[0].length;
  const mean = X.map((x) => x.reduce((a, b) => a + b, 0) / n);
  const sd = X.map((x, i) => Math.sqrt(x.reduce((a, b) => a + (b - mean[i]) ** 2, 0) / n) || 1e-9);
  const R = X.map((x, i) => X.map((y, j) => x.reduce((a, _, k) => a + (x[k] - mean[i]) * (y[k] - mean[j]), 0) / n / sd[i] / sd[j]));
  // participation ratio of the correlation spectrum = effective number of independent voters
  const tr = R.reduce((a, r, i) => a + r[i], 0), tr2 = R.reduce((a, r) => a + r.reduce((b, v) => b + v * v, 0), 0);
  const pairs: [string, string, number][] = [];
  for (let i = 0; i < m; i++) for (let j = i + 1; j < m; j++) if (Math.abs(R[i][j]) >= 0.6) pairs.push([ids[i], ids[j], +R[i][j].toFixed(2)]);
  out.corr[`${coin}_${tf}`] = { m, effective: +(tr * tr / tr2).toFixed(1), highPairs: pairs.sort((a, b) => b[2] - a[2]), meanAbs: +(R.flat().reduce((a, v) => a + Math.abs(v), 0) / (m * m)).toFixed(2) };
}
fs.writeFileSync(`${S}/exp/stats_null.json`, JSON.stringify(out, null, 1));
console.log(out.null.map((r: any) => `${r.coin} ${r.tf} n=${r.nSig}: 靠谱 ${r.靠谱} 一般 ${r.一般} 不靠谱 ${r.不靠谱} 不足 ${r.样本不足} → false 靠谱 ${r.falseRate}%`).join("\n"));
for (const [k, v] of Object.entries<any>(out.corr)) console.log(k, "voters", v.m, "effective", v.effective, "mean|r|", v.meanAbs, "pairs≥0.6:", v.highPairs.length, JSON.stringify(v.highPairs.slice(0, 14)));
