/**
 * E47：亏损时补仓（拉低均价）有没有用。规则在跑之前定好；入场、认错位、离场和 E31 完全相同：
 *
 * - 数据：Binance 永续 4 小时 / 日线和资金费率（e30-fetch.ts 的 <dataDir>/e30/<COIN>.json），1 小时 K 线
 *   （e31-fetch.ts 的 <dataDir>/e31/<COIN>.json，S2 的转强确认用），10 个研究币。
 * - 入场：计划页同一套 `findEntries`（4 小时入场、日线结构定方向），一个币同时只拿一笔。止损 = 页面的认错位
 *   （保护摆动点 anchor 外加 p80 扫损缓冲）。离场：跟着结构移动认错位（只收紧），最长 MAX_HOLD_BARS。
 * - 所有做法在初始止损处最多亏 1R（R = 一次满仓打到初始止损的亏损），只有 S3 例外（它就是“不认错”的做法）。
 *   所以差别只来自“在哪里、什么时候把仓位放上去”。
 * - A 一次满仓：入场收盘满仓（1R）。
 * - S1 计划内分批（碰到就补）：入场先开 q1，价格逆向碰到补仓位 L 就按 L 成交补 q2，止损不动；
 *   q1 = q2 = 1 / ((E − stop) + (L − stop))（两笔都打到止损合计正好 1R）。没碰到 L 就只有 q1（风险更小）。
 *   L 两种：L50 = 入场和止损的正中间；Lanc = 止损保护的摆动点本身（止损在它外面一个扫损缓冲）。
 * - S2 转强才补：同 S1 的 q1 和 L，碰到 L 之后的 24 根 1 小时 K 线内，第一次 1 小时收盘越过之前 3 根 1 小时的
 *   最高（做空：最低）才按那根收盘补，补的数量让两笔合计打到当时的止损仍是 1R；先打到止损或 24 根内没转强就不补。
 * - S3 摊平（反面对照）：入场满仓 1R；止损还没上移、价格打到初始止损时不走，在那里再加一样多，止损往外挪 1R，
 *   最多两次（最后止损在入场外 3R），之后照常跟着结构收紧。打穿全部时亏 1 + 2 + 3 = 6R。
 * - 成本：每笔成交按成交额扣 0.15%（来回）；资金费按持有期间每次结算。
 * - 切分：样本外 = 最近 12 个月（2025-11-08 起），样本内再分前后两半；BTC、ETH 单看。
 * - 达标（同 engine.ts 的 judge）：对 A 的配对平均差 ≥ 0.1R，t ≥ 2，BTC / ETH / 前后两半 / 样本外方向一致。
 * - 另外记录（决策矩阵用）：入场后先碰到 L 的比例，碰到 L 之后最后被止损 / 能到 +1R 的比例。
 *
 *   node --experimental-strip-types scripts/research-data/e47.ts <dataDir>
 */
import { readFileSync } from "node:fs";
import { alignHigher, findEntries, MAX_HOLD_BARS } from "../../src/lib/ta/plan.ts";
import { atrSeries, bufferAtr, calibrate } from "../../src/lib/ta/risk.ts";
import { structureDirection, structureSeries, swings, type Swing } from "../../src/lib/ta/structure.ts";
import { BUILTIN_COINS } from "../../src/lib/symbols.ts";
import type { Candle } from "../../src/lib/types.ts";

const dir = process.argv[2];
if (!dir) {
  console.log("usage: node --experimental-strip-types scripts/research-data/e47.ts <dataDir>");
  process.exit(1);
}
const TF = "4h" as const;
const COST = 0.0015;
const SWING_ATR = 2;
const WARMUP = 300;
const MAXBARS = MAX_HOLD_BARS[TF] ?? 120;
const OOS = Date.UTC(2025, 10, 8) / 1000;
const CONFIRM_1H = 24;
const H4 = 14400;

type Fill = { price: number; qty: number; i: number };
type Res = { coin: string; t: number; A: number; S1m: number; S1a: number; S2m: number; S2a: number; S3: number; touchM: boolean; touchA: boolean; addS2m: boolean; addS2a: boolean; addsS3: number; mfeA: number };

const bars = (rows: number[][]): Candle[] => rows.map((r) => ({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] }));

function run(coin: string): Res[] {
  const j = JSON.parse(readFileSync(`${dir}/e30/${coin}.json`, "utf8")) as { d1: number[][]; h4: number[][]; funding: number[][] };
  const h1 = bars((JSON.parse(readFileSync(`${dir}/e31/${coin}.json`, "utf8")) as { h1: number[][] }).h1);
  const d1 = bars(j.d1), c = bars(j.h4);
  if (c.length < WARMUP + 200) return [];
  const atr = atrSeries(c);
  const ss = structureSeries(c, atr, SWING_ATR);
  const sw = swings(c, atr, SWING_ATR);
  const fss = structureSeries(d1, atrSeries(d1), SWING_ATR);
  const fIdx = alignHigher(c, TF, d1, "1d");
  const isEnd = c.findIndex((x) => x.t >= OOS);
  const buf = bufferAtr(calibrate(c.slice(0, isEnd > 0 ? isEnd : c.length), TF, 18), 80);
  const evs = findEntries({ tf: TF, c, atr, ss, filterAt: (t) => (fIdx[t] < 0 ? 0 : structureDirection(fss[fIdx[t]])), buf, from: WARMUP });
  const fund = j.funding;
  // first 1-hour bar of each 4-hour bar
  const h1At: number[] = [];
  for (let jj = 0, k = 0; jj < c.length; jj++) {
    while (k < h1.length && h1[k].t < c[jj].t) k++;
    h1At[jj] = k;
  }

  /** The trailing stop after an entry (E31's), optionally starting from a stop that `moveOut` may push out once per touch. */
  function trail(i: number, d: 1 | -1, stop0: number, onTouch?: (jj: number, stop: number, untrailed: boolean) => number | null) {
    const stops: number[] = [];
    let stop = stop0, k = 0, trailed = false;
    while (k < sw.length && sw[k].confirmedAt <= i) k++;
    const end = Math.min(c.length - 1, i + MAXBARS);
    for (let jj = i + 1; jj <= end; jj++) {
      const b = c[jj];
      stops[jj] = stop;
      if (d > 0 ? b.l <= stop : b.h >= stop) {
        const pushed = onTouch?.(jj, stop, !trailed);
        if (pushed == null) return { exitBar: jj, exitPx: d > 0 ? Math.min(stop, b.o) : Math.max(stop, b.o), stops };
        stop = pushed;
        stops[jj] = stop;
        if (d > 0 ? b.l <= stop : b.h >= stop) {
          const again = onTouch?.(jj, stop, true);
          if (again == null) return { exitBar: jj, exitPx: stop, stops };
          stop = again;
          if (d > 0 ? b.l <= stop : b.h >= stop) return { exitBar: jj, exitPx: stop, stops };
        }
      }
      while (k < sw.length && sw[k].confirmedAt <= jj) {
        const s: Swing = sw[k++];
        if (s.kind !== (d > 0 ? "low" : "high")) continue;
        const level = s.price - d * buf * atr[jj];
        if ((level - stop) * d > 0 && (b.c - level) * d > 0) (stop = level), (trailed = true);
      }
      stops[jj + 1] = stop;
      if (jj === i + MAXBARS) return { exitBar: jj, exitPx: b.c, stops };
    }
    return null;
  }

  function result(fills: Fill[], d: 1 | -1, exitBar: number, exitPx: number) {
    let pnl = 0;
    for (const x of fills) {
      pnl += d * (exitPx - x.price) * x.qty - COST * x.price * x.qty;
      const from = c[x.i].t + H4, to = c[exitBar].t + (exitPx === c[exitBar].c ? H4 : 0);
      for (const [ft, rate] of fund) if (ft > from && ft <= to) pnl -= d * rate * x.price * x.qty;
    }
    return pnl;
  }

  const out: Res[] = [];
  let free = -1;
  for (const e of evs) {
    if (e.i < free) continue;
    const d = e.dir, E = c[e.i].c, stop0 = e.stop, R0 = (E - stop0) * d;
    const p = trail(e.i, d, stop0);
    if (!p) continue;
    free = p.exitBar;
    const A = result([{ price: E, qty: 1 / R0, i: e.i }], d, p.exitBar, p.exitPx);

    // the best close-to-close excursion of A before its exit, in R (for the decision stats)
    let mfe = 0;
    for (let jj = e.i + 1; jj <= p.exitBar; jj++) mfe = Math.max(mfe, (d * ((d > 0 ? c[jj].h : c[jj].l) - E)) / R0);

    // first 4-hour bar that reaches L before (or on) the exit bar
    const touchBar = (L: number) => {
      for (let jj = e.i + 1; jj <= p.exitBar; jj++) if (d > 0 ? c[jj].l <= L : c[jj].h >= L) return jj;
      return -1;
    };
    const s1 = (L: number) => {
      const q = 1 / ((E - stop0) * d + (L - stop0) * d);
      const fills: Fill[] = [{ price: E, qty: q, i: e.i }];
      const tb = touchBar(L);
      if (tb > 0) fills.push({ price: d > 0 ? Math.min(L, c[tb].o) : Math.max(L, c[tb].o), qty: q, i: tb });
      return { r: result(fills, d, p.exitBar, p.exitPx), touched: tb > 0 };
    };
    const s2 = (L: number) => {
      const q1 = 1 / ((E - stop0) * d + (L - stop0) * d);
      const fills: Fill[] = [{ price: E, qty: q1, i: e.i }];
      const tb = touchBar(L);
      let added = false;
      if (tb > 0) {
        // the 1-hour bar that touched L, then a close beyond the last 3 hours' extreme
        let k = h1At[tb];
        while (k < h1.length && h1[k].t < c[tb].t + H4 && !(d > 0 ? h1[k].l <= L : h1[k].h >= L)) k++;
        for (let n = 1; n <= CONFIRM_1H && k + n < h1.length; n++) {
          const b = h1[k + n];
          const i4 = Math.floor((b.t - c[e.i].t) / H4) + e.i;
          if (i4 > p.exitBar || (i4 === p.exitBar && b.t + 3600 > c[p.exitBar].t + H4)) break;
          const stop = p.stops[i4] ?? stop0;
          if (d > 0 ? b.l <= stop : b.h >= stop) break;
          const prev = h1.slice(Math.max(0, k + n - 3), k + n);
          const ext = d > 0 ? Math.max(...prev.map((x) => x.h)) : Math.min(...prev.map((x) => x.l));
          if (d * (b.c - ext) > 0) {
            // the remaining budget at the stop in force: both fills together lose 1R there
            const left = 1 - q1 * d * (E - stop);
            const q2 = Math.max(0, Math.min(3 * q1, left / (d * (b.c - stop))));
            // fills after the 1-hour close: count from the 4-hour bar it closes in
            if (q2 > 0 && i4 < p.exitBar) (fills.push({ price: b.c, qty: q2, i: i4 }), (added = true));
            break;
          }
        }
      }
      return { r: result(fills, d, p.exitBar, p.exitPx), added };
    };
    const m = s1(E - d * 0.5 * R0), a = s1(e.anchor);
    const m2 = s2(E - d * 0.5 * R0), a2 = s2(e.anchor);

    // S3: at the untrailed initial stop, add as much again and push the stop out 1R; twice at most
    let adds = 0;
    const f3: Fill[] = [{ price: E, qty: 1 / R0, i: e.i }];
    const p3 = trail(e.i, d, stop0, (jj, stop, untrailed) => {
      if (!untrailed || adds >= 2) return null;
      adds++;
      f3.push({ price: stop, qty: 1 / R0, i: jj });
      return stop - d * R0;
    });
    const S3 = p3 ? result(f3, d, p3.exitBar, p3.exitPx) : A;

    out.push({ coin, t: c[e.i].t, A, S1m: m.r, S1a: a.r, S2m: m2.r, S2a: a2.r, S3, touchM: m.touched, touchA: a.touched, addS2m: m2.added, addS2a: a2.added, addsS3: adds, mfeA: mfe });
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
];
const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const sd = (a: number[]) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
const f2 = (x: number) => (Number.isFinite(x) ? (x >= 0 ? "+" : "") + x.toFixed(2) : "—");
const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(0)}%` : "—");
function maxDD(rows: Res[], k: keyof Res) {
  let eq = 0, peak = 0, dd = 0;
  for (const x of [...rows].sort((a, b) => a.t - b.t)) {
    eq += x[k] as number;
    peak = Math.max(peak, eq);
    dd = Math.max(dd, peak - eq);
  }
  return dd;
}

const is = all.filter((x) => x.t < OOS);
console.log(`E47 亏损补仓  周期 4h（日线定方向）  样本外从 2025-11-08`);
console.log(`交易 ${all.length} 笔（样本内 ${is.length}），币 ${new Set(all.map((x) => x.coin)).size} 个，起点 ${new Date(firstT * 1000).toISOString().slice(0, 10)}`);

const V: [keyof Res, string][] = [["A", "A 一次满仓"], ["S1m", "S1 L50 碰到就补"], ["S1a", "S1 摆动点碰到就补"], ["S2m", "S2 L50 转强才补"], ["S2a", "S2 摆动点转强才补"], ["S3", "S3 摊平(反面)"]];
console.log("\n各做法（样本内，R / 笔）：");
console.log("做法                平均     中位    标准差   赚钱%   亏>1.1R%  亏>1.5R%  最差     最大回撤(R)");
for (const [k, n] of V) {
  const a = is.map((x) => x[k] as number);
  console.log(`${n.padEnd(14, "　")}${f2(mean(a)).padStart(7)} ${f2(med(a)).padStart(7)} ${sd(a).toFixed(2).padStart(7)} ${pct(a.filter((x) => x > 0).length, a.length).padStart(6)} ${pct(a.filter((x) => x < -1.1).length, a.length).padStart(8)} ${pct(a.filter((x) => x < -1.5).length, a.length).padStart(8)} ${f2(Math.min(...a)).padStart(7)} ${maxDD(is, k).toFixed(1).padStart(10)}`);
}

console.log("\n平均（R / 笔）按切分：");
console.log(`切分      笔数  ${V.map(([k]) => String(k).padEnd(7)).join(" ")}`);
for (const [g, fn] of groups) {
  const rows = all.filter(fn);
  console.log(`${g.padEnd(6, "　")}${String(rows.length).padStart(5)} ${V.map(([k]) => f2(mean(rows.map((x) => x[k] as number))).padStart(7)).join(" ")}`);
}

const verdicts: Record<string, string> = {};
function paired(a: keyof Res, b: keyof Res, name: string) {
  console.log(`\n${name}（配对差，R / 笔；t = 平均 / 标准误）：`);
  const signs: number[] = [];
  for (const [g, fn] of groups) {
    const dif = all.filter(fn).map((x) => (x[a] as number) - (x[b] as number));
    const m = mean(dif), t = m / (sd(dif) / Math.sqrt(dif.length));
    if (g !== "样本内") signs.push(Math.sign(m));
    console.log(`  ${g.padEnd(6, "　")}${f2(m).padStart(7)}  t ${t.toFixed(2).padStart(6)}  更好 ${pct(dif.filter((x) => x > 1e-9).length, dif.length)}  更差 ${pct(dif.filter((x) => x < -1e-9).length, dif.length)}`);
  }
  const dif = is.map((x) => (x[a] as number) - (x[b] as number));
  const m = mean(dif), t = m / (sd(dif) / Math.sqrt(dif.length));
  const ok = m >= 0.1 && t >= 2 && signs.every((s) => s === Math.sign(m));
  const worse = m <= -0.1 && t <= -2 && signs.every((s) => s === Math.sign(m));
  verdicts[name] = ok ? "达标（有优势）" : worse ? "比满仓差（达到“更差”）" : m >= 0.1 && t >= 2 ? "样本内显著但切分不一致 → 未达标" : "未达标";
  console.log(`  结论：${verdicts[name]}`);
}
paired("S1m", "A", "S1 L50 碰到就补 对 A");
paired("S1a", "A", "S1 摆动点碰到就补 对 A");
paired("S2m", "A", "S2 L50 转强才补 对 A");
paired("S2a", "A", "S2 摆动点转强才补 对 A");
paired("S2m", "S1m", "S2 对 S1（L50：等转强 对 碰到就补）");
paired("S2a", "S1a", "S2 对 S1（摆动点：等转强 对 碰到就补）");
paired("S3", "A", "S3 摊平 对 A");

console.log("\n决策矩阵用的频率（样本内）：");
for (const [k, n] of [["touchM", "L50（入场到止损的中间）"], ["touchA", "保护摆动点本身"]] as const) {
  const t = is.filter((x) => x[k]);
  const stopped = t.filter((x) => x.A < 0).length, reached = t.filter((x) => x.mfeA >= 1).length;
  console.log(`  碰到 ${n}：${pct(t.length, is.length)} 的交易；碰到之后 A 最后亏钱 ${pct(stopped, t.length)}，之后曾到过 +1R ${pct(reached, t.length)}；没碰到的交易 A 平均 ${f2(mean(is.filter((x) => !x[k]).map((x) => x.A)))}，碰到的 ${f2(mean(t.map((x) => x.A)))}`);
}
console.log(`  S2 实际补上：L50 ${pct(is.filter((x) => x.addS2m).length, is.filter((x) => x.touchM).length)}，摆动点 ${pct(is.filter((x) => x.addS2a).length, is.filter((x) => x.touchA).length)}（占碰到的交易）`);
const s3 = is.filter((x) => x.addsS3 > 0);
console.log(`  S3 摊平过的交易 ${pct(s3.length, is.length)}：其中 A 平均 ${f2(mean(s3.map((x) => x.A)))}，S3 平均 ${f2(mean(s3.map((x) => x.S3)))}；S3 亏超 3R 的 ${pct(is.filter((x) => x.S3 < -3).length, is.length)}（全部交易），最差 ${f2(Math.min(...is.map((x) => x.S3)))}`);
console.log(`\nJSON ${JSON.stringify({ n: is.length, verdicts, mean: Object.fromEntries(V.map(([k]) => [k, +mean(is.map((x) => x[k] as number)).toFixed(3)])), oos: Object.fromEntries(V.map(([k]) => [k, +mean(all.filter((x) => x.t >= OOS).map((x) => x[k] as number)).toFixed(3)])), touch: { L50: +(is.filter((x) => x.touchM).length / is.length).toFixed(3), anchor: +(is.filter((x) => x.touchA).length / is.length).toFixed(3) }, lossAfterTouch: { L50: +(is.filter((x) => x.touchM && x.A < 0).length / Math.max(1, is.filter((x) => x.touchM).length)).toFixed(3), anchor: +(is.filter((x) => x.touchA && x.A < 0).length / Math.max(1, is.filter((x) => x.touchA).length)).toFixed(3) } })}`);
