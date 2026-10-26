/**
 * E28（2026-10-26）：订单流（CVD / 足迹图）的信号能不能让盯盘更好。第一阶段，用 1 分钟 K 线近似足迹图。
 *   DATA_DIR=<研究库> node --experimental-strip-types scripts/research-data/e28.ts
 * 先跑 build.ts 和 e28-fetch.ts。可调：ABS=0.6（吸收的主动卖出占比）、EXH=0.03（衰竭的极端 10% 成交占比）、DBARS=8。
 *
 * 跑之前定好的规则（看结果之前写下，不再改）：
 * - 事件、A / C 两种进场、止损（最新极点外 p80 缓冲 × 1 小时 ATR）、离场（跟着 1 小时摆动点，最长 7 天）、
 *   随机对照（同币、同方向、同止损距离，每笔 3 个）全部沿用 E19（src/lib/research/watch.ts），10 个币，15 分钟 2022 年起。
 * - 四项订单流迹象（做多一侧；做空镜像），在 C 入场时已知：
 *   衰竭 exh：最新极点那根 15 分钟 K 线，最低 10% 价格区间里的成交量（1 分钟 K 线按高低点均摊）不到这根的 3%，
 *     且收在这根的中点之上（Coinglass：“创新低，最低 10% 的价位几乎没有成交，收在上半”）；
 *   吸收 abs：碰到关键位那根起 1 小时（4 根 15 分钟，不超过入场那根），主动卖出占成交 ≥ 60%，
 *     但最低价没有跌破关键位 0.25 倍 1 小时 ATR；
 *   Delta 背离 div：最新极点那根收涨，或 Delta（主动买 − 主动卖）为正；
 *   Delta 背离（Coinglass 写法）div2：最新极点那根收跌，但 Delta 占成交 ≥ +10%（“下跌缺少主动卖盘”）。
 *   在 C 入场上“有对没有”（同 E19b，数据缺失单独计数）。
 * - 三种新进场 D（和 C 一样只在事件窗口 3 天内）：
 *   Dx 衰竭后拐回：新极点那根满足“衰竭”，之后 8 根内、没有再创新低之前，第一次收盘高于这根的最高价就进；
 *   Dd Delta 背离后拐回：同上，条件换成 div；
 *   Da 吸收后站住：碰到后第 4 根收盘时满足“吸收”且收在关键位之上，就在这根收盘进。
 *   止损 = 最新极点外 p80 缓冲。每种对随机入场；并在同一批事件上和 C 配对比较（平均 R、接到半山腰、24 小时内被扫、早进几根）。
 * - 成交量关键位 V：把关键位换成 1 分钟 K 线算的成交量位——前一日 POC / VAH / VAL（价值区 70%）/ VWAP、上周 POC、
 *   最近 20 天还没被碰过的每日 POC（裸 POC）；同样的事件规则（从 0.5 ATR 外来、0.25 ATR 内合并、一个方向 3 天一次），
 *   A 和 C 对随机入场，和原关键位的 A / C 并列。
 * 判定同 engine.ts 的 judge，BH 按组校正。
 */
import { readFileSync } from "node:fs";
import { finish, loadHistory, type ResearchRow } from "../../src/lib/research/run.ts";
import { cells, makeSplit, type Trade } from "../../src/lib/research/engine.ts";
import { simulate, type SimContext } from "../../src/lib/research/sim.ts";
import { DEFAULT_ENGINE_PARAMS } from "../../src/lib/params.ts";
import { RESEARCH_COINS } from "../../src/lib/symbols.ts";
import { alignHigher } from "../../src/lib/ta/plan.ts";
import { atrSeries, bufferAtr } from "../../src/lib/ta/risk.ts";
import { structureSeries, swings, type Swing } from "../../src/lib/ta/structure.ts";
import { eventTriggers, FROM_BARS, levelSource, scanEvents, stopBeyond, type KeyLevel, type LevelSource, type Trigger, type WatchInput } from "../../src/lib/ta/watch.ts";
import type { Candle } from "../../src/lib/types.ts";

const ep = DEFAULT_ENGINE_PARAMS;
const nowSec = Date.parse("2026-10-25T00:00:00Z") / 1000;
const DIR = process.env.DATA_DIR!;
const ABS = Number(process.env.ABS ?? 0.6);
const EXH = Number(process.env.EXH ?? 0.03);
const DBARS = Number(process.env.DBARS ?? 8);
const WARMUP = 300;
const MAX_BARS = 672;
const RECLAIM_BARS = 16;
const HALFWAY_BARS = 96;
const QUICK_BARS = 96;
const NAKED_DAYS = 20;

type Pol = "A" | "C" | "Dx" | "Dd" | "Da" | "VA" | "VC";
const NAME: Record<Pol, string> = {
  A: "A 碰到就进（原关键位）",
  C: "C 15 分钟转强（原关键位）",
  Dx: "Dx 衰竭后拐回",
  Dd: "Dd Delta 背离后拐回",
  Da: "Da 吸收后站住",
  VA: "成交量位 · A 碰到就进",
  VC: "成交量位 · C 15 分钟转强",
};
type Sign = "exh" | "abs" | "div" | "div2";
const SIGN_NAME: Record<Sign, string> = { exh: "衰竭（极点几乎没成交）", abs: "吸收（主动卖很多但跌不下去）", div: "Delta 背离（收涨或 Delta 为正）", div2: "Delta 背离（收跌但 Delta ≥ +10%）" };

interface Taken {
  trade: Trade;
  i: number;
  halfway: boolean;
  quick: boolean;
}
type Row = Omit<ResearchRow, "q" | "consistent" | "verdict">;
const out: string[] = [];
const say = (s: string) => (console.log(s), out.push(s));

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
function lowerBound(arr: ArrayLike<number>, x: number, stride = 1): number {
  let lo = 0, hi = arr.length / stride;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid * stride] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** 1-minute bars: t, o, h, l, c, v, tbv */
function loadM1(coin: string): Float64Array | null {
  try {
    const b = readFileSync(`${DIR}/m1/${coin}.bin`);
    return new Float64Array(b.buffer, b.byteOffset, b.byteLength / 8);
  } catch {
    return null;
  }
}

/** One UTC day's (or week's) volume profile from 1-minute bars [a, b): POC, value area, VWAP. */
function profile(m: Float64Array, a: number, b: number, bins = 200) {
  let lo = Infinity, hi = -Infinity, pv = 0, vv = 0;
  for (let k = a; k < b; k++) {
    lo = Math.min(lo, m[k * 7 + 3]);
    hi = Math.max(hi, m[k * 7 + 2]);
    const v = m[k * 7 + 5];
    pv += ((m[k * 7 + 2] + m[k * 7 + 3] + m[k * 7 + 4]) / 3) * v;
    vv += v;
  }
  if (!(hi > lo) || !(vv > 0)) return null;
  const step = (hi - lo) / bins;
  const vol = new Float64Array(bins);
  for (let k = a; k < b; k++) {
    const x0 = Math.max(0, Math.floor((m[k * 7 + 3] - lo) / step)), x1 = Math.min(bins - 1, Math.floor((m[k * 7 + 2] - lo) / step));
    const share = m[k * 7 + 5] / (x1 - x0 + 1);
    for (let x = x0; x <= x1; x++) vol[x] += share;
  }
  let poc = 0;
  for (let x = 1; x < bins; x++) if (vol[x] > vol[poc]) poc = x;
  let s = poc, e = poc, acc = vol[poc];
  while (acc < vv * 0.7 && (s > 0 || e < bins - 1)) {
    const l = s > 0 ? vol[s - 1] : -1, r = e < bins - 1 ? vol[e + 1] : -1;
    if (r >= l) acc += vol[++e];
    else acc += vol[--s];
  }
  return { poc: lo + (poc + 0.5) * step, val: lo + s * step, vah: lo + (e + 1) * step, vwap: pv / vv };
}

type VLevel = KeyLevel & { label: string };

/** Volume levels known at the close of 15-minute bar j (see the header). */
function volumeSource(c: Candle[], m: Float64Array): LevelSource {
  const n = m.length / 7;
  const DAY = 86400, WEEK = 7 * DAY;
  const firstDay = Math.ceil(m[0] / DAY) * DAY;
  const days = new Map<number, ReturnType<typeof profile>>();
  for (let d = firstDay; d + DAY <= m[(n - 1) * 7] + 60; d += DAY) days.set(d, profile(m, lowerBound(m, d, 7), lowerBound(m, d + DAY, 7)));
  const weeks = new Map<number, ReturnType<typeof profile>>();
  const monday = (t: number) => t - (((new Date(t * 1000).getUTCDay() + 6) % 7) * DAY) - (t % DAY);
  for (let w = monday(firstDay) + WEEK; w + WEEK <= m[(n - 1) * 7] + 60; w += WEEK) weeks.set(w, profile(m, lowerBound(m, w, 7), lowerBound(m, w + WEEK, 7)));
  // the first 15-minute bar at or after each day's end that traded through its POC
  const times = c.map((x) => x.t);
  const touched = new Map<number, number>();
  for (const [d, p] of days) {
    if (!p) continue;
    let k = lowerBound(times, d + DAY);
    while (k < c.length && !(c[k].l <= p.poc && c[k].h >= p.poc)) k++;
    touched.set(d, k);
  }
  const cache = new Map<number, VLevel[]>();
  return (j) => {
    const end = c[j].t + 900;
    const today = Math.floor(end / DAY) * DAY;
    let base = cache.get(today);
    if (!base) {
      base = [];
      const p = days.get(today - DAY);
      if (p) base.push({ price: p.poc, kind: "prevDay", label: "前一日 POC" }, { price: p.vah, kind: "prevDay", label: "前一日 VAH" }, { price: p.val, kind: "prevDay", label: "前一日 VAL" }, { price: p.vwap, kind: "prevDay", label: "前一日 VWAP" });
      const wk = weeks.get(monday(end) - WEEK);
      if (wk) base.push({ price: wk.poc, kind: "prevWeek", label: "上周 POC" });
      cache.set(today, base);
    }
    const naked: VLevel[] = [];
    for (let d = today - 2 * DAY; d >= today - NAKED_DAYS * DAY; d -= DAY) {
      const p = days.get(d);
      if (p && (touched.get(d) ?? 0) > j) naked.push({ price: p.poc, kind: "prevDay", label: "裸 POC" });
    }
    return base.concat(naked);
  };
}

interface Ev {
  t: number;
  coin: string;
  dir: 1 | -1;
  label: string;
  taken: Partial<Record<Pol, Taken>>;
}
interface CoinOut {
  coin: string;
  events: Ev[];
  vEvents: Ev[];
  random: Record<Pol, Trade[]>;
  signs: { trade: Trade; v: Record<Sign, boolean | null> }[];
  from: number;
  counts: Record<string, number>;
}

function runCoin(coin: string, ci: number): CoinOut | null {
  const c = loadHistory(coin, "15m", nowSec);
  const m = loadM1(coin);
  if (c.length < 5000 || !m) return null;
  const h = loadHistory(coin, "1h", nowSec);
  const c4 = loadHistory(coin, "4h", nowSec);
  const d1 = loadHistory(coin, "1d", nowSec);
  const mult = ep.structure.swingAtr;
  const buf = bufferAtr(null, 80);
  const WINDOW = ep.watch.windowBars;
  const times = c.map((x) => x.t);
  const atr15 = atrSeries(c);
  const ss = structureSeries(c, atr15, mult);
  const hatr = atrSeries(h);
  const hss = structureSeries(h, hatr, mult);
  const hIdx = alignHigher(c, "15m", h, "1h");
  const atr = hIdx.map((j) => (j >= 0 ? hatr[j] : NaN));
  const idx4 = alignHigher(c, "15m", c4, "4h");
  const idx1 = alignHigher(c, "15m", d1, "1d");
  const at15 = (hourOpen: number) => lowerBound(times, hourOpen + 3600 - 900);
  const ctxSwings: Swing[] = swings(h, hatr, mult).map((s) => ({ ...s, i: lowerBound(times, h[s.i].t), confirmedAt: at15(h[s.confirmedAt].t) }));
  const ctx: SimContext = { c, atr, swings: ctxSwings, buf, costPct: ep.stats.costPct, maxBars: MAX_BARS };
  const w: WatchInput = { c, atr, ss, h, hss, hIdx, levels: levelSource(c, d1, atrSeries(d1), idx1, c4, atrSeries(c4), idx4) };
  // only where the 1-minute data covers
  let start = Math.max(WARMUP, FROM_BARS + 1, lowerBound(times, m[0] + 21 * 86400));
  while (start < c.length && !(atr[start - 1] > 0)) start++;
  const counts: Record<string, number> = {};

  // ---- the order-flow facts
  const exh = (e: number, dir: 1 | -1): boolean | null => {
    const a = lowerBound(m, c[e].t, 7), b = lowerBound(m, c[e].t + 900, 7);
    if (b - a < 10) return null;
    const { l: lo, h: hi } = c[e];
    if (!(hi > lo)) return null;
    const zb = dir > 0 ? lo : hi - 0.1 * (hi - lo), zt = dir > 0 ? lo + 0.1 * (hi - lo) : hi;
    let zv = 0, tv = 0;
    for (let k = a; k < b; k++) {
      const H = m[k * 7 + 2], L = m[k * 7 + 3], v = m[k * 7 + 5];
      tv += v;
      const ov = Math.min(H, zt) - Math.max(L, zb);
      zv += H > L ? (v * Math.max(0, ov)) / (H - L) : L >= zb && L <= zt ? v : 0;
    }
    if (!(tv > 0)) return null;
    return zv < EXH * tv && (c[e].c - (lo + hi) / 2) * dir >= 0;
  };
  const abs = (k0: number, s: number, L: number, dir: 1 | -1): boolean | null => {
    let v = 0, tb = 0, x = dir > 0 ? Infinity : -Infinity;
    for (let k = k0; k <= s; k++) {
      if (c[k].tbv == null) return null;
      v += c[k].v;
      tb += c[k].tbv!;
      x = dir > 0 ? Math.min(x, c[k].l) : Math.max(x, c[k].h);
    }
    if (!(v > 0)) return null;
    const against = dir > 0 ? 1 - tb / v : tb / v;
    return against >= ABS && (L - x) * dir <= 0.25 * atr[k0];
  };
  const delta = (e: number) => (c[e].tbv == null || !(c[e].v > 0) ? null : (2 * c[e].tbv! - c[e].v) / c[e].v);
  const div = (e: number, dir: 1 | -1): boolean | null => {
    const d = delta(e);
    return d == null ? null : (c[e].c - c[e].o) * dir > 0 || d * dir > 0;
  };
  const div2 = (e: number, dir: 1 | -1): boolean | null => {
    const d = delta(e);
    return d == null ? null : (c[e].c - c[e].o) * dir < 0 && d * dir >= 0.1;
  };

  // D: armed on a new extreme bar that shows the sign; the first close beyond that bar's other end within DBARS
  const dTrigger = (k0: number, dir: 1 | -1, sign: (e: number) => boolean | null): Trigger | null => {
    let x = dir > 0 ? c[k0].l : c[k0].h, xi = k0;
    let armed = sign(k0) ? k0 : -1;
    for (let k = k0 + 1; k < c.length && k <= k0 + WINDOW; k++) {
      const v = dir > 0 ? c[k].l : c[k].h;
      if ((v - x) * dir < 0) {
        x = v;
        xi = k;
        armed = sign(k) ? k : -1;
        continue;
      }
      if (armed >= 0 && k - armed <= DBARS && (c[k].c - (dir > 0 ? c[armed].h : c[armed].l)) * dir > 0) return { i: k, extreme: x, extremeI: xi, extremeT: c[xi].t };
    }
    return null;
  };
  const daTrigger = (k0: number, dir: 1 | -1, L: number): Trigger | null => {
    const s = k0 + 3;
    if (s >= c.length || !abs(k0, s, L, dir) || (c[s].c - L) * dir < 0) return null;
    let x = dir > 0 ? Infinity : -Infinity, xi = k0;
    for (let k = k0; k <= s; k++) if (((dir > 0 ? c[k].l : c[k].h) - x) * dir < 0) (x = dir > 0 ? c[k].l : c[k].h), (xi = k);
    return { i: s, extreme: x, extremeI: xi, extremeT: c[xi].t };
  };

  const ranOver = (p: Pol, i: number, entry: number, dir: 1 | -1) => {
    const lim = entry - dir * atr[i];
    for (let j = p === "A" || p === "VA" ? i : i + 1; j < c.length && j <= i + HALFWAY_BARS; j++) if (dir > 0 ? c[j].l <= lim : c[j].h >= lim) return true;
    return false;
  };
  const enter = (p: Pol, g: Trigger, L: number, dir: 1 | -1) => {
    if (!(atr[g.i] > 0)) return null;
    const isA = p === "A" || p === "VA";
    const stop = stopBeyond(isA ? L : g.extreme, dir, buf, atr[g.i]);
    if (isA) {
      const R = (L - stop) * dir;
      if (!(R > 0)) return null;
      if (dir > 0 ? c[g.i].l <= stop : c[g.i].h >= stop) {
        const r = -1 - ((ep.stats.costPct / 100) * L) / R;
        return { entry: L, stop, r: { r, pct: (r * R * 100) / L, bars: 0, exit: "stop" as const } };
      }
      const r = simulate(ctx, g.i, dir, stop, "structure", L);
      return r ? { entry: L, stop, r } : null;
    }
    const r = simulate(ctx, g.i, dir, stop, "structure");
    return r ? { entry: c[g.i].c, stop, r } : null;
  };

  const random = { A: [], C: [], Dx: [], Dd: [], Da: [], VA: [], VC: [] } as Record<Pol, Trade[]>;
  const signs: CoinOut["signs"] = [];
  const hi = c.length - (MAX_BARS + 1);
  const run = (evs: { k0: number; dir: 1 | -1; level: KeyLevel }[], pols: Pol[], trig: (e: { k0: number; dir: 1 | -1; level: KeyLevel }, p: Pol) => Trigger | null): Ev[] => {
    const res: Ev[] = evs.map((e) => ({ t: c[e.k0].t, coin, dir: e.dir, label: (e.level as VLevel).label ?? e.level.kind, taken: {} }));
    for (const [pi, p] of pols.entries()) {
      const r = rng(2800 + ci * 10 + pi);
      for (const dir of [1, -1] as const) {
        let free = -1;
        evs.forEach((e, n) => {
          if (e.dir !== dir) return;
          const g = trig(e, p);
          if (!g || g.i < free) return;
          const x = enter(p, g, e.level.price, dir);
          if (!x) return;
          free = g.i + x.r.bars;
          const trade: Trade = { t: c[g.i].t, coin, r: x.r.r, pct: x.r.pct };
          res[n].taken[p] = { trade, i: g.i, halfway: ranOver(p, g.i, x.entry, dir), quick: x.r.exit === "stop" && x.r.r < 0 && x.r.bars <= QUICK_BARS };
          const riskAtr = ((x.entry - x.stop) * dir) / atr[g.i];
          for (let k = 0; k < 3 && hi > start; k++) {
            const u = start + Math.floor(r() * (hi - start));
            if (!(atr[u] > 0)) continue;
            const s = simulate(ctx, u, dir, c[u].c - dir * riskAtr * atr[u], "structure");
            if (s) random[p].push({ t: c[u].t, coin, r: s.r, pct: s.pct });
          }
          if (p === "C")
            signs.push({ trade, v: { exh: exh(g.extremeI, dir), abs: abs(e.k0, Math.min(e.k0 + 3, g.i), e.level.price, dir), div: div(g.extremeI, dir), div2: div2(g.extremeI, dir) } });
        });
      }
    }
    return res;
  };

  const evs = scanEvents(w, start, c.length - WINDOW, WINDOW);
  const trigs = evs.map((e) => eventTriggers(w, e, WINDOW, RECLAIM_BARS));
  const pos = new Map(evs.map((e, n) => [e, n]));
  const events = run(evs, ["A", "C", "Dx", "Dd", "Da"], (e, p) => {
    if (p === "A" || p === "C") return trigs[pos.get(e as never)!][p];
    if (p === "Dx") return dTrigger(e.k0, e.dir, (k) => exh(k, e.dir));
    if (p === "Dd") return dTrigger(e.k0, e.dir, (k) => div(k, e.dir));
    return daTrigger(e.k0, e.dir, e.level.price);
  });
  for (const e of events) counts.events = (counts.events ?? 0) + 1;

  const wv: WatchInput = { ...w, levels: volumeSource(c, m) };
  const vevs = scanEvents(wv, start, c.length - WINDOW, WINDOW);
  const vtrigs = new Map(vevs.map((e) => [e, eventTriggers(wv, e, WINDOW, RECLAIM_BARS)]));
  const vEvents = run(vevs, ["VA", "VC"], (e, p) => vtrigs.get(e as never)![p === "VA" ? "A" : "C"]);
  for (const e of vEvents) counts[e.label] = (counts[e.label] ?? 0) + 1;
  return { coin, events, vEvents, random, signs, from: c[start].t, counts };
}

const data: CoinOut[] = [];
for (const [ci, coin] of RESEARCH_COINS.entries()) {
  const t0 = Date.now();
  const d = runCoin(coin, ci);
  if (d) data.push(d);
  console.error(`${coin}: ${d ? `${d.events.length} 事件、成交量位 ${d.vEvents.length}` : "跳过"}，${Math.round((Date.now() - t0) / 1000)} 秒`);
}
const first = Math.min(...data.map((d) => d.from));
const split = makeSplit(first, nowSec);
const inS = (t: number) => t < split.holdoutFrom;
const f = (v: number | null | undefined, d = 2) => (v == null ? "—" : v.toFixed(d));
const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(0)}%` : "—");
const mk = (key: string, name: string, sig: Trade[], ctl: Trade[], step: number): Row => ({ family: "watch", key: `e28:${key}`, name, side: "bull", tf: "15m", horizon: MAX_BARS, cells: cells(sig, ctl, split, step) });
const print = (title: string, rows: Row[], notes: Map<string, string> = new Map()) => {
  say(`\n--- ${title}`);
  for (const x of finish(rows, ep.stats.alpha, ep.stats.minSamples))
    say(
      `${x.name.padEnd(30)} n ${String(x.cells.is.n).padStart(4)}  均 ${f(x.cells.is.meanR).padStart(6)}R  对照差 ${f(x.cells.is.edgeR).padStart(6)}R | BTC ${f(x.cells.btc.edgeR)} ETH ${f(x.cells.eth.edgeR)} 前 ${f(x.cells.firstHalf.edgeR)} 后 ${f(x.cells.secondHalf.edgeR)} | 样本外 ${x.cells.oos.n} 笔 ${f(x.cells.oos.edgeR)} | q ${f(x.q, 3)} ${x.verdict}${notes.get(x.key) ?? ""}`,
    );
};

const events = data.flatMap((d) => d.events);
const vEvents = data.flatMap((d) => d.vEvents);
say(`E28 订单流（1 分钟近似）：${data.map((d) => d.coin).join(" / ")}，从 ${new Date(first * 1000).toISOString().slice(0, 10)} 起，样本外从 ${new Date(split.holdoutFrom * 1000).toISOString().slice(0, 10)} 起；ABS ${ABS}、EXH ${EXH}、DBARS ${DBARS}`);
say(`原关键位事件 ${events.length}（样本内 ${events.filter((e) => inS(e.t)).length}）；成交量位事件 ${vEvents.length}（样本内 ${vEvents.filter((e) => inS(e.t)).length}）`);

const desc = (p: Pol, list: Ev[]) => {
  const isE = list.filter((e) => inS(e.t));
  const tk = isE.map((e) => e.taken[p]).filter((x): x is Taken => !!x);
  return `  · 样本内触发 ${pct(tk.length, isE.length)}，接到半山腰 ${pct(tk.filter((x) => x.halfway).length, tk.length)}，24 小时内被扫 ${pct(tk.filter((x) => x.quick).length, tk.length)}`;
};
const tradesOf = (p: Pol, list: Ev[]) => list.map((e) => e.taken[p]?.trade).filter((x): x is Trade => !!x);
const ctlOf = (p: Pol) => data.flatMap((d) => d.random[p]);

// 1) entries against random
const g1: Row[] = [], n1 = new Map<string, string>();
for (const p of ["A", "C", "Dx", "Dd", "Da"] as Pol[]) {
  g1.push(mk(p, NAME[p], tradesOf(p, events), ctlOf(p), 3));
  n1.set(`e28:${p}`, desc(p, events));
}
print("进场对随机入场（同方向、同止损距离）", g1, n1);

// 2) D against C on the same events
const g2: Row[] = [], n2 = new Map<string, string>();
for (const p of ["Dx", "Dd", "Da"] as Pol[]) {
  const pairs = events.filter((e) => e.taken[p] && e.taken.C);
  const isP = pairs.filter((e) => inS(e.taken[p]!.trade.t));
  const rate = (q: Pol, k: "halfway" | "quick") => pct(isP.filter((e) => e.taken[q]![k]).length, isP.length);
  const early = isP.map((e) => e.taken.C!.i - e.taken[p]!.i).sort((a, b) => a - b);
  g2.push(mk(`${p}_vs_C`, `${NAME[p]} 对 C`, pairs.map((e) => e.taken[p]!.trade), pairs.map((e) => e.taken.C!.trade), 1));
  n2.set(`e28:${p}_vs_C`, `  · 半山腰 ${rate(p, "halfway")} 对 ${rate("C", "halfway")}，24 小时内被扫 ${rate(p, "quick")} 对 ${rate("C", "quick")}，比 C 早进中位 ${early.length ? early[early.length >> 1] : "—"} 根 15 分钟`);
}
print("同一批事件上和 C 配对", g2, n2);

// 3) signs at the C entries
const signs = data.flatMap((d) => d.signs);
const g3: Row[] = [], n3 = new Map<string, string>();
for (const s of ["exh", "abs", "div", "div2"] as Sign[]) {
  const yes = signs.filter((x) => x.v[s] === true), no = signs.filter((x) => x.v[s] === false);
  g3.push(mk(`sign:${s}`, `迹象：${SIGN_NAME[s]}`, yes.map((x) => x.trade), no.map((x) => x.trade), 1));
  n3.set(`e28:sign:${s}`, `  · 有 ${yes.length}、没有 ${no.length}、数据缺 ${signs.length - yes.length - no.length}（有的比例 ${pct(yes.length, yes.length + no.length)}）`);
}
print("迹象：C 入场时有对没有", g3, n3);

// 4) volume levels
const g4: Row[] = [], n4 = new Map<string, string>();
for (const p of ["VA", "VC"] as Pol[]) {
  g4.push(mk(p, NAME[p], tradesOf(p, vEvents), ctlOf(p), 3));
  n4.set(`e28:${p}`, desc(p, vEvents));
}
print("成交量关键位（1 分钟成交量分布）对随机入场", g4, n4);
const counts: Record<string, number> = {};
for (const d of data) for (const [k, v] of Object.entries(d.counts)) if (k !== "events") counts[k] = (counts[k] ?? 0) + v;
say(`成交量位事件按种类：${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join("、")}`);
const g5: Row[] = [];
for (const label of Object.keys(counts)) {
  const list = vEvents.filter((e) => e.label === label);
  g5.push(mk(`VC:${label}`, `成交量位 C · ${label}`, tradesOf("VC", list), ctlOf("VC"), 3));
}
print("成交量位 C 按种类（描述，对照是全部成交量位 C 的随机入场）", g5);

if (process.env.OUT) (await import("node:fs")).writeFileSync(process.env.OUT, out.join("\n") + "\n");
