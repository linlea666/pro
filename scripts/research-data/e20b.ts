/**
 * E20b（2026-10-26）：裸 K 形态的三个改进想法，能不能让 E20 的形态比随机入场好。
 *   DATA_DIR=<研究库> node --experimental-strip-types scripts/research-data/e20b.ts [--coins all]
 *
 * 跑之前定好的规则（看结果之前写下，不再改）：
 * - 基线 V0：E20 原样的形态和入场（ta/patterns.ts 的 findPatterns，确认收盘入场，止损 = 极点外 p80 缓冲，
 *   风险 0.3–8 ATR，跟着本周期新确认的摆动点移动认错位，一个币、一种形态、一个方向同时只持有一笔）。
 *   为了和 V2 同一套撮合，交易都在小一级周期（4 小时 → 1 小时，日线 → 4 小时）上逐根模拟：
 *   ATR、摆动点、止损缓冲仍用本周期的，只是止损按小周期的 K 线检查。
 * - V1 区间过滤（Al Brooks：区间里多数突破会失败，只在区间两端做反转）：本周期结构为“区间”时，
 *   ① 不做突破型（孕线突破、突破回踩）；② 反转型（长影线、吞没、2B）只做入场价在区间下 1/3（做空上 1/3）的，
 *   区间 = 当时最近确认的摆动高点和低点。V1 = 基线去掉 ① ② 两类。
 * - V2 形态后再等转强（E19 的 C 做法）：形态确认后，在小一级周期上等“极点之后走出更高的低点，并收盘站上
 *   最近的反弹高点 0.1 倍 ATR”（watch.ts 的 turnAt，小周期自己的结构），最多等 6 根本周期 K 线；极点随新低更新，
 *   止损 = 最新极点外 p80 缓冲 × 本周期 ATR，风险 0.3–8 ATR 才做。确认那根已经转强的就在原处入场。
 *   和同一批形态的 V0 配对比较。
 * - V3 关键位加大周期翻转点：4 小时的关键位加日线“被突破后翻转”的摆动点（日线加周线的），
 *   看长影线 / 吞没 / 孕线突破在新关键位上是否比随机好、比中间好。
 * 对照：每笔 3 个同币、同方向、同止损 ATR 距离、同离场的随机入场。判定同 engine.ts 的 judge，BH 按周期分组。
 */
import { finish, loadHistory, type ResearchRow } from "../../src/lib/research/run.ts";
import { cells, makeSplit, type Trade } from "../../src/lib/research/engine.ts";
import { simulate, type SimContext } from "../../src/lib/research/sim.ts";
import { DEFAULT_ENGINE_PARAMS } from "../../src/lib/params.ts";
import { RESEARCH_COINS } from "../../src/lib/symbols.ts";
import { findPatterns, locateSetup, LOCATED, PA_HIGHER, PA_RULES, paLevelSource, PATTERNS, type PaFrame, type PaInput, type PaLevel, type PatternKind } from "../../src/lib/ta/patterns.ts";
import { MAX_HOLD_BARS, alignHigher } from "../../src/lib/ta/plan.ts";
import { atrSeries, bufferAtr, PIVOT_K } from "../../src/lib/ta/risk.ts";
import { flippedPivots } from "../../src/lib/ta/defend.ts";
import { structureSeries, swings, type Swing } from "../../src/lib/ta/structure.ts";
import { turnAt } from "../../src/lib/ta/watch.ts";
import { TF_SECONDS, type Timeframe } from "../../src/lib/types.ts";

const ep = DEFAULT_ENGINE_PARAMS;
const nowSec = Date.parse("2026-10-25T00:00:00Z") / 1000;
const COINS = process.argv.includes("--coins") ? RESEARCH_COINS : ["BTC", "ETH"];
const WARMUP = 300;
const WAIT = 6;
const BREAKOUT: PatternKind[] = ["inside", "retest"];
const TFS: [Timeframe, Timeframe][] = [["4h", "1h"], ["1d", "4h"]];
const HOLD: Partial<Record<Timeframe, number>> = { "4h": MAX_HOLD_BARS["4h"] ?? 180, "1d": MAX_HOLD_BARS["1d"] ?? 90 };

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

interface T {
  coin: string;
  kind: PatternKind;
  t: number;
  v0: Trade;
  v0ctl: Trade[];
  range: boolean;
  /** entry in the range's far third (bottom for longs); null outside a range */
  edge: boolean | null;
  locOld: "key" | "mid";
  locNew: "key" | "mid";
  v2: Trade | null;
  v2ctl: Trade[];
  /** the turn had already come at the confirming close */
  v2same: boolean;
}

type Row = Omit<ResearchRow, "q" | "consistent" | "verdict">;
const out: string[] = [];
const say = (s: string) => (console.log(s), out.push(s));

for (const [ti, [tf, lt]] of TFS.entries()) {
  const ratio = TF_SECONDS[tf] / TF_SECONDS[lt];
  const hold = HOLD[tf]!;
  const all: T[] = [];
  let first = Infinity;
  for (const [ci, coin] of COINS.entries()) {
    const c = loadHistory(coin, tf, nowSec);
    const lc = loadHistory(coin, lt, nowSec);
    if (c.length < WARMUP + hold + 200 || lc.length < 1000) continue;
    const mult = ep.structure.swingAtr;
    const atr = atrSeries(c);
    const ss = structureSeries(c, atr, mult);
    const higher: PaFrame[] = (PA_HIGHER[tf] ?? []).map((h) => {
      const hc = loadHistory(coin, h, nowSec);
      return { tf: h, c: hc, atr: atrSeries(hc) };
    });
    const daily = tf === "1d" ? c : loadHistory(coin, "1d", nowSec);
    const buf = bufferAtr(null, PA_RULES.stopQ);
    const old = paLevelSource(tf, c, atr, higher, daily);
    // V3: the higher timeframes' flipped swings join the key levels
    const hIdx = higher.map((f) => alignHigher(c, tf, f.c, f.tf));
    const flipCache = new Map<string, PaLevel[]>();
    const levelsNew = (s: number, dir: 1 | -1): PaLevel[] => {
      const extra: PaLevel[] = [];
      higher.forEach((f, n) => {
        const k = hIdx[n][s];
        if (k < 0) return;
        const key = `${n}|${k}|${dir}`;
        let x = flipCache.get(key);
        if (!x) {
          x = flippedPivots(f.c, f.atr, k, PIVOT_K[f.tf], dir > 0 ? "high" : "low").map((p) => ({ price: p.price, kind: "higher" as const }));
          flipCache.set(key, x);
        }
        extra.push(...x);
      });
      return [...old(s, dir), ...extra];
    };
    const inp: PaInput = { tf, c, atr, ss, levels: old, buf };
    const inpNew: PaInput = { ...inp, levels: levelsNew };

    // the lower timeframe carries the fills; ATR and swings stay this timeframe's
    const latr = atrSeries(lc);
    const lss = structureSeries(lc, latr, mult);
    const k2l = new Map<number, number>();
    lc.forEach((x, j) => k2l.set(x.t + TF_SECONDS[lt], j));
    const closeL = (k: number) => k2l.get(c[k].t + TF_SECONDS[tf]);
    const up = alignHigher(lc, lt, c, tf);
    const mA = up.map((k) => (k >= 0 ? atr[k] : NaN));
    const sw: Swing[] = [];
    for (const s of swings(c, atr, mult)) {
      const j = closeL(s.confirmedAt);
      if (j != null) sw.push({ ...s, confirmedAt: j });
    }
    const ctx: SimContext = { c: lc, atr: mA, swings: sw, buf, costPct: ep.stats.costPct, maxBars: hold * ratio };
    const loFirst = lc.findIndex((_, j) => up[j] >= WARMUP);
    if (loFirst < 0) continue;
    const hi = lc.length - (hold * ratio + 1);
    const control = (r: () => number, dir: 1 | -1, riskAtr: number): Trade[] => {
      const ctl: Trade[] = [];
      for (let m = 0; m < 3 && hi > loFirst; m++) {
        const u = loFirst + Math.floor(r() * (hi - loFirst));
        if (!(mA[u] > 0)) continue;
        const cr = simulate(ctx, u, dir, lc[u].c - dir * riskAtr * mA[u], "structure");
        if (cr) ctl.push({ t: lc[u].t, coin, r: cr.r, pct: cr.pct });
      }
      return ctl;
    };

    const setups = findPatterns(inp, { from: WARMUP, locate: false });
    for (const [ki, kind] of PATTERNS.entries()) {
      for (const dir of [1, -1] as const) {
        const r = rng(20260 + ti * 1000 + ci * 20 + ki * 2 + (dir > 0 ? 0 : 1));
        const list = setups.filter((x) => x.kind === kind && x.dir === dir && x.status === "entered" && x.ok).sort((a, b) => a.e! - b.e!);
        let free = -1;
        for (const x of list) {
          const e = x.e!;
          const jE = closeL(e);
          if (jE == null || jE < free) continue;
          const res = simulate(ctx, jE, dir, x.stop, "structure");
          if (!res) continue;
          free = jE + res.bars;
          first = Math.min(first, c[e].t);
          // V1: where the entry sits in the range (between the last confirmed swing high and low)
          const st = ss[x.s];
          const range = st?.state === "range";
          let edge: boolean | null = null;
          if (range && st.lastHigh && st.lastLow && st.lastHigh.price > st.lastLow.price) {
            const pos = (c[e].c - st.lastLow.price) / (st.lastHigh.price - st.lastLow.price);
            edge = dir > 0 ? pos <= 1 / 3 : pos >= 2 / 3;
          }
          // V2: wait on the lower timeframe for a higher low after the extreme and a close over the bounce high
          const jS = closeL(x.start - 1) ?? -1;
          let ext = x.extreme, extJ = jE;
          for (let j = Math.max(0, jS + 1); j <= jE; j++) if ((dir > 0 ? lc[j].l : lc[j].h) === ext) extJ = j;
          let v2: Trade | null = null, v2ctl: Trade[] = [], v2same = false;
          for (let j = jE; j <= Math.min(jE + WAIT * ratio, lc.length - 2); j++) {
            const low = dir > 0 ? lc[j].l : lc[j].h;
            if (j > jE && (low - ext) * dir < 0) (ext = low), (extJ = j);
            if (!lss[j] || !turnAt(lss[j], dir, lc[extJ].t)) continue;
            const A = mA[j];
            const stop = ext - dir * buf * A;
            const risk = ((lc[j].c - stop) * dir) / A;
            if (risk >= PA_RULES.minRiskAtr && risk <= PA_RULES.maxRiskAtr) {
              const r2 = simulate(ctx, j, dir, stop, "structure");
              if (r2) {
                v2 = { t: lc[j].t, coin, r: r2.r, pct: r2.pct };
                v2ctl = control(r, dir, risk);
                v2same = j === jE;
              }
            }
            break;
          }
          all.push({
            coin,
            kind,
            t: c[e].t,
            v0: { t: c[e].t, coin, r: res.r, pct: res.pct },
            v0ctl: control(r, dir, x.riskAtr),
            range,
            edge,
            locOld: locateSetup(inp, x),
            locNew: locateSetup(inpNew, x),
            v2,
            v2ctl,
            v2same,
          });
        }
      }
    }
  }
  if (!all.length) continue;
  const split = makeSplit(first, nowSec);
  const rows: Row[] = [];
  const mk = (key: string, name: string, list: T[], pick: "v0" | "v2" = "v0", ctlOf?: (x: T) => Trade[]) =>
    rows.push({
      family: "pa",
      key: `e20b:${tf}:${key}`,
      name: `${tf} · ${name}`,
      side: "bull",
      tf,
      horizon: hold,
      cells: cells(
        list.map((x) => (pick === "v0" ? x.v0 : x.v2!)),
        list.flatMap((x) => (ctlOf ? ctlOf(x) : pick === "v0" ? x.v0ctl : x.v2ctl)),
        split,
        ctlOf ? 1 : 3,
      ),
    });
  const breakoutInRange = (x: T) => x.range && BREAKOUT.includes(x.kind);
  const midReversal = (x: T) => x.range && !BREAKOUT.includes(x.kind) && x.edge === false;
  mk("v0", "V0 基线：全部形态", all);
  mk("v1", "V1 区间过滤后保留的", all.filter((x) => !breakoutInRange(x) && !midReversal(x)));
  mk("v1-drop-break", "V1 去掉的：区间里的突破型", all.filter(breakoutInRange));
  mk("v1-drop-mid", "V1 去掉的：区间中部的反转型", all.filter(midReversal));
  mk("v1-edge", "区间两端的反转型", all.filter((x) => x.range && !BREAKOUT.includes(x.kind) && x.edge === true));
  const w = all.filter((x) => x.v2);
  mk("v2", "V2 等小周期转强再进", w, "v2");
  mk("v2-vs-v0", "V2 对 V0（同一批形态）", w, "v2", (x) => [x.v0]);
  const loc = all.filter((x) => LOCATED.includes(x.kind));
  mk("v3-key-old", "长影线/吞没/孕线 · 关键位（原定义）", loc.filter((x) => x.locOld === "key"));
  mk("v3-key-new", "长影线/吞没/孕线 · 关键位（加大周期翻转点）", loc.filter((x) => x.locNew === "key"));
  mk("v3-added", "长影线/吞没/孕线 · 新增进关键位的", loc.filter((x) => x.locNew === "key" && x.locOld === "mid"));
  mk("v3-mid-new", "长影线/吞没/孕线 · 中间（新定义）", loc.filter((x) => x.locNew === "mid"));
  for (const kind of PATTERNS) {
    const wk = w.filter((x) => x.kind === kind);
    mk(`v2-${kind}`, `V2 对 V0 · ${kind}`, wk, "v2", (x) => [x.v0]);
  }
  const f = (v: number | null | undefined, d = 2) => (v == null ? "—" : v.toFixed(d));
  say(`\n===== ${tf}（成交按 ${lt}），${COINS.join(" / ")}，从 ${new Date(first * 1000).toISOString().slice(0, 10)} 起，样本外从 ${new Date(split.holdoutFrom * 1000).toISOString().slice(0, 10)} 起`);
  say(`V2：${all.length} 个形态里 ${w.length} 个等到了转强（${((w.length / all.length) * 100).toFixed(0)}%），其中 ${w.filter((x) => x.v2same).length} 个在确认那根就已转强；没等到的 ${all.length - w.length} 个按 V0 做的平均 ${f(mean(all.filter((x) => !x.v2).map((x) => x.v0.r)))}R`);
  for (const x of finish(rows, ep.stats.alpha, ep.stats.minSamples))
    say(
      `${x.name.padEnd(34)} n ${String(x.cells.is.n).padStart(4)}  均 ${f(x.cells.is.meanR).padStart(6)}R  对照差 ${f(x.cells.is.edgeR).padStart(6)}R | BTC ${f(x.cells.btc.edgeR)} ETH ${f(x.cells.eth.edgeR)} 前 ${f(x.cells.firstHalf.edgeR)} 后 ${f(x.cells.secondHalf.edgeR)} | 样本外 ${x.cells.oos.n} 笔 ${f(x.cells.oos.edgeR)} | q ${f(x.q, 3)} ${x.verdict}`,
    );
}
function mean(xs: number[]) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}
if (process.env.OUT) (await import("node:fs")).writeFileSync(process.env.OUT, out.join("\n") + "\n");
