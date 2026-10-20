// E9: do the ideas in razorbladekisses/Tradingview-Indicators survive an honest test on BTC/ETH?
// Re-implemented from the published rules (no code copied; CC BY-NC 4.0 source).
//   H1 displacement supply/demand zones vs random zones of the same width and distance
//   H2 fresh vs retested zones / levels
//   H3 invalidation rule: wick through (theirs) vs close beyond 0.1 ATR (ours) vs close beyond 0.8 ATR
//   H4 equal highs/lows vs single swing points: how often they get swept
//   H5 breakouts of intact swing levels split by relative volume
//   H6 swing confirmation 3 left / 2 right (theirs) vs 5 / 5 (ours)
// Usage: node research/e9_zones.mjs research research/out/e9.json BTC_4h ETH_4h ...   (reads research/hist/)
import fs from "node:fs";

const S = process.argv[2], OUT = process.argv[3], DATASETS = process.argv.slice(4);
const load = (k) => JSON.parse(fs.readFileSync(`${S}/hist/${k}.json`, "utf8"));
const atrOf = (c, n = 14) => { const a = new Array(c.length).fill(NaN); let s = 0; for (let i = 1; i < c.length; i++) { const tr = Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c)); if (i <= n) { s += tr; if (i === n) a[i] = s / n; } else a[i] = (a[i - 1] * (n - 1) + tr) / n; } return a; };
const COST = 0.0015;           // round trip, share of price
const HORIZON = { "1h": 24, "4h": 18, "1d": 10 };  // the site's stats horizon
const TMAX = { "1h": 72, "4h": 60, "1d": 30 };     // max holding for trade simulation
let seed = 20261020; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

/**
 * Trade a touch of a zone: enter at the inner edge, stop beyond the outer edge + buffer, target 2R,
 * time exit after T bars. Conservative: a bar that reaches both stop and target counts as stopped.
 * Also returns `held`: price moved 2 ATR away in our favour before closing beyond the outer edge by 0.1 ATR.
 */
function trade(c, atr, j, dir, inner, outer, buf, T) {
  const n = c.length, A = atr[j];
  const E = inner, Sp = outer - dir * buf * A, R = Math.abs(E - Sp);
  if (!(R > 0)) return null;
  const tgt = E + dir * 2 * R, cost = (COST * E) / R;
  let r = null, held = null;
  const end = Math.min(n - 1, j + T);
  // the touch bar itself: stop first
  if (dir > 0 ? c[j].l <= Sp : c[j].h >= Sp) r = -1;
  for (let k = j + 1; k <= end && (r == null || held == null); k++) {
    const x = c[k];
    if (r == null) {
      if (dir > 0 ? x.l <= Sp : x.h >= Sp) r = -1;
      else if (dir > 0 ? x.h >= tgt : x.l <= tgt) r = 2;
    }
    if (held == null) {
      if ((outer - x.c) * dir > 0.1 * atr[k]) held = false;
      else if ((dir > 0 ? x.h - inner : inner - x.l) >= 2 * A) held = true;
    }
  }
  if (r == null) r = Math.max(-1, ((c[end].c - E) * dir) / R);
  return { r: r - cost, held };
}

function pivotsAt(c, i, L, Rr, side) { // is bar i a swing point with L bars left, Rr right?
  for (let j = i - L; j <= i + Rr; j++) if (j !== i && j >= 0 && j < c.length && (side === "high" ? c[j].h > c[i].h : c[j].l < c[i].l)) return false;
  return true;
}

function run(key) {
  const c = load(key), tf = key.split("_")[1], n = c.length, atr = atrOf(c), H = HORIZON[tf], T = TMAX[tf];
  const mid = c[Math.floor(n / 2)].t;
  const half = (j) => (c[j].t < mid ? "前半" : "后半");
  const ev = [];   // {h, g, half, r, held, extra}
  const push = (h, g, j, o, extra) => { if (o) ev.push({ h, g, p: half(j), r: +o.r.toFixed(3), held: o.held, x: extra }); };

  // ---------------- H1/H2: displacement zones and their random twins
  const zones = [];
  for (let i = 2; i < n - 1; i++) {
    const a = c[i - 1], b = c[i];
    const bodyA = Math.abs(a.c - a.o), bodyB = Math.abs(b.c - b.o);
    if (!(bodyA > 0) || bodyB / bodyA < 1.8) continue;
    // supply: green (or doji) then big red that closes below the green close and opens at/above its open
    if (a.c >= a.o && b.c < b.o && a.c >= b.c && a.o <= b.o) zones.push({ born: i, dir: -1, inner: a.o, outer: Math.max(a.h, b.h), g: "供需区" });
    if (a.c <= a.o && b.c > b.o && a.c <= b.c && a.o >= b.o) zones.push({ born: i, dir: 1, inner: a.o, outer: Math.min(a.l, b.l), g: "供需区" });
  }
  // random twins: same side, same width and same entry distance (in ATR), born at a random bar
  const twins = zones.map((z) => {
    const A = atr[z.born]; if (!(A > 0)) return null;
    const dist = (c[z.born].c - z.inner) * z.dir / A, width = Math.abs(z.inner - z.outer) / A;
    const b = 300 + Math.floor(rnd() * (n - 400)), Ab = atr[b];
    const inner = c[b].c - z.dir * dist * Ab;
    return { born: b, dir: z.dir, inner, outer: inner - z.dir * width * Ab, g: "随机区间(对照)" };
  }).filter(Boolean);

  const walkZones = (list, rule, label, withH2) => {
    for (const z of list) {
      if (z.born < 300) continue;
      let tests = 0, lastTouch = -1e9;
      for (let j = z.born + 1; j < n - 1; j++) {
        const x = c[j], A = atr[j];
        if (j - z.born > 500) break;
        // the zone was alive at the start of this bar: record a touch first, then apply the invalidation rule
        // (checking invalidation first would drop exactly the touches that went badly — a look-ahead bias)
        const touched = z.dir > 0 ? x.l <= z.inner : x.h >= z.inner;
        const fromOutside = (c[j - 1].c - z.inner) * z.dir > 0;
        if (touched && fromOutside && j - lastTouch >= H) {
          const o = trade(c, atr, j, z.dir, z.inner, z.outer, 0.3, T);
          if (tests === 0) push("H1", label ?? z.g, j, o);
          if (withH2) push("H2", `${z.g}：第 ${Math.min(tests, 2) + 1}${tests >= 2 ? "+" : ""} 次触碰`, j, o);
          tests++; lastTouch = j;
        }
        // invalidation (the repo's rule: any wick beyond the outer edge removes the zone)
        if (rule === "wick" ? (z.dir > 0 ? x.l < z.outer : x.h > z.outer) : ((z.outer - x.c) * z.dir > 0.1 * A)) break;
      }
    }
  };
  walkZones(zones, "wick", "供需区（仓库规则：影线越过即失效）", false);
  walkZones(zones, "close", "供需区（收盘越过才失效）", true);
  walkZones(twins, "close", "随机区间(对照)", true);

  // ---------------- swing levels (lines): H2, H3, H4, H5, H6
  const levelsFor = (Lb, Rb, tag) => {
    const out = [];
    for (let i = 300; i < n - Rb - 1; i++) for (const side of ["high", "low"]) {
      if (!pivotsAt(c, i, Lb, Rb, side)) continue;
      out.push({ i, conf: i + Rb, side, dir: side === "low" ? 1 : -1, L: side === "low" ? c[i].l : c[i].h, tag });
    }
    return out;
  };
  const sw5 = levelsFor(5, 5, "左右各 5 根（我们）");
  const sw32 = levelsFor(3, 2, "左 3 右 2（仓库）");

  // equal highs/lows: a swing point within 0.1 ATR of an earlier intact one of the same side (≥2 touches)
  const eq = new Set();
  for (let a = 0; a < sw5.length; a++) for (let b = a - 1; b >= 0 && sw5[a].i - sw5[b].i < 300; b--) {
    if (sw5[b].side !== sw5[a].side) continue;
    if (Math.abs(sw5[a].L - sw5[b].L) <= 0.1 * atr[sw5[a].i]) { eq.add(sw5[a]); break; }
  }

  for (const lv of [...sw5, ...sw32]) {
    let tests = 0, lastTouch = -1e9, deadWick = null, deadClose = null, deadDeep = null;
    for (let j = lv.conf + 1; j < Math.min(n - 1, lv.conf + 500); j++) {
      const x = c[j], A = atr[j], beyondWick = lv.dir > 0 ? x.l < lv.L : x.h > lv.L, beyondClose = (lv.L - x.c) * lv.dir;
      const touched = (lv.dir > 0 ? x.l - lv.L : lv.L - x.h) <= 0.2 * A;
      const fromOutside = (c[j - 1].c - lv.L) * lv.dir > 0.3 * A;
      if (deadClose == null && touched && fromOutside && j - lastTouch >= H) {
        const o = trade(c, atr, j, lv.dir, lv.L + lv.dir * 0.2 * A, lv.L, 0.8, T);
        if (lv.tag.startsWith("左右各 5")) {
          push("H2", `结构高低点：第 ${Math.min(tests, 2) + 1}${tests >= 2 ? "+" : ""} 次触碰`, j, o);
          // H4: sweep = pokes beyond by >0.1 ATR within 3 bars but closes back on our side
          let swept = false, broke = false;
          for (let k = j; k <= Math.min(n - 1, j + 3); k++) {
            const poke = lv.dir > 0 ? lv.L - c[k].l : c[k].h - lv.L;
            if ((lv.L - c[k].c) * lv.dir > 0.1 * atr[k]) { broke = true; break; }
            if (poke > 0.1 * atr[k]) swept = true;
          }
          push("H4", eq.has(lv) ? "等高 / 等低点" : "单一高低点", j, o, { swept, broke });
        }
        push("H6", lv.tag, j, o);
        tests++; lastTouch = j;
      }
      if (deadWick == null && beyondWick) deadWick = j;
      if (deadClose == null && beyondClose > 0.1 * A) deadClose = j;
      if (deadDeep == null && beyondClose > 0.8 * A) deadDeep = j;
      if (deadClose != null && deadDeep != null) break;
    }
    // H3: after each rule says "dead", did the level actually fail? fail = within H bars price closes 1 ATR beyond;
    // false alarm = within H bars price is back on the original side by 1 ATR first.
    if (lv.tag.startsWith("左右各 5")) for (const [rule, j0] of [["影线越过（仓库）", deadWick], ["收盘越过 0.1 倍波幅（我们）", deadClose], ["收盘越过 0.8 倍波幅", deadDeep]]) {
      if (j0 == null) continue;
      let verdict = "未定";
      for (let k = j0 + 1; k <= Math.min(n - 1, j0 + H); k++) {
        const A = atr[k];
        if ((lv.L - c[k].c) * lv.dir > 1 * A) { verdict = "真跌破"; break; }
        if ((c[k].c - lv.L) * lv.dir > 1 * A) { verdict = "误判（位置其实守住了）"; break; }
      }
      ev.push({ h: "H3", g: rule, p: half(j0), r: 0, held: verdict === "误判（位置其实守住了）" ? false : verdict === "真跌破" ? true : null });
    }
  }

  // ---------------- H5: breakouts of intact swing levels (ours), split by relative volume
  // measured as excess over the average H-bar drift, so a bull market doesn't flatter upside breakouts
  let mu = 0, mn = 0;
  for (let j = 300; j < n - H - 1; j++) { mu += (c[j + H].c - c[j].c) / c[j].c; mn++; }
  mu /= mn || 1;
  for (const lv of sw5) {
    for (let j = lv.conf + 1; j < Math.min(n - H - 1, lv.conf + 500); j++) {
      const A = atr[j];
      if ((lv.L - c[j].c) * lv.dir > 0.1 * A) {
        // broke through: direction of the breakout is -dir
        const vols = c.slice(Math.max(0, j - 20), j).map((x) => x.v).sort((a, b) => a - b);
        const med = vols[Math.floor(vols.length / 2)] || 0, rv = med > 0 ? c[j].v / med : NaN;
        const bdir = -lv.dir, ret = (((c[j + H].c - c[j].c) / c[j].c) - mu) * bdir - COST;
        const g = rv >= 2 ? "放量突破（≥2 倍）" : rv >= 1 ? "普通量突破（1–2 倍）" : "缩量突破（<1 倍）";
        ev.push({ h: "H5", g, p: half(j), r: +(ret * 100).toFixed(3), held: ret + COST > 0 });
        break;
      }
    }
  }
  // H5 baseline: every bar, same horizon, random direction
  for (let j = 300; j < n - H - 1; j += H) {
    const bdir = rnd() < 0.5 ? 1 : -1, ret = (((c[j + H].c - c[j].c) / c[j].c) - mu) * bdir - COST;
    ev.push({ h: "H5", g: "随机方向(对照)", p: half(j), r: +(ret * 100).toFixed(3), held: ret + COST > 0 });
  }
  return { n, from: c[0].t, to: c[n - 1].t, ev };
}

const out = {};
for (const k of DATASETS) { const t0 = Date.now(); out[k] = run(k); console.error(k, out[k].ev.length, "events", ((Date.now() - t0) / 1000).toFixed(0), "s"); }
fs.writeFileSync(OUT, JSON.stringify(out));
