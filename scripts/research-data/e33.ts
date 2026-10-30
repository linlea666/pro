/**
 * E33（2026-10-30）：行情阶段梯。用户的痛点是下跌一路接、15 分钟转强来得太晚。
 *   DATA_DIR=<研究库> node --experimental-strip-types scripts/research-data/e33.ts
 * 先跑 build.ts（15 分钟 2022 年起、1 小时 2020 年起、4 小时 2021-10 起、日线）。OUT=文件 另存一份输出。
 *
 * 跑之前定好的规则（看结果之前写下，不再改）：
 * E33a 更早入场。事件、止损（最新极点外 p80 缓冲 × 1 小时 ATR）、离场（跟着 1 小时摆动点，最长 7 天）、随机对照（同币、
 *   同方向、同止损距离，每笔 3 个）全部沿用 E19 / E28，10 个币，15 分钟 2022 年起，样本外 = 最近 12 个月。
 *   - C 现行：15 分钟走出更高的低点（摆动点 2 倍 ATR 确认），收盘越过反弹高点 0.1 ATR，在这根收盘进；
 *   - Ci 盘中：同样的条件，但更高的低点一确认就在“反弹高点 + 0.1 ATR”挂条件单，之后哪根 K 线盘中碰到就按这个价
 *     （跳空按开盘价）成交；碰到的那根如果也创了新低，不算（先后不知道，保守）；确认那根收盘就已越过的，同 C；
 *   - Cf15 / Cf10：15 分钟摆动点按 1.5 / 1 倍 ATR 确认（更早出现更高的低点），其余同 C；
 *   - BC 分两半：扫过后收回（B）先进一半，转强（C）再进一半，各用各的止损；没有 B 就只有 C 那一半。只和 C 配对比。
 *   每种：对随机入场；同一批事件上对 C 配对；早于 C 的根数（中位）；入场离极点几个 R（(入场 − 极点) ÷ (入场 − 止损)，
 *   即“让出去的盈亏比”）；24 小时内被扫；接到半山腰（入场后 24 小时内又不利 1 倍 1 小时 ATR）。
 *   用户 2026-10-30 定的“早提示”标准（不劣且更早）：比 C 早进中位 ≥ 4 根（1 小时）；样本内对 C 配对平均 ≥ −0.05R；
 *   BTC、ETH、前后两半、样本外对 C 都不差于 −0.1R；样本内对随机 ≥ 0。全部满足才在页面上显示为“早提示”，正式入场仍是 C。
 * E33b 阶段转换（描述，不判优势）：1 小时和 4 小时，10 个币全部历史，`phaseAt` 每次进入 ②③④ 时（同一方向的梯子），
 *   之后 200 根内先到哪里：②③ 看先到 ④（同一梯子）还是先回到 ①；④ 看先继续创新高（梯子换到反方向的 ①）还是先收盘
 *   跌破更高的低点 0.1 ATR（转强失败）。（初稿把 ④ 的目标写成“结构判定为反方向趋势”，跑出来 100%：转强后只要回落 2 倍 ATR
 *   就会确认一个更高的高点，等于定义本身，改成上面这个。）BTC / ETH 和其他币分开，给次数、比例和中位根数；少于 20 次的不写进页面。
 */
import { finish, loadHistory, type ResearchRow } from "../../src/lib/research/run.ts";
import { cells, makeSplit, type Trade } from "../../src/lib/research/engine.ts";
import { simulate, type SimContext } from "../../src/lib/research/sim.ts";
import { DEFAULT_ENGINE_PARAMS } from "../../src/lib/params.ts";
import { RESEARCH_COINS } from "../../src/lib/symbols.ts";
import { alignHigher } from "../../src/lib/ta/plan.ts";
import { atrSeries, bufferAtr } from "../../src/lib/ta/risk.ts";
import { structureSeries, swings, type StructureState, type Swing } from "../../src/lib/ta/structure.ts";
import { phaseAt, type Phase } from "../../src/lib/ta/phase.ts";
import { BEYOND_ATR, eventTriggers, FROM_BARS, levelSource, scanEvents, stopBeyond, turnAt, type Trigger, type WatchInput } from "../../src/lib/ta/watch.ts";
import type { Candle } from "../../src/lib/types.ts";

const ep = DEFAULT_ENGINE_PARAMS;
const nowSec = Date.parse("2026-10-29T00:00:00Z") / 1000;
const WARMUP = 300;
const MAX_BARS = 672;
const RECLAIM_BARS = 16;
const HALFWAY_BARS = 96;
const QUICK_BARS = 96;
const HORIZON = 200;

type Pol = "C" | "Ci" | "Cf15" | "Cf10" | "B";
const NAME: Record<Pol | "BC", string> = {
  C: "C 15 分钟转强（现行）",
  Ci: "Ci 盘中碰到触发价就进",
  Cf15: "Cf15 摆动点 1.5 倍 ATR",
  Cf10: "Cf10 摆动点 1 倍 ATR",
  B: "B 扫过后收回",
  BC: "BC 收回进一半 + 转强进一半",
};
interface Taken {
  trade: Trade;
  i: number;
  halfway: boolean;
  quick: boolean;
  /** (entry − extreme) / (entry − stop) */
  given: number;
}
interface Ev {
  t: number;
  coin: string;
  taken: Partial<Record<Pol | "BC", Taken>>;
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

/** Ci: armed once the higher low is confirmed after the newest extreme; filled intrabar at bounce + 0.1 ATR. */
function ciTrigger(c: Candle[], ss: StructureState[], atr15: number[], k0: number, dir: 1 | -1, window: number): (Trigger & { px: number }) | null {
  let x = dir > 0 ? c[k0].l : c[k0].h, xi = k0;
  let trig: number | null = null;
  for (let k = k0 + 1; k < c.length && k <= k0 + window; k++) {
    const v = dir > 0 ? c[k].l : c[k].h;
    if ((v - x) * dir < 0) {
      x = v;
      xi = k;
      trig = null; // a new extreme (also when the bar reached the trigger too: which came first is unknown)
    } else if (trig != null && (dir > 0 ? c[k].h >= trig : c[k].l <= trig)) {
      const px = dir > 0 ? Math.max(c[k].o, trig) : Math.min(c[k].o, trig);
      return { i: k, extreme: x, extremeI: xi, extremeT: c[xi].t, px };
    }
    const s = ss[k];
    if (turnAt(s, dir, c[xi].t)) return { i: k, extreme: x, extremeI: xi, extremeT: c[xi].t, px: c[k].c };
    const sw = dir > 0 ? s.lastLow : s.lastHigh, other = dir > 0 ? s.lastHigh : s.lastLow;
    trig = sw && other && sw.t > c[xi].t && sw.label === (dir > 0 ? "HL" : "LH") ? other.price + dir * BEYOND_ATR * atr15[k] : null;
  }
  return null;
}

interface CoinOut {
  coin: string;
  events: Ev[];
  random: Record<Pol, Trade[]>;
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
  const ssBy: Record<"Cf15" | "Cf10", StructureState[]> = { Cf15: structureSeries(c, atr15, 1.5), Cf10: structureSeries(c, atr15, 1) };
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

  const ranOver = (i: number, entry: number, dir: 1 | -1) => {
    const lim = entry - dir * atr[i];
    for (let j = i + 1; j < c.length && j <= i + HALFWAY_BARS; j++) if (dir > 0 ? c[j].l <= lim : c[j].h >= lim) return true;
    return false;
  };
  const enter = (g: Trigger, dir: 1 | -1, px?: number) => {
    if (!(atr[g.i] > 0)) return null;
    const stop = stopBeyond(g.extreme, dir, buf, atr[g.i]);
    const r = simulate(ctx, g.i, dir, stop, "structure", px);
    return r ? { entry: px ?? c[g.i].c, stop, r } : null;
  };

  const random = { C: [], Ci: [], Cf15: [], Cf10: [], B: [] } as Record<Pol, Trade[]>;
  const hi = c.length - (MAX_BARS + 1);
  const evs = scanEvents(w, start, c.length - WINDOW, WINDOW);
  const events: Ev[] = evs.map((e) => ({ t: c[e.k0].t, coin, taken: {} }));
  const trig = (e: (typeof evs)[number], p: Pol): (Trigger & { px?: number }) | null => {
    if (p === "C" || p === "B") return eventTriggers(w, e, WINDOW, RECLAIM_BARS)[p];
    if (p === "Ci") return ciTrigger(c, ss, atr15, e.k0, e.dir, WINDOW);
    return eventTriggers({ ...w, ss: ssBy[p] }, e, WINDOW, RECLAIM_BARS).C;
  };
  for (const [pi, p] of (["C", "Ci", "Cf15", "Cf10", "B"] as Pol[]).entries()) {
    const r = rng(3300 + ci * 10 + pi);
    for (const dir of [1, -1] as const) {
      let free = -1;
      evs.forEach((e, n) => {
        if (e.dir !== dir) return;
        const g = trig(e, p);
        if (!g || g.i < free) return;
        const x = enter(g, dir, g.px);
        if (!x) return;
        free = g.i + x.r.bars;
        const trade: Trade = { t: c[g.i].t, coin, r: x.r.r, pct: x.r.pct };
        events[n].taken[p] = {
          trade,
          i: g.i,
          halfway: ranOver(g.i, x.entry, dir),
          quick: x.r.exit === "stop" && x.r.r < 0 && x.r.bars <= QUICK_BARS,
          given: ((x.entry - g.extreme) * dir) / ((x.entry - x.stop) * dir),
        };
        const riskAtr = ((x.entry - x.stop) * dir) / atr[g.i];
        for (let k = 0; k < 3 && hi > start; k++) {
          const u = start + Math.floor(r() * (hi - start));
          if (!(atr[u] > 0)) continue;
          const s = simulate(ctx, u, dir, c[u].c - dir * riskAtr * atr[u], "structure");
          if (s) random[p].push({ t: c[u].t, coin, r: s.r, pct: s.pct });
        }
      });
    }
  }
  // BC: half at B (when it comes before C), half at C
  for (const e of events) {
    const tc = e.taken.C;
    if (!tc) continue;
    const tb = e.taken.B && e.taken.B.i <= tc.i ? e.taken.B : null;
    const rr = 0.5 * tc.trade.r + (tb ? 0.5 * tb.trade.r : 0);
    e.taken.BC = { ...tc, trade: { ...tc.trade, t: tb ? tb.trade.t : tc.trade.t, r: rr, pct: 0.5 * tc.trade.pct + (tb ? 0.5 * tb.trade.pct : 0) }, i: tb ? tb.i : tc.i };
  }
  return { coin, events, random, from: c[start].t };
}

// ---------------------------------------------------------------- E33b

interface Tr {
  coin: string;
  tf: string;
  dir: 1 | -1;
  stage: number;
  /** "up": reached the next goal (④, or the fifth cell from ④); "back": back to ①; "none": neither within HORIZON */
  end: "up" | "back" | "none";
  bars: number;
}
function transitions(coin: string, tf: "1h" | "4h"): Tr[] {
  const c = loadHistory(coin, tf, nowSec);
  if (c.length < 500) return [];
  const atr = atrSeries(c);
  const ss = structureSeries(c, atr, ep.structure.swingAtr);
  const ph: (Phase | null)[] = c.map((_, n) => phaseAt(c, atr, ss, n, ep.structure.swingAtr));
  const out: Tr[] = [];
  for (let n = 1; n < c.length - 1; n++) {
    const p = ph[n], q = ph[n - 1];
    if (!p || p.stage === 1 || (q && q.dir === p.dir && q.stage === p.stage)) continue;
    let end: Tr["end"] = "none", bars = 0;
    for (let k = n + 1; k < c.length && k <= n + HORIZON; k++) {
      const x = ph[k];
      if (!x) continue;
      // ④ 之后结构很快就会判成反方向的趋势（梯子换边），所以 ④ 看的是：先继续创新高（换边后的 ①），还是先收盘跌破更高的低点
      const failed = p.stage < 4 ? x.dir === p.dir && x.stage === 1 : (c[k].c - p.invalid) * p.dir < -0.1 * atr[k];
      if (failed) {
        end = "back";
        bars = k - n;
        break;
      }
      if (p.stage < 4 ? x.dir === p.dir && x.stage === 4 : x.dir !== p.dir && x.stage === 1) {
        end = "up";
        bars = k - n;
        break;
      }
    }
    if (n + HORIZON >= c.length && end === "none") continue;
    out.push({ coin, tf, dir: p.dir, stage: p.stage, end, bars });
  }
  return out;
}

// ---------------------------------------------------------------- run

const data: CoinOut[] = [];
const trs: Tr[] = [];
for (const [ci, coin] of RESEARCH_COINS.entries()) {
  const t0 = Date.now();
  const d = runCoin(coin, ci);
  if (d) data.push(d);
  for (const tf of ["1h", "4h"] as const) trs.push(...transitions(coin, tf));
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
const mk = (key: string, name: string, sig: Trade[], ctl: Trade[], step: number): Row => ({ family: "watch", key: `e33:${key}`, name, side: "bull", tf: "15m", horizon: MAX_BARS, cells: cells(sig, ctl, split, step) });
const fin = (rows: Row[]) => finish(rows, ep.stats.alpha, ep.stats.minSamples);
const line = (x: ReturnType<typeof fin>[number]) =>
  `${x.name.padEnd(30)} n ${String(x.cells.is.n).padStart(4)}  均 ${f(x.cells.is.meanR).padStart(6)}R  对照差 ${f(x.cells.is.edgeR).padStart(6)}R | BTC ${f(x.cells.btc.edgeR)} ETH ${f(x.cells.eth.edgeR)} 前 ${f(x.cells.firstHalf.edgeR)} 后 ${f(x.cells.secondHalf.edgeR)} | 样本外 ${x.cells.oos.n} 笔 ${f(x.cells.oos.edgeR)} | q ${f(x.q, 3)} ${x.verdict}`;

const events = data.flatMap((d) => d.events);
say(`E33a 更早入场：${data.map((d) => d.coin).join(" / ")}，从 ${new Date(first * 1000).toISOString().slice(0, 10)} 起，样本外从 ${new Date(split.holdoutFrom * 1000).toISOString().slice(0, 10)} 起`);
say(`事件 ${events.length}（样本内 ${events.filter((e) => inS(e.t)).length}）`);

const tradesOf = (p: Pol) => events.map((e) => e.taken[p]?.trade).filter((x): x is Trade => !!x);
const desc = (p: Pol | "BC") => {
  const tk = events.filter((e) => inS(e.t)).map((e) => e.taken[p]).filter((x): x is Taken => !!x);
  const isE = events.filter((e) => inS(e.t)).length;
  return `  · 样本内触发 ${pct(tk.length, isE)}，入场离极点中位 ${f(med(tk.map((x) => x.given)))}R，接到半山腰 ${pct(tk.filter((x) => x.halfway).length, tk.length)}，24 小时内被扫 ${pct(tk.filter((x) => x.quick).length, tk.length)}`;
};

say("\n--- 对随机入场（同方向、同止损距离）");
const g1 = fin((["C", "Ci", "Cf15", "Cf10", "B"] as Pol[]).map((p) => mk(p, NAME[p], tradesOf(p), data.flatMap((d) => d.random[p]), 3)));
for (const [k, x] of g1.entries()) {
  say(line(x));
  say(desc((["C", "Ci", "Cf15", "Cf10", "B"] as Pol[])[k]));
}

say("\n--- 同一批事件上和 C 配对（早提示标准：早 ≥ 4 根、样本内 ≥ −0.05R、各段 ≥ −0.1R、对随机 ≥ 0）");
const vsRandom = new Map(g1.map((x) => [x.key, x.cells.is.edgeR]));
const g2rows: Row[] = [];
const extra = new Map<string, string>();
for (const p of ["Ci", "Cf15", "Cf10", "BC"] as const) {
  const pairs = events.filter((e) => e.taken[p] && e.taken.C);
  const isP = pairs.filter((e) => inS(e.taken.C!.trade.t));
  const early = med(isP.map((e) => e.taken.C!.i - e.taken[p]!.i));
  const rate = (q: Pol | "BC", k: "halfway" | "quick") => pct(isP.filter((e) => e.taken[q]![k]).length, isP.length);
  // pair on the C trade's time so both sides fall in the same split
  const sig = pairs.map((e) => ({ ...e.taken[p]!.trade, t: e.taken.C!.trade.t }));
  g2rows.push(mk(`${p}_vs_C`, `${NAME[p]} 对 C`, sig, pairs.map((e) => e.taken.C!.trade), 1));
  extra.set(`e33:${p}_vs_C`, `  · 早进中位 ${early} 根 15 分钟；入场离极点 ${f(med(isP.map((e) => e.taken[p]!.given)))}R 对 C ${f(med(isP.map((e) => e.taken.C!.given)))}R；半山腰 ${rate(p, "halfway")} 对 ${rate("C", "halfway")}；24 小时内被扫 ${rate(p, "quick")} 对 ${rate("C", "quick")}`);
}
for (const x of fin(g2rows)) {
  say(line(x));
  say(extra.get(x.key)!);
  const p = x.key.slice(4, -5);
  const cl = x.cells;
  const early = Number(extra.get(x.key)!.match(/早进中位 (-?\d+)/)?.[1]);
  const vr = p === "BC" ? null : vsRandom.get(`e33:${p}`);
  const ok = early >= 4 && cl.is.edgeR! >= -0.05 && [cl.btc, cl.eth, cl.firstHalf, cl.secondHalf, cl.oos].every((g) => g.edgeR == null || g.edgeR >= -0.1) && (vr == null || vr >= 0);
  say(`  · 早提示标准：${ok ? "通过" : "不通过"}`);
}

// ---------------------------------------------------------------- E33b output
say("\n--- E33b 阶段转换（进入这一格之后 200 根内先到哪里；描述）");
const NAMES: Record<number, string[]> = { 1: ["下跌中", "止跌尝试", "反弹", "转强", "上升中"], [-1]: ["上涨中", "滞涨尝试", "回调", "转弱", "下跌中"] };
const facts: string[] = [];
for (const tf of ["1h", "4h"]) {
  for (const grp of ["BTC/ETH", "其他"]) {
    for (const dir of [1, -1] as const) {
      for (const stage of [2, 3, 4]) {
        const xs = trs.filter((x) => x.tf === tf && x.dir === dir && x.stage === stage && (grp === "BTC/ETH") === (x.coin === "BTC" || x.coin === "ETH"));
        const up = xs.filter((x) => x.end === "up"), back = xs.filter((x) => x.end === "back");
        const goal = stage < 4 ? `到${NAMES[dir][3]}` : dir > 0 ? "继续创新高" : "继续创新低";
        const fail = stage < 4 ? `回${NAMES[dir][0]}` : dir > 0 ? "收盘跌破更高的低点" : "收盘涨破更低的高点";
        say(`${tf} ${grp.padEnd(7)} ${NAMES[dir][stage - 1]}（${dir > 0 ? "下跌后" : "上涨后"}）n ${String(xs.length).padStart(5)}：先${goal} ${pct(up.length, xs.length)}（中位 ${med(up.map((x) => x.bars))} 根），先${fail} ${pct(back.length, xs.length)}（中位 ${med(back.map((x) => x.bars))} 根），都没有 ${pct(xs.length - up.length - back.length, xs.length)}`);
        if (grp === "BTC/ETH") facts.push(`  "${tf}:${dir}:${stage}": { n: ${xs.length}, up: ${xs.length ? Math.round((up.length / xs.length) * 100) : 0}, back: ${xs.length ? Math.round((back.length / xs.length) * 100) : 0}, upBars: ${med(up.map((x) => x.bars)) || 0}, backBars: ${med(back.map((x) => x.bars)) || 0} },`);
      }
    }
  }
}
say("\nPHASE_FACTS（BTC/ETH）：\n" + facts.join("\n"));

if (process.env.OUT) (await import("node:fs")).writeFileSync(process.env.OUT, out.join("\n") + "\n");
