import { PRIMARY_SOURCE } from "../data/klines.ts";
import { openInterestSeries } from "../data/perp.ts";
import type { EngineParams } from "../params.ts";
import { getDb } from "../server/db.ts";
import { RESEARCH_COINS } from "../symbols.ts";
import * as ta from "../ta/core.ts";
import type { OiSeries } from "../ta/defend.ts";
import { alignHigher } from "../ta/plan.ts";
import { atrSeries, bufferAtr } from "../ta/risk.ts";
import { normCdf } from "../ta/stats.ts";
import { structureSeries, swings, type Swing } from "../ta/structure.ts";
import { eventTriggers, FROM_BARS, levelSource, scanEvents, stopBeyond, type KeyLevel, type Trigger, type WatchInput } from "../ta/watch.ts";
import { SIGN_NAME, SIGNS, signsAt, type SignData, type SignKey } from "../ta/watchsigns.ts";
import type { Candle } from "../types.ts";
import { fundingFuel } from "./defend.ts";
import { bhAdjust, cells, controlTrades, judge, makeSplit, trades as fwdTrades, type Split, type Trade } from "./engine.ts";
import { loadHistory, type ResearchReport, type ResearchRow } from "./run.ts";
import { simulate, type SimContext, type SimResult } from "./sim.ts";

/**
 * E19: wait for the turn, or catch the knife?
 *
 * Price falls to a key low (the previous day / week / month low, an intact 4-hour or daily swing low) after
 * coming from above. Four ways to buy it, each on every such event, all with the stop beyond the newest low plus
 * the p80 sweep buffer and the same exit (trailing behind each new hour-chart swing, at most 7 days), so R is
 * comparable: A buys at the level on the touch; B after a sweep, on the first close back above it (within 4
 * hours); C when the 15-minute chart has turned (a higher low after the newest low, then a close above the latest
 * bounce high); C1 when the hour chart has. Highs and shorts are the mirror image.
 *
 * The main question is not mean R (E12 and E17 found no edge in such confirmations) but whether waiting means
 * being run over less ("接到半山腰": within 24 hours of the entry, price goes a further 1 ATR of the hour chart
 * against it) and at what cost: moves missed, mean R.
 *
 * E19b: for the C entries, seven signs at the low — momentum and flow divergences, spot buying, a volume climax,
 * an open-interest flush, crowded funding, the hour chart turning too — each with against without.
 * E19c: after the biggest 24-hour drops and rallies (the coin's own 5% tails), the next 72 hours.
 *
 * Definitions were fixed before looking at results.
 */

type Policy = "A" | "B" | "C" | "C1";
const POLICIES: Policy[] = ["A", "B", "C", "C1"];
const POLICY_NAME: Record<Policy, string> = {
  A: "碰到就进（在关键位直接接）",
  B: "扫过后收回再进",
  C: "15 分钟转强才进（等确认）",
  C1: "1 小时转强才进",
};

/** 15-minute bars: the reclaim window (the event window and the cooldown between events of one direction are
 * EngineParams.watch.windowBars, 288 = 3 days) */
const RECLAIM_BARS = 16;
/** longest hold (7 days) */
const MAX_BARS = 672;
/** "run over": within this many bars, a further HALFWAY_ATR of the hour chart's ATR against the entry */
const HALFWAY_BARS = 96;
const HALFWAY_ATR = 1;
/** stopped out at a loss within this many bars (24 hours) */
const QUICK_BARS = 96;
/** "missed": no trigger, but price went this many ATR the trade's way from the level within the window */
const MISSED_ATR = 2;
const MIN_BARS = 5000;
const WARMUP = 300;
/** E19c: hours held, hours of history before the tails are trusted, hours between events */
const HOLD = 72;
const MIN_HISTORY = 2000;
const COOL24 = 24;

type Row = Omit<ResearchRow, "q" | "consistent" | "verdict">;

interface Taken {
  trade: Trade;
  halfway: boolean;
  quick: boolean;
}

interface EvOut {
  t: number;
  coin: string;
  dir: 1 | -1;
  kind: KeyLevel["kind"];
  triggered: Record<Policy, boolean>;
  missed: { C: boolean; C1: boolean };
  taken: Record<Policy, Taken | null>;
}

interface CoinOut {
  coin: string;
  events: EvOut[];
  random: Record<Policy, Trade[]>;
  signs: { trade: Trade; v: Record<SignKey, boolean | null> }[];
  bars: number;
  from: number;
  to: number;
}

/** deterministic random numbers, so reports can be reproduced */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/** First index of a sorted array with value ≥ x (arr.length if none). */
function lowerBound(arr: number[], x: number): number {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : null);
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/** Two-proportion z-test (pooled), two-sided p-value. */
function twoProp(x1: number, n1: number, x2: number, n2: number): number | null {
  if (!n1 || !n2) return null;
  const p = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  if (!(se > 0)) return null;
  const z = (x1 / n1 - x2 / n2) / se;
  return Math.round(2 * (1 - normCdf(Math.abs(z))) * 10000) / 10000;
}

/**
 * One coin: the events, the four entries on each, the random control and the signs at the C entries.
 * Yields between the steps so the server keeps answering while the weekly report runs.
 */
async function runCoin(coin: string, ci: number, ep: EngineParams, nowSec: number, tick: () => Promise<unknown>): Promise<CoinOut | null> {
  const c = loadHistory(coin, "15m", nowSec);
  if (c.length < MIN_BARS) return null;
  const h = loadHistory(coin, "1h", nowSec);
  const c4 = loadHistory(coin, "4h", nowSec);
  const d1 = loadHistory(coin, "1d", nowSec);
  if (h.length < 100) return null;
  const spot = loadHistory(coin, "15m", nowSec, "binance-spot");
  const oi: OiSeries | null = openInterestSeries(coin, nowSec);
  const fr = getDb().prepare("SELECT t, rate FROM funding_rates WHERE coin = ? AND source = ? AND t <= ? ORDER BY t").all(coin, PRIMARY_SOURCE, nowSec) as { t: number; rate: number }[];
  const funding = { t: fr.map((x) => x.t), rate: fr.map((x) => x.rate) };
  const mult = ep.structure.swingAtr;
  const buf = bufferAtr(null, 80);
  const WINDOW = ep.watch.windowBars;
  const COOLDOWN = WINDOW;

  const times = c.map((x) => x.t);
  const spotTimes = spot.map((x) => x.t);
  const atr15 = atrSeries(c);
  const ss = structureSeries(c, atr15, mult);
  const rsi = ta.rsi(c.map((x) => x.c), 14);
  // the hour chart: its ATR is the unit of everything here; only hour bars closed by a 15-minute bar's close
  const hatr = atrSeries(h);
  const hss = structureSeries(h, hatr, mult);
  const hIdx = alignHigher(c, "15m", h, "1h");
  const atr = hIdx.map((j) => (j >= 0 ? hatr[j] : NaN));
  const idx4 = alignHigher(c, "15m", c4, "4h");
  const idx1 = alignHigher(c, "15m", d1, "1d");
  const atr4 = atrSeries(c4);
  const atr1 = atrSeries(d1);
  // hour swings for the trailing stop, on the 15-minute bar that closes with the hour bar that confirmed them
  const at15 = (hourOpen: number) => lowerBound(times, hourOpen + 3600 - 900);
  const ctxSwings: Swing[] = swings(h, hatr, mult).map((s) => ({ ...s, i: lowerBound(times, h[s.i].t), confirmedAt: at15(h[s.confirmedAt].t) }));
  const ctx: SimContext = { c, atr, swings: ctxSwings, buf, costPct: ep.stats.costPct, maxBars: MAX_BARS };
  const w: WatchInput = { c, atr, ss, h, hss, hIdx, levels: levelSource(c, d1, atr1, idx1, c4, atr4, idx4) };
  await tick();

  // ---- events: the first touch of a key level price came down (up) to; one per direction per window (3 days)
  let start = Math.max(WARMUP, FROM_BARS + 1);
  while (start < c.length && !(atr[start - 1] > 0)) start++;
  type Ev = { k0: number; dir: 1 | -1; level: KeyLevel; trig: Record<Policy, Trigger | null>; missed: { C: boolean; C1: boolean } };
  const evs: Ev[] = scanEvents(w, start, c.length - WINDOW, COOLDOWN).map((e) => {
    const { k0: k, dir } = e;
    const L = e.level.price;
    const trig = eventTriggers(w, e, WINDOW, RECLAIM_BARS);
    let best = -Infinity;
    for (let j = k; j <= k + WINDOW; j++) best = Math.max(best, ((dir > 0 ? c[j].h : c[j].l) - L) * dir);
    const went = best >= MISSED_ATR * atr[k];
    return { ...e, trig, missed: { C: !trig.C && went, C1: !trig.C1 && went } };
  });
  await tick();

  // E19b: the seven signs at the C entries (null: the data is missing)
  const sd: SignData = { c, times, ss, rsi, spot, spotTimes, oi, hss, hIdx, funding: (dir, at) => fundingFuel(funding, dir, at) };

  // ---- the trades: one at a time per policy and direction, as `sequential` in plans.ts
  const enter = (e: Ev, p: Policy): { i: number; entry: number; stop: number; r: SimResult } | null => {
    const g = e.trig[p];
    if (!g || !(atr[g.i] > 0)) return null;
    const { dir } = e;
    // A fills at the level while the touching bar is still trading: the extreme known at the fill is the level itself
    // (the bar's low comes after the fill), so its stop hangs below the level; the others enter at a close
    const stop = stopBeyond(p === "A" ? e.level.price : g.extreme, dir, buf, atr[g.i]);
    if (p === "A") {
      const L = e.level.price;
      const R = (L - stop) * dir;
      if (!(R > 0)) return null;
      // filled and stopped in the same bar: the conservative reading (as E16)
      if (dir > 0 ? c[g.i].l <= stop : c[g.i].h >= stop) {
        const r = -1 - ((ep.stats.costPct / 100) * L) / R;
        return { i: g.i, entry: L, stop, r: { r, pct: (r * R * 100) / L, bars: 0, mfe: 0, mae: 1, exit: "stop" } };
      }
      const r = simulate(ctx, g.i, dir, stop, "structure", L);
      return r ? { i: g.i, entry: L, stop, r } : null;
    }
    const r = simulate(ctx, g.i, dir, stop, "structure");
    return r ? { i: g.i, entry: c[g.i].c, stop, r } : null;
  };
  // run over: the price path after the fill (for A the rest of the touching bar too, which trades after the fill)
  const ranOver = (p: Policy, i: number, entry: number, dir: 1 | -1) => {
    const lim = entry - dir * HALFWAY_ATR * atr[i];
    for (let j = p === "A" ? i : i + 1; j < c.length && j <= i + HALFWAY_BARS; j++) if (dir > 0 ? c[j].l <= lim : c[j].h >= lim) return true;
    return false;
  };
  const out: EvOut[] = evs.map((e) => ({
    t: c[e.k0].t,
    coin,
    dir: e.dir,
    kind: e.level.kind,
    triggered: { A: !!e.trig.A, B: !!e.trig.B, C: !!e.trig.C, C1: !!e.trig.C1 },
    missed: e.missed,
    taken: { A: null, B: null, C: null, C1: null },
  }));
  const random: Record<Policy, Trade[]> = { A: [], B: [], C: [], C1: [] };
  const signs: CoinOut["signs"] = [];
  const hi = c.length - (MAX_BARS + 1);
  for (const [pi, p] of POLICIES.entries()) {
    const r = rng(1900 + ci * 10 + pi);
    for (const dir of [1, -1] as const) {
      let free = -1;
      evs.forEach((e, n) => {
        if (e.dir !== dir) return;
        const g = e.trig[p];
        if (!g || g.i < free) return;
        const x = enter(e, p);
        if (!x) return;
        free = x.i + x.r.bars;
        const trade: Trade = { t: c[x.i].t, coin, r: x.r.r, pct: x.r.pct };
        out[n].taken[p] = { trade, halfway: ranOver(p, x.i, x.entry, dir), quick: x.r.exit === "stop" && x.r.r < 0 && x.r.bars <= QUICK_BARS };
        // the random control: same coin, direction and stop distance in ATR, the same exits
        const riskAtr = ((x.entry - x.stop) * dir) / atr[x.i];
        for (let m = 0; m < 3 && hi > start; m++) {
          const u = start + Math.floor(r() * (hi - start));
          if (!(atr[u] > 0)) continue;
          const res = simulate(ctx, u, dir, c[u].c - dir * riskAtr * atr[u], "structure");
          if (res) random[p].push({ t: c[u].t, coin, r: res.r, pct: res.pct });
        }
        if (p === "C") signs.push({ trade, v: signsAt(sd, g.extremeI, g.i, g.extreme, dir) });
      });
    }
    await tick();
  }
  return { coin, events: out, random, signs, bars: c.length, from: c[start].t, to: c[c.length - 1].t };
}

interface Move24Out {
  coin: string;
  c: Candle[];
  atr: number[];
  from: number;
  drops: number[];
  rises: number[];
  /** std of the next 72 hourly returns over its median over all hours, by bar */
  vol: (number | null)[];
  ret: number[];
}

/** E19c, one coin: 24-hour returns in the coin's own 5% tails, on the history known at the time. */
function move24(coin: string, nowSec: number): Move24Out | null {
  const c = loadHistory(coin, "1h", nowSec);
  if (c.length < MIN_HISTORY + COOL24 + HOLD + 10) return null;
  const atr = atrSeries(c);
  const ret = c.map((x, i) => (i >= 24 && x.t - c[i - 24].t === 24 * 3600 ? x.c / c[i - 24].c - 1 : NaN));
  // expanding percentiles: a Fenwick tree over the ranks of every return
  const valid = ret.map((v, i) => i).filter((i) => Number.isFinite(ret[i]));
  const order = [...valid].sort((a, b) => ret[a] - ret[b]);
  const rank = new Map<number, number>();
  order.forEach((i, r) => rank.set(i, r));
  const m = order.length;
  const tree = new Array(m + 1).fill(0);
  let count = 0;
  const add = (r: number) => {
    for (let x = r + 1; x <= m; x += x & -x) tree[x]++;
  };
  const kth = (k: number) => {
    // smallest rank with k values at or below it (1-based k)
    let pos = 0, rem = k;
    for (let step = 1 << Math.floor(Math.log2(m)); step; step >>= 1) {
      if (pos + step <= m && tree[pos + step] < rem) {
        pos += step;
        rem -= tree[pos];
      }
    }
    return ret[order[pos]];
  };
  const drops: number[] = [], rises: number[] = [];
  let lastDrop = -1e9, lastRise = -1e9, from = -1;
  for (const i of valid) {
    if (count >= MIN_HISTORY && i + HOLD < c.length) {
      if (from < 0) from = i;
      const p5 = kth(Math.floor(0.05 * (count - 1)) + 1), p95 = kth(Math.floor(0.95 * (count - 1)) + 1);
      if (ret[i] <= p5 && i - lastDrop >= COOL24) {
        drops.push(i);
        lastDrop = i;
      }
      if (ret[i] >= p95 && i - lastRise >= COOL24) {
        rises.push(i);
        lastRise = i;
      }
    }
    add(rank.get(i)!);
    count++;
  }
  if (from < 0) return null;
  // how much the next 72 hours move, against the coin's usual
  const r1 = c.map((x, i) => (i > 0 ? x.c / c[i - 1].c - 1 : 0));
  const fwd: (number | null)[] = c.map((_, i) => {
    if (i + HOLD >= c.length) return null;
    let s = 0, s2 = 0;
    for (let j = i + 1; j <= i + HOLD; j++) {
      s += r1[j];
      s2 += r1[j] * r1[j];
    }
    const mean = s / HOLD;
    return Math.sqrt(Math.max(0, (s2 - HOLD * mean * mean) / (HOLD - 1)));
  });
  const med = median(fwd.filter((x): x is number => x != null)) ?? 0;
  const vol = fwd.map((x) => (x == null || !(med > 0) ? null : x / med));
  return { coin, c, atr, from, drops, rises, vol, ret };
}

export async function watchReport(ep: EngineParams, opts: { paramsVersion: number; coins?: string[]; nowSec?: number } = { paramsVersion: 0 }): Promise<ResearchReport> {
  const t0 = Date.now();
  const { coins = RESEARCH_COINS, nowSec = Date.now() / 1000 } = opts;
  const tick = () => new Promise((ok) => setImmediate(ok));
  const cost = ep.stats.costPct;
  const title = "盯盘：等转强 vs 碰到就进（接飞刀）";
  const data: CoinOut[] = [];
  for (const [ci, coin] of coins.entries()) {
    const d = await runCoin(coin, ci, ep, nowSec, tick);
    if (d) data.push(d);
    await tick();
  }
  const moves: Move24Out[] = [];
  for (const coin of coins) {
    const m = move24(coin, nowSec);
    if (m) moves.push(m);
    await tick();
  }
  const coverage: ResearchReport["coverage"] = [];
  const groups: Row[][] = [];
  const pre = makeSplit(nowSec, nowSec);
  let split: Split = pre;
  const mk = (family: Row["family"], key: string, name: string, sig: Trade[], ctl: Trade[], control: string, step: number, extra: Record<string, number | null>, sp: Split, tf: Row["tf"] = "15m", horizon = MAX_BARS): Row => ({
    family,
    key: `${family}:${key}`,
    name,
    side: "bull",
    tf,
    horizon,
    cells: cells(sig, ctl, sp, step),
    control,
    extra,
  });

  if (data.length) {
    const first = Math.min(...data.map((d) => d.from));
    split = makeSplit(first, nowSec);
    coverage.push({ tf: "15m", coins: data.length, bars: Math.round(data.reduce((s, d) => s + d.bars, 0) / data.length), from: first, to: Math.max(...data.map((d) => d.to)), holdoutFrom: split.holdoutFrom });
    const inS = (t: number) => t < split.holdoutFrom;
    const events = data.flatMap((d) => d.events);
    const isEvents = events.filter((e) => inS(e.t));

    // ---- E19: each entry against random entries
    const g1: Row[] = [];
    for (const p of POLICIES) {
      const taken = events.map((e) => e.taken[p]).filter((x): x is Taken => !!x);
      const isTaken = taken.filter((x) => inS(x.trade.t));
      const extra: Record<string, number | null> = {
        events: isEvents.length,
        eventsOos: events.length - isEvents.length,
        triggerPct: pct(isEvents.filter((e) => e.triggered[p]).length, isEvents.length),
        halfwayPct: pct(isTaken.filter((x) => x.halfway).length, isTaken.length),
        quickStopPct: pct(isTaken.filter((x) => x.quick).length, isTaken.length),
      };
      if (p === "C" || p === "C1") extra.missedPct = pct(isEvents.filter((e) => e.missed[p]).length, isEvents.length);
      g1.push(mk("watch", p, POLICY_NAME[p], taken.map((x) => x.trade), data.flatMap((d) => d.random[p]), "同方向、同止损距离的随机入场", 3, extra, split));
    }
    // paired: the same events, waiting against buying the touch
    const paired: { row: Row; p: number | null }[] = [];
    for (const p of ["B", "C", "C1"] as const) {
      const pairs = events.filter((e) => e.taken[p] && e.taken.A).map((e) => ({ x: e.taken[p]!, a: e.taken.A!, coin: e.coin }));
      const rate = (list: typeof pairs, f: (y: (typeof pairs)[number]) => boolean) => (list.length ? (list.filter(f).length / list.length) * 100 : null);
      const diff = (list: typeof pairs) => {
        const x = rate(list, (y) => y.x.halfway), a = rate(list, (y) => y.a.halfway);
        return x == null || a == null ? null : x - a;
      };
      const isP = pairs.filter((y) => inS(y.x.trade.t));
      const d0 = diff(isP);
      const parts = [
        isP.filter((y) => y.coin === "BTC"),
        isP.filter((y) => y.coin === "ETH"),
        isP.filter((y) => y.x.trade.t < split.mid),
        isP.filter((y) => !(y.x.trade.t < split.mid)),
        pairs.filter((y) => !inS(y.x.trade.t)),
      ].map(diff);
      const consistent = d0 != null && d0 !== 0 && parts.every((v) => v != null && Math.sign(v) === Math.sign(d0));
      const hp = twoProp(isP.filter((y) => y.x.halfway).length, isP.length, isP.filter((y) => y.a.halfway).length, isP.length);
      const r1 = (v: number | null) => (v == null ? null : Math.round(v * 10) / 10);
      const row = mk(
        "watch",
        `${p}_vs_A`,
        `${POLICY_NAME[p]} 对 碰到就进`,
        pairs.map((y) => y.x.trade),
        pairs.map((y) => y.a.trade),
        "同一批事件，碰到就进",
        1,
        {
          halfwayPct: r1(rate(isP, (y) => y.x.halfway)),
          halfwayA: r1(rate(isP, (y) => y.a.halfway)),
          quickStopPct: r1(rate(isP, (y) => y.x.quick)),
          quickStopA: r1(rate(isP, (y) => y.a.quick)),
          halfwayDiff: r1(d0),
          halfwayP: hp,
          halfwayQ: null,
          halfwayConsistent: consistent ? 1 : 0,
        },
        split,
      );
      paired.push({ row, p: hp });
      g1.push(row);
    }
    const hq = bhAdjust(paired.map((x) => x.p));
    paired.forEach((x, k) => (x.row.extra!.halfwayQ = hq[k]));
    groups.push(g1);

    // ---- E19b: signs at the C entries, with against without
    const g2: Row[] = [];
    const all = data.flatMap((d) => d.signs);
    for (const s of SIGNS) {
      const yes = all.filter((x) => x.v[s] === true).map((x) => x.trade);
      const no = all.filter((x) => x.v[s] === false).map((x) => x.trade);
      g2.push(mk("watch_sign", s, `迹象：${SIGN_NAME[s]}`, yes, no, "同一批 15 分钟转强入场，没有这项迹象", 1, { unknown: all.filter((x) => x.v[s] == null).length }, split));
    }
    groups.push(g2);
  }

  // ---- E19c: after the biggest 24-hour moves
  const notes24: string[] = [];
  if (moves.length) {
    const first = Math.min(...moves.map((m) => m.c[m.from].t));
    const sp = makeSplit(first, nowSec);
    coverage.push({ tf: "1h", coins: moves.length, bars: Math.round(moves.reduce((s, m) => s + m.c.length, 0) / moves.length), from: first, to: Math.max(...moves.map((m) => m.c[m.c.length - 1].t)), holdoutFrom: sp.holdoutFrom });
    const g3: Row[] = [];
    for (const [key, name, which, dir] of [
      ["drop:long", "24 小时大跌之后做多（接下来 72 小时）", "drops", 1],
      ["drop:short", "24 小时大跌之后顺势做空（接下来 72 小时）", "drops", -1],
      ["rise:short", "24 小时大涨之后做空（接下来 72 小时）", "rises", -1],
      ["rise:long", "24 小时大涨之后顺势做多（接下来 72 小时）", "rises", 1],
    ] as const) {
      const sig: Trade[] = [], ctl: Trade[] = [], ratios: number[] = [];
      let n = 0;
      for (const m of moves) {
        const idx = m[which];
        n += idx.length;
        sig.push(...fwdTrades(m.c, m.atr, idx, dir, HOLD, cost, m.coin));
        ctl.push(...controlTrades(m.c, m.atr, dir, HOLD, cost, m.coin, m.from));
        for (const i of idx) if (m.vol[i] != null) ratios.push(m.vol[i]!);
      }
      const vr = median(ratios);
      g3.push(mk("move24", key, name, sig, ctl, "同一币种、同一段时间每根 K 线同方向持有 72 小时", HOLD, { events: n, volRatio: vr == null ? null : Math.round(vr * 100) / 100 }, sp, "1h", HOLD));
    }
    groups.push(g3);
    const btc = moves.find((m) => m.coin === "BTC");
    if (btc) notes24.push(...btcMoves(btc));
  }

  const rows = groups.flatMap((g) => finish(g, ep));
  const sgn = (p: string) => (p === "C" ? "15 分钟" : "1 小时");
  const days = `${Math.round(((ep.watch.windowBars * 15) / 1440) * 10) / 10} 天`;
  return {
    kind: "watch",
    title,
    createdAt: Date.now(),
    source: PRIMARY_SOURCE,
    paramsVersion: opts.paramsVersion,
    costPct: cost,
    alpha: ep.stats.alpha,
    holdoutFrom: split.holdoutFrom,
    coins: data.map((d) => d.coin),
    coverage,
    rows,
    notes: [
      `事件：价格从上方（${FROM_BARS} 根 15 分钟 K 线之前的收盘至少高 0.5 倍 1 小时 ATR）第一次碰到一个关键低点——前一日 / 上周 / 上月低点（UTC 日历）、没被收盘跌破的 4 小时或日线摆动低点；关键位只用这根 15 分钟 K 线开盘之前已经收盘的数据，相距 0.25 倍 1 小时 ATR 以内的合并为一个（上月 > 上周 > 日线摆动点 > 前一日 > 4 小时摆动点）。同一方向 ${days}内只算一次；高点和做空是镜像。`,
      `四种进场，每个事件都算：A 碰到就进（在关键位挂单成交）；B 扫过后收回（${RECLAIM_BARS} 根 15 分钟内第一次收盘回到关键位之上）；C 15 分钟转强（触位后 ${days}内，最新低点之后 15 分钟出现更高的低点，并收盘站上最近的反弹高点 0.1 倍 ATR 以上）；C1 1 小时转强（同样的定义，看 1 小时收盘）。`,
      "四种进场的止损规则相同：入场时已知的最新低点之外加 p80 扫损缓冲（A 在关键位挂单成交，成交时还不知道这根 K 线会跌到哪，所以按关键位本身算）（0.8 倍 1 小时 ATR）；离场也相同：跟着新确认的 1 小时摆动点移动认错位，最长 7 天。所以 R 可以直接比较。A 那根 K 线如果同时碰到止损，按亏 1R 加成本算。一个币、一种进场、一个方向同时只持有一笔。",
      `“接到半山腰”：入场后 24 小时内价格又朝不利方向走了 1 倍 1 小时 ATR（只看价格路径，不管是否止损；A 包括成交那根 K 线剩下的部分）。“24 小时内被扫”：24 小时内打到止损出局。“错过”：${sgn("C")} / ${sgn("C1")}转强在 ${days}内一直没出现，但价格从关键位朝交易方向走出了 ${MISSED_ATR} 倍 1 小时 ATR。细节里的百分比都按样本内计（和“优势”一栏相同）。`,
      "预先写定的判据：只有“15 分钟转强 对 碰到就进”的“接到半山腰”比例至少少 5 个百分点、三组配对比较 BH 校正后 q < 0.05（halfwayQ）、并且 BTC / ETH、前后两半和最近 12 个月方向一致（halfwayConsistent = 1），才可以说“等转强能少接飞刀”。平均 R 的优势仍按常规标准判定。",
      "迹象（E19b，在 15 分钟转强的入场上，有对没有；数据缺失不算“没有”，单独计数）：动能衰竭——新低低于之前的 15 分钟摆动低点，RSI(14) 却高于那时；主动成交背离——从前一个摆动低点到新低，合约主动买入多于卖出；现货承接——新低前 16 根，现货主动买入占多、合约主动卖出占多；放量后缩量——新低那根成交量 ≥ 2 倍近 20 根中位数，更高的低点那根 < 1 倍；持仓量骤降——新低前 4 小时到那根收盘，持仓量降幅超过过去 30 天同长度变化的 p80；资金费率——入场时在 90 天的反方向 20% 分位；1 小时也已转强。",
      `24 小时涨跌（E19c）：每小时收盘的 24 小时涨跌幅落在这个币此前全部历史的 5% / 95% 分位之外（至少 ${MIN_HISTORY} 小时历史），同类事件相隔至少 24 小时；之后持有 72 小时，不设止损止盈，R = 入场时 1 倍 1 小时 ATR，交易之间不重叠；对照是同期每根 K 线。volRatio = 之后 72 小时每小时涨跌的波动 ÷ 这个币平时的中位数。`,
      ...notes24,
      "15 分钟数据：BTC / ETH 从 2022 年起，其余币只有最近约 1 年（大部分落在样本外）。10 个币走势高度相关，合并后的显著性偏乐观，以 BTC / ETH 分开的结果是否一致为准。",
    ],
    durationMs: Date.now() - t0,
    rules: { ...ep.watch },
  };
}

/** Plain numbers on BTC's 24-hour moves, for the notes. */
function btcMoves(m: Move24Out): string[] {
  const valid = m.ret.map((v, i) => i).filter((i) => Number.isFinite(m.ret[i]));
  const abs = valid.map((i) => Math.abs(m.ret[i])).sort((a, b) => a - b);
  const q = (x: number) => (abs[Math.floor(x * (abs.length - 1))] * 100).toFixed(1);
  const top = (sign: 1 | -1) => {
    const order = [...valid].sort((a, b) => (m.ret[b] - m.ret[a]) * sign);
    const picked: number[] = [];
    for (const i of order) {
      if (picked.length >= 5) break;
      if (picked.some((j) => Math.abs(j - i) < 24)) continue;
      picked.push(i);
    }
    return picked.map((i) => `${new Date((m.c[i].t + 3600) * 1000).toISOString().slice(0, 13).replace("T", " ")}:00 ${m.ret[i] > 0 ? "+" : ""}${(m.ret[i] * 100).toFixed(1)}%`).join("；");
  };
  const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
  return [
    `BTC 24 小时涨跌幅（${day(m.c[0].t)} 至 ${day(m.c[m.c.length - 1].t)}，每小时收盘）的绝对值：中位数 ${q(0.5)}%，p90 ${q(0.9)}%，p95 ${q(0.95)}%，p99 ${q(0.99)}%。`,
    `BTC 最大的 5 次 24 小时下跌（互不重叠，UTC 结束时刻）：${top(-1)}。最大的 5 次上涨：${top(1)}。`,
  ];
}

/** BH within one group of hypotheses, then the usual judgement. */
function finish(rows: Row[], ep: EngineParams): ResearchRow[] {
  const q = bhAdjust(rows.map((r) => (r.cells.is.n < ep.stats.minSamples ? null : r.cells.is.p)));
  return rows.map((r, k) => ({ ...r, q: q[k], ...judge(r.cells, q[k], ep.stats.alpha, ep.stats.minSamples) }));
}
