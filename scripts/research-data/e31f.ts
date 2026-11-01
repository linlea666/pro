/**
 * E31f：站稳第一个关键位后把止损移到开仓价（保本），之后滚仓更激进，好不好。规则在跑之前定好：
 *
 * - 入场、结构移动认错位、关键位同 E31 / E31e（关键位 = 入场时还没被收盘越过的 4 小时和日线摆动点，取最近的一个）。
 * - 保本规则（都只在收盘后调整、只收紧，之后照常跟着结构移）：
 *   N 不移（现在）；L 4 小时收盘站上第一个关键位后移到开仓价（用户的做法）；
 *   R1 收盘浮盈到 1R 后移；A1 收盘离开仓价 1 倍 ATR 后移；Q 入场后下一根收盘赚钱就移（“太早移”的对照）。
 * - 每种保本规则下三种仓位：不滚（只有第一笔）、进取：保本滚（预算 0、每次 ≤ 上一笔、最多 5 次）、
 *   激进（预算 1R、同上）。加仓时点同 E31 的 B：收盘越过最近确认的摆动高点 0.1 ATR，且在上一笔之外。
 * - 成本、资金费、R、切分同 E31。另统计：打到保本出场的比例，其中按 N（不移）本来能拿到 ≥ 1R 的比例（“扫掉的好单”）。
 *
 *   node --experimental-strip-types scripts/research-data/e31f.ts <dataDir>
 */
import { readFileSync } from "node:fs";
import { alignHigher, findEntries, MAX_HOLD_BARS } from "../../src/lib/ta/plan.ts";
import { atrSeries, bufferAtr, calibrate } from "../../src/lib/ta/risk.ts";
import { structureDirection, structureSeries, swings, type Swing } from "../../src/lib/ta/structure.ts";
import { maxAdd, positionOf, type Fill } from "../../src/lib/ta/roll.ts";
import { BUILTIN_COINS } from "../../src/lib/symbols.ts";
import type { Candle, Timeframe } from "../../src/lib/types.ts";

const dir = process.argv[2];
const TF: Timeframe = "4h";
const FILTER: Timeframe = "1d";
const COST = 0.0015;
const PIERCE = 0.1;
const SWING_ATR = 2;
const WARMUP = 300;
const MAXBARS = MAX_HOLD_BARS[TF] ?? 120;
const OOS = Date.UTC(2025, 9, 27) / 1000;
const SEC = 14400;

type J = { d1: number[][]; h4: number[][]; funding: number[][] };
const bars = (rows: number[][]): Candle[] => rows.map((r) => ({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] }));

const RULES = ["N", "L", "R1", "A1", "Q"] as const;
type Rule = (typeof RULES)[number];
const SIZES = ["one", "bold", "agg"] as const;
type Size = (typeof SIZES)[number];
type Key = `${Rule}_${Size}`;
type Res = { coin: string; t: number; dir: number; be: Record<Rule, number>; beGood: Record<Rule, number> } & Record<Key, number>;

function run(coin: string): Res[] {
  const j: J = JSON.parse(readFileSync(`${dir}/e30/${coin}.json`, "utf8"));
  const d1 = bars(j.d1);
  const c = bars(j.h4);
  if (c.length < WARMUP + 200) return [];
  const atr = atrSeries(c);
  const ss = structureSeries(c, atr, SWING_ATR);
  const sw = swings(c, atr, SWING_ATR);
  const fAtr = atrSeries(d1);
  const fsw = swings(d1, fAtr, SWING_ATR);
  const fss = structureSeries(d1, fAtr, SWING_ATR);
  const fIdx = alignHigher(c, TF, d1, FILTER);
  const isEnd = c.findIndex((x) => x.t >= OOS);
  const cal = calibrate(c.slice(0, isEnd > 0 ? isEnd : c.length), TF, 18);
  const buf = bufferAtr(cal, 80);
  const evs = findEntries({ tf: TF, c, atr, ss, filterAt: (t) => (fIdx[t] < 0 ? 0 : structureDirection(fss[fIdx[t]])), buf, from: WARMUP });
  const fund = j.funding;

  function firstLevel(i: number, d: 1 | -1, E: number): number | null {
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
      if (d1[s.confirmedAt].t + 86400 > tEnd || s.kind !== kind || d * (s.price - E) <= 0) continue;
      let broken = false;
      for (let jj = s.i + 1; jj < d1.length && d1[jj].t + 86400 <= tEnd; jj++) if (d * (d1[jj].c - s.price) > 0) { broken = true; break; }
      if (!broken) cand.push(s.price);
    }
    cand.sort((a, b) => d * (a - b));
    return cand[0] ?? null;
  }

  // the stop path under a break-even rule: stops[jj] is in force during bar jj
  function path(i: number, d: 1 | -1, stop0: number, rule: Rule, L: number | null) {
    const stops: number[] = [];
    const E = c[i].c, risk0 = d * (E - stop0);
    let stop = stop0, k = 0, be = false;
    while (k < sw.length && sw[k].confirmedAt <= i) k++;
    const end = Math.min(c.length - 1, i + MAXBARS);
    for (let jj = i + 1; jj <= end; jj++) {
      const b = c[jj];
      stops[jj] = stop;
      if (d > 0 ? b.l <= stop : b.h >= stop) return { exitBar: jj, exitPx: d > 0 ? Math.min(stop, b.o) : Math.max(stop, b.o), stops, atBe: be && stop === E };
      while (k < sw.length && sw[k].confirmedAt <= jj) {
        const s: Swing = sw[k++];
        if (s.kind !== (d > 0 ? "low" : "high")) continue;
        const level = s.price - d * buf * atr[jj];
        if ((level - stop) * d > 0 && (b.c - level) * d > 0) stop = level;
      }
      if (!be) {
        const gain = d * (b.c - E);
        const hit =
          rule === "L" ? L != null && d * (b.c - L) > 0 : rule === "R1" ? gain >= risk0 : rule === "A1" ? gain >= atr[i] : rule === "Q" ? gain > 0 : false;
        if (hit) {
          be = true;
          if (d * (E - stop) > 0) stop = E;
        }
      }
      stops[jj + 1] = stop;
      if (jj === i + MAXBARS) return { exitBar: jj, exitPx: b.c, stops, atBe: false };
    }
    return null;
  }

  function result(fills: (Fill & { i: number })[], d: 1 | -1, exitBar: number, exitPx: number) {
    let pnl = 0;
    for (const x of fills) {
      pnl += d * (exitPx - x.price) * x.qty - COST * x.price * x.qty;
      const from = c[x.i].t + SEC, to = c[exitBar].t + (exitPx === c[exitBar].c ? SEC : 0);
      for (const [ft, rate] of fund) if (ft > from && ft <= to) pnl -= d * rate * x.price * x.qty;
    }
    return pnl;
  }

  const out: Res[] = [];
  let free = -1;
  for (const e of evs) {
    if (e.i < free) continue;
    const d = e.dir, E = c[e.i].c, risk0 = (E - e.stop) * d;
    const L = firstLevel(e.i, d, E);
    const paths = Object.fromEntries(RULES.map((r) => [r, path(e.i, d, e.stop, r, L)])) as Record<Rule, ReturnType<typeof path>>;
    if (RULES.some((r) => !paths[r])) continue;
    free = Math.max(...RULES.map((r) => paths[r]!.exitBar));
    const first: Fill & { i: number } = { kind: "open", price: E, qty: 1 / risk0, i: e.i };
    const row = { coin, t: c[e.i].t, dir: d, be: {} as Record<Rule, number>, beGood: {} as Record<Rule, number> } as Res;
    const nRes = result([first], d, paths.N!.exitBar, paths.N!.exitPx);
    for (const r of RULES) {
      const p = paths[r]!;
      const rolled = (budget: number) => {
        const fills = [first];
        for (let jj = e.i + 1; jj < p.exitBar && fills.length - 1 < 5; jj++) {
          const s = ss[jj], ext = d > 0 ? s.lastHigh : s.lastLow;
          if (!ext || !(atr[jj] > 0)) continue;
          const lvl = ext.price + d * PIERCE * atr[jj];
          if (!((c[jj].c - lvl) * d > 0 && (c[jj - 1].c - lvl) * d <= 0)) continue;
          if ((ext.price - fills[fills.length - 1].price) * d <= 0) continue;
          const x = maxAdd({ pos: positionOf(d, fills, 0), price: c[jj].c, stop: p.stops[jj + 1], budget, mode: "cross", leverage: 1, account: 1e18, atr: null, fee: 0, rules: { pyramid: 1, maxAdds: 5 } }).qty;
          if (x > 0) fills.push({ kind: "add", price: c[jj].c, qty: x, i: jj });
        }
        return result(fills, d, p.exitBar, p.exitPx);
      };
      row[`${r}_one`] = result([first], d, p.exitBar, p.exitPx);
      row[`${r}_bold`] = rolled(0);
      row[`${r}_agg`] = rolled(1);
      row.be[r] = p.atBe ? 1 : 0;
      row.beGood[r] = p.atBe && nRes >= 1 ? 1 : 0;
    }
    out.push(row);
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
function maxDD(rows: Res[], k: Key) {
  let eq = 0, peak = 0, dd = 0;
  for (const x of [...rows].sort((a, b) => a.t - b.t)) { eq += x[k]; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  return dd;
}
const RN: Record<Rule, string> = { N: "不移保本（现在）", L: "站上第一个关键位后保本", R1: "浮盈 1R 后保本", A1: "离开仓价 1 ATR 后保本", Q: "下一根赚钱就保本" };
const SN: Record<Size, string> = { one: "不滚", bold: "保本滚", agg: "激进滚" };
const is = all.filter((x) => x.t < OOS);
console.log(`E31f 保本止损的时机  4 小时（日线定方向）  样本外从 2025-10-27`);
console.log(`交易 ${all.length} 笔（样本内 ${is.length}）`);
for (const s of SIZES) {
  console.log(`\n${SN[s]}（样本内，R / 笔）：`);
  console.log("保本规则                    平均     中位   赚钱%  最大回撤  打到保本%  其中本来能赚≥1R%  大行情(N≥5R)");
  const big = is.filter((x) => x.N_one >= 5);
  for (const r of RULES) {
    const k = `${r}_${s}` as Key, a = is.map((x) => x[k]);
    const be = is.filter((x) => x.be[r]).length;
    console.log(`${RN[r].padEnd(14, "　")}${f2(mean(a)).padStart(7)} ${f2(med(a)).padStart(7)} ${((a.filter((x) => x > 0).length / a.length) * 100).toFixed(0).padStart(6)} ${maxDD(is, k).toFixed(1).padStart(8)} ${((be / is.length) * 100).toFixed(0).padStart(9)} ${(be ? (is.filter((x) => x.beGood[r]).length / be) * 100 : 0).toFixed(0).padStart(14)} ${f2(mean(big.map((x) => x[k]))).padStart(12)}`);
  }
}
function paired(a: Key, b: Key) {
  console.log(`\n${RN[a.split("_")[0] as Rule]}·${SN[a.split("_")[1] as Size]} 对 ${RN[b.split("_")[0] as Rule]}·${SN[b.split("_")[1] as Size]}（配对差，R / 笔）：`);
  const signs: number[] = [];
  for (const [g, fn] of groups) {
    const dif = all.filter(fn).map((x) => x[a] - x[b]);
    const m = mean(dif), t = m / (sd(dif) / Math.sqrt(dif.length));
    if (g !== "样本内") signs.push(Math.sign(m));
    console.log(`  ${g.padEnd(6, "　")}${f2(m).padStart(7)}  t ${t.toFixed(2).padStart(6)}`);
  }
  const dif = is.map((x) => x[a] - x[b]);
  const m = mean(dif), t = m / (sd(dif) / Math.sqrt(dif.length));
  console.log(`  结论：${Math.abs(m) >= 0.1 && Math.abs(t) >= 2 && signs.every((s) => s === Math.sign(m)) ? (m > 0 ? "达标（更好）" : "达标（更差）") : "未达标"}`);
}
for (const s of SIZES) for (const r of ["L", "R1", "A1", "Q"] as Rule[]) paired(`${r}_${s}` as Key, `N_${s}` as Key);
paired("L_agg", "N_one");
paired("L_bold", "N_one");
