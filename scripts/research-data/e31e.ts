/**
 * E31e：到了关键位，看“站没站稳”再决定减不减，比现在“碰到就减三分之一”好不好。规则在跑之前定好：
 *
 * - 入场、止损、离场同 E31 的 A（交易计划页同一套 `findEntries`，跟着结构移动认错位，不加仓），所以每种做法离场时刻相同，
 *   差别只来自在关键位减不减、什么时候减。
 * - 关键位（页面用 4 小时计划的关键位，这里用摆动点近似）：入场时已经确认、在入场价之外（做多：上方）、
 *   之后还没有收盘越过的 4 小时和日线摆动点（做多取高点，做空取低点），0.25 ATR 内合并，取最近的 2 个。
 * - A 不减：一直拿到移动认错位。
 * - K 碰到就减（现在的页面）：影线第一次碰到第 1、第 2 个关键位，按关键位价各减初始仓位的 1/3。
 * - S 看收盘：碰到关键位的那根收盘回到关键位以内（没站稳）→ 这根收盘减 1/3；收盘在关键位之外（站稳）→ 不减，这个位作废。
 * - S2 看两根收盘：碰到的那根和下一根都收在关键位之外才算站稳；其中任意一根收回来 → 那根收盘减 1/3。
 * - S5 没站稳减一半：同 S，但减 1/2。
 * - 变体（环境变量）：NEAR=x 冲到离关键位 x 倍 ATR 内就算“冲击”（没碰到也算，比如冲到 78,800 没上 79,000）；
 *   ROUND=1 关键位再加整数关口（价格的上一位整数，BTC 1,000、ETH 100）。另按做多 / 做空分开列。
 * - 成本、资金费、R、切分、达标同 E31。
 *
 *   node --experimental-strip-types scripts/research-data/e31e.ts <dataDir>   [环境变量 TF=4h|1d]
 */
import { readFileSync } from "node:fs";
import { alignHigher, findEntries, MAX_HOLD_BARS } from "../../src/lib/ta/plan.ts";
import { atrSeries, bufferAtr, calibrate } from "../../src/lib/ta/risk.ts";
import { structureDirection, structureSeries, swings, type Swing } from "../../src/lib/ta/structure.ts";
import { BUILTIN_COINS } from "../../src/lib/symbols.ts";
import type { Candle, Timeframe } from "../../src/lib/types.ts";

const dir = process.argv[2];
const TF = (process.env.TF ?? "4h") as Timeframe;
const FILTER: Timeframe = TF === "4h" ? "1d" : "1w";
const COST = 0.0015;
const SWING_ATR = 2;
const HORIZON: Record<string, number> = { "4h": 18, "1d": 10 };
const WARMUP = 300;
const MAXBARS = MAX_HOLD_BARS[TF] ?? 120;
const OOS = Date.UTC(2025, 9, 27) / 1000;
const NEAR = Number(process.env.NEAR ?? 0);
const ROUND = process.env.ROUND === "1";
const SEC = TF === "4h" ? 14400 : 86400;

type J = { d1: number[][]; h4: number[][]; funding: number[][] };
const bars = (rows: number[][]): Candle[] => rows.map((r) => ({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] }));
function weekly(d: Candle[]): Candle[] {
  const out: Candle[] = [];
  for (const b of d) {
    const wk = b.t - (((Math.floor(b.t / 86400) + 3) % 7) * 86400);
    const w = out[out.length - 1];
    if (w && w.t === wk) Object.assign(w, { h: Math.max(w.h, b.h), l: Math.min(w.l, b.l), c: b.c, v: w.v + b.v });
    else out.push({ ...b, t: wk });
  }
  return out;
}

const KEYS = ["A", "K", "S", "S2", "S5"] as const;
type Key = (typeof KEYS)[number];
type Res = { coin: string; t: number; dir: number; touched: number; stood: number; cutsS: number } & Record<Key, number>;
type Cut = { i: number; price: number; frac: number };

function run(coin: string): Res[] {
  const j: J = JSON.parse(readFileSync(`${dir}/e30/${coin}.json`, "utf8"));
  const d1 = bars(j.d1);
  const c = TF === "4h" ? bars(j.h4) : d1;
  const f = TF === "4h" ? d1 : weekly(d1);
  if (c.length < WARMUP + 200) return [];
  const atr = atrSeries(c);
  const ss = structureSeries(c, atr, SWING_ATR);
  const sw = swings(c, atr, SWING_ATR);
  const fAtr = atrSeries(f);
  const fsw = swings(f, fAtr, SWING_ATR);
  const fss = structureSeries(f, fAtr, SWING_ATR);
  const fIdx = alignHigher(c, TF, f, FILTER);
  const isEnd = c.findIndex((x) => x.t >= OOS);
  const cal = calibrate(c.slice(0, isEnd > 0 ? isEnd : c.length), TF, HORIZON[TF]);
  const buf = bufferAtr(cal, 80);
  const evs = findEntries({ tf: TF, c, atr, ss, filterAt: (t) => (fIdx[t] < 0 ? 0 : structureDirection(fss[fIdx[t]])), buf, from: WARMUP });
  const fund = j.funding;
  const fSec = TF === "4h" ? 86400 : 7 * 86400;

  function path(i: number, d: 1 | -1, stop0: number) {
    let stop = stop0, k = 0;
    while (k < sw.length && sw[k].confirmedAt <= i) k++;
    const end = Math.min(c.length - 1, i + MAXBARS);
    for (let jj = i + 1; jj <= end; jj++) {
      const b = c[jj];
      if (d > 0 ? b.l <= stop : b.h >= stop) return { exitBar: jj, exitPx: d > 0 ? Math.min(stop, b.o) : Math.max(stop, b.o) };
      while (k < sw.length && sw[k].confirmedAt <= jj) {
        const s: Swing = sw[k++];
        if (s.kind !== (d > 0 ? "low" : "high")) continue;
        const level = s.price - d * buf * atr[jj];
        if ((level - stop) * d > 0 && (b.c - level) * d > 0) stop = level;
      }
      if (jj === i + MAXBARS) return { exitBar: jj, exitPx: b.c };
    }
    return null;
  }

  // the 2 nearest unbroken opposite swings (4h and 1d) beyond the entry, known at the entry close
  function levelsAt(i: number, d: 1 | -1, E: number): number[] {
    const kind = d > 0 ? "high" : "low";
    const cand: number[] = [];
    for (const s of sw) {
      if (s.confirmedAt > i || s.kind !== kind || d * (s.price - E) <= 0) continue;
      let broken = false;
      for (let jj = s.i + 1; jj <= i; jj++) if (d * (c[jj].c - s.price) > 0) { broken = true; break; }
      if (!broken) cand.push(s.price);
    }
    const tEnd = c[i].t + SEC;
    for (const s of fsw) {
      if (f[s.confirmedAt].t + fSec > tEnd || s.kind !== kind || d * (s.price - E) <= 0) continue;
      let broken = false;
      for (let jj = s.i + 1; jj < f.length && f[jj].t + fSec <= tEnd; jj++) if (d * (f[jj].c - s.price) > 0) { broken = true; break; }
      if (!broken) cand.push(s.price);
    }
    if (ROUND) {
      const step = 10 ** (Math.floor(Math.log10(E)) - 1);
      for (let k = 1; k <= 3; k++) cand.push((d > 0 ? Math.ceil(E / step) + k - 1 : Math.floor(E / step) - k + 1) * step);
    }
    cand.sort((a, b) => d * (a - b));
    const out: number[] = [];
    for (const x of cand) if (!out.length || Math.abs(x - out[out.length - 1]) > 0.25 * atr[i]) out.push(x);
    return out.slice(0, 2);
  }

  // net result in R of the first fill: cuts close shares at their bar, the rest at the exit
  function result(E: number, i: number, d: 1 | -1, q0: number, exitBar: number, exitPx: number, cuts: Cut[]) {
    const legs = [...cuts.map((x) => ({ bar: x.i, px: x.price, frac: x.frac, atClose: x.price === c[x.i].c })), { bar: exitBar, px: exitPx, frac: 1 - cuts.reduce((s, x) => s + x.frac, 0), atClose: exitPx === c[exitBar].c }];
    let pnl = -COST / 2 * E * q0;
    for (const L of legs) {
      const q = q0 * L.frac;
      pnl += d * (L.px - E) * q - (COST / 2) * L.px * q;
      const from = c[i].t + SEC, to = c[L.bar].t + (L.atClose ? SEC : 0);
      for (const [ft, rate] of fund) if (ft > from && ft <= to) pnl -= d * rate * E * q;
    }
    return pnl;
  }

  const out: Res[] = [];
  let free = -1;
  for (const e of evs) {
    if (e.i < free) continue;
    const d = e.dir, E = c[e.i].c, risk0 = (E - e.stop) * d;
    const p = path(e.i, d, e.stop);
    if (!p) continue;
    free = p.exitBar;
    const q0 = 1 / risk0;
    const lv = levelsAt(e.i, d, E);
    const beyond = (x: number, L: number) => d * (x - L) > 0;
    const touch = (jj: number, L: number) => (d > 0 ? c[jj].h >= L - NEAR * atr[jj] : c[jj].l <= L + NEAR * atr[jj]);

    const K: Cut[] = [], S: Cut[] = [], S2: Cut[] = [], S5: Cut[] = [];
    let touched = 0, stood = 0;
    for (const L of lv) {
      let tj = -1;
      for (let jj = e.i + 1; jj < p.exitBar; jj++) if (touch(jj, L)) { tj = jj; break; }
      if (tj < 0) continue;
      touched++;
      // K is the page's limit order at the level: only filled when the level itself is reached
      for (let jj = tj; jj < p.exitBar; jj++) if (d > 0 ? c[jj].h >= L : c[jj].l <= L) { K.push({ i: jj, price: d > 0 ? Math.max(L, c[jj].o) : Math.min(L, c[jj].o), frac: 1 / 3 }); break; }
      if (beyond(c[tj].c, L)) stood++;
      else (S.push({ i: tj, price: c[tj].c, frac: 1 / 3 }), S5.push({ i: tj, price: c[tj].c, frac: 1 / 2 }));
      if (!beyond(c[tj].c, L)) S2.push({ i: tj, price: c[tj].c, frac: 1 / 3 });
      else if (tj + 1 < p.exitBar && !beyond(c[tj + 1].c, L)) S2.push({ i: tj + 1, price: c[tj + 1].c, frac: 1 / 3 });
    }
    // S5 can cut 1/2 twice: cap the total at the full position less a share left to trail
    if (S5.length === 2) S5[1].frac = 1 / 3;
    const R = (cuts: Cut[]) => result(E, e.i, d, q0, p.exitBar, p.exitPx, cuts);
    out.push({ coin, t: c[e.i].t, dir: d, touched, stood, cutsS: S.length, A: R([]), K: R(K), S: R(S), S2: R(S2), S5: R(S5) });
  }
  return out;
}

const all = BUILTIN_COINS.flatMap((x) => run(x.id));
const firstT = Math.min(...all.map((x) => x.t));
const MID = firstT + (OOS - firstT) / 2;
const groups: [string, (x: Res) => boolean][] = [
  ["样本内", (x) => x.t < OOS],
  ["前半", (x) => x.t < MID],
  ["后半", (x) => x.t >= MID && x.t < OOS],
  ["BTC", (x) => x.coin === "BTC" && x.t < OOS],
  ["ETH", (x) => x.coin === "ETH" && x.t < OOS],
  ["样本外", (x) => x.t >= OOS],
  ["做多", (x) => x.dir > 0 && x.t < OOS],
  ["做空", (x) => x.dir < 0 && x.t < OOS],
];
const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const sd = (a: number[]) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
const f2 = (x: number) => (Number.isFinite(x) ? (x >= 0 ? "+" : "") + x.toFixed(2) : "—");
function maxDD(rows: Res[], k: Key) {
  let eq = 0, peak = 0, dd = 0;
  for (const x of [...rows].sort((a, b) => a.t - b.t)) {
    eq += x[k];
    peak = Math.max(peak, eq);
    dd = Math.max(dd, peak - eq);
  }
  return dd;
}
const NAME: Record<Key, string> = { A: "A 不减", K: "K 碰到就减（现在）", S: "S 收盘没站稳才减", S2: "S2 两根收盘没站稳才减", S5: "S5 没站稳减一半" };

const is = all.filter((x) => x.t < OOS);
console.log(`E31e 关键位站稳再决定减不减  周期 ${TF}  冲击 = 离关键位 ${NEAR} ATR 内${ROUND ? "  含整数关口" : ""}（${FILTER} 定方向）  样本外从 2025-10-27`);
console.log(`交易 ${all.length} 笔（样本内 ${is.length}），起点 ${new Date(firstT * 1000).toISOString().slice(0, 10)}`);
const lvT = is.reduce((s, x) => s + x.touched, 0);
console.log(`碰到关键位 ${lvT} 次（${((is.filter((x) => x.touched > 0).length / is.length) * 100).toFixed(0)}% 的交易碰到过），其中碰到那根收盘站在位外 ${((is.reduce((s, x) => s + x.stood, 0) / lvT) * 100).toFixed(0)}%`);

console.log("\n各做法（样本内，R / 笔）：");
console.log("做法                    平均     中位    标准差   赚钱%   最大单笔  最大回撤(R)");
for (const k of KEYS) {
  const a = is.map((x) => x[k]);
  console.log(`${NAME[k].padEnd(16, "　")}${f2(mean(a)).padStart(7)} ${f2(med(a)).padStart(7)} ${sd(a).toFixed(2).padStart(7)} ${((a.filter((x) => x > 0).length / a.length) * 100).toFixed(0).padStart(6)} ${f2(Math.max(...a)).padStart(8)} ${maxDD(is, k).toFixed(1).padStart(10)}`);
}
console.log("\n平均（R / 笔）按切分：");
console.log(`切分      笔数  ${KEYS.map((k) => k.padEnd(7)).join(" ")}`);
for (const [g, fn] of groups) {
  const rows = all.filter(fn);
  console.log(`${g.padEnd(6, "　")}${String(rows.length).padStart(5)} ${KEYS.map((k) => f2(mean(rows.map((x) => x[k]))).padStart(7)).join(" ")}`);
}

function paired(a: Key, b: Key) {
  console.log(`\n${NAME[a]} 对 ${NAME[b]}（配对差，R / 笔）：`);
  const signs: number[] = [];
  for (const [g, fn] of groups) {
    const dif = all.filter(fn).map((x) => x[a] - x[b]);
    const m = mean(dif), t = m / (sd(dif) / Math.sqrt(dif.length));
    if (g !== "样本内" && g !== "做多" && g !== "做空") signs.push(Math.sign(m));
    console.log(`  ${g.padEnd(6, "　")}${f2(m).padStart(7)}  t ${t.toFixed(2).padStart(6)}`);
  }
  const dif = is.map((x) => x[a] - x[b]);
  const m = mean(dif), t = m / (sd(dif) / Math.sqrt(dif.length));
  const ok = Math.abs(m) >= 0.1 && Math.abs(t) >= 2 && signs.every((s) => s === Math.sign(m));
  console.log(`  结论：${ok ? (m > 0 ? "达标（更好）" : "达标（更差）") : "未达标"}`);
}
paired("S", "K");
paired("S2", "K");
paired("S5", "K");
paired("K", "A");
paired("S", "A");

// the trend trades the question is about: A made ≥ 5R
for (const th of [3, 5]) {
  const big = is.filter((x) => x.A >= th);
  console.log(`\nA ≥ ${th}R 的大行情 ${big.length} 笔（样本内）：平均 A ${f2(mean(big.map((x) => x.A)))}，${KEYS.slice(1).map((k) => `${k} ${f2(mean(big.map((x) => x[k])))}`).join("，")}`);
}
const small = is.filter((x) => x.A < 3);
console.log(`其余 ${small.length} 笔：平均 A ${f2(mean(small.map((x) => x.A)))}，${KEYS.slice(1).map((k) => `${k} ${f2(mean(small.map((x) => x[k])))}`).join("，")}`);
