// E5: pure-noise stop curve — P(stop k·ATR away is touched within the horizon), random entry time & side
import fs from "node:fs";
const S = process.argv[2];
const atrOf = (c, n = 14) => { const a = new Array(c.length).fill(NaN); let s = 0; for (let i = 1; i < c.length; i++) { const tr = Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c)); if (i <= n) { s += tr; if (i === n) a[i] = s / n; } else a[i] = (a[i - 1] * (n - 1) + tr) / n; } return a; };
const out = {};
for (const k of ["BTC_4h", "ETH_4h", "BTC_1d", "ETH_1d"]) {
  const c = JSON.parse(fs.readFileSync(`${S}/hist/${k}.json`, "utf8")), atr = atrOf(c), H = k.endsWith("4h") ? 18 : 10;
  const ks = [0.5, 1, 1.5, 2, 3, 4], hit = ks.map(() => 0); let n = 0;
  for (let t = 50; t < c.length - H; t++) for (const sgn of [1, -1]) { // sgn 1 = short (stop above)
    n++; const p = c[t].c, a = atr[t];
    let ext = 0; for (let j = t + 1; j <= t + H; j++) ext = Math.max(ext, sgn > 0 ? c[j].h - p : p - c[j].l);
    ks.forEach((m, q) => { if (ext >= m * a) hit[q]++; });
  }
  out[k] = Object.fromEntries(ks.map((m, q) => [m, +(hit[q] / n * 100).toFixed(1)]));
}
fs.writeFileSync(`${S}/exp/noise.json`, JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
