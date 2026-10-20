// E6b: does trading a level WITH the trend, or at a confluence of methods, beat random lines?
import fs from "node:fs";
const [file, ...keys] = process.argv.slice(2);
const d = JSON.parse(fs.readFileSync(file, "utf8"));
const R3 = 3, MFE = 5, ST = 6, MA = 7, CF = 8;
const stat = (rows) => { const n = rows.length; if (n < 30) return { n, m: null, se: null, hit: null }; const v = rows.map((r) => r[R3]); const m = v.reduce((a, b) => a + b, 0) / n; const sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1)); return { n, m, se: sd / Math.sqrt(n), hit: rows.filter((r) => r[MFE] >= 3).length / n }; };
const fmt = (s) => (s.m == null ? `n=${s.n}`.padEnd(22) : `${s.m.toFixed(2)}±${s.se.toFixed(2)} n=${s.n}`.padEnd(22));
const PLACEBO = "随机价格线(对照)";
const out = {};
for (const st of ["A", "B", "C"]) {
  const groups = new Set(); for (const k of keys) for (const g of Object.keys(d[k]?.[st] ?? {})) groups.add(g);
  const evs = (g) => keys.flatMap((k) => d[k]?.[st]?.[g] ?? []);
  const allReal = [...groups].filter((g) => g !== PLACEBO).flatMap(evs);
  const rows = [...groups].map((g) => ({ g, ev: evs(g) }));
  rows.push({ g: "全部真实方法合计", ev: allReal });
  console.log(`\n== style ${st} ==  E[3R] by structure trend (顺势/逆势/无) | by daily MA trend (顺势/逆势) | confluence 1 / 2-3 / ≥4`);
  out[st] = {};
  for (const { g, ev } of rows) {
    const s = {
      stWith: stat(ev.filter((r) => r[ST] === 1)), stAgainst: stat(ev.filter((r) => r[ST] === -1)), stFlat: stat(ev.filter((r) => r[ST] === 0)),
      maWith: stat(ev.filter((r) => r[MA] === 1)), maAgainst: stat(ev.filter((r) => r[MA] === -1)),
      cf1: stat(ev.filter((r) => r[CF] <= 1)), cf23: stat(ev.filter((r) => r[CF] >= 2 && r[CF] <= 3)), cf4: stat(ev.filter((r) => r[CF] >= 4)),
      bothWith: stat(ev.filter((r) => r[ST] === 1 && r[MA] === 1)),
    };
    out[st][g] = s;
    console.log(`${g.padEnd(14, "　")} 结构顺 ${fmt(s.stWith)} 结构逆 ${fmt(s.stAgainst)} | 均线顺 ${fmt(s.maWith)} 均线逆 ${fmt(s.maAgainst)} | 双顺 ${fmt(s.bothWith)} | 共振1 ${fmt(s.cf1)} 2-3 ${fmt(s.cf23)} ≥4 ${fmt(s.cf4)}`);
  }
}
fs.writeFileSync(file.replace(".json", `_regime_${keys.join("+")}.json`), JSON.stringify(out, null, 1));
