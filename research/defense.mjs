// E4: structural defense levels — prototype + an honest test of the hypothesis behind it
import fs from "node:fs";
const S = process.argv[2];
const load = (k) => JSON.parse(fs.readFileSync(`${S}/hist/${k}.json`, "utf8"));
const atrOf = (c, n = 14) => { const a = new Array(c.length).fill(NaN); let s = 0; for (let i = 1; i < c.length; i++) { const tr = Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c)); if (i <= n) { s += tr; if (i === n) a[i] = s / n; } else a[i] = (a[i - 1] * (n - 1) + tr) / n; } return a; };
// pivot confirmed K bars later (no lookahead when used at t >= i+K)
const pivots = (c, K, side) => { const out = []; for (let i = K; i < c.length - K; i++) { let ok = true; for (let j = i - K; j <= i + K && ok; j++) if (j !== i && (side === "high" ? c[j].h > c[i].h : c[j].l < c[i].l)) ok = false; if (ok) out.push(i); } return out; };

/** levels known at bar t: confirmed pivots, with test count / state, measured only with bars <= t */
function levelsAt(c, atr, t, K, side, look = 400) {
  const piv = pivots(c.slice(0, t + 1), K, side).filter((i) => i + K <= t && i >= t - look);
  const out = [];
  for (const i of piv) {
    const lv = side === "high" ? c[i].h : c[i].l, sgn = side === "high" ? 1 : -1;
    let tests = 0, lastTest = -99, broken = false, maxProbe = 0, swept = 0;
    for (let j = i + K + 1; j <= t; j++) {
      const a = atr[j];
      const close = c[j].c, ext = side === "high" ? c[j].h : c[j].l;
      if ((close - lv) * sgn > 0.1 * a) { broken = true; break; }           // a close beyond = broken
      const near = (lv - ext) * sgn <= 0.3 * a;                            // came within 0.3 ATR
      if (near && j - lastTest >= 3) { tests++; lastTest = j; }
      if ((ext - lv) * sgn > 0) { swept++; maxProbe = Math.max(maxProbe, ((ext - lv) * sgn) / a); }
    }
    if (!broken) out.push({ i, t: c[i].t, price: lv, tests, swept, maxProbe });
  }
  return out;
}

// ---------------- Part A: BTC snapshot now (daily K=3 and 4h K=5)
const fmt = (x) => Math.round(x).toLocaleString("en-US"), day = (t) => new Date(t * 1000).toISOString().slice(0, 10);
const snap = {};
for (const [tf, K, look] of [["1d", 3, 200], ["4h", 5, 360]]) {
  const c = load(`BTC_${tf}`), atr = atrOf(c), t = c.length - 1, p = c[t].c;
  const hi = levelsAt(c, atr, t, K, "high", look).filter((l) => l.price > p).sort((a, b) => a.price - b.price);
  const lo = levelsAt(c, atr, t, K, "low", look).filter((l) => l.price < p).sort((a, b) => b.price - a.price);
  snap[tf] = { price: p, atr: atr[t], above: hi.map((l) => `${fmt(l.price)} (${day(l.t)}, tests ${l.tests}, +${((l.price / p - 1) * 100).toFixed(1)}%)`), below: lo.map((l) => `${fmt(l.price)} (${day(l.t)}, tests ${l.tests}, ${((l.price / p - 1) * 100).toFixed(1)}%)`) };
}
console.log(JSON.stringify(snap, null, 1));

// ---------------- Part B: does a tested, intact level hold more often than a random line?
const res = {};
for (const k of ["BTC_4h", "ETH_4h", "BTC_1d", "ETH_1d"]) {
  const c = load(k), atr = atrOf(c), H = k.endsWith("4h") ? 18 : 10, K = k.endsWith("4h") ? 5 : 3;
  const look = k.endsWith("4h") ? 360 : 200;
  const g = { fresh: [0, 0], tested1: [0, 0], tested2: [0, 0], placebo: [0, 0] }; const probes = [];
  let seed = 11; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let t = 300; t < c.length - H; t += 3) {
    for (const side of ["high", "low"]) {
      const sgn = side === "high" ? 1 : -1, p = c[t].c, a = atr[t];
      const lv = levelsAt(c, atr, t, K, side, look).filter((l) => (l.price - p) * sgn > 0.5 * a && (l.price - p) * sgn < 6 * a).sort((x, y) => (x.price - y.price) * sgn).at(0);
      const evalLine = (L) => { // reach within 0.3 ATR, then close beyond L + 0.3 ATR within the horizon?
        let touched = -1; for (let j = t + 1; j <= t + H; j++) { const ext = side === "high" ? c[j].h : c[j].l; if (touched < 0 && (L - ext) * sgn <= 0.3 * a) touched = j; if (touched >= 0 && (c[j].c - L) * sgn > 0.3 * a) return 1; }
        return touched >= 0 ? 0 : -1; };
      if (lv) {
        const r = evalLine(lv.price); const grp = lv.tests === 0 ? "fresh" : lv.tests === 1 ? "tested1" : "tested2";
        if (r >= 0) { g[grp][0]++; g[grp][1] += r; }
        if (r === 0) { let m = 0; for (let j = t + 1; j <= t + H; j++) { const ext = side === "high" ? c[j].h : c[j].l; m = Math.max(m, ((ext - lv.price) * sgn) / a); } if (m > 0) probes.push(m); }
        const d = (0.5 + rnd() * 5.5) * a, rr = evalLine(p + sgn * d); if (rr >= 0) { g.placebo[0]++; g.placebo[1] += rr; }
      }
    }
  }
  probes.sort((x, y) => x - y);
  const q = (f) => probes.length ? +probes[Math.floor(probes.length * f)].toFixed(2) : null;
  res[k] = Object.fromEntries(Object.entries(g).map(([n, [touch, brk]]) => [n, { touched: touch, breakAfterTouch: +(brk / (touch || 1) * 100).toFixed(1) }]));
  res[k].heldProbeATR = { n: probes.length, p50: q(0.5), p80: q(0.8), p90: q(0.9) };
}
fs.writeFileSync(`${S}/exp/defense.json`, JSON.stringify({ snap, res }, null, 1));
for (const [k, v] of Object.entries(res)) console.log(k, JSON.stringify(v));
