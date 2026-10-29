/**
 * E31：滚仓（顺势加仓）有没有用。规则在跑之前定好，和滚仓助手页面（src/lib/ta/roll.ts）同一套：
 *
 * - 数据：Binance 永续 4 小时 / 日线和资金费率（e30-fetch.ts 的 <dataDir>/e30/<COIN>.json），10 个研究币。
 *   周线由日线合成（周一开）。
 * - 入场：交易计划页同一套 `findEntries`（突破跟随、顺势回调、等收盘确认、逆势反转，两个方向），
 *   4 小时入场配日线结构、日线入场配周线结构；一个币同时只拿一笔（样本不重叠）。止损 = 页面的认错位（p80 扫损缓冲）。
 * - 离场：跟着结构移动认错位（同 sim.ts 的 structure：新的摆动点确认后、收盘在它外面才上移，只收紧），
 *   最长 180 / 90 根。止损那根按止损价成交，跳空按开盘价。所有做法的止损路径相同，所以离场时刻相同，
 *   差别只来自加不加、什么时候加、加多少。
 * - A 不滚：只拿第一笔。
 * - B 滚仓（页面规则）：持仓中某根收盘越过最近确认的摆动高点（做空：低点）0.1 ATR、上一根还没越过，
 *   且这个摆动点在上一笔成交价之外 → 这根收盘加仓。数量 = roll.ts 的 `maxAdd`：只在赚钱一边，加完整笔打到
 *   当前（已上移的）止损最多亏 BUDGET 倍初始风险（默认 1；B0 = 0，保本滚仓），不超过上一笔的 PYR（0.5），最多 3 次。
 * - C 随机时点加：同一笔交易、同样的加仓次数（B 加了几次 C 就加几次）、同一个数量规则，但加仓的那根 K 线
 *   在持仓期间随机挑（证明“越过摆动点再加”这个时点有没有用）。每笔 20 次随机。
 * - D 固定 2R 止盈、不加仓（新手常见做法的对照）。
 * - 成本：每一笔成交按成交额扣 0.15%（来回，同 stats.ts）；资金费按每次结算时的持仓数量 × 当时价格 × 费率。
 * - R = 第一笔的初始风险（入场到止损的距离 × 第一笔数量），所有做法同一个分母。
 * - 切分：样本外 = 最近 12 个月（2025-10-27 起），样本内再分前后两半；BTC、ETH 单看。
 * - 达标（同 engine.ts 的 judge）：B 对 A（或对 C）配对平均差 ≥ 0.1R，t ≥ 2，BTC / ETH / 前后两半 / 样本外方向一致。
 *
 *   node --experimental-strip-types scripts/research-data/e31.ts <dataDir>   [环境变量 TF=4h|1d、BUDGET、PYR、MAXADDS]
 */
import { readFileSync } from "node:fs";
import { alignHigher, findEntries, MAX_HOLD_BARS } from "../../src/lib/ta/plan.ts";
import { atrSeries, bufferAtr, calibrate } from "../../src/lib/ta/risk.ts";
import { structureDirection, structureSeries, swings, type Swing } from "../../src/lib/ta/structure.ts";
import { maxAdd, positionOf, type Fill } from "../../src/lib/ta/roll.ts";
import { BUILTIN_COINS } from "../../src/lib/symbols.ts";
import type { Candle, Timeframe } from "../../src/lib/types.ts";

const dir = process.argv[2];
const TF = (process.env.TF ?? "4h") as Timeframe;
const FILTER: Timeframe = TF === "4h" ? "1d" : "1w";
const BUDGET = Number(process.env.BUDGET ?? 1);
const PYR = Number(process.env.PYR ?? 0.5);
const MAXADDS = Number(process.env.MAXADDS ?? 3);
const RANDOMS = 20;
/** E31b: confirm adds on 1-hour or 15-minute closes beyond the same 4-hour swing (needs e31-fetch.ts data) */
const FAST = process.env.FAST ?? "";
/** E31c: giveback cut (peak floating ≥ GB_PEAK R, a close back to ≤ GB_KEEP of it → cut GB_CUT of the position, once) */
const GB_PEAK = Number(process.env.GB_PEAK ?? 1.5);
const GB_KEEP = Number(process.env.GB_KEEP ?? 0.5);
const GB_CUT = Number(process.env.GB_CUT ?? 1 / 3);
const GB_UNIT = process.env.GB_UNIT ?? "r";
/** E31c: no add when the close is more than EXT ATR beyond the swing */
const EXT = Number(process.env.EXT ?? 1.5);
const COST = 0.0015;
const PIERCE = 0.1;
const SWING_ATR = 2;
const HORIZON: Record<string, number> = { "4h": 18, "1d": 10 };
const WARMUP = 300;
const MAXBARS = MAX_HOLD_BARS[TF] ?? 120;
const OOS = Date.UTC(2025, 9, 27) / 1000;

type J = { d1: number[][]; h4: number[][]; funding: number[][] };
const bars = (rows: number[][]): Candle[] => rows.map((r) => ({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] }));
function weekly(d: Candle[]): Candle[] {
  const out: Candle[] = [];
  for (const b of d) {
    const wk = b.t - (((Math.floor(b.t / 86400) + 3) % 7) * 86400); // Monday 00:00 UTC
    const w = out[out.length - 1];
    if (w && w.t === wk) Object.assign(w, { h: Math.max(w.h, b.h), l: Math.min(w.l, b.l), c: b.c, v: w.v + b.v });
    else out.push({ ...b, t: wk });
  }
  return out;
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

type Res = { coin: string; t: number; A: number; B: number; B0: number; C: number; D: number; F: number; addsB: number; addsB0: number; addedB: number; addsF: number; gapB: number[]; gapF: number[]; G: number; BG: number; X: number; cutG: number; cutBG: number; skippedX: number };

function run(coin: string): Res[] {
  const j: J = JSON.parse(readFileSync(`${dir}/e30/${coin}.json`, "utf8"));
  const d1 = bars(j.d1);
  const c = TF === "4h" ? bars(j.h4) : d1;
  const f = TF === "4h" ? d1 : weekly(d1);
  if (c.length < WARMUP + 200) return [];
  const atr = atrSeries(c);
  const ss = structureSeries(c, atr, SWING_ATR);
  const sw = swings(c, atr, SWING_ATR);
  const fss = structureSeries(f, atrSeries(f), SWING_ATR);
  const fIdx = alignHigher(c, TF, f, FILTER);
  const isEnd = c.findIndex((x) => x.t >= OOS);
  const cal = calibrate(c.slice(0, isEnd > 0 ? isEnd : c.length), TF, HORIZON[TF]);
  const buf = bufferAtr(cal, 80);
  const evs = findEntries({ tf: TF, c, atr, ss, filterAt: (t) => (fIdx[t] < 0 ? 0 : structureDirection(fss[fIdx[t]])), buf, from: WARMUP });
  const fund = j.funding;
  // lower-timeframe closes inside each entry bar, for FAST
  const sub: Candle[] = FAST ? bars(JSON.parse(readFileSync(`${dir}/e31/${coin}.json`, "utf8"))[FAST === "1h" ? "h1" : "m15"]) : [];
  const subStart: number[] = [];
  for (let jj = 0, k = 0; jj < c.length; jj++) {
    while (k < sub.length && sub[k].t < c[jj].t) k++;
    subStart[jj] = k;
  }

  // the stop path after an entry: independent of size, so every variant exits on the same bar
  function path(i: number, d: 1 | -1, stop0: number) {
    const stops: number[] = [];
    let stop = stop0, k = 0;
    while (k < sw.length && sw[k].confirmedAt <= i) k++;
    const end = Math.min(c.length - 1, i + MAXBARS);
    for (let jj = i + 1; jj <= end; jj++) {
      const b = c[jj];
      stops[jj] = stop; // in force during bar jj
      if (d > 0 ? b.l <= stop : b.h >= stop) return { exitBar: jj, exitPx: d > 0 ? Math.min(stop, b.o) : Math.max(stop, b.o), stops };
      while (k < sw.length && sw[k].confirmedAt <= jj) {
        const s: Swing = sw[k++];
        if (s.kind !== (d > 0 ? "low" : "high")) continue;
        const level = s.price - d * buf * atr[jj];
        if ((level - stop) * d > 0 && (b.c - level) * d > 0) stop = level;
      }
      stops[jj + 1] = stop;
      if (jj === i + MAXBARS) return { exitBar: jj, exitPx: b.c, stops };
    }
    return null;
  }

  // net result of a set of fills closed at exitPx on exitBar, in units of the first fill's risk
  function result(fills: (Fill & { i: number })[], d: 1 | -1, exitBar: number, exitPx: number, risk: number) {
    let pnl = 0;
    for (const x of fills) {
      pnl += d * (exitPx - x.price) * x.qty - COST * x.price * x.qty;
      // funding settled while this fill was held
      const from = c[x.i].t + (TF === "4h" ? 14400 : 86400), to = c[exitBar].t + (exitPx === c[exitBar].c ? (TF === "4h" ? 14400 : 86400) : 0);
      for (const [ft, rate] of fund) if (ft > from && ft <= to) pnl -= d * rate * x.price * x.qty;
    }
    return pnl / risk;
  }

  // like result(), with a share of every open lot closed at a cut close (cut = { i, price, frac } or null)
  function resultCut(fills: (Fill & { i: number })[], d: 1 | -1, exitBar: number, exitPx: number, cut: { i: number; price: number; frac: number } | null) {
    if (!cut) return result(fills, d, exitBar, exitPx, 1);
    const before = fills.filter((x) => x.i <= cut.i), after = fills.filter((x) => x.i > cut.i);
    const cutLots = before.map((x) => ({ ...x, qty: x.qty * cut.frac }));
    const keepLots = before.map((x) => ({ ...x, qty: x.qty * (1 - cut.frac) }));
    // the cut share closes at the cut bar's close (funding up to that close)
    return result(cutLots, d, cut.i, cut.price, 1) + result([...keepLots, ...after], d, exitBar, exitPx, 1);
  }
  // the giveback cut on a set of fills: track the position's peak floating profit (bar extremes), cut at the first close
  // that keeps ≤ GB_KEEP of a peak ≥ GB_PEAK (R of the first fill)
  function giveback(fills: (Fill & { i: number })[], d: 1 | -1, from: number, exitBar: number) {
    let peak = 0;
    for (let jj = from + 1; jj < exitBar; jj++) {
      const lots = fills.filter((x) => x.i < jj);
      const at = (px: number) => lots.reduce((s, x) => s + d * (px - x.price) * x.qty, 0);
      peak = Math.max(peak, at(d > 0 ? c[jj].h : c[jj].l));
      // GB_UNIT=atr (the page's version): the best price at least GB_PEAK ATR beyond the average
      const qty = lots.reduce((s, x) => s + x.qty, 0), avg = lots.reduce((s, x) => s + x.price * x.qty, 0) / qty;
      const far = GB_UNIT === "atr" ? peak >= GB_PEAK * atr[jj] * qty : peak >= GB_PEAK;
      if (far && at(c[jj].c) <= GB_KEEP * peak && d * (c[jj].c - avg) > -Infinity) return { i: jj, price: c[jj].c, frac: GB_CUT };
    }
    return null;
  }

  const out: Res[] = [];
  let free = -1;
  const r = rng(coin.charCodeAt(0) * 7919 + coin.length);
  for (const e of evs) {
    if (e.i < free) continue;
    const d = e.dir, E = c[e.i].c, risk0 = (E - e.stop) * d;
    const p = path(e.i, d, e.stop);
    if (!p) continue;
    free = p.exitBar;
    const q0 = 1 / risk0;
    const first: Fill & { i: number } = { kind: "open", price: E, qty: q0, i: e.i };

    // B / B0: add at the close that breaks beyond the last confirmed swing, outside the last fill
    let skipped = 0;
    const rolled = (budget: number, ext0 = Infinity, until = Infinity) => {
      const fills = [first];
      for (let jj = e.i + 1; jj < Math.min(p.exitBar, until) && fills.length - 1 < MAXADDS; jj++) {
        const s = ss[jj], ext = d > 0 ? s.lastHigh : s.lastLow;
        if (!ext || !(atr[jj] > 0)) continue;
        const lvl = ext.price + d * PIERCE * atr[jj];
        if (!((c[jj].c - lvl) * d > 0 && (c[jj - 1].c - lvl) * d <= 0)) continue;
        if ((ext.price - fills[fills.length - 1].price) * d <= 0) continue;
        if (d * (c[jj].c - ext.price) > ext0 * atr[jj]) { skipped++; continue; }
        const x = addAt(fills, jj, budget);
        if (x > 0) fills.push({ kind: "add", price: c[jj].c, qty: x, i: jj });
      }
      return fills;
    };
    const addAt = (fills: Fill[], jj: number, budget: number) => {
      const pos = positionOf(d, fills, 0);
      return maxAdd({ pos, price: c[jj].c, stop: p.stops[jj + 1], budget, mode: "cross", leverage: 1, account: 1e18, atr: null, fee: 0, rules: { pyramid: PYR, maxAdds: MAXADDS } }).qty;
    };
    // F: the same rule, but the close beyond the swing is a lower-timeframe close inside the 4-hour bar
    const gapF: number[] = [];
    const fast = () => {
      const fills = [first];
      if (!FAST) return fills;
      outer: for (let jj = e.i + 1; jj <= p.exitBar && fills.length - 1 < MAXADDS; jj++) {
        const s = ss[jj - 1], ext = d > 0 ? s.lastHigh : s.lastLow;
        if (!ext || !(atr[jj - 1] > 0)) continue;
        if ((ext.price - fills[fills.length - 1].price) * d <= 0) continue;
        const lvl = ext.price + d * PIERCE * atr[jj - 1], stop = p.stops[jj];
        let prev = c[jj - 1].c;
        for (let k = subStart[jj]; k < sub.length && sub[k].t < c[jj].t + 14400; k++) {
          const b = sub[k];
          if (d > 0 ? b.l <= stop : b.h >= stop) break outer;
          if ((b.c - lvl) * d > 0 && (prev - lvl) * d <= 0) {
            const x = maxAdd({ pos: positionOf(d, fills, 0), price: b.c, stop, budget: BUDGET, mode: "cross", leverage: 1, account: 1e18, atr: null, fee: 0, rules: { pyramid: PYR, maxAdds: MAXADDS } }).qty;
            if (x > 0) (fills.push({ kind: "add", price: b.c, qty: x, i: jj }), gapF.push((d * (b.c - ext.price)) / risk0));
            break;
          }
          prev = b.c;
        }
      }
      return fills;
    };
    const ff = fast();
    const fb = rolled(BUDGET), fb0 = rolled(0);
    const gapB = fb.slice(1).map((x) => {
      const ext = d > 0 ? ss[x.i].lastHigh : ss[x.i].lastLow;
      return ext ? (d * (x.price - ext.price)) / risk0 : 0;
    });
    const resB = result(fb, d, p.exitBar, p.exitPx, 1);
    skipped = 0;
    const fx = rolled(BUDGET, EXT);
    const skippedX = skipped;
    // G: no adds, giveback cut; BG: B's adds up to the cut, none after
    const cutA = giveback([first], d, e.i, p.exitBar);
    const fbg = rolled(BUDGET, Infinity, Infinity);
    const cutB = giveback(fbg, d, e.i, p.exitBar);
    const fbg2 = cutB ? fbg.filter((x) => x.i <= cutB.i) : fbg;

    // C: the same number of adds as B, at random bars of the trade, same sizing
    let resC = resB;
    const k = fb.length - 1;
    if (k > 0) {
      let sum = 0;
      for (let rep = 0; rep < RANDOMS; rep++) {
        const fills = [first];
        for (let jj = e.i + 1; jj < p.exitBar && fills.length - 1 < k; jj++) {
          const left = p.exitBar - jj;
          if (r() > (k - (fills.length - 1)) / left) continue;
          const x = addAt(fills, jj, BUDGET);
          if (x > 0) fills.push({ kind: "add", price: c[jj].c, qty: x, i: jj });
        }
        sum += result(fills, d, p.exitBar, p.exitPx, 1);
      }
      resC = sum / RANDOMS;
    }

    // D: fixed 2R target, no adds, initial stop only
    let resD = 0;
    for (let jj = e.i + 1; jj <= Math.min(c.length - 1, e.i + MAXBARS); jj++) {
      const b = c[jj], tgt = E + d * 2 * risk0;
      if (d > 0 ? b.l <= e.stop : b.h >= e.stop) { resD = result([first], d, jj, d > 0 ? Math.min(e.stop, b.o) : Math.max(e.stop, b.o), 1); break; }
      if (d > 0 ? b.h >= tgt : b.l <= tgt) { resD = result([first], d, jj, tgt, 1); break; }
      if (jj === e.i + MAXBARS) resD = result([first], d, jj, b.c, 1);
    }

    out.push({ coin, t: c[e.i].t, G: resultCut([first], d, p.exitBar, p.exitPx, cutA), BG: resultCut(fbg2, d, p.exitBar, p.exitPx, cutB), X: result(fx, d, p.exitBar, p.exitPx, 1), cutG: cutA ? 1 : 0, cutBG: cutB ? 1 : 0, skippedX, A: result([first], d, p.exitBar, p.exitPx, 1), B: resB, F: result(ff, d, p.exitBar, p.exitPx, 1), addsF: ff.length - 1, gapB, gapF, B0: result(fb0, d, p.exitBar, p.exitPx, 1), C: resC, D: resD, addsB: k, addsB0: fb0.length - 1, addedB: fb.slice(1).reduce((s, x) => s + x.qty, 0) / q0 });
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
function maxDD(rows: Res[], k: keyof Res) {
  let eq = 0, peak = 0, dd = 0;
  for (const x of [...rows].sort((a, b) => a.t - b.t)) {
    eq += x[k] as number;
    peak = Math.max(peak, eq);
    dd = Math.max(dd, peak - eq);
  }
  return dd;
}

console.log(`E31 滚仓  周期 ${TF}（${FILTER} 定方向）  预算 ${BUDGET}R  金字塔 ${PYR}  最多加 ${MAXADDS} 次  样本外从 2025-10-27`);
console.log(`交易 ${all.length} 笔（样本内 ${all.filter((x) => x.t < OOS).length}），币 ${new Set(all.map((x) => x.coin)).size} 个，起点 ${new Date(firstT * 1000).toISOString().slice(0, 10)}`);
const is = all.filter((x) => x.t < OOS);
console.log(`\n加仓：B 有加仓的交易 ${((is.filter((x) => x.addsB > 0).length / is.length) * 100).toFixed(0)}%，平均加 ${mean(is.map((x) => x.addsB)).toFixed(2)} 次、加的数量合计为第一笔的 ${mean(is.filter((x) => x.addsB > 0).map((x) => x.addedB)).toFixed(2)} 倍；B0 有加仓 ${((is.filter((x) => x.addsB0 > 0).length / is.length) * 100).toFixed(0)}%`);

const V: [keyof Res, string][] = [["A", "A 不滚"], ["B", "B 滚仓"], ["B0", "B0 保本滚仓"], ["C", "C 随机时点加"], ["D", "D 固定 2R"], ["G", "G 不滚+回吐减"], ["BG", "BG 滚仓+回吐减"], ["X", "X 太远不加"], ...(FAST ? [["F", `F ${FAST} 收盘确认`] as [keyof Res, string]] : [])];
console.log("\n各做法（样本内，R / 笔）：");
console.log("做法          平均     中位    标准差   赚钱%   亏>1.1R%  最大单笔  最大回撤(R)");
for (const [k, n] of V) {
  const a = is.map((x) => x[k] as number);
  console.log(`${n.padEnd(12, "　")}${f2(mean(a)).padStart(7)} ${f2(med(a)).padStart(7)} ${sd(a).toFixed(2).padStart(7)} ${((a.filter((x) => x > 0).length / a.length) * 100).toFixed(0).padStart(6)} ${((a.filter((x) => x < -1.1).length / a.length) * 100).toFixed(1).padStart(8)} ${f2(Math.max(...a)).padStart(8)} ${maxDD(is, k).toFixed(1).padStart(10)}`);
}

console.log("\n平均（R / 笔）按切分：");
console.log(`切分      笔数  ${V.map(([k]) => String(k).padEnd(7)).join(" ")}`);
for (const [g, fn] of groups) {
  const rows = all.filter(fn);
  console.log(`${g.padEnd(6, "　")}${String(rows.length).padStart(5)} ${V.map(([k]) => f2(mean(rows.map((x) => x[k] as number))).padStart(7)).join(" ")}`);
}

function paired(a: keyof Res, b: keyof Res, name: string) {
  console.log(`\n${name}（配对差，R / 笔；t = 平均 / 标准误）：`);
  const signs: number[] = [];
  for (const [g, fn] of groups) {
    const dif = all.filter(fn).map((x) => (x[a] as number) - (x[b] as number));
    const m = mean(dif), t = m / (sd(dif) / Math.sqrt(dif.length));
    if (g !== "样本内") signs.push(Math.sign(m));
    console.log(`  ${g.padEnd(6, "　")}${f2(m).padStart(7)}  t ${t.toFixed(2).padStart(6)}  更好 ${((dif.filter((x) => x > 1e-9).length / dif.length) * 100).toFixed(0)}%  更差 ${((dif.filter((x) => x < -1e-9).length / dif.length) * 100).toFixed(0)}%`);
  }
  const dif = is.map((x) => (x[a] as number) - (x[b] as number));
  const m = mean(dif), t = m / (sd(dif) / Math.sqrt(dif.length));
  const ok = m >= 0.1 && t >= 2 && signs.every((s) => s === Math.sign(m));
  console.log(`  结论：${ok ? "达标（有优势）" : m >= 0.1 && t >= 2 ? "样本内显著，但切分方向不一致 → 未达标" : "未达标"}`);
}
paired("B", "A", "B 滚仓 对 A 不滚");
paired("B0", "A", "B0 保本滚仓 对 A 不滚");
paired("B", "C", "B 越过摆动点再加 对 C 随机时点加");
paired("A", "D", "A 移动认错位 对 D 固定 2R");
console.log(`\nE31c 浮盈回吐：浮盈到过 ${GB_PEAK}R 后收盘只剩 ≤ ${GB_KEEP * 100}% → 减 ${(GB_CUT * 100).toFixed(0)}%（一次）。触发：不滚 ${((is.filter((x) => x.cutG).length / is.length) * 100).toFixed(0)}%，滚仓 ${((is.filter((x) => x.cutBG).length / is.length) * 100).toFixed(0)}%`);
paired("G", "A", "G 不滚 + 浮盈回吐减仓 对 A 不滚");
paired("BG", "B", "BG 滚仓 + 浮盈回吐减仓（之后不再加） 对 B 滚仓");
console.log(`\nE31c 离摆动点超过 ${EXT} 倍 ATR 不加：跳过 ${is.reduce((s, x) => s + x.skippedX, 0)} 次加仓`);
paired("X", "B", `X 离摆动点 > ${EXT} ATR 不加 对 B 滚仓`);
if (FAST) {
  paired("F", "B", `F ${FAST} 收盘确认加仓 对 B 4 小时收盘确认`);
  paired("F", "A", `F ${FAST} 收盘确认加仓 对 A 不滚`);
  const gb = is.flatMap((x) => x.gapB), gf = is.flatMap((x) => x.gapF);
  console.log(`\n加仓价离摆动点多远（R，样本内，越小越接近突破点）：4 小时收盘 平均 ${mean(gb).toFixed(2)}、中位 ${med(gb).toFixed(2)}（${gb.length} 次）；${FAST} 收盘 平均 ${mean(gf).toFixed(2)}、中位 ${med(gf).toFixed(2)}（${gf.length} 次）`);
  const fa = is.filter((x) => x.addsF > 0), dfa = fa.map((x) => x.F - x.A);
  console.log(`F 加过仓的 ${fa.length} 笔：比不滚差的 ${((dfa.filter((x) => x < 0).length / dfa.length) * 100).toFixed(0)}%，好的 ${((dfa.filter((x) => x > 0).length / dfa.length) * 100).toFixed(0)}%；F 有加仓的交易 ${((fa.length / is.length) * 100).toFixed(0)}%`);
}

// only trades where B actually added: the shape the page talks about
const added = is.filter((x) => x.addsB > 0);
const d = added.map((x) => x.B - x.A);
console.log(`\n只看 B 加过仓的 ${added.length} 笔（样本内）：B − A 平均 ${f2(mean(d))}，中位 ${f2(med(d))}；B 比 A 差的 ${((d.filter((x) => x < 0).length / d.length) * 100).toFixed(0)}%（平均差 ${f2(mean(d.filter((x) => x < 0)))}），好的 ${((d.filter((x) => x > 0).length / d.length) * 100).toFixed(0)}%（平均多 ${f2(mean(d.filter((x) => x > 0)))}）`);
const big = [...added].sort((a, b) => b.B - b.A - (a.B - a.A)).slice(0, Math.max(1, Math.round(added.length * 0.05)));
console.log(`  差值最大的 5% 笔贡献了 B − A 总和的 ${((big.reduce((s, x) => s + x.B - x.A, 0) / d.reduce((s, x) => s + x, 0)) * 100).toFixed(0)}%`);
