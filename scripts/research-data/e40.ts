/**
 * E40（2026-11-01）：碰到盯盘关键位时，那根 K 线的影线 + 量能能不能帮盯盘。
 *   DATA_DIR=<研究库> node --experimental-strip-types scripts/research-data/e40.ts
 * 用户贴币安“AI 智能机器人”的 ETH 帖：反弹到阻力出现上影线、缩量 → 做空；跌到支撑出现放量、长下影 → 做多。用户定只测 BTC / ETH。
 * 先跑 build.ts（15 分钟 2022 年起、1 小时、4 小时、日线）。OUT=文件 另存一份输出；VUP / VDOWN 改放量 / 缩量门槛（变体）。
 *
 * 跑之前定好的规则（看结果之前写下，不再改）：
 * - 事件、止损（最新极点外 p80 缓冲 × 1 小时 ATR）、离场（跟着 1 小时摆动点，最长 7 天）、随机对照（同币、同方向、同止损距离，
 *   每笔 3 个）、样本外（最近 12 个月）全部沿用 E19 / E33；BTC、ETH，15 分钟 2022 年起。
 * - 迹象 K 线：事件窗口（288 根 15 分钟）里、15 分钟“已转强”之前或同一根，第一根满足下面三条的已收盘 K 线（15 分钟一组，
 *   1 小时一组：只看整点收盘的那根 15 分钟，用那根 1 小时 K 线）：
 *   ① 在关键位上：做多时这根的最低价 ≤ 关键位 + 0.25 倍 1 小时 ATR（做空镜像）；之前没有收盘离开关键位 3 倍 1 小时 ATR；
 *   ② 长影线：做多看下影线 ≥ 全长的 50%、收盘在全长上部 1/3（同裸 K `PA_RULES.pinWick / pinClose`）；做空镜像（上影线）；
 *   ③ 量能（`relVolume`：对前 20 根的中位数）：放量 ≥ 1.5 倍，缩量 ≤ 0.8 倍；“不看量”只要 ①②。
 *   博主做法 = 做多“长下影 + 放量”、做空“长上影 + 缩量”；另测“不看量”和反过来的量能。
 * - 三种用法：
 *   E40a 马上进：迹象 K 线收盘就进，对随机入场；
 *   E40b 早提示：同一批事件上和 15 分钟转强（C）配对，用 E33 的“不劣且更早”标准（早 ≥ 4 根中位、样本内对 C ≥ −0.05R、
 *     BTC / ETH / 前后两半 / 样本外对 C 都不差于 −0.1R、对随机 ≥ 0）；
 *   E40c 辅助判断：转强（C）的那些交易，转强之前（含同一根）出现过迹象的，对没出现过的；达标仍按 judge（≥ 0.1R、显著、各段一致）。
 */
import { finish, loadHistory, type ResearchRow } from "../../src/lib/research/run.ts";
import { cells, makeSplit, type Trade } from "../../src/lib/research/engine.ts";
import { simulate, type SimContext } from "../../src/lib/research/sim.ts";
import { DEFAULT_ENGINE_PARAMS } from "../../src/lib/params.ts";
import { alignHigher, relVolume } from "../../src/lib/ta/plan.ts";
import { atrSeries, bufferAtr } from "../../src/lib/ta/risk.ts";
import { structureSeries, swings, type Swing } from "../../src/lib/ta/structure.ts";
import { PA_RULES } from "../../src/lib/ta/patterns.ts";
import { eventTriggers, FROM_BARS, hourClosed, levelSource, scanEvents, stopBeyond, type WatchInput } from "../../src/lib/ta/watch.ts";
import type { Candle } from "../../src/lib/types.ts";

const ep = DEFAULT_ENGINE_PARAMS;
const nowSec = Date.parse("2026-10-31T00:00:00Z") / 1000;
const COINS = ["BTC", "ETH"];
const WARMUP = 300;
const MAX_BARS = 672;
const RECLAIM_BARS = 16;
const QUICK_BARS = 96;
const NEAR_ATR = 0.25;
const LEAVE_ATR = 3;
const VUP = Number(process.env.VUP ?? 1.5);
const VDOWN = Number(process.env.VDOWN ?? 0.8);

type Tf = "15m" | "1h";
type Vol = "any" | "up" | "down";
const VOL_WORD: Record<Vol, string> = { any: "不看量", up: "放量", down: "缩量" };
/** the blogger's pairing */
const BLOG: Record<1 | -1, Vol> = { 1: "up", [-1]: "down" };
const key = (tf: Tf, dir: 1 | -1, v: Vol) => `${tf}:${dir}:${v}`;
const nameOf = (tf: Tf, dir: 1 | -1, v: Vol) => `${tf === "15m" ? "15 分钟" : "1 小时"} ${dir > 0 ? "长下影" : "长上影"}+${VOL_WORD[v]}${BLOG[dir] === v ? "（博主）" : ""}`;

interface Taken {
  trade: Trade;
  i: number;
  quick: boolean;
}
interface Ev {
  coin: string;
  dir: 1 | -1;
  t: number;
  C: Taken | null;
  /** first sign bar (15-minute index of its close) per kind, at or before C */
  sign: Map<string, number>;
  /** E40a trades per kind */
  taken: Map<string, Taken>;
}
type Row = Omit<ResearchRow, "q" | "consistent" | "verdict">;
const out: string[] = [];
const say = (s: string) => (console.log(s), out.push(s));

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

/** ② a long wick on the defended side (lower wick for longs) */
function wick(b: Candle, dir: 1 | -1): boolean {
  const range = b.h - b.l;
  if (!(range > 0)) return false;
  const w = dir > 0 ? Math.min(b.o, b.c) - b.l : b.h - Math.max(b.o, b.c);
  const close = dir > 0 ? b.c - b.l : b.h - b.c;
  return w >= PA_RULES.pinWick * range && close >= PA_RULES.pinClose * range;
}
const volOk = (rv: number, v: Vol) => (v === "any" ? true : v === "up" ? rv >= VUP : rv <= VDOWN);

interface CoinOut {
  coin: string;
  events: Ev[];
  random: Map<string, Trade[]>;
  randomC: Record<1 | -1, Trade[]>;
  from: number;
}

function runCoin(coin: string, ci: number): CoinOut | null {
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
  let start = Math.max(WARMUP, FROM_BARS + 1);
  while (start < c.length && !(atr[start - 1] > 0)) start++;
  const hi = c.length - (MAX_BARS + 1);

  const evs = scanEvents(w, start, c.length - WINDOW, WINDOW);
  const events: Ev[] = [];
  const random = new Map<string, Trade[]>();
  const randomC: Record<1 | -1, Trade[]> = { 1: [], [-1]: [] };
  const kinds: [Tf, Vol][] = (["15m", "1h"] as Tf[]).flatMap((tf) => (["any", "up", "down"] as Vol[]).map((v) => [tf, v] as [Tf, Vol]));

  // running extreme from the touch through bar k
  const extremeAt = (k0: number, k: number, dir: 1 | -1) => {
    let x = dir > 0 ? c[k0].l : c[k0].h;
    for (let j = k0 + 1; j <= k; j++) x = dir > 0 ? Math.min(x, c[j].l) : Math.max(x, c[j].h);
    return x;
  };
  const enterAt = (i: number, k0: number, dir: 1 | -1) => {
    if (!(atr[i] > 0)) return null;
    const stop = stopBeyond(extremeAt(k0, i, dir), dir, buf, atr[i]);
    if ((c[i].c - stop) * dir <= 0) return null;
    const r = simulate(ctx, i, dir, stop, "structure");
    return r ? { stop, r } : null;
  };
  const rnd = rng(4000 + ci * 7);
  const addRandom = (list: Trade[], i: number, dir: 1 | -1, stop: number) => {
    const riskAtr = ((c[i].c - stop) * dir) / atr[i];
    for (let k = 0; k < 3 && hi > start; k++) {
      const u = start + Math.floor(rnd() * (hi - start));
      if (!(atr[u] > 0)) continue;
      const s = simulate(ctx, u, dir, c[u].c - dir * riskAtr * atr[u], "structure");
      if (s) list.push({ t: c[u].t, coin, r: s.r, pct: s.pct });
    }
  };

  for (const e of evs) {
    const dir = e.dir, L = e.level.price, k0 = e.k0;
    const ev: Ev = { coin, dir, t: c[k0].t, C: null, sign: new Map(), taken: new Map() };
    const g = eventTriggers(w, e, WINDOW, RECLAIM_BARS).C;
    const lastK = Math.min(c.length - 1, k0 + WINDOW, g ? g.i : Infinity);
    // ① the bar is at the level; stop looking once a close has left it by 3 hour ATR
    for (let k = k0; k <= lastK; k++) {
      const a = atr[k];
      if (!(a > 0)) continue;
      if ((c[k].c - L) * dir > LEAVE_ATR * a) break;
      for (const tf of ["15m", "1h"] as Tf[]) {
        let bar: Candle, rv: number;
        if (tf === "15m") {
          bar = c[k];
          rv = relVolume(c, k);
        } else {
          if (!hourClosed(w, k) || h[hIdx[k]].t < c[k0].t - 2700) continue; // the hour bar must contain the touch or come after it
          bar = h[hIdx[k]];
          rv = relVolume(h, hIdx[k]);
        }
        const at = dir > 0 ? bar.l <= L + NEAR_ATR * a : bar.h >= L - NEAR_ATR * a;
        if (!at || !wick(bar, dir)) continue;
        for (const v of ["any", "up", "down"] as Vol[]) {
          const kk = key(tf, dir, v);
          if (!ev.sign.has(kk) && volOk(rv, v)) ev.sign.set(kk, k);
        }
      }
    }
    events.push(ev);
  }

  // E40a: enter at the sign bar's close (one open trade per kind and direction), and C itself
  for (const dir of [1, -1] as const) {
    let freeC = -1;
    for (const ev of events) {
      if (ev.dir !== dir) continue;
      const e = evs[events.indexOf(ev)];
      const g = eventTriggers(w, e, WINDOW, RECLAIM_BARS).C;
      if (g && g.i >= freeC) {
        const x = enterAt(g.i, e.k0, dir);
        if (x) {
          freeC = g.i + x.r.bars;
          ev.C = { trade: { t: c[g.i].t, coin, r: x.r.r, pct: x.r.pct }, i: g.i, quick: x.r.exit === "stop" && x.r.r < 0 && x.r.bars <= QUICK_BARS };
          addRandom(randomC[dir], g.i, dir, x.stop);
        }
      }
    }
    for (const [tf, v] of kinds) {
      const kk = key(tf, dir, v);
      if (!random.has(kk)) random.set(kk, []);
      let free = -1;
      events.forEach((ev, n) => {
        if (ev.dir !== dir) return;
        const i = ev.sign.get(kk);
        if (i == null || i < free) return;
        const x = enterAt(i, evs[n].k0, dir);
        if (!x) return;
        free = i + x.r.bars;
        ev.taken.set(kk, { trade: { t: c[i].t, coin, r: x.r.r, pct: x.r.pct }, i, quick: x.r.exit === "stop" && x.r.r < 0 && x.r.bars <= QUICK_BARS });
        addRandom(random.get(kk)!, i, dir, x.stop);
      });
    }
  }
  return { coin, events, random, randomC, from: c[start].t };
}

// ---------------------------------------------------------------- run

const data: CoinOut[] = [];
for (const [ci, coin] of COINS.entries()) {
  const t0 = Date.now();
  const d = runCoin(coin, ci);
  if (d) data.push(d);
  console.error(`${coin}: ${d ? `${d.events.length} 事件` : "跳过"}，${Math.round((Date.now() - t0) / 1000)} 秒`);
}
const first = Math.min(...data.map((d) => d.from));
const split = makeSplit(first, nowSec);
const inS = (t: number) => t < split.holdoutFrom;
const f = (v: number | null | undefined, d = 2) => (v == null || !Number.isFinite(v) ? "—" : v.toFixed(d));
const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(0)}%` : "—");
const med = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : NaN;
};
const mk = (k: string, name: string, dir: 1 | -1, sig: Trade[], ctl: Trade[], step: number): Row => ({ family: "watch", key: `e40:${k}`, name, side: dir > 0 ? "bull" : "bear", tf: "15m", horizon: MAX_BARS, cells: cells(sig, ctl, split, step) });
const fin = (rows: Row[]) => finish(rows, ep.stats.alpha, ep.stats.minSamples);
const line = (x: ReturnType<typeof fin>[number]) =>
  `${x.name.padEnd(28)} n ${String(x.cells.is.n).padStart(4)}  均 ${f(x.cells.is.meanR).padStart(6)}R  差 ${f(x.cells.is.edgeR).padStart(6)}R | BTC ${f(x.cells.btc.edgeR)} ETH ${f(x.cells.eth.edgeR)} 前 ${f(x.cells.firstHalf.edgeR)} 后 ${f(x.cells.secondHalf.edgeR)} | 样本外 ${x.cells.oos.n} 笔 ${f(x.cells.oos.edgeR)} | q ${f(x.q, 3)} ${x.verdict}`;

const events = data.flatMap((d) => d.events);
const isEv = events.filter((e) => inS(e.t));
say(`E40 影线 + 量能：${data.map((d) => d.coin).join(" / ")}，从 ${new Date(first * 1000).toISOString().slice(0, 10)} 起，样本外从 ${new Date(split.holdoutFrom * 1000).toISOString().slice(0, 10)} 起；放量 ≥ ${VUP} 倍、缩量 ≤ ${VDOWN} 倍`);
say(`事件 ${events.length}（样本内 ${isEv.length}：做多 ${isEv.filter((e) => e.dir > 0).length}，做空 ${isEv.filter((e) => e.dir < 0).length}）`);
const DIRS = [1, -1] as const;
const TFS: Tf[] = ["15m", "1h"];
const VOLS: Vol[] = ["any", "up", "down"];

say("\n--- 出现比例（样本内事件里，转强之前或同一根出现过迹象的比例）");
for (const dir of DIRS)
  for (const tf of TFS) {
    const es = isEv.filter((e) => e.dir === dir);
    say(`${dir > 0 ? "做多" : "做空"} ${tf}：${VOLS.map((v) => `${VOL_WORD[v]} ${pct(es.filter((e) => e.sign.has(key(tf, dir, v))).length, es.length)}`).join("，")}`);
  }

say("\n--- E40a 迹象 K 线收盘就进，对随机入场（同方向、同止损距离）");
const aRows: Row[] = [];
for (const dir of DIRS) for (const tf of TFS) for (const v of VOLS) {
  const kk = key(tf, dir, v);
  aRows.push(mk(`a:${kk}`, nameOf(tf, dir, v), dir, events.map((e) => e.taken.get(kk)?.trade).filter((x): x is Trade => !!x), data.flatMap((d) => d.random.get(kk) ?? []), 3));
}
const cRows = DIRS.map((dir) => mk(`a:C:${dir}`, `15 分钟转强 C（${dir > 0 ? "做多" : "做空"}，对照）`, dir, events.filter((e) => e.dir === dir).map((e) => e.C?.trade).filter((x): x is Trade => !!x), data.flatMap((d) => d.randomC[dir]), 3));
const gA = fin([...aRows, ...cRows]);
const vsRandom = new Map(gA.map((x) => [x.key, x.cells.is.edgeR]));
for (const x of gA) {
  say(line(x));
  const kk = x.key.slice(6);
  const tk = isEv.map((e) => e.taken.get(kk)).filter((t): t is Taken => !!t);
  if (tk.length) say(`  · 24 小时内被扫 ${pct(tk.filter((t) => t.quick).length, tk.length)}`);
}

say("\n--- E40b 早提示：同一批事件上和 C 配对（早 ≥ 4 根、样本内 ≥ −0.05R、各段 ≥ −0.1R、对随机 ≥ 0）");
const bRows: Row[] = [];
const extra = new Map<string, string>();
for (const dir of DIRS) for (const tf of TFS) for (const v of VOLS) {
  const kk = key(tf, dir, v);
  const pairs = events.filter((e) => e.dir === dir && e.C && e.taken.get(kk));
  const isP = pairs.filter((e) => inS(e.C!.trade.t));
  const early = med(isP.map((e) => e.C!.i - e.taken.get(kk)!.i));
  bRows.push(mk(`b:${kk}`, `${nameOf(tf, dir, v)} 对 C`, dir, pairs.map((e) => ({ ...e.taken.get(kk)!.trade, t: e.C!.trade.t })), pairs.map((e) => e.C!.trade), 1));
  extra.set(`e40:b:${kk}`, `  · 早进中位 ${early} 根 15 分钟；24 小时内被扫 ${pct(isP.filter((e) => e.taken.get(kk)!.quick).length, isP.length)} 对 C ${pct(isP.filter((e) => e.C!.quick).length, isP.length)}`);
}
for (const x of fin(bRows)) {
  say(line(x));
  say(extra.get(x.key)!);
  const cl = x.cells;
  const early = Number(extra.get(x.key)!.match(/早进中位 (-?\d+)/)?.[1]);
  const vr = vsRandom.get(`e40:a:${x.key.slice(6)}`);
  const ok = early >= 4 && cl.is.edgeR != null && cl.is.edgeR >= -0.05 && [cl.btc, cl.eth, cl.firstHalf, cl.secondHalf, cl.oos].every((g) => g.edgeR == null || g.edgeR >= -0.1) && vr != null && vr >= 0;
  say(`  · 早提示标准：${ok ? "通过" : "不通过"}`);
}

say("\n--- E40c 辅助判断：转强（C）之前出现过迹象的，对没出现过的");
const cRows2: Row[] = [];
for (const dir of DIRS) for (const tf of TFS) for (const v of VOLS) {
  const kk = key(tf, dir, v);
  const withC = events.filter((e) => e.dir === dir && e.C);
  cRows2.push(mk(`c:${kk}`, `C 之前有 ${nameOf(tf, dir, v)}`, dir, withC.filter((e) => e.sign.has(kk)).map((e) => e.C!.trade), withC.filter((e) => !e.sign.has(kk)).map((e) => e.C!.trade), 1));
}
for (const x of fin(cRows2)) say(line(x));

if (process.env.OUT) (await import("node:fs")).writeFileSync(process.env.OUT, out.join("\n") + "\n");
