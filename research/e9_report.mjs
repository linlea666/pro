// Summarise e9_zones output: per hypothesis and group, pooled and split by coin / time half.
import fs from "node:fs";
const data = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const wilson = (k, n, z = 1.96) => { if (!n) return [0, 100]; const p = k / n, z2 = z * z, c = (p + z2 / (2 * n)) / (1 + z2 / n), h = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n); return [Math.round((c - h) * 100), Math.round((c + h) * 100)]; };
const stat = (evs) => {
  const n = evs.length, m = n ? evs.reduce((s, e) => s + e.r, 0) / n : 0;
  const sd = n > 1 ? Math.sqrt(evs.reduce((s, e) => s + (e.r - m) ** 2, 0) / (n - 1)) : 0;
  const hk = evs.filter((e) => e.held === true).length, hn = evs.filter((e) => e.held != null).length;
  const sw = evs.filter((e) => e.x?.swept).length, br = evs.filter((e) => e.x?.broke).length;
  return { n, mean: +m.toFixed(3), ci: [+(m - 1.96 * sd / Math.sqrt(n || 1)).toFixed(3), +(m + 1.96 * sd / Math.sqrt(n || 1)).toFixed(3)], hold: hn ? Math.round((hk / hn) * 100) : null, holdCi: wilson(hk, hn), hn, swept: n ? Math.round((sw / n) * 100) : null, sweptCi: wilson(sw, n), broke: n ? Math.round((br / n) * 100) : null };
};
const tfs = [...new Set(Object.keys(data).map((k) => k.split("_")[1]))];
const report = {};
for (const tf of tfs) {
  const keys = Object.keys(data).filter((k) => k.endsWith("_" + tf));
  const all = keys.flatMap((k) => data[k].ev.map((e) => ({ ...e, coin: k.split("_")[0] })));
  const byH = {};
  for (const e of all) ((byH[e.h] ??= {})[e.g] ??= []).push(e);
  report[tf] = {};
  for (const [h, gs] of Object.entries(byH)) {
    report[tf][h] = {};
    for (const [g, evs] of Object.entries(gs)) {
      const split = {};
      for (const coin of ["BTC", "ETH"]) split[coin] = stat(evs.filter((e) => e.coin === coin));
      for (const p of ["前半", "后半"]) split[p] = stat(evs.filter((e) => e.p === p));
      report[tf][h][g] = { ...stat(evs), split };
    }
  }
  // framework sanity: random twins split in two at random should not differ
  const rt = byH.H1?.["随机区间(对照)"] ?? [];
  report[tf].sanity = { a: stat(rt.filter((_, i) => i % 2 === 0)), b: stat(rt.filter((_, i) => i % 2 === 1)) };
}
fs.writeFileSync(process.argv[3], JSON.stringify(report, null, 1));
for (const [tf, hs] of Object.entries(report)) {
  console.log(`\n######## ${tf}`);
  for (const [h, gs] of Object.entries(hs)) {
    if (h === "sanity") { console.log(`  sanity random halves: ${gs.a.mean} (${gs.a.ci}) vs ${gs.b.mean} (${gs.b.ci})`); continue; }
    console.log(`  == ${h}`);
    for (const [g, s] of Object.entries(gs)) {
      const sp = s.split;
      console.log(`    ${g.padEnd(28)} n=${String(s.n).padStart(5)}  均值 ${String(s.mean).padStart(7)} [${s.ci}]  守住 ${s.hold}% [${s.holdCi}] n=${s.hn}${s.swept != null && h === "H4" ? `  刺穿 ${s.swept}% [${s.sweptCi}] 破 ${s.broke}%` : ""}  | BTC ${sp.BTC.mean}/${sp.BTC.hold}% ETH ${sp.ETH.mean}/${sp.ETH.hold}% 前 ${sp["前半"].mean}/${sp["前半"].hold}% 后 ${sp["后半"].mean}/${sp["后半"].hold}%`);
    }
  }
}
