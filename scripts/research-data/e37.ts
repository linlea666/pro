/**
 * E37（2026-10-31）：大趋势（周线 + 日线结构）顺 / 逆，盯盘转强和 4 小时计划入场是不是不一样。
 * 用户 87k → 76k 一路接多亏损；回放（项目文件夹 trend-replay/）显示周线全程下降、日线 10/22 起下降，
 * 而盯盘在那之后给了 3 次做多“已转强”，都先打到止损。只有一段，要先在全部历史上验证。
 *   DATA_DIR=<研究库> node --experimental-strip-types scripts/research-data/e37.ts
 * 先跑 build.ts。OUT=文件 另存一份输出。
 *
 * 跑之前定好的规则（看结果之前写下，不再改）：
 * 大趋势 = 入场那根 K 线收盘时已收盘的周线和日线，结构方向（`structureDirection`，同计划页的大周期方向）一致时为那个方向，
 *   不一致为 0。一笔交易：方向和大趋势相同 = 顺，相反 = 逆，大趋势为 0 = 中性。另做一版只看日线（日线方向 = 顺 / 逆 / 0）。
 * E37a 盯盘：沿用 E19 / E33 的事件、C 入场（15 分钟转强）、止损、离场（跟着 1 小时摆动点，最长 7 天）、10 个币 15 分钟 2022 年起，
 *   样本外 = 最近 12 个月。每组：① 对随机入场（同币、同方向、同止损距离，每笔 3 个，时点不限）；② 对同一组大趋势里的随机入场
 *   （随机时点也要落在同样的顺 / 逆 / 中性里）；③ 逆 对 顺（两组直接比，对照步长 1）。
 * E37b 4 小时计划：`research/plans.ts` 的 `prepare`（日线定方向、4 小时入场，`findEntries` 三种入场），跟着结构移动认错位，
 *   一个币一组同时只持有一笔；每组对随机（同币、同方向、同止损距离，每笔 3 个）和 逆 对 顺。仓位都按 1 份算（不按半仓折）。
 * 达标（才考虑“逆大趋势时盯盘不提示转强 / 不发邮件”）：逆 对 顺 ≤ −0.1R、BH 校正后显著、BTC / ETH / 前后两半 / 样本外方向一致
 *   （即 `judge` 判“比随机差”）。不达标：页面最多只描述大趋势、照计划页规则写“逆大趋势半仓”，不说“逆势转强更差”。
 */
import { finish, loadHistory, type ResearchRow } from "../../src/lib/research/run.ts";
import { cells, makeSplit, type Trade } from "../../src/lib/research/engine.ts";
import { simulate, type SimContext } from "../../src/lib/research/sim.ts";
import { ctxOf, prepare, sequential, randomTrades, type Setup } from "../../src/lib/research/plans.ts";
import { DEFAULT_ENGINE_PARAMS } from "../../src/lib/params.ts";
import { RESEARCH_COINS } from "../../src/lib/symbols.ts";
import { alignHigher } from "../../src/lib/ta/plan.ts";
import { atrSeries, bufferAtr } from "../../src/lib/ta/risk.ts";
import { structureDirection, structureSeries, swings, type Swing } from "../../src/lib/ta/structure.ts";
import { eventTriggers, FROM_BARS, levelSource, scanEvents, stopBeyond, type WatchInput } from "../../src/lib/ta/watch.ts";
import type { Candle, Timeframe } from "../../src/lib/types.ts";
import fs from "node:fs";

const ep = DEFAULT_ENGINE_PARAMS;
const nowSec = Date.parse("2026-10-30T00:00:00Z") / 1000;
const WARMUP = 300;
const MAX_BARS = 672;
const RECLAIM_BARS = 16;

type Rel = "with" | "against" | "neutral";
const REL_NAME: Record<Rel, string> = { with: "顺", against: "逆", neutral: "中性" };
type By = "big" | "day";
const BY_NAME: Record<By, string> = { big: "周线 + 日线", day: "只看日线" };

const out: string[] = [];
const say = (s: string) => (console.log(s), out.push(s));
type Row = Omit<ResearchRow, "q" | "consistent" | "verdict">;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
function lowerBound(arr: ArrayLike<number>, x: number): number {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** the weekly and daily structure direction known at the close of each bar of `c` */
function trendDirs(coin: string, c: Candle[], tf: Timeframe) {
  const mult = ep.structure.swingAtr;
  const dir = (htf: Timeframe) => {
    const f = loadHistory(coin, htf, nowSec);
    const ss = structureSeries(f, atrSeries(f), mult);
    const idx = alignHigher(c, tf, f, htf);
    return (i: number): 1 | -1 | 0 => (idx[i] < 0 || f.length < 30 ? 0 : structureDirection(ss[idx[i]]));
  };
  const w = dir("1w"), d = dir("1d");
  const big = (i: number): 1 | -1 | 0 => {
    const a = w(i), b = d(i);
    return a !== 0 && a === b ? a : 0;
  };
  return { big, day: d };
}
const relOf = (t: 1 | -1 | 0, dir: 1 | -1): Rel => (t === 0 ? "neutral" : t === dir ? "with" : "against");

interface Tk {
  trade: Trade;
  dir: 1 | -1;
  rel: Record<By, Rel>;
  /** controls: random anywhere, random in the same group (per By) */
  any: Trade[];
  same: Record<By, Trade[]>;
}

// ---------------------------------------------------------------- E37a: the watch's C entries

function watchCoin(coin: string, ci: number): { tk: Tk[]; from: number } | null {
  const c = loadHistory(coin, "15m", nowSec);
  if (c.length < 5000) return null;
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
  const T = trendDirs(coin, c, "15m");
  let start = Math.max(WARMUP, FROM_BARS + 1);
  while (start < c.length && !(atr[start - 1] > 0)) start++;
  const hi = c.length - (MAX_BARS + 1);
  const r = rng(3700 + ci);
  const randomAt = (dir: 1 | -1, riskAtr: number, want?: { by: By; rel: Rel }): Trade | null => {
    for (let tries = 0; tries < 50; tries++) {
      const u = start + Math.floor(r() * (hi - start));
      if (!(atr[u] > 0)) continue;
      if (want && relOf(T[want.by](u), dir) !== want.rel) continue;
      const s = simulate(ctx, u, dir, c[u].c - dir * riskAtr * atr[u], "structure");
      return s ? { t: c[u].t, coin, r: s.r, pct: s.pct } : null;
    }
    return null;
  };

  const tk: Tk[] = [];
  const evs = scanEvents(w, start, c.length - WINDOW, WINDOW);
  for (const dir of [1, -1] as const) {
    let free = -1;
    for (const e of evs) {
      if (e.dir !== dir) continue;
      const g = eventTriggers(w, e, WINDOW, RECLAIM_BARS).C;
      if (!g || g.i < free || !(atr[g.i] > 0)) continue;
      const stop = stopBeyond(g.extreme, dir, buf, atr[g.i]);
      const s = simulate(ctx, g.i, dir, stop, "structure");
      if (!s) continue;
      free = g.i + s.bars;
      const riskAtr = ((c[g.i].c - stop) * dir) / atr[g.i];
      const rel = { big: relOf(T.big(g.i), dir), day: relOf(T.day(g.i), dir) };
      const pick = (want?: { by: By; rel: Rel }) => Array.from({ length: 3 }, () => randomAt(dir, riskAtr, want)).filter((x): x is Trade => !!x);
      tk.push({ trade: { t: c[g.i].t, coin, r: s.r, pct: s.pct }, dir, rel, any: pick(), same: { big: pick({ by: "big", rel: rel.big }), day: pick({ by: "day", rel: rel.day }) } });
    }
  }
  return { tk, from: c[start].t };
}

// ---------------------------------------------------------------- E37b: 4-hour plan entries

const SETUP: Setup = { tf: "4h", filter: "1d" };
function planCoin(coin: string, ci: number, holdoutFrom: number): Tk[] {
  const p = prepare(coin, SETUP, ep, nowSec, holdoutFrom);
  if (!p) return [];
  const ctx = ctxOf(p, SETUP, ep);
  const T = trendDirs(coin, p.c, "4h");
  const tk: Tk[] = [];
  for (const by of ["big", "day"] as const) {
    for (const rel of ["with", "against", "neutral"] as const) {
      const evs = p.events.filter((e) => relOf(T[by](e.i), e.dir) === rel);
      const taken = sequential(evs, ctx, "structure");
      const seed = 3750 + ci * 10 + (by === "big" ? 0 : 5) + ["with", "against", "neutral"].indexOf(rel);
      // controls per trade (same coin, direction and stop distance), so every split and direction keeps its own
      taken.forEach((x, k) => tk.push({ trade: { t: p.c[x.e.i].t, coin, r: x.r.r, pct: x.r.pct }, dir: x.e.dir, rel: { big: by === "big" ? rel : "neutral", day: by === "day" ? rel : "neutral" }, any: randomTrades(p, [x.e], ctx, "structure", 3, seed * 1000 + k), same: { big: [], day: [] }, by } as Tk & { by: By }));
    }
  }
  return tk;
}

// ---------------------------------------------------------------- run

const watch: Tk[] = [];
const plans: (Tk & { by: By })[] = [];
let first = Infinity;
for (const [ci, coin] of RESEARCH_COINS.entries()) {
  const t0 = Date.now();
  const d = watchCoin(coin, ci);
  if (d) watch.push(...d.tk), (first = Math.min(first, d.from));
  console.error(`${coin}: 盯盘 ${d ? d.tk.length : 0} 笔，${Math.round((Date.now() - t0) / 1000)} 秒`);
}
const split = makeSplit(first, nowSec);
for (const [ci, coin] of RESEARCH_COINS.entries()) plans.push(...(planCoin(coin, ci, split.holdoutFrom) as (Tk & { by: By })[]));

const f = (v: number | null | undefined, d = 2) => (v == null || !Number.isFinite(v) ? "—" : v.toFixed(d));
const mk = (key: string, name: string, sig: Trade[], ctl: Trade[], step: number): Row => ({ family: "watch", key: `e37:${key}`, name, side: "bull", tf: "15m", horizon: MAX_BARS, cells: cells(sig, ctl, split, step) });
const fin = (rows: Row[]) => finish(rows, ep.stats.alpha, ep.stats.minSamples);
const line = (x: ReturnType<typeof fin>[number]) =>
  `${x.name.padEnd(34)} n ${String(x.cells.is.n).padStart(4)}  均 ${f(x.cells.is.meanR).padStart(6)}R  差 ${f(x.cells.is.edgeR).padStart(6)}R | BTC ${f(x.cells.btc.edgeR)} ETH ${f(x.cells.eth.edgeR)} 前 ${f(x.cells.firstHalf.edgeR)} 后 ${f(x.cells.secondHalf.edgeR)} | 样本外 ${x.cells.oos.n} 笔 均 ${f(x.cells.oos.meanR)} 差 ${f(x.cells.oos.edgeR)} | q ${f(x.q, 3)} ${x.verdict}`;

say(`E37 大趋势顺 / 逆：10 个币，盯盘 15 分钟从 ${new Date(first * 1000).toISOString().slice(0, 10)} 起，样本外从 ${new Date(split.holdoutFrom * 1000).toISOString().slice(0, 10)} 起`);
for (const by of ["big", "day"] as const) {
  say(`\n=== E37a 盯盘 C（15 分钟转强），大趋势 = ${BY_NAME[by]}`);
  for (const d of [1, -1, 0] as const) {
    const xs = watch.filter((x) => d === 0 || x.dir === d);
    const label = d === 1 ? "做多" : d === -1 ? "做空" : "多空合计";
    const rows: Row[] = [];
    for (const rel of ["with", "against", "neutral"] as const) {
      const g = xs.filter((x) => x.rel[by] === rel);
      rows.push(mk(`${by}:${d}:${rel}:any`, `${label} ${REL_NAME[rel]} 对随机`, g.map((x) => x.trade), g.flatMap((x) => x.any), 3));
      rows.push(mk(`${by}:${d}:${rel}:same`, `${label} ${REL_NAME[rel]} 对同组随机`, g.map((x) => x.trade), g.flatMap((x) => x.same[by]), 3));
    }
    const w = xs.filter((x) => x.rel[by] === "with"), a = xs.filter((x) => x.rel[by] === "against");
    rows.push(mk(`${by}:${d}:avw`, `${label} 逆 对 顺`, a.map((x) => x.trade), w.map((x) => x.trade), 1));
    say(`\n--- ${label}（顺 ${w.length}、逆 ${a.length}、中性 ${xs.length - w.length - a.length} 笔，含样本外）`);
    for (const x of fin(rows)) say(line(x));
  }
}
for (const by of ["big", "day"] as const) {
  say(`\n=== E37b 4 小时计划入场（日线定方向，三种入场），大趋势 = ${BY_NAME[by]}`);
  const xs = plans.filter((x) => x.by === by);
  for (const d of [1, -1, 0] as const) {
    const ys = xs.filter((x) => d === 0 || x.dir === d);
    const label = d === 1 ? "做多" : d === -1 ? "做空" : "多空合计";
    const rows: Row[] = [];
    for (const rel of ["with", "against", "neutral"] as const) {
      const g = ys.filter((x) => x.rel[by] === rel);
      rows.push(mk(`p:${by}:${d}:${rel}`, `${label} ${REL_NAME[rel]} 对随机`, g.map((x) => x.trade), g.flatMap((x) => x.any), 3));
    }
    const w = ys.filter((x) => x.rel[by] === "with"), a = ys.filter((x) => x.rel[by] === "against");
    rows.push(mk(`p:${by}:${d}:avw`, `${label} 逆 对 顺`, a.map((x) => x.trade), w.map((x) => x.trade), 1));
    say(`\n--- ${label}（顺 ${w.length}、逆 ${a.length}、中性 ${ys.length - w.length - a.length} 笔）`);
    for (const x of fin(rows)) say(line(x));
  }
}
if (process.env.OUT) fs.writeFileSync(process.env.OUT, out.join("\n") + "\n");
