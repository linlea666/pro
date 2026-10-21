import { PRIMARY_SOURCE } from "../data/klines.ts";
import type { EngineParams } from "../params.ts";
import {
  findPatterns,
  LOCATED,
  locateSetup,
  PA_HIGHER,
  PA_RULES,
  paLevelSource,
  PATTERN_NAME,
  PATTERNS,
  type PaFrame,
  type PaInput,
  type PaLoc,
  type PaTrend,
  type PatternKind,
} from "../ta/patterns.ts";
import { MAX_HOLD_BARS } from "../ta/plan.ts";
import { atrSeries, bufferAtr } from "../ta/risk.ts";
import { structureSeries, swings } from "../ta/structure.ts";
import { cells, makeSplit, type Trade } from "./engine.ts";
import { finish, loadHistory, type ResearchReport, type ResearchRow } from "./run.ts";
import { runUp, simulate, type SimContext } from "./sim.ts";

/**
 * E20: do the classic naked-K patterns beat chance?
 *
 * Five patterns (ta/patterns.ts: long wick, engulfing, inside-bar breakout, false break 2B, breakout-retest) on the
 * 15-minute, hour, 4-hour and daily charts of every coin. Each is entered at the confirming close, with the stop
 * beyond the pattern's extreme plus the p80 sweep buffer, and managed like the plan's trades: the stop trails behind
 * each newly confirmed swing of the same chart, up to a holding cap. Every trade is compared with three random
 * entries on the same coin, in the same direction, with the same stop distance in ATR and the same exit.
 *
 * Rows: per timeframe and pattern, all trades and the textbook ones (at a key level and with the structure; 2B and
 * the retest sit on a swing by definition, so only with the structure), a subset of the same non-overlapping
 * trades. BH is applied within each (family, timeframe) group.
 *
 * Definitions were fixed before looking at results. Most patterns are expected to show no provable edge, which is
 * itself the lesson for beginners: report it as it is.
 */

/** the coins researched by default (the weekly job and the CLI) */
export const PA_COINS: string[] = ["BTC", "ETH"];
/** the timeframes reported; 15m and 1h are ready (hold caps, key-level frames) and can be added here */
export const PA_TFS: PaTf[] = ["4h", "1d"];
type PaTf = "15m" | "1h" | "4h" | "1d";
const TF_CN: Record<PaTf, string> = { "15m": "15 分钟", "1h": "1 小时", "4h": "4 小时", "1d": "日线" };
/** longest hold, bars: 15m 7 days (as E19), 1h 10 days (as E16), 4h 30 days and 1d 90 days (as the plan research) */
const HOLD: Record<PaTf, number> = { "15m": 672, "1h": 240, "4h": MAX_HOLD_BARS["4h"] ?? 180, "1d": MAX_HOLD_BARS["1d"] ?? 90 };
const HOLD_WHY: Record<PaTf, string> = { "15m": "7 天，同 E19 盯盘", "1h": "10 天，同 E16 关键位", "4h": "30 天，同交易计划研究", "1d": "90 天，同交易计划研究" };
/** "stopped at once": out at a loss within this many bars */
const QUICK_BARS = 6;
const WARMUP = 300;
/** bars scanned for patterns between two yields */
const CHUNK = 20000;
/** trades simulated between two yields */
const TICK_TRADES = 25;
const CONTROL = "同一币种、同方向、同止损距离的随机入场";

type Row = Omit<ResearchRow, "q" | "consistent" | "verdict">;

interface PaTrade {
  trade: Trade;
  kind: PatternKind;
  trend: PaTrend;
  loc: PaLoc;
  /** reached 2R before the initial stop */
  reach2: boolean;
  quick: boolean;
  riskAtr: number;
  /** this trade's three random entries */
  ctl: Trade[];
}

interface CoinOut {
  coin: string;
  trades: PaTrade[];
  /** every pattern that formed (both outcomes of one inside bar count once), for the trigger rate */
  formed: { kind: PatternKind; t: number; entered: boolean }[];
  bars: number;
  from: number;
  to: number;
}

/** deterministic random numbers, so reports can be reproduced */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : null);
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.floor(s.length / 2)] * 100) / 100;
};

/**
 * One coin on one timeframe: the patterns, the trades (one at a time per pattern and direction) and their random
 * controls. Yields between chunks of bars and of trades so the server keeps answering while the weekly report runs.
 */
async function runCoin(coin: string, ci: number, tf: PaTf, ti: number, ep: EngineParams, nowSec: number, tick: () => Promise<unknown>): Promise<CoinOut | null> {
  const c = loadHistory(coin, tf, nowSec);
  const hold = HOLD[tf];
  if (c.length < WARMUP + hold + 200) return null;
  const higher: PaFrame[] = (PA_HIGHER[tf] ?? []).map((htf) => {
    const hc = loadHistory(coin, htf, nowSec);
    return { tf: htf, c: hc, atr: atrSeries(hc) };
  });
  const daily = tf === "1d" ? c : loadHistory(coin, "1d", nowSec);
  await tick();
  const mult = ep.structure.swingAtr;
  const atr = atrSeries(c);
  const ss = structureSeries(c, atr, mult);
  await tick();
  const buf = bufferAtr(null, PA_RULES.stopQ);
  const inp: PaInput = { tf, c, atr, ss, levels: paLevelSource(tf, c, atr, higher, daily), buf };
  const ctx: SimContext = { c, atr, swings: swings(c, atr, mult), buf, costPct: ep.stats.costPct, maxBars: hold };
  await tick();

  const setups: ReturnType<typeof findPatterns> = [];
  for (let k = WARMUP; k < c.length; k += CHUNK) {
    for (const x of findPatterns(inp, { from: k, to: k + CHUNK, locate: false })) setups.push(x);
    await tick();
  }
  const formed: CoinOut["formed"] = [];
  const seen = new Set<string>();
  for (const x of setups) {
    if (x.status === "waiting") continue;
    const key = `${x.kind}|${x.start}|${x.kind === "inside" ? 0 : x.dir}`;
    if (seen.has(key)) continue;
    seen.add(key);
    formed.push({ kind: x.kind, t: c[x.start].t, entered: x.status === "entered" });
  }

  const trades: PaTrade[] = [];
  const hi = c.length - (hold + 1);
  for (const [ki, kind] of PATTERNS.entries()) {
    for (const dir of [1, -1] as const) {
      const r = rng(20200 + ti * 1000 + ci * 20 + ki * 2 + (dir > 0 ? 0 : 1));
      const list = setups.filter((x) => x.kind === kind && x.dir === dir && x.status === "entered" && x.ok).sort((a, b) => a.e! - b.e!);
      // one position at a time per coin, pattern and direction, as `sequential` in plans.ts
      let free = -1, n = 0;
      for (const x of list) {
        const e = x.e!;
        if (e < free) continue;
        const res = simulate(ctx, e, dir, x.stop, "structure");
        if (!res) continue;
        free = e + res.bars;
        // the random control: same coin, direction and stop distance in ATR, the same exits
        const ctl: Trade[] = [];
        for (let m = 0; m < 3 && hi > WARMUP; m++) {
          const u = WARMUP + Math.floor(r() * (hi - WARMUP));
          if (!(atr[u] > 0)) continue;
          const cr = simulate(ctx, u, dir, c[u].c - dir * x.riskAtr * atr[u], "structure");
          if (cr) ctl.push({ t: c[u].t, coin, r: cr.r, pct: cr.pct });
        }
        trades.push({
          trade: { t: c[e].t, coin, r: res.r, pct: res.pct },
          kind,
          trend: x.trend,
          loc: locateSetup(inp, x),
          reach2: runUp(ctx, e, dir, x.stop) >= 2,
          quick: res.exit === "stop" && res.r < 0 && res.bars <= QUICK_BARS,
          riskAtr: x.riskAtr,
          ctl,
        });
        if (++n % TICK_TRADES === 0) await tick();
      }
      await tick();
    }
  }
  return { coin, trades, formed, bars: c.length, from: c[WARMUP].t, to: c[c.length - 1].t };
}

export async function patternsReport(ep: EngineParams, opts: { paramsVersion: number; coins?: string[]; nowSec?: number } = { paramsVersion: 0 }): Promise<ResearchReport> {
  const t0 = Date.now();
  const { coins = PA_COINS, nowSec = Date.now() / 1000 } = opts;
  const tick = () => new Promise((ok) => setImmediate(ok));
  const coverage: ResearchReport["coverage"] = [];
  const groups: Row[][] = [];
  const used = new Set<string>();
  const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
  const covText: string[] = [];
  let holdoutFrom = makeSplit(nowSec, nowSec).holdoutFrom;

  for (const [ti, tf] of PA_TFS.entries()) {
    const data: CoinOut[] = [];
    for (const [ci, coin] of coins.entries()) {
      const d = await runCoin(coin, ci, tf, ti, ep, nowSec, tick);
      if (d) data.push(d);
      await tick();
    }
    if (!data.length) continue;
    for (const d of data) used.add(d.coin);
    const first = Math.min(...data.map((d) => d.from));
    const split = makeSplit(first, nowSec);
    holdoutFrom = split.holdoutFrom;
    const last = Math.max(...data.map((d) => d.to));
    coverage.push({ tf, coins: data.length, bars: Math.round(data.reduce((s, d) => s + d.bars, 0) / data.length), from: first, to: last, holdoutFrom: split.holdoutFrom });
    const btc = data.find((d) => d.coin === "BTC");
    covText.push(`${TF_CN[tf]} ${data.length} 个币，${day(first)} 至 ${day(last)}${btc ? `（BTC 从 ${day(btc.from)} 起）` : ""}`);

    const inS = (t: number) => t < split.holdoutFrom;
    const all = data.flatMap((d) => d.trades);
    const formed = data.flatMap((d) => d.formed).filter((x) => inS(x.t));
    // percentages and the median are in-sample, as the edge column
    const stats = (list: PaTrade[]): Record<string, number | null> => {
      const is = list.filter((x) => inS(x.trade.t));
      return {
        trades: list.length,
        reach2: pct(is.filter((x) => x.reach2).length, is.length),
        quickStopPct: pct(is.filter((x) => x.quick).length, is.length),
        riskAtrMed: median(is.map((x) => x.riskAtr)),
      };
    };
    const mk = (family: Row["family"], key: string, name: string, list: PaTrade[], extra: Record<string, number | null> = {}): Row => ({
      family,
      key: `${family}:${tf}:${key}`,
      name: `${TF_CN[tf]} · ${name}`,
      side: "bull",
      tf,
      horizon: HOLD[tf],
      cells: cells(
        list.map((x) => x.trade),
        list.flatMap((x) => x.ctl),
        split,
        3,
      ),
      control: CONTROL,
      extra: { ...stats(list), ...extra },
    });

    const main: Row[] = [];
    for (const kind of PATTERNS) {
      const name = PATTERN_NAME[kind];
      const mine = all.filter((x) => x.kind === kind);
      const f = formed.filter((x) => x.kind === kind);
      main.push(mk("pa", `${kind}:all`, `${name} · 全部`, mine, { setups: f.length, triggerPct: pct(f.filter((x) => x.entered).length, f.length) }));
      // the textbook way: at a key level and with the structure (2B and the retest are at a swing by definition)
      main.push(mk("pa", `${kind}:text`, `${name} · ${LOCATED.includes(kind) ? "关键位 + 顺势" : "顺势"}`, mine.filter((x) => x.loc === "key" && x.trend === "with")));
    }
    groups.push(main);
  }

  // BH within each (family, timeframe) group, then the usual judgement
  const rows = groups.flatMap((g) => finish(g, ep.stats.alpha, ep.stats.minSamples));
  return {
    kind: "patterns",
    title: "裸 K 形态：长影线、吞没、孕线突破、假突破 2B、突破回踩对随机入场（E20）",
    createdAt: Date.now(),
    source: PRIMARY_SOURCE,
    paramsVersion: opts.paramsVersion,
    costPct: ep.stats.costPct,
    alpha: ep.stats.alpha,
    holdoutFrom,
    coins: coins.filter((x) => used.has(x)),
    coverage,
    rows,
    notes: [
      `币种：${coins.filter((x) => used.has(x)).join("、") || "—"}。数据：${covText.join("；") || "—"}。每个币前 ${WARMUP} 根只用来预热；最近 365 天为样本外（从 ${day(holdoutFrom)} 起），样本内再分前后两半。`,
      `形态（做多；做空是镜像）：长影线——振幅 ≥ ${PA_RULES.pinRangeAtr} 倍 ATR，下影线 ≥ 振幅的一半，收盘在振幅上方 2/3，最低点是近 6 根最低；吞没——阴线后一根阳线实体包住它（实体 ≥ ${PA_RULES.engulfBodyAtr} 倍 ATR），两根的最低点是近 6 根最低；这两种在之后 ${PA_RULES.confirmBars} 根内收盘高于形态最高点入场，先收盘跌破形态最低点就作废。孕线突破——母线振幅 ≥ ${PA_RULES.motherAtr} 倍 ATR，之后 1–${PA_RULES.maxInside} 根在它范围内，再 ${PA_RULES.confirmBars} 根内第一次收在母线之外就按那个方向入场。假突破 2B——第一次跌破最近确认的摆动低点，这根和之后 ${PA_RULES.reclaimBars} 根内收盘回到它之上入场（先收盘跌破 ${PA_RULES.voidAtr} 倍 ATR 作废）。突破回踩——第一次收盘高于最近确认的摆动高点 ${PA_RULES.breakAtr} 倍 ATR，之后 ${PA_RULES.retestBars} 根内回到它上方 ${PA_RULES.retestAtr} 倍 ATR 以内算回踩，最近一根回踩之后 ${PA_RULES.retestConfirm} 根内收盘高于它的最高点入场。`,
      `入场在确认 K 线收盘；止损 = 形态极点外加 p${PA_RULES.stopQ} 扫损缓冲（${bufferAtr(null, PA_RULES.stopQ)} 倍入场时 ATR），风险不在 ${PA_RULES.minRiskAtr}–${PA_RULES.maxRiskAtr} 倍 ATR 之间的不做（同交易计划）。离场：跟着本周期新确认的摆动点移动认错位（摆动点外加同样的缓冲）。最长持有：${PA_TFS.map((tf) => `${TF_CN[tf]} ${HOLD[tf]} 根（${HOLD_WHY[tf]}）`).join("、")}。结果以 R 计（R = 入场到初始止损），已扣往返成本。`,
      `分类都在形态完成那根 K 线收盘时做，只用当时已知的数据：顺势看本周期结构（更高的高低点为上升，做多时上升为顺势）；关键位 = 形态极点 ${PA_RULES.keyAtr} 倍 ATR 以内有当时已知的支撑（做空看阻力）：本周期没被收盘越过的摆动点和被突破后翻转的摆动点（形态自己的 K 线不算）、更大周期没被越过的摆动点（4 小时看日线，日线看周线）、前一日 / 上周 / 上月高低（日线只看周和月）。假突破 2B 和突破回踩本身就在摆动点上，教科书一行只看顺势。`,
      `对照：每笔取同一币种、同方向、同止损 ATR 距离、同离场方式的 3 个随机 K 线入场（固定随机种子）。一个币、一种形态、一个方向同时只持有一笔，样本不重叠；教科书一行是同一批交易里在关键位、顺势的那些。细节一栏：笔数为全部交易；“先到 2R”= 打到初始止损前曾走到 2R 的比例，“6 根内被扫”= ${QUICK_BARS} 根 K 线内亏损止损出局的比例，风险中位数以入场时 ATR 计，“全部”行另给形态个数和被确认触发的比例——这些都按样本内计。`,
      "BH 校正按周期分组：每个周期 10 个假设（5 种形态 × 全部 / 教科书做法）；判定用统一标准（优势至少 0.1R、校正后显著，并且 BTC / ETH、前后两半和样本外方向一致）。",
      surprises(rows, ep.stats.minSamples),
      used.size > 1 ? `${used.size} 个币走势高度相关，合并后的显著性偏乐观，以 BTC / ETH 分开的结果是否一致为准。` : "只有一个币时，“BTC / ETH 方向一致”这一条无法满足，结论最多是“无可证明的优势”。",
    ],
    durationMs: Date.now() - t0,
    rules: { ...PA_RULES },
  };
}

/** What stands out, in one note: rows that passed either way, the biggest edge, and textbook against all. */
function surprises(rows: ResearchRow[], minSamples: number): string {
  const r2 = (x: number | null) => (x == null ? "—" : `${x >= 0 ? "+" : ""}${x.toFixed(2)}R`);
  const found = rows.filter((x) => x.verdict === "有优势" || x.verdict === "比随机差");
  const parts: string[] = [
    found.length
      ? `达到标准的行：${found.map((x) => `${x.name}（${x.verdict}，样本内 ${r2(x.cells.is.edgeR)}，样本外 ${r2(x.cells.oos.edgeR)}）`).join("；")}`
      : "没有一行达到“有优势”或“比随机差”的标准",
  ];
  const main = rows.filter((x) => x.family === "pa" && x.cells.is.n >= minSamples && x.cells.is.edgeR != null);
  const top = [...main].sort((a, b) => Math.abs(b.cells.is.edgeR!) - Math.abs(a.cells.is.edgeR!))[0];
  if (top) parts.push(`主表里样本内优势绝对值最大的是 ${top.name}：${r2(top.cells.is.edgeR)}（样本外 ${r2(top.cells.oos.edgeR)}，q ${top.q ?? "—"}，${top.verdict}）`);
  let better = 0, pairs = 0;
  for (const x of main.filter((y) => y.key.endsWith(":text"))) {
    const a = main.find((y) => y.key === x.key.replace(/:text$/, ":all"));
    if (!a) continue;
    pairs++;
    if (x.cells.is.edgeR! > a.cells.is.edgeR!) better++;
  }
  if (pairs) parts.push(`教科书做法（关键位 + 顺势）的样本内优势高于同一形态全部交易的：${better} / ${pairs} 组（周期 × 形态）`);
  return `意外发现：${parts.join("。")}。`;
}
