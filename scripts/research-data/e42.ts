/**
 * E42（2026-11-05）：博主的“回踩看反应”入场法——在关键区等价格扫过局部低点（SFP）并迅速收回才做多，不是一到支撑就买。
 *   DATA_DIR=<研究库> [COINS=BTC] node --experimental-strip-types scripts/research-data/e42.ts
 * 变体：ZONE（区的宽度，默认 0.25 ATR）、LOCAL（局部低点回看根数，默认 12）、R_ATR（快速反弹的距离，默认 1 ATR）。
 * 先跑 build.ts（COINS=BTC,ETH；15 分钟 2022 年起、1 小时 2020 年起、日线、周线）。OUT=文件 另存一份输出。
 * 用户 11-05：以 BTC 为准、ETH 参考；时段（纽约开盘）不要限制死，只作分组；主线是“回踩时的反应”；视频里其他判断也一起看。
 *
 * 跑之前定好的规则（看结果之前写下，不再改）：
 * - 关键位（UTC 日 / 周，开盘时就已知）：前一日高 / 低 / 中点（均衡）、前一日 0.382 回撤（前一日收涨：高 − 0.382 × 振幅，做多用；
 *   收跌镜像，做空用）、前一日成交量分布（15 分钟 K 线的量均匀摊到 0.1% 价格格子）的 POC / VAH / VAL、前一日 30 分钟 TPO 的
 *   single prints（只被 1 根 30 分钟 K 线碰过、连续 ≥ 3 格、不在当天最高 / 最低那一格的区段，上下两条边）、本周开盘、上周开盘、
 *   上周高 / 低 / 中点。
 * - 事件：价格从上方来（16 根前收盘在位上 ≥ 0.5 倍 1 小时 ATR，同盯盘 FROM_*），第一次进入区（最低 ≤ 位 + 0.25 ATR，上一根还没进），
 *   每个位（种类 + 那一天 / 那一周）只算第一次。窗口 96 根 15 分钟（1 天）；收盘跌破位 0.8 ATR（失效，博主“看下一层”）或
 *   收盘离开位 3 ATR 就结束。做空镜像。
 * - 入场（窗口内第一次，收盘入场；止损 = 入场前最新极点外 p80 扫损缓冲 × 1 小时 ATR；离场 = 跟着 1 小时摆动点，最长 7 天，同 E19 / E40）：
 *   A  一到就买：碰到那根收盘（止损在位和那根最低价中更低的之外，同 E19 A）；
 *   S1 SFP 同根收回：某根最低价扫过局部低点（之前 12 根即 3 小时的最低价，且这个低点离位 ≤ 1 ATR）、最低价在区内、没低于位 0.8 ATR，
 *      并且这根收盘回到局部低点之上；
 *   S3 SFP 3 根内收回：同上，但扫过后 3 根内（含那根）第一次收回局部低点之上；
 *   R  快速反弹：碰到后 8 根（2 小时）内，第一次收盘离碰到后的极点 ≥ 1 倍 1 小时 ATR；
 *   C  15 分钟转强（盯盘现在的做法），窗口内。
 * - 比较：各自对随机入场（同币、同方向、同止损距离，每笔 3 个）；同一事件上 S1 对 A、S1 对 C、R 对 A、R 对 C 配对；
 *   S1 / R 作“早提示”按 E33 标准（对 C 早 ≥ 4 根中位、样本内 ≥ −0.05R、各段 ≥ −0.1R、对随机 ≥ 0）。
 * - S1 分组（各自对随机）：关键位种类；时段（亚洲 00–07 UTC、伦敦 07 点到纽约开盘、纽约开盘后 2.5 小时、其余）；
 *   这根扫的是不是本周新低（本周已过 ≥ 1 天）；前一天是不是同向大趋势日（振幅 ≥ 之前 20 天中位 1.5 倍、收在上 1/3）；
 *   收在上周中点之上 / 下；位附近（0.25 ATR）有 ≥ 2 种关键位。
 * - 一个币、一个方向、一种入场同时只持有一笔；达标按 judge（≥ 0.1R、BH 校正后显著、BTC / ETH / 前后两半 / 样本外同向）。
 * - 描述统计（视频里的其他判断）：
 *   D1 大波动日之后是不是多为 inside day；亚洲时段（00–08 UTC）没延续的话，当天之后还越不越过前高 / 低；
 *   D2 日内低点之后 4 小时反弹的强弱，和这个低点守成当天 / 本周低点的比例；
 *   D3 周线收在上周高点之上（吞没）之后，下一周是否继续；
 *   D4 各时段（UTC 小时）的平均振幅和成交量占比（纽约是不是主时段）。
 */
import { finish, loadHistory, type ResearchRow } from "../../src/lib/research/run.ts";
import { cells, makeSplit, type Trade } from "../../src/lib/research/engine.ts";
import { simulate, type SimContext } from "../../src/lib/research/sim.ts";
import { DEFAULT_ENGINE_PARAMS } from "../../src/lib/params.ts";
import { alignHigher } from "../../src/lib/ta/plan.ts";
import { atrSeries, bufferAtr } from "../../src/lib/ta/risk.ts";
import { structureSeries, swings, type Swing } from "../../src/lib/ta/structure.ts";
import { firstTurn, stopBeyond, turnAt } from "../../src/lib/ta/watch.ts";
import type { Candle } from "../../src/lib/types.ts";
import { BIGDAY_RULES, dayShape } from "../../src/lib/ta/bigday.ts";

const ep = DEFAULT_ENGINE_PARAMS;
const nowSec = Date.parse("2026-11-05T00:00:00Z") / 1000;
const COINS = (process.env.COINS ?? "BTC,ETH").split(",");
const WARMUP = 300;
const MAX_BARS = 672;
const QUICK_BARS = 96;
const WINDOW = 96;
const ZONE = Number(process.env.ZONE ?? 0.25);
const FROM_BARS = 16;
const FROM_ATR = 0.5;
const FAIL_ATR = 0.8;
const LEAVE_ATR = 3;
const LOCAL = Number(process.env.LOCAL ?? 12);
const LOCAL_NEAR = 1;
const R_BARS = 8;
const R_ATR = Number(process.env.R_ATR ?? 1);
const DAY = 86400;

type Kind = "pdh" | "pdl" | "pmid" | "fib" | "poc" | "vah" | "val" | "sp" | "wopen" | "pwopen" | "pwh" | "pwl" | "pwmid";
const KIND_NAME: Record<Kind, string> = {
  pdh: "前一日高", pdl: "前一日低", pmid: "前一日中点", fib: "前一日 0.382", poc: "前一日 POC", vah: "前一日 VAH", val: "前一日 VAL",
  sp: "single prints", wopen: "本周开盘", pwopen: "上周开盘", pwh: "上周高", pwl: "上周低", pwmid: "上周中点",
};
const KINDS = Object.keys(KIND_NAME) as Kind[];
interface Lv { kind: Kind; price: number; dir: 0 | 1 | -1; id: string }
type Entry = "A" | "S1" | "S3" | "R" | "C";
const ENTRY_NAME: Record<Entry, string> = { A: "A 一到就买", S1: "S1 SFP 同根收回", S3: "S3 SFP 3 根内收回", R: "R 快速反弹 1 ATR", C: "C 15 分钟转强" };
const ENTRIES = Object.keys(ENTRY_NAME) as Entry[];

interface Taken { trade: Trade; i: number; quick: boolean; mfe: number }
interface Ev {
  coin: string; dir: 1 | -1; k0: number; t: number; lv: Lv;
  at: Partial<Record<Entry, { i: number; stop: number }>>;
  tags: Record<string, string>;
  taken: Partial<Record<Entry, Taken>>;
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
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : NaN;
};

/** New York's 9:30 open in UTC seconds of the day (US DST: second Sunday of March to first Sunday of November). */
function nyOpen(daySec: number): number {
  const d = new Date(daySec * 1000);
  const y = d.getUTCFullYear();
  const nthSunday = (m: number, n: number) => {
    const first = new Date(Date.UTC(y, m, 1)).getUTCDay();
    return Date.UTC(y, m, 1 + ((7 - first) % 7) + 7 * (n - 1)) / 1000;
  };
  const dst = daySec >= nthSunday(2, 2) && daySec < nthSunday(10, 1);
  return dst ? 13.5 * 3600 : 14.5 * 3600;
}
function session(t: number): string {
  const day = Math.floor(t / DAY) * DAY, s = t + 900 - day; // the bar's close, seconds into the UTC day
  const ny = nyOpen(day);
  if (s <= 7 * 3600) return "亚洲 00–07";
  if (s <= ny) return "伦敦 07–纽约开盘";
  if (s <= ny + 2.5 * 3600) return "纽约开盘后 2.5 小时";
  return "其余（美盘下午 / 收盘后）";
}

/** Volume profile and TPO single prints of one day's 15-minute bars. */
function dayProfile(bars: Candle[]): { poc: number; vah: number; val: number; sp: number[] } | null {
  if (bars.length < 48) return null;
  const hi = Math.max(...bars.map((b) => b.h)), lo = Math.min(...bars.map((b) => b.l));
  const bw = bars[bars.length - 1].c * 0.001;
  const n = Math.max(1, Math.ceil((hi - lo) / bw));
  const vol = new Float64Array(n), tpo = new Int32Array(n);
  const bin = (p: number) => Math.min(n - 1, Math.max(0, Math.floor((p - lo) / bw)));
  for (const b of bars) {
    const a = bin(b.l), z = bin(b.h);
    for (let k = a; k <= z; k++) vol[k] += b.v / (z - a + 1);
  }
  for (let j = 0; j + 1 < bars.length; j += 2) {
    const a = bin(Math.min(bars[j].l, bars[j + 1].l)), z = bin(Math.max(bars[j].h, bars[j + 1].h));
    for (let k = a; k <= z; k++) tpo[k]++;
  }
  let p = 0;
  for (let k = 1; k < n; k++) if (vol[k] > vol[p]) p = k;
  const total = vol.reduce((s, x) => s + x, 0);
  let a = p, z = p, acc = vol[p];
  while (acc < 0.7 * total && (a > 0 || z < n - 1)) {
    const up = z < n - 1 ? vol[z + 1] : -1, dn = a > 0 ? vol[a - 1] : -1;
    if (up >= dn) acc += vol[++z];
    else acc += vol[--a];
  }
  const sp: number[] = [];
  for (let k = 1; k < n - 1; k++) {
    if (tpo[k] !== 1 || tpo[k - 1] === 1) continue;
    let e = k;
    while (e + 1 < n - 1 && tpo[e + 1] === 1) e++;
    if (e - k + 1 >= 3) sp.push(lo + k * bw, lo + (e + 1) * bw);
    k = e;
  }
  return { poc: lo + (p + 0.5) * bw, vah: lo + (z + 1) * bw, val: lo + a * bw, sp };
}

interface CoinOut { coin: string; events: Ev[]; random: Map<string, Trade[]>; from: number }

function runCoin(coin: string, ci: number): CoinOut | null {
  const c = loadHistory(coin, "15m", nowSec);
  if (c.length < 5000) return null;
  const h = loadHistory(coin, "1h", nowSec);
  const mult = ep.structure.swingAtr;
  const buf = bufferAtr(null, 80);
  const times = c.map((x) => x.t);
  const ss = structureSeries(c, atrSeries(c), mult);
  const hatr = atrSeries(h);
  const hIdx = alignHigher(c, "15m", h, "1h");
  const atr = hIdx.map((j) => (j >= 0 ? hatr[j] : NaN));
  const at15 = (hourOpen: number) => lowerBound(times, hourOpen + 3600 - 900);
  const ctxSwings: Swing[] = swings(h, hatr, mult).map((s) => ({ ...s, i: lowerBound(times, h[s.i].t), confirmedAt: at15(h[s.confirmedAt].t) }));
  const ctx: SimContext = { c, atr, swings: ctxSwings, buf, costPct: ep.stats.costPct, maxBars: MAX_BARS };

  // ---- days and weeks (UTC; weeks from Monday)
  const dayOf = (t: number) => Math.floor(t / DAY);
  const weekOf = (t: number) => Math.floor((t / DAY + 3) / 7); // 1970-01-05 was a Monday
  const dayBars = new Map<number, [number, number]>();
  c.forEach((b, i) => {
    const d = dayOf(b.t), r = dayBars.get(d);
    if (r) r[1] = i;
    else dayBars.set(d, [i, i]);
  });
  const dayHL = (d: number) => {
    const r = dayBars.get(d);
    if (!r) return null;
    let H = -Infinity, L = Infinity;
    for (let i = r[0]; i <= r[1]; i++) (H = Math.max(H, c[i].h)), (L = Math.min(L, c[i].l));
    return { H, L, o: c[r[0]].o, c: c[r[1]].c, n: r[1] - r[0] + 1 };
  };
  const rangeHist: number[] = [];
  const dayLevels = new Map<number, Lv[]>();
  const bigDay = new Map<number, 0 | 1 | -1>();
  for (const d of [...dayBars.keys()].sort((a, b) => a - b)) {
    const p = dayHL(d - 1);
    const lv: Lv[] = [];
    if (p && p.n >= 90) {
      const R = p.H - p.L;
      const med = rangeHist.length >= 20 ? median(rangeHist.slice(-20)) : NaN;
      const pos = R > 0 ? (p.c - p.L) / R : 0.5;
      bigDay.set(d, R >= 1.5 * med ? (pos >= 2 / 3 ? 1 : pos <= 1 / 3 ? -1 : 0) : 0);
      rangeHist.push(R);
      const id = (k: string) => `${k}:${d}`;
      lv.push({ kind: "pdh", price: p.H, dir: 0, id: id("pdh") }, { kind: "pdl", price: p.L, dir: 0, id: id("pdl") }, { kind: "pmid", price: (p.H + p.L) / 2, dir: 0, id: id("pmid") });
      if (p.c > p.o) lv.push({ kind: "fib", price: p.H - 0.382 * R, dir: 1, id: id("fib") });
      if (p.c < p.o) lv.push({ kind: "fib", price: p.L + 0.382 * R, dir: -1, id: id("fib") });
      const r = dayBars.get(d - 1)!;
      const prof = dayProfile(c.slice(r[0], r[1] + 1));
      if (prof) {
        lv.push({ kind: "poc", price: prof.poc, dir: 0, id: id("poc") }, { kind: "vah", price: prof.vah, dir: 0, id: id("vah") }, { kind: "val", price: prof.val, dir: 0, id: id("val") });
        prof.sp.forEach((x, n) => lv.push({ kind: "sp", price: x, dir: 0, id: id(`sp${n}`) }));
      }
    } else if (p) rangeHist.push(p.H - p.L);
    dayLevels.set(d, lv);
  }
  const weekBars = new Map<number, [number, number]>();
  c.forEach((b, i) => {
    const w = weekOf(b.t), r = weekBars.get(w);
    if (r) r[1] = i;
    else weekBars.set(w, [i, i]);
  });
  const weekLevels = new Map<number, Lv[]>();
  const weekMid = new Map<number, number>();
  for (const w of weekBars.keys()) {
    const r = weekBars.get(w)!, p = weekBars.get(w - 1);
    const id = (k: string) => `${k}:w${w}`;
    const lv: Lv[] = [{ kind: "wopen", price: c[r[0]].o, dir: 0, id: id("wopen") }];
    if (p && p[1] - p[0] > 600) {
      let H = -Infinity, L = Infinity;
      for (let i = p[0]; i <= p[1]; i++) (H = Math.max(H, c[i].h)), (L = Math.min(L, c[i].l));
      lv.push({ kind: "pwopen", price: c[p[0]].o, dir: 0, id: id("pwopen") }, { kind: "pwh", price: H, dir: 0, id: id("pwh") }, { kind: "pwl", price: L, dir: 0, id: id("pwl") }, { kind: "pwmid", price: (H + L) / 2, dir: 0, id: id("pwmid") });
      weekMid.set(w, (H + L) / 2);
    }
    weekLevels.set(w, lv);
  }
  const levelsAt = (k: number) => (dayLevels.get(dayOf(c[k].t)) ?? []).concat(weekLevels.get(weekOf(c[k].t)) ?? []);

  let start = WARMUP;
  while (start < c.length && !(atr[start - 1] > 0)) start++;
  const hi = c.length - (MAX_BARS + 1);

  // ---- events
  const events: Ev[] = [];
  const seen = new Set<string>();
  for (let k = start; k < c.length - 1; k++) {
    const a = atr[k - 1];
    if (!(a > 0)) continue;
    for (const lv of levelsAt(k)) {
      for (const dir of [1, -1] as const) {
        if (lv.dir && lv.dir !== dir) continue;
        const L = lv.price, sid = `${lv.id}:${dir}`;
        if (seen.has(sid)) continue;
        const inZone = (b: Candle) => (dir > 0 ? b.l <= L + ZONE * a : b.h >= L - ZONE * a);
        if (!inZone(c[k]) || inZone(c[k - 1])) continue;
        if ((c[k - FROM_BARS].c - L) * dir < FROM_ATR * a) continue;
        // the bar must not have opened already through the level's far side (a gap through it is no test)
        if ((c[k].o - L) * dir < -FAIL_ATR * a) continue;
        seen.add(sid);
        events.push(scanEvent(k, dir, lv));
      }
    }
  }

  function scanEvent(k0: number, dir: 1 | -1, lv: Lv): Ev {
    const L = lv.price;
    const ev: Ev = { coin, dir, k0, t: c[k0].t, lv, at: {}, tags: {}, taken: {} };
    const a0 = atr[k0];
    let end = Math.min(c.length - 1, k0 + WINDOW);
    for (let k = k0; k <= end; k++) {
      if ((L - c[k].c) * dir > FAIL_ATR * atr[k] || (c[k].c - L) * dir > LEAVE_ATR * atr[k]) {
        end = k;
        break;
      }
    }
    const ext = (i0: number, i1: number) => {
      let x = dir > 0 ? Infinity : -Infinity;
      for (let j = i0; j <= i1; j++) x = dir > 0 ? Math.min(x, c[j].l) : Math.max(x, c[j].h);
      return x;
    };
    ev.at.A = { i: k0, stop: stopBeyond(dir > 0 ? Math.min(L, c[k0].l) : Math.max(L, c[k0].h), dir, buf, a0) };
    // S1 / S3
    for (let j = k0; j <= end && (!ev.at.S1 || !ev.at.S3); j++) {
      const a = atr[j];
      const loc = ext(j - LOCAL, j - 1);
      const sweep = (dir > 0 ? c[j].l < loc : c[j].h > loc) && (dir > 0 ? c[j].l <= L + ZONE * a : c[j].h >= L - ZONE * a) && (L - (dir > 0 ? c[j].l : c[j].h)) * dir <= FAIL_ATR * a && Math.abs(loc - L) <= LOCAL_NEAR * a;
      if (!sweep) continue;
      for (let m = j; m <= Math.min(end, j + 2); m++) {
        if ((c[m].c - loc) * dir > 0) {
          const x = { i: m, stop: stopBeyond(ext(j, m), dir, buf, atr[m]) };
          if (m === j && !ev.at.S1) ev.at.S1 = x;
          if (!ev.at.S3) ev.at.S3 = x;
          if (!ev.tags.week) {
            const wk = weekBars.get(weekOf(c[j].t))!;
            const sinceMon = c[j].t - c[wk[0]].t;
            const prior = wk[0] < j ? ext(wk[0], j - 1) : NaN;
            ev.tags.week = sinceMon < DAY ? "本周第一天" : (dir > 0 ? c[j].l < prior : c[j].h > prior) ? "扫出本周新极点" : "没有创本周新极点";
          }
          break;
        }
      }
    }
    // R
    for (let j = k0; j <= Math.min(end, k0 + R_BARS); j++) {
      const x = ext(k0, j);
      if ((c[j].c - x) * dir >= R_ATR * atr[j]) {
        ev.at.R = { i: j, stop: stopBeyond(x, dir, buf, atr[j]) };
        break;
      }
    }
    // C
    const g = firstTurn(c, k0, dir, WINDOW, (j, tX) => turnAt(ss[j], dir, tX));
    if (g) ev.at.C = { i: g.i, stop: stopBeyond(g.extreme, dir, buf, atr[g.i]) };
    // tags (at the touch, known then)
    const d = dayOf(c[k0].t), w = weekOf(c[k0].t);
    ev.tags.kind = KIND_NAME[lv.kind];
    const big = bigDay.get(d) ?? 0;
    ev.tags.big = big === dir ? "前一天是同向大趋势日" : big === -dir ? "前一天是反向大趋势日" : "前一天不是大趋势日";
    const mid = weekMid.get(w);
    ev.tags.eq = mid == null ? "" : (c[k0].c - mid) * dir > 0 ? "在上周中点有利一侧" : "在上周中点不利一侧";
    const near = new Set(levelsAt(k0).filter((x) => Math.abs(x.price - L) <= ZONE * a0).map((x) => x.kind));
    ev.tags.conf = near.size >= 2 ? "附近 ≥ 2 种位" : "只有 1 种位";
    if (ev.at.S1) ev.tags.session = session(c[ev.at.S1.i].t);
    return ev;
  }

  // ---- trades: one open trade per entry kind and direction (the trade's grouping rows reuse these)
  const random = new Map<string, Trade[]>();
  const rnd = rng(4200 + ci * 7);
  const addRandom = (list: Trade[], i: number, dir: 1 | -1, stop: number) => {
    const riskAtr = ((c[i].c - stop) * dir) / atr[i];
    for (let k = 0; k < 3 && hi > start; k++) {
      const u = start + Math.floor(rnd() * (hi - start));
      if (!(atr[u] > 0)) continue;
      const s = simulate(ctx, u, dir, c[u].c - dir * riskAtr * atr[u], "structure");
      if (s) list.push({ t: c[u].t, coin, r: s.r, pct: s.pct });
    }
  };
  events.sort((x, y) => x.k0 - y.k0);
  for (const dir of [1, -1] as const)
    for (const en of ENTRIES) {
      const kk = `${en}:${dir}`;
      random.set(kk, []);
      const taken = new Map<number, number>(); // entry bar → bars held (several events can share one entry bar)
      let free = -1;
      for (const ev of events) {
        if (ev.dir !== dir) continue;
        const x = ev.at[en];
        if (!x || !(atr[x.i] > 0) || (c[x.i].c - x.stop) * dir <= 0) continue;
        if (x.i < free && !taken.has(x.i)) continue;
        const s = simulate(ctx, x.i, dir, x.stop, "structure");
        if (!s) continue;
        ev.taken[en] = { trade: { t: c[x.i].t, coin, r: s.r, pct: s.pct }, i: x.i, quick: s.exit === "stop" && s.r < 0 && s.bars <= QUICK_BARS, mfe: s.mfe };
        if (!taken.has(x.i)) {
          taken.set(x.i, s.bars);
          free = x.i + s.bars;
          addRandom(random.get(kk)!, x.i, dir, x.stop);
        }
      }
    }
  return { coin, events, random, from: c[start].t };
}

// ---------------------------------------------------------------- run: entries

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
const mk = (k: string, name: string, dir: 1 | -1, sig: Trade[], ctl: Trade[], step: number): Row => ({ family: "watch", key: `e42:${k}`, name, side: dir > 0 ? "bull" : "bear", tf: "15m", horizon: MAX_BARS, cells: cells(sig, ctl, split, step) });
const fin = (rows: Row[]) => finish(rows, ep.stats.alpha, ep.stats.minSamples);
const line = (x: ReturnType<typeof fin>[number]) =>
  `${x.name.padEnd(34)} n ${String(x.cells.is.n).padStart(4)}  均 ${f(x.cells.is.meanR).padStart(6)}R  差 ${f(x.cells.is.edgeR).padStart(6)}R | BTC ${f(x.cells.btc.edgeR)}（${x.cells.btc.n}）ETH ${f(x.cells.eth.edgeR)} 前 ${f(x.cells.firstHalf.edgeR)} 后 ${f(x.cells.secondHalf.edgeR)} | 样本外 ${x.cells.oos.n} 笔 ${f(x.cells.oos.edgeR)} | q ${f(x.q, 3)} ${x.verdict}`;
const DIRS = [1, -1] as const;
const side = (d: 1 | -1) => (d > 0 ? "做多" : "做空");
const events = data.flatMap((d) => d.events);
const isEv = events.filter((e) => inS(e.t));
/** unique trades of one entry kind (several events can share an entry bar) */
const uniq = (evs: Ev[], en: Entry) => {
  const m = new Map<string, Taken>();
  for (const e of evs) {
    const x = e.taken[en];
    if (x) m.set(`${e.coin}:${e.dir}:${x.i}`, x);
  }
  return [...m.values()];
};
const rand = (en: Entry, dir: 1 | -1) => data.flatMap((d) => d.random.get(`${en}:${dir}`) ?? []);

say(`E42 回踩看反应（SFP）：${data.map((d) => d.coin).join(" / ")}，15 分钟从 ${new Date(first * 1000).toISOString().slice(0, 10)} 起，样本外从 ${new Date(split.holdoutFrom * 1000).toISOString().slice(0, 10)} 起`);
say(`事件 ${events.length}（样本内 ${isEv.length}：做多 ${isEv.filter((e) => e.dir > 0).length}，做空 ${isEv.filter((e) => e.dir < 0).length}）`);
for (const dir of DIRS) {
  const es = isEv.filter((e) => e.dir === dir);
  say(`${side(dir)}：事件里出现 ${ENTRIES.map((en) => `${en} ${pct(es.filter((e) => e.at[en]).length, es.length)}`).join("，")}`);
}

say("\n--- E42a 各种入场对随机入场（同方向、同止损距离；一个方向同时一笔）");
const aRows: Row[] = [];
for (const dir of DIRS) for (const en of ENTRIES) aRows.push(mk(`a:${en}:${dir}`, `${ENTRY_NAME[en]}（${side(dir)}）`, dir, uniq(events.filter((e) => e.dir === dir), en).map((x) => x.trade), rand(en, dir), 3));
const vsRandom = new Map<string, number | null>();
for (const x of fin(aRows)) {
  vsRandom.set(x.key, x.cells.is.edgeR);
  say(line(x));
  const [, , en, d] = x.key.split(":");
  const tk = uniq(isEv.filter((e) => e.dir === Number(d)), en as Entry);
  say(`  · 24 小时内被扫 ${pct(tk.filter((t) => t.quick).length, tk.length)}；止损前最远浮盈中位 ${f(median(tk.map((t) => t.mfe)))}R，先到 2R ${pct(tk.filter((t) => t.mfe >= 2).length, tk.length)}`);
}

say("\n--- E42b 同一事件上配对（左边减右边）；早提示按 E33 标准");
const pairs: [Entry, Entry][] = [["S1", "A"], ["S3", "A"], ["R", "A"], ["C", "A"], ["S1", "C"], ["S3", "C"], ["R", "C"]];
const bRows: Row[] = [];
const extra = new Map<string, string>();
for (const dir of DIRS)
  for (const [x, y] of pairs) {
    const seenP = new Set<string>();
    const ps = events.filter((e) => {
      if (e.dir !== dir || !e.taken[x] || !e.taken[y]) return false;
      const id = `${e.coin}:${e.taken[x]!.i}`; // one pair per entry bar of the left side (events can share it)
      if (seenP.has(id)) return false;
      seenP.add(id);
      return true;
    });
    const isP = ps.filter((e) => inS(e.t));
    const early = median(isP.map((e) => e.taken[y]!.i - e.taken[x]!.i));
    const k = `b:${x}-${y}:${dir}`;
    bRows.push(mk(k, `${x} 对 ${y}（${side(dir)}）`, dir, ps.map((e) => ({ ...e.taken[x]!.trade, t: e.t })), ps.map((e) => ({ ...e.taken[y]!.trade, t: e.t })), 1));
    extra.set(`e42:${k}`, `  · ${x} 比 ${y} 早进中位 ${early} 根 15 分钟；24 小时内被扫 ${pct(isP.filter((e) => e.taken[x]!.quick).length, isP.length)} 对 ${pct(isP.filter((e) => e.taken[y]!.quick).length, isP.length)}`);
  }
for (const x of fin(bRows)) {
  say(line(x));
  say(extra.get(x.key)!);
  const [, , pair, d] = x.key.split(":");
  const [l, r] = pair.split("-");
  if (r === "C" && l !== "C") {
    const cl = x.cells;
    const early = Number(extra.get(x.key)!.match(/早进中位 (-?[\d.]+)/)?.[1]);
    const vr = vsRandom.get(`e42:a:${l}:${d}`);
    const ok = early >= 4 && cl.is.edgeR != null && cl.is.edgeR >= -0.05 && [cl.btc, cl.eth, cl.firstHalf, cl.secondHalf, cl.oos].every((g) => g.edgeR == null || g.edgeR >= -0.1) && vr != null && vr >= 0;
    say(`  · 早提示标准：${ok ? "通过" : "不通过"}`);
  }
}

say("\n--- E42c S1（SFP 同根收回）按条件分组，各自对随机入场");
const tagSets: [string, string][] = [["kind", "关键位"], ["session", "时段"], ["week", "本周新极点"], ["big", "前一天"], ["eq", "上周中点"], ["conf", "位的重合"]];
for (const en of ["S1", "A"] as Entry[]) {
  say(`\n[${ENTRY_NAME[en]}]`);
  const cRows: Row[] = [];
  for (const dir of DIRS)
    for (const [tag, title] of tagSets) {
      if (en === "A" && tag !== "kind") continue;
      const vals = [...new Set(events.filter((e) => e.dir === dir && e.taken[en] && e.tags[tag]).map((e) => e.tags[tag]))].sort();
      for (const v of vals) {
        const es = events.filter((e) => e.dir === dir && e.tags[tag] === v && e.taken[en]);
        const m = new Map<string, Trade>();
        for (const e of es) m.set(`${e.coin}:${e.taken[en]!.i}`, e.taken[en]!.trade);
        cRows.push(mk(`c:${en}:${tag}:${v}:${dir}`, `${side(dir)} ${title}：${v}`, dir, [...m.values()], rand(en, dir), 3));
      }
    }
  for (const x of fin(cRows)) say(line(x));
}

// ---------------------------------------------------------------- descriptive: the video's other claims

say("\n=== 描述统计（视频里的其他判断，只描述）");
for (const coin of data.map((d) => d.coin)) {
  const d1 = loadHistory(coin, "1d", nowSec);
  const h1 = loadHistory(coin, "1h", nowSec);
  const w1 = loadHistory(coin, "1w", nowSec);
  const hByDay = new Map<number, Candle[]>();
  for (const b of h1) {
    const d = Math.floor(b.t / DAY);
    (hByDay.get(d) ?? hByDay.set(d, []).get(d)!).push(b);
  }
  say(`\n[${coin}] 日线 ${new Date(d1[0].t * 1000).toISOString().slice(0, 10)} 起 ${d1.length} 天`);
  // D1
  const rows: { big: number; inside: boolean; upH: boolean; dnL: boolean; dir: number; asiaH: boolean; asiaL: boolean; laterH: boolean; laterL: boolean }[] = [];
  for (let i = 21; i < d1.length; i++) {
    const p = d1[i - 1], x = d1[i];
    const sh = dayShape(d1, i - 1); // the page's rule (ta/bigday.ts)
    if (!sh) continue;
    const hs = hByDay.get(Math.floor(x.t / DAY)) ?? [];
    if (hs.length < 24) continue;
    const asia = hs.slice(0, BIGDAY_RULES.asiaEndH), later = hs.slice(BIGDAY_RULES.asiaEndH);
    rows.push({
      big: sh.ratio, inside: x.h <= p.h && x.l >= p.l, upH: x.h > p.h, dnL: x.l < p.l, dir: sh.pos === "top" ? 1 : sh.pos === "bottom" ? -1 : 0,
      asiaH: asia.some((b) => b.h > p.h), asiaL: asia.some((b) => b.l < p.l), laterH: later.some((b) => b.h > p.h), laterL: later.some((b) => b.l < p.l),
    });
  }
  const show = (name: string, rs: typeof rows) => say(`  ${name.padEnd(30)} ${String(rs.length).padStart(5)} 天：第二天 inside day ${pct(rs.filter((r) => r.inside).length, rs.length)}，越过前高 ${pct(rs.filter((r) => r.upH).length, rs.length)}，跌破前低 ${pct(rs.filter((r) => r.dnL).length, rs.length)}`);
  say("  D1 大波动日之后（振幅对之前 20 天中位）");
  show("所有日子", rows);
  show("前一天 ≥ 1.5 倍", rows.filter((r) => r.big >= 1.5));
  show("前一天 ≥ 2 倍", rows.filter((r) => r.big >= 2));
  show("前一天 ≥ 2 倍且收在上 1/3", rows.filter((r) => r.big >= 2 && r.dir > 0));
  show("前一天 ≥ 2 倍且收在下 1/3", rows.filter((r) => r.big >= 2 && r.dir < 0));
  const cont = (name: string, rs: typeof rows, up: boolean) => {
    const asiaNo = rs.filter((r) => !(up ? r.asiaH : r.asiaL)), asiaYes = rs.filter((r) => (up ? r.asiaH : r.asiaL));
    say(`  ${name}：亚洲（00–08 UTC）已越过 ${pct(asiaYes.length, rs.length)}；亚洲没越过的 ${asiaNo.length} 天里，之后当天还越过 ${pct(asiaNo.filter((r) => (up ? r.laterH : r.laterL)).length, asiaNo.length)}`);
  };
  cont("所有日子 · 越过前高", rows, true);
  cont("前一天 ≥ 1.5 倍且收在上 1/3 · 越过前高", rows.filter((r) => r.big >= 1.5 && r.dir > 0), true);
  show("前一天 ≥ 2 倍且收在中间", rows.filter((r) => r.big >= 2 && r.dir === 0));
  cont("前一天 ≥ 2 倍且收在上 1/3 · 越过前高", rows.filter((r) => r.big >= 2 && r.dir > 0), true);
  cont("前一天 ≥ 2 倍且收在下 1/3 · 跌破前低", rows.filter((r) => r.big >= 2 && r.dir < 0), false);
  cont("所有日子 · 跌破前低", rows, false);
  cont("前一天 ≥ 1.5 倍且收在下 1/3 · 跌破前低", rows.filter((r) => r.big >= 1.5 && r.dir < 0), false);

  // D2: the day's low, 4 hours later
  const ha = atrSeries(h1);
  const hIndex = new Map(h1.map((b, i) => [b.t, i]));
  const d2: { bounce: number; day: boolean; wkLow: boolean; week: boolean; hour: number }[] = [];
  for (const [d, hs] of hByDay) {
    if (hs.length < 24) continue;
    let lowI = 0;
    for (let j = 1; j < 24; j++) {
      if (hs[j].l < hs[lowI].l) lowI = j;
      if (j - lowI === 4 && lowI <= 19) {
        const gi = hIndex.get(hs[j].t)!;
        const a = ha[gi];
        if (!(a > 0)) break;
        const lo = hs[lowI].l;
        const dayHold = hs.slice(j + 1).every((b) => b.l >= lo);
        const wkEnd = (Math.floor((d + 3) / 7) + 1) * 7 - 3; // next Monday (day number)
        let weekHold = dayHold;
        for (let g = gi + 1; g < h1.length && Math.floor(h1[g].t / DAY) < wkEnd && weekHold; g++) if (h1[g].l < lo) weekHold = false;
        // the week's low so far must be this one for "weekly low"
        const wkStart = wkEnd - 7;
        let priorWeekLow = Infinity;
        for (let g = gi - j + lowI - 1; g >= 0 && Math.floor(h1[g].t / DAY) >= wkStart; g--) priorWeekLow = Math.min(priorWeekLow, h1[g].l);
        d2.push({ bounce: (hs[j].c - lo) / a, day: dayHold, wkLow: lo < priorWeekLow, week: weekHold && lo < priorWeekLow, hour: lowI });
        break;
      }
    }
  }
  say("  D2 当天低点出现后 4 小时（且这 4 小时没再创新低），反弹多远（1 小时 ATR）→ 守成当天低点 / 本周低点");
  const b2 = (name: string, rs: typeof d2) => {
    const wk = rs.filter((r) => r.wkLow);
    say(`  ${name.padEnd(18)} ${String(rs.length).padStart(5)} 天：守成当天低点 ${pct(rs.filter((r) => r.day).length, rs.length)}；其中这个低点也是本周到那时最低的 ${wk.length} 天，守成本周低点 ${pct(wk.filter((r) => r.week).length, wk.length)}`);
  };
  for (const [lo, hi2, nm] of [[-Infinity, 1.5, "反弹 < 1.5 ATR"], [1.5, 3, "反弹 1.5–3 ATR"], [3, Infinity, "反弹 ≥ 3 ATR"]] as const) {
    b2(nm, d2.filter((r) => r.bounce >= lo && r.bounce < hi2));
    b2(`  其中低点在 08 点前`, d2.filter((r) => r.bounce >= lo && r.bounce < hi2 && r.hour < 8));
  }

  // D3: weekly close beyond the previous week's high / low
  let n = 0, nUp = 0, nHH = 0, nAll = 0, allUp = 0, allHH = 0, m = 0, mDn = 0, mLL = 0;
  for (let i = 1; i + 1 < w1.length; i++) {
    const p = w1[i - 1], x = w1[i], nx = w1[i + 1];
    nAll++;
    if (nx.c > x.c) allUp++;
    if (nx.h > x.h) allHH++;
    if (x.c > p.h) {
      n++;
      if (nx.c > x.c) nUp++;
      if (nx.h > x.h) nHH++;
    }
    if (x.c < p.l) {
      m++;
      if (nx.c < x.c) mDn++;
      if (nx.l < x.l) mLL++;
    }
  }
  say(`  D3 周线：所有周 ${nAll} 周，下一周收涨 ${pct(allUp, nAll)}、越过这周高点 ${pct(allHH, nAll)}；收在上周高点之上 ${n} 周，下一周收涨 ${pct(nUp, n)}、越过这周高点 ${pct(nHH, n)}；收在上周低点之下 ${m} 周，下一周收跌 ${pct(mDn, m)}、跌破这周低点 ${pct(mLL, m)}`);

  // D4: by UTC hour, from 2024 (the ETF era)
  const since = Date.parse("2024-01-11T00:00:00Z") / 1000;
  const byH = Array.from({ length: 24 }, () => ({ r: 0, v: 0, n: 0 }));
  for (const b of h1) {
    if (b.t < since) continue;
    const hh = new Date(b.t * 1000).getUTCHours();
    byH[hh].r += (b.h - b.l) / b.o;
    byH[hh].v += b.v;
    byH[hh].n++;
  }
  const tv = byH.reduce((s, x) => s + x.v, 0);
  say(`  D4 2024-01-11 起每个 UTC 小时：平均振幅 / 成交量占比`);
  say("  " + byH.map((x, hh) => `${String(hh).padStart(2, "0")} ${((x.r / x.n) * 100).toFixed(2)}% ${((x.v / tv) * 100).toFixed(1)}%`).join(" | "));
}

if (process.env.OUT) (await import("node:fs")).writeFileSync(process.env.OUT, out.join("\n") + "\n");
