// Summarise E6: expectancy in R (after costs) per method and entry style, pooled over the given datasets.
import fs from "node:fs";
const [file, ...keys] = process.argv.slice(2);
const d = JSON.parse(fs.readFileSync(file, "utf8"));
const TI = { 1: 1, 2: 2, 3: 3, 5: 4 }; // column of each target in the compact rows
const stat = (rows, col) => {
  const v = rows.map((r) => r[col]); const n = v.length; if (!n) return null;
  const m = v.reduce((a, b) => a + b, 0) / n; const sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, n - 1));
  return { n, m, se: sd / Math.sqrt(n) };
};
const out = {};
for (const st of ["A", "B", "C"]) {
  const groups = new Set(); for (const k of keys) for (const g of Object.keys(d[k]?.[st] ?? {})) groups.add(g);
  const rows = [];
  for (const g of groups) {
    const ev = keys.flatMap((k) => d[k]?.[st]?.[g] ?? []);
    const early = ev.filter((r) => r[0] <= 2021), late = ev.filter((r) => r[0] >= 2022);
    const s3 = stat(ev, TI[3]), s2 = stat(ev, TI[2]), s5 = stat(ev, TI[5]);
    const hit3 = ev.filter((r) => r[5] >= 3).length / ev.length;
    rows.push({ g, n: ev.length, hit3: +(hit3 * 100).toFixed(1), e2: +s2.m.toFixed(3), e3: +s3.m.toFixed(3), se3: +s3.se.toFixed(3), e5: +s5.m.toFixed(3), e3early: early.length ? +stat(early, TI[3]).m.toFixed(3) : null, e3late: late.length ? +stat(late, TI[3]).m.toFixed(3) : null, medMfe: +ev.map((r) => r[5]).sort((a, b) => a - b)[ev.length >> 1].toFixed(2) });
  }
  rows.sort((a, b) => b.e3 - a.e3);
  out[st] = rows;
  console.log(`\n== style ${st} (${keys.join("+")}) ==   n | P(MFE≥3R) | E[2R] | E[3R] ±se | E[5R] | E3 2017-21 | E3 2022-26 | median MFE`);
  for (const r of rows) console.log(`${r.g.padEnd(16, "　")} ${String(r.n).padStart(6)} | ${String(r.hit3).padStart(5)}% | ${r.e2.toFixed(2)} | ${r.e3.toFixed(2)} ±${r.se3.toFixed(2)} | ${r.e5.toFixed(2)} | ${r.e3early?.toFixed(2)} | ${r.e3late?.toFixed(2)} | ${r.medMfe}`);
}
fs.writeFileSync(file.replace(".json", `_report_${keys.join("+")}.json`), JSON.stringify(out, null, 1));
