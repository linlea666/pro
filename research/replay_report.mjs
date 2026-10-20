import fs from "node:fs";
const S = process.argv[2];
const out = {};
for (const k of ["BTC_4h", "ETH_4h", "BTC_1d", "ETH_1d"]) {
  const r = JSON.parse(fs.readFileSync(`${S}/out/replay_${k}.json`, "utf8"));
  const d = (x) => new Date(x * 1000).toISOString().slice(0, 10);
  const mean = (a) => a.reduce((s, v) => s + v, 0) / (a.length || 1);
  const up = r.filter((x) => x.close > 0).length / r.length * 100;
  const quietBase = r.filter((x) => Math.abs(x.close) < 2 * x.atrPct).length / r.length * 100;
  const L = {};
  for (const light of ["green", "yellow", "red"]) {
    const g = r.filter((x) => x.light === light);
    const st = g.filter((x) => x.stopHit != null);
    const hit = st.filter((x) => x.stopHit);
    // stop hit, but by the end of the horizon price went the predicted way anyway
    const swept = hit.filter((x) => (light === "green" ? x.close > 0 : light === "red" ? x.close < 0 : x.close > 0));
    L[light] = { n: g.length, share: +(g.length / r.length * 100).toFixed(0), correct: +(g.filter((x) => x.correct).length / (g.length || 1) * 100).toFixed(1),
      meanClose: +mean(g.map((x) => x.close)).toFixed(2), withStop: st.length, stopHit: +(hit.length / (st.length || 1) * 100).toFixed(0), sweptThenRight: +(swept.length / (hit.length || 1) * 100).toFixed(0),
      stopAtr: +mean(st.map((x) => x.stopAtr)).toFixed(2) };
  }
  // score → forward return, Spearman rank correlation
  const rank = (a) => { const o = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]); const rk = new Array(a.length); o.forEach(([, i], k) => (rk[i] = k)); return rk; };
  const rs = rank(r.map((x) => x.score)), rc = rank(r.map((x) => x.close));
  const mr = (r.length - 1) / 2; let num = 0, da = 0, db = 0;
  for (let i = 0; i < r.length; i++) { num += (rs[i] - mr) * (rc[i] - mr); da += (rs[i] - mr) ** 2; db += (rc[i] - mr) ** 2; }
  const bins = [[-100, -35], [-35, -18], [-18, 0], [0, 18], [18, 35], [35, 101]].map(([a, b]) => { const g = r.filter((x) => x.score >= a && x.score < b); return { bin: `${a}..${b}`, n: g.length, meanClose: +mean(g.map((x) => x.close)).toFixed(2), up: +(g.filter((x) => x.close > 0).length / (g.length || 1) * 100).toFixed(0) }; });
  out[k] = { runs: r.length, from: d(r[0].t), to: d(r.at(-1).t), baseUp: +up.toFixed(1), baseQuiet: +quietBase.toFixed(1), spearman: +(num / Math.sqrt(da * db)).toFixed(3), L, bins, levelsMean: +mean(r.map((x) => x.nlev)).toFixed(1) };
}
fs.writeFileSync(`${S}/out/replay_report.json`, JSON.stringify(out, null, 1));
for (const [k, v] of Object.entries(out)) {
  console.log(`\n${k} runs ${v.runs} ${v.from}→${v.to} baseUp ${v.baseUp}% baseQuiet ${v.baseQuiet}% spearman ${v.spearman} levels ${v.levelsMean}`);
  for (const [l, s] of Object.entries(v.L)) console.log(" ", l, JSON.stringify(s));
  console.log("  bins", v.bins.map((b) => `${b.bin}: n${b.n} ${b.meanClose}% up${b.up}%`).join(" | "));
}
