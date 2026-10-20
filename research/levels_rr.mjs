// E6: which level-finding methods give trades with better risk/reward than random lines?
// Event study: every time price comes back to a level known at that moment, simulate a trade
// against the level under three entry styles and record the outcome in R (risk units).
import fs from "node:fs";
import { levelCandidates, periodCandidates } from "../src/lib/ta/levels.ts";

const S = process.argv[2], OUT = process.argv[3], DATASETS = process.argv.slice(4);
const load = (k) => JSON.parse(fs.readFileSync(`${S}/hist/${k}.json`, "utf8"));
const atrOf = (c, n = 14) => { const a = new Array(c.length).fill(NaN); let s = 0; for (let i = 1; i < c.length; i++) { const tr = Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c)); if (i <= n) { s += tr; if (i === n) a[i] = s / n; } else a[i] = (a[i - 1] * (n - 1) + tr) / n; } return a; };

const COST = 0.0015;            // round trip: 0.05% taker × 2 + 0.05% slippage, as a share of price
const TARGETS = [1, 2, 3, 5];
// A = front-run with a tight stop just beyond the level (the "short 87,000, stop 87,400" style)
// B = enter at the level, stop beyond the p80 sweep depth
// C = swing-failure: price pokes through the level, closes back; enter on that close, stop above the poke
const STYLES = { A: { e: 0.5, b: 0.05 }, B: { e: 0.1, b: 0.85 }, C: {} };

let seed = 20261019; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

function groupOf(c) {
  const l = c.label;
  switch (c.method) {
    case "volume": return l.includes("POC") ? "成交量 POC" : l.includes("VAH") || l.includes("VAL") ? "成交量 价值区边缘" : "成交量 高量节点";
    case "ma": return l.includes("EMA20") ? "EMA20" : l.includes("EMA50") ? "EMA50" : l.includes("EMA100") ? "EMA100" : "MA200";
    case "prevHL": return l.includes("PDH") || l.includes("PDL") ? "前日高低" : l.includes("上周") ? "前周高低" : "前月高低";
    default: return { swing: "摆动高低(ZigZag)", fractal: "分形", pivot: "经典 Pivot", camarilla: "Camarilla", fibPivot: "Fib Pivot", fib: "斐波那契回撤", donchian: "Donchian 20", keltner: "Keltner", bollinger: "布林带", avwap: "锚定 VWAP", round: "整数关口" }[c.method];
  }
}

function pivots(c, from, to, K, side) {
  const out = [];
  for (let i = Math.max(from, K); i <= to - K; i++) {
    let ok = true;
    for (let j = i - K; j <= i + K && ok; j++) if (j !== i && (side === "high" ? c[j].h > c[i].h : c[j].l < c[i].l)) ok = false;
    if (ok) out.push(i);
  }
  return out;
}

function run(key) {
  const c = load(key), tf = key.endsWith("4h") ? "4h" : "1d", daily = load(key.replace(/_(4h|1d)$/, "_1d"));
  const atr = atrOf(c), n = c.length;
  const step = tf === "4h" ? 3 : 1, T = tf === "4h" ? 60 : 30, K = tf === "4h" ? 5 : 3;
  const bars = (days) => (tf === "4h" ? days * 6 : days);
  const res = {}; // style -> group -> [{y, r:[...targets], mfe}]
  const last = {}; // dedupe: style|group -> [{L, j}]
  const placebo = []; // {L, side, born}
  let di = 0;

  const simulate = (side, E, Sp, j0) => { // trade opened at price E on bar j0 (simulation starts at bar j0+1)
    const R = Math.abs(Sp - E); if (!(R > 0)) return null;
    const sg = side === "short" ? 1 : -1;
    let mfe = 0, stopped = false, end = Math.min(n - 1, j0 + T);
    for (let k = j0 + 1; k <= end; k++) {
      if ((sg > 0 ? c[k].h >= Sp : c[k].l <= Sp)) { stopped = true; break; }
      mfe = Math.max(mfe, (sg > 0 ? E - c[k].l : c[k].h - E) / R);
    }
    const closeR = stopped ? -1 : Math.max(-1, (sg > 0 ? E - c[end].c : c[end].c - E) / R);
    const cost = (COST * E) / R;
    return { r: TARGETS.map((m) => (mfe >= m ? m : stopped ? -1 : Math.min(m, closeR)) - cost), mfe, R };
  };
  const ema = (v, q) => { const k = 2 / (q + 1), o = []; let e = v[0]; for (const x of v) { e = x * k + e * (1 - k); o.push(e); } return o; };
  const dcl = daily.map((x) => x.c), e50 = ema(dcl, 50), e200 = ema(dcl, 200);
  const align = (side, reg) => (reg === "flat" ? 0 : (side === "short") === (reg === "down") ? 1 : -1);
  let meta = null; // regime + confluence of the level whose event is being pushed
  const push = (style, g, ev, y) => { if (!ev) return; ev.y = y; ev.meta = meta; ((res[style] ??= {})[g] ??= []).push(ev); };
  const fresh = (style, g, L, j, A) => {
    const arr = ((last[`${style}|${g}`]) ??= []);
    if (arr.some((x) => j - x.j < 12 && Math.abs(x.L - L) < 0.3 * A)) return false;
    arr.push({ L, j }); if (arr.length > 50) arr.shift(); return true;
  };

  for (let t = 600; t < n - 2; t += step) {
    const A = atr[t], p = c[t].c, y = new Date(c[t].t * 1000).getUTCFullYear();
    // ---- levels known at the close of bar t
    const lv = [];
    const win = c.slice(Math.max(0, t - 999), t + 1);
    for (const x of levelCandidates(win, tf)) lv.push({ g: groupOf(x), L: x.price });
    while (di + 1 < daily.length && daily[di + 1].t <= c[t].t) di++;
    for (const x of periodCandidates(daily.slice(Math.max(0, di - 70), di + 1), p)) lv.push({ g: groupOf(x), L: x.price });
    // daily trend regime from the last completed day
    const dd = Math.max(0, di - 1);
    const maReg = dcl[dd] < e200[dd] && e50[dd] < e200[dd] ? "down" : dcl[dd] > e200[dd] && e50[dd] > e200[dd] ? "up" : "flat";
    const lastPiv = { high: [], low: [] };
    for (const [name, N] of [["滚动 100 根高低", 100], ["滚动 200 根高低", 200], ["滚动 500 根高低", 500], ["近 7 日高低", bars(7)], ["近 30 日高低", bars(30)]]) {
      let hi = -Infinity, lo = Infinity;
      for (let i = Math.max(0, t - N + 1); i <= t; i++) { hi = Math.max(hi, c[i].h); lo = Math.min(lo, c[i].l); }
      lv.push({ g: name, L: hi }, { g: name, L: lo });
    }
    // intact structural pivots (K bars each side, confirmed), with test counts (E4 definition)
    for (const side of ["high", "low"]) {
      const sg = side === "high" ? 1 : -1;
      for (const i of pivots(c, t - 400, t, K, side)) {
        if (i + K > t) continue;
        lastPiv[side].push(i);
        const L = side === "high" ? c[i].h : c[i].l;
        let tests = 0, lastT = -99, broken = false;
        for (let j = i + K + 1; j <= t; j++) {
          if ((c[j].c - L) * sg > 0.1 * atr[j]) { broken = true; break; }
          if ((L - (side === "high" ? c[j].h : c[j].l)) * sg <= 0.3 * atr[j] && j - lastT >= 3) { tests++; lastT = j; }
        }
        if (broken) continue;
        lv.push({ g: "结构高低点(未破)", L });
        if (tests >= 2) lv.push({ g: "结构高低点(测试≥2次)", L });
      }
    }
    // rejection-wick clusters: ≥2 long wicks ending within 0.3 ATR, never closed through
    for (const side of ["high", "low"]) {
      const sg = side === "high" ? 1 : -1, wk = [];
      for (let i = Math.max(1, t - 300); i <= t; i++) {
        const x = c[i], rng = x.h - x.l, wick = side === "high" ? x.h - Math.max(x.o, x.c) : Math.min(x.o, x.c) - x.l;
        if (rng > 0 && wick >= 0.5 * rng && wick >= 0.5 * atr[i]) wk.push({ i, L: side === "high" ? x.h : x.l });
      }
      wk.sort((a, b) => a.L - b.L);
      for (let a = 0; a < wk.length; a++) {
        const grp = wk.filter((w) => Math.abs(w.L - wk[a].L) <= 0.3 * A);
        if (grp.length < 2 || grp.some((w) => w.L * sg > wk[a].L * sg)) continue; // anchor = most extreme of the cluster
        const first = Math.min(...grp.map((w) => w.i));
        let broken = false;
        for (let j = first + 1; j <= t && !broken; j++) if ((c[j].c - wk[a].L) * sg > 0.1 * atr[j]) broken = true;
        if (!broken) lv.push({ g: "影线密集区", L: wk[a].L });
      }
    }
    // placebo: random lines that live like real ones (until broken or 300 bars old)
    for (let k = placebo.length - 1; k >= 0; k--) {
      const q = placebo[k];
      if (t - q.born > 300 || (q.above ? p > q.L : p < q.L)) placebo.splice(k, 1);
    }
    for (let k = 0; k < 2; k++) placebo.push({ L: p + (0.3 + rnd() * 5.7) * A, born: t, above: true }, { L: p - (0.3 + rnd() * 5.7) * A, born: t, above: false });
    for (const q of placebo) lv.push({ g: "随机价格线(对照)", L: q.L });

    // price structure on this timeframe: last two confirmed swing highs and lows
    const ph = lastPiv.high.slice(-2), pl = lastPiv.low.slice(-2);
    const stReg = ph.length === 2 && pl.length === 2 ? (c[ph[1]].h < c[ph[0]].h && c[pl[1]].l < c[pl[0]].l ? "down" : c[ph[1]].h > c[ph[0]].h && c[pl[1]].l > c[pl[0]].l ? "up" : "flat") : "flat";
    // confluence: distinct real methods within 0.3 ATR of each level
    const real = lv.filter((x) => x.g !== "随机价格线(对照)" && x.g !== "结构高低点(测试≥2次)");
    for (const x of lv) { const gs = new Set(); for (const r of real) if (Math.abs(r.L - x.L) <= 0.3 * A) gs.add(r.g); x.cf = gs.size; }

    // ---- events in the next `step` bars
    for (const { g, L, cf } of lv) {
      if (!(L > 0)) continue;
      const side = L > p ? "short" : "long", sg = side === "short" ? 1 : -1;
      meta = [align(side, stReg), align(side, maReg), cf];
      if (Math.abs(L - p) < 0.3 * A) continue;
      for (let j = t + 1; j <= Math.min(t + step, n - 2); j++) {
        const prev = c[j - 1].c, x = c[j];
        for (const st of ["A", "B"]) {
          const { e, b } = STYLES[st], E = L - sg * e * A, Sp = L + sg * b * A;
          if ((E - p) * sg <= 0) continue;                        // entry must still be ahead of price at t
          if ((E - prev) * sg <= 0) continue;                     // approach from the near side
          if ((sg > 0 ? x.h >= E : x.l <= E) && fresh(st, g, L, j, A)) {
            // conservative: a bar that reaches the stop as well counts as stopped
            if (sg > 0 ? x.h >= Sp : x.l <= Sp) push(st, g, { y, r: TARGETS.map(() => -1 - (COST * E) / Math.abs(Sp - E)), mfe: 0, R: Math.abs(Sp - E) }, y);
            else push(st, g, simulate(side, E, Sp, j), y);
          }
        }
        // C: swing failure at the level
        if ((prev - L) * sg < 0 && (sg > 0 ? x.h > L + 0.05 * A && x.c < L : x.l < L - 0.05 * A && x.c > L) && fresh("C", g, L, j, A)) {
          const Sp = (sg > 0 ? x.h : x.l) + sg * 0.1 * A;
          push("C", g, simulate(side, x.c, Sp, j), y);
        }
      }
    }
  }
  return res;
}

const all = {};
for (const k of DATASETS) { const t0 = Date.now(); all[k] = run(k); console.error(k, "done", ((Date.now() - t0) / 1000).toFixed(0), "s"); }
// compact: store per event [year, r1, r2, r3, r5, mfe]
const compact = {};
for (const [k, v] of Object.entries(all)) { compact[k] = {}; for (const [st, gs] of Object.entries(v)) { compact[k][st] = {}; for (const [g, evs] of Object.entries(gs)) compact[k][st][g] = evs.map((e) => [e.y, ...e.r.map((x) => +x.toFixed(3)), +e.mfe.toFixed(2), ...e.meta]); } }
fs.writeFileSync(OUT, JSON.stringify(compact));
