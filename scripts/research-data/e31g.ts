/**
 * E31g：知名交易员的四种滚仓做法，在 E31 的同一批交易上对照。规则在跑之前定好：
 *
 * - 入场、结构移动认错位、加仓触发、成本、资金费、R、切分同 E31（4 小时，日线定方向，10 个研究币，
 *   样本外 = 2025-10-27 起）。一个币同时只拿一笔；所有做法里最晚的离场之后才找下一笔。
 * - ONE 不滚；CUR 页面现在的稳健滚仓（收盘越过最近确认的摆动点 0.1 ATR 且在上一笔之外 → 加，
 *   `maxAdd` 预算 1R、≤ 上一笔 50%、最多 3 次，全部仓位共用结构认错位）。
 * - A 试仓分批建仓（利弗莫尔 / 米勒维尼 / Tony 的试仓 + 加仓）：A3 第一笔只拿 1/3，同一加仓触发再加两次、每次 1/3
 *   （加完整笔打到止损 ≤ 1R），A2 第一笔 1/2、再加一次 1/2。
 * - B 加仓单单独止损（Tony：“对新加的仓位，止损移到新的关键点……失败只止损加的仓位”）：每笔加仓另设止损 =
 *   刚越过的摆动点外 p80 扫损缓冲（和结构认错位取更紧的），打到只平这一笔，底仓照常；之后同一触发可以再加
 *   （最多 3 笔同时持有、一共 5 次）。B1 = CUR 的数量 + 单独止损（只看单独止损的作用）；BE = 等量加（1:1:1，
 *   Tony）+ 单独止损；B2 = 每笔加仓按自己的止损亏 0.5R 定数量、≤ 第一笔，B2u = 同样的数量但共用结构认错位（对照）。
 * - C 海龟式：每离上一笔 k 倍 ATR（入场时的 ATR）收盘就加一次，等量，最多 3 次（加完整笔打到止损 ≤ 1R）；
 *   每次加完把全部仓位的止损收紧到最新加仓价外 2 ATR（不放宽结构认错位）。C05 / C1 = k 0.5 / 1；C05s = C05 不收紧（对照）。
 * - D 高潮减仓（米勒维尼“走强时卖”）：DE 收盘离 EMA20 超过 3 ATR → 减 1/3；DR 连续 5 根同向收盘 → 减 1/3；
 *   每笔交易最多 2 次，条件要先消失再出现才算第二次。DE、DR 加在 ONE 上，DCE = DE 加在 CUR 上。
 * - 达标同 engine.ts：配对平均差 ≥ 0.1R、t ≥ 2、BTC / ETH / 前后两半 / 样本外方向一致。另报最大回撤、
 *   亏超 1.1R 的比例、大行情（ONE ≥ 5R 的那些笔）的平均。
 *
 *   node --experimental-strip-types scripts/research-data/e31g.ts <dataDir>
 */
import { readFileSync } from "node:fs";
import { alignHigher, findEntries, MAX_HOLD_BARS } from "../../src/lib/ta/plan.ts";
import { atrSeries, bufferAtr, calibrate } from "../../src/lib/ta/risk.ts";
import { ema } from "../../src/lib/ta/core.ts";
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

const KEYS = ["ONE", "CUR", "A3", "A2", "B1", "BE", "B2", "B2u", "C05", "C1", "C05s", "DE", "DR", "DCE"] as const;
type Key = (typeof KEYS)[number];
type Res = { coin: string; t: number; adds: Record<Key, number>; addStops: Record<Key, number> } & Record<Key, number>;

type Cfg = {
  first: number; // share of the full first position
  add?: "swing" | "turtle";
  sizing?: "page" | "probe" | "risk";
  pyr?: number;
  maxAdds?: number;
  own?: boolean; // separate stop for each add
  ownSize?: boolean; // B2u: size as if own stops, but share the structure stop
  k?: number; // turtle spacing, ATR
  unify?: boolean; // turtle: tighten all to last add − 2 ATR
  cut?: "ema" | "run";
};
const CFG: Record<Key, Cfg> = {
  ONE: { first: 1 },
  CUR: { first: 1, add: "swing", sizing: "page", pyr: 0.5, maxAdds: 3 },
  A3: { first: 1 / 3, add: "swing", sizing: "probe", maxAdds: 2 },
  A2: { first: 1 / 2, add: "swing", sizing: "probe", maxAdds: 1 },
  B1: { first: 1, add: "swing", sizing: "page", pyr: 0.5, maxAdds: 3, own: true },
  BE: { first: 1, add: "swing", sizing: "page", pyr: 1, maxAdds: 3, own: true },
  B2: { first: 1, add: "swing", sizing: "risk", maxAdds: 3, own: true },
  B2u: { first: 1, add: "swing", sizing: "risk", maxAdds: 3, ownSize: true },
  C05: { first: 1, add: "turtle", sizing: "page", pyr: 1, maxAdds: 3, k: 0.5, unify: true },
  C1: { first: 1, add: "turtle", sizing: "page", pyr: 1, maxAdds: 3, k: 1, unify: true },
  C05s: { first: 1, add: "turtle", sizing: "page", pyr: 1, maxAdds: 3, k: 0.5 },
  DE: { first: 1, cut: "ema" },
  DR: { first: 1, cut: "run" },
  DCE: { first: 1, add: "swing", sizing: "page", pyr: 0.5, maxAdds: 3, cut: "ema" },
};

function run(coin: string): Res[] {
  const j: J = JSON.parse(readFileSync(`${dir}/e30/${coin}.json`, "utf8"));
  const d1 = bars(j.d1);
  const c = bars(j.h4);
  if (c.length < WARMUP + 200) return [];
  const atr = atrSeries(c);
  const e20 = ema(c.map((x) => x.c), 20);
  const ss = structureSeries(c, atr, SWING_ATR);
  const sw = swings(c, atr, SWING_ATR);
  const fAtr = atrSeries(d1);
  const fss = structureSeries(d1, fAtr, SWING_ATR);
  const fIdx = alignHigher(c, TF, d1, FILTER);
  const isEnd = c.findIndex((x) => x.t >= OOS);
  const cal = calibrate(c.slice(0, isEnd > 0 ? isEnd : c.length), TF, 18);
  const buf = bufferAtr(cal, 80);
  const evs = findEntries({ tf: TF, c, atr, ss, filterAt: (t) => (fIdx[t] < 0 ? 0 : structureDirection(fss[fIdx[t]])), buf, from: WARMUP });
  const fund = j.funding;

  type Lot = { price: number; qty: number; i: number; own: number | null; add: boolean };
  const lotPnl = (d: number, l: Lot, qty: number, px: number, toT: number) => {
    let p = d * (px - l.price) * qty;
    const from = c[l.i].t + SEC;
    for (const [ft, rate] of fund) if (ft > from && ft <= toT) p -= d * rate * l.price * qty;
    return p;
  };

  function sim(i: number, d: 1 | -1, stop0: number, cfg: Cfg) {
    const E = c[i].c, risk0 = d * (E - stop0), q0 = 1 / risk0, atrE = atr[i];
    const tight = (a: number, b: number) => (d > 0 ? Math.max(a, b) : Math.min(a, b));
    let lots: Lot[] = [{ price: E, qty: q0 * cfg.first, i, own: null, add: false }];
    let pnl = -COST * E * q0 * cfg.first;
    let st = stop0, uni = d > 0 ? -Infinity : Infinity, k = 0, adds = 0, tries = 0, addStops = 0;
    let lastPx = E, cuts = 0, armed = true, runN = 0;
    while (k < sw.length && sw[k].confirmedAt <= i) k++;
    const end = Math.min(c.length - 1, i + MAXBARS);
    const fillsOf = () => lots.map((l, n): Fill => ({ kind: n === 0 && !l.add ? "open" : "add", price: l.price, qty: l.qty }));
    for (let jj = i + 1; jj <= end; jj++) {
      const b = c[jj];
      // stops in force during this bar
      const keep: Lot[] = [];
      for (const l of lots) {
        const s = l.own != null ? tight(tight(st, uni), l.own) : tight(st, uni);
        if (d > 0 ? b.l <= s : b.h >= s) {
          const px = d > 0 ? Math.min(s, b.o) : Math.max(s, b.o);
          pnl += lotPnl(d, l, l.qty, px, b.t);
          if (l.add && l.own != null && s === l.own && d * (l.own - tight(st, uni)) > 0) addStops++;
        } else keep.push(l);
      }
      lots = keep;
      if (!lots.length) return { pnl, exitBar: jj, adds, addStops };
      if (jj === i + MAXBARS) break;
      // trail the structure stop
      while (k < sw.length && sw[k].confirmedAt <= jj) {
        const s: Swing = sw[k++];
        if (s.kind !== (d > 0 ? "low" : "high")) continue;
        const level = s.price - d * buf * atr[jj];
        if ((level - st) * d > 0 && (b.c - level) * d > 0) st = level;
      }
      // D: climax cut
      if (cfg.cut && cuts < 2) {
        runN = d * (b.c - c[jj - 1].c) > 0 ? runN + 1 : 0;
        const hot = cfg.cut === "ema" ? d * (b.c - e20[jj]) > 3 * atr[jj] : runN >= 5;
        if (hot && armed) {
          for (const l of lots) {
            const q = l.qty / 3;
            pnl += lotPnl(d, l, q, b.c, b.t + SEC);
            l.qty -= q;
          }
          cuts++;
          armed = false;
          if (cfg.cut === "run") runN = 0;
        } else if (!hot) armed = true;
      }
      // adds
      if (!cfg.add || tries >= 5) continue;
      const openAdds = lots.filter((l) => l.add).length;
      if (openAdds >= (cfg.maxAdds ?? 3)) continue;
      if (cfg.sizing === "probe" && adds >= (cfg.maxAdds ?? 2)) continue;
      if (!cfg.own && cfg.sizing !== "risk" && adds >= (cfg.maxAdds ?? 3)) continue;
      let lvlPx: number | null = null;
      if (cfg.add === "swing") {
        const s = ss[jj], ext = d > 0 ? s.lastHigh : s.lastLow;
        if (!ext || !(atr[jj] > 0)) continue;
        const lvl = ext.price + d * PIERCE * atr[jj];
        if (!((b.c - lvl) * d > 0 && (c[jj - 1].c - lvl) * d <= 0)) continue;
        const ref = Math.max(...lots.map((l) => d * l.price)) * d;
        if ((ext.price - ref) * d <= 0) continue;
        lvlPx = ext.price;
      } else {
        if (!(d * (b.c - lastPx) >= (cfg.k ?? 1) * atrE)) continue;
      }
      if (d * (b.c - (lots.reduce((s, l) => s + l.price * l.qty, 0) / lots.reduce((s, l) => s + l.qty, 0))) <= 0) continue;
      const own = lvlPx != null ? lvlPx - d * buf * atr[jj] : null;
      const newUni = cfg.unify ? tight(uni, b.c - d * 2 * atrE) : uni;
      const stopNext = tight(st, newUni);
      let x = 0;
      if (cfg.sizing === "risk") {
        if (own == null || d * (b.c - own) <= 0) continue;
        x = Math.min(q0, 0.5 / (d * (b.c - own)));
      } else if (cfg.sizing === "probe") {
        const lim = maxAdd({ pos: positionOf(d, fillsOf(), 0), price: b.c, stop: stopNext, budget: 1, mode: "cross", leverage: 1, account: 1e18, atr: null, fee: 0, rules: { pyramid: 10, maxAdds: 9 } }).qty;
        x = Math.min(q0 * cfg.first, lim);
      } else {
        const pos = positionOf(d, fillsOf(), 0);
        if (cfg.own) pos.adds = Math.min(pos.adds, adds); // re-adds after an add was stopped out
        x = maxAdd({ pos, price: b.c, stop: stopNext, budget: 1, mode: "cross", leverage: 1, account: 1e18, atr: null, fee: 0, rules: { pyramid: cfg.pyr ?? 0.5, maxAdds: cfg.own ? 9 : (cfg.maxAdds ?? 3) } }).qty;
      }
      if (!(x > 0)) continue;
      tries++;
      adds++;
      lots.push({ price: b.c, qty: x, i: jj, own: cfg.own && own != null && d * (b.c - own) > 0 ? own : null, add: true });
      pnl -= COST * b.c * x;
      lastPx = b.c;
      uni = newUni;
    }
    // time exit at the close of the last bar
    const last = c[Math.min(end, i + MAXBARS)];
    for (const l of lots) pnl += lotPnl(d, l, l.qty, last.c, last.t + SEC);
    return { pnl, exitBar: Math.min(end, i + MAXBARS), adds, addStops };
  }

  const out: Res[] = [];
  let free = -1;
  for (const e of evs) {
    if (e.i < free) continue;
    if (e.i + MAXBARS >= c.length) continue;
    const d = e.dir;
    const row = { coin, t: c[e.i].t, adds: {}, addStops: {} } as Res;
    let maxExit = e.i;
    for (const key of KEYS) {
      const r = sim(e.i, d, e.stop, CFG[key]);
      row[key] = r.pnl;
      row.adds[key] = r.adds;
      row.addStops[key] = r.addStops;
      maxExit = Math.max(maxExit, r.exitBar);
    }
    free = maxExit;
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
const NAME: Record<Key, string> = {
  ONE: "不滚", CUR: "现在的稳健滚仓", A3: "A3 试仓 1/3 分批", A2: "A2 试仓 1/2 分批",
  B1: "B1 现数量+单独止损", BE: "BE 等量加+单独止损", B2: "B2 每笔 0.5R 单独止损", B2u: "B2u 同数量共用止损",
  C05: "C05 海龟 0.5ATR", C1: "C1 海龟 1ATR", C05s: "C05s 海龟不收紧",
  DE: "DE 离均线 3ATR 减", DR: "DR 连 5 根减", DCE: "DCE 滚仓+离均线减",
};
const is = all.filter((x) => x.t < OOS);
const big = is.filter((x) => x.ONE >= 5);
console.log(`E31g 知名交易员的滚仓做法  4 小时（日线定方向）  样本外从 2025-10-27`);
console.log(`交易 ${all.length} 笔（样本内 ${is.length}，其中 ONE ≥ 5R 的大行情 ${big.length} 笔）\n`);
console.log("样本内，R / 笔                 平均     中位   赚钱%  最大回撤  亏>1.1R%  大行情  平均加仓次数  加仓单被单独止损/笔  标准差  平均÷标准差");
for (const k of KEYS) {
  const a = is.map((x) => x[k]);
  console.log(
    `${NAME[k].padEnd(14, "　")}${f2(mean(a)).padStart(7)} ${f2(med(a)).padStart(7)} ${((a.filter((x) => x > 0).length / a.length) * 100).toFixed(0).padStart(6)} ${maxDD(is, k).toFixed(1).padStart(8)} ${((a.filter((x) => x < -1.1).length / a.length) * 100).toFixed(1).padStart(8)} ${f2(mean(big.map((x) => x[k]))).padStart(7)} ${mean(is.map((x) => x.adds[k])).toFixed(2).padStart(12)} ${mean(is.map((x) => x.addStops[k])).toFixed(2).padStart(12)} ${sd(a).toFixed(2).padStart(10)} ${(mean(a) / sd(a)).toFixed(3).padStart(8)}`,
  );
}
const SD: Record<string, number> = Object.fromEntries(KEYS.map((k) => [k, sd(is.map((x) => x[k]))]));
function paired(a: Key, b: Key, vol = false) {
  // vol: both sides scaled to the same per-trade spread as 不滚 (sizes matched by risk, not by R)
  const sa = vol ? SD.ONE / SD[a] : 1, sb = vol ? SD.ONE / SD[b] : 1;
  console.log(`\n${NAME[a]} 对 ${NAME[b]}${vol ? `（按波动折算：×${sa.toFixed(2)} / ×${sb.toFixed(2)}）` : ""}（配对差，R / 笔）：`);
  const signs: number[] = [];
  for (const [g, fn] of groups) {
    const dif = all.filter(fn).map((x) => x[a] * sa - x[b] * sb);
    const m = mean(dif), t = m / (sd(dif) / Math.sqrt(dif.length));
    if (g !== "样本内") signs.push(Math.sign(m));
    console.log(`  ${g.padEnd(6, "　")}${f2(m).padStart(7)}  t ${t.toFixed(2).padStart(6)}  (${dif.length})`);
  }
  const dif = is.map((x) => x[a] * sa - x[b] * sb);
  const m = mean(dif), t = m / (sd(dif) / Math.sqrt(dif.length));
  console.log(`  结论：${Math.abs(m) >= 0.1 && Math.abs(t) >= 2 && signs.every((s) => s === Math.sign(m)) ? (m > 0 ? "达标（更好）" : "达标（更差）") : "未达标"}`);
}
const PAIRS: [Key, Key][] = [
  ["CUR", "ONE"],
  ["A3", "ONE"], ["A3", "CUR"], ["A2", "ONE"],
  ["B1", "CUR"], ["BE", "CUR"], ["B2", "CUR"], ["B2", "B2u"], ["B2", "ONE"],
  ["C05", "CUR"], ["C1", "CUR"], ["C05", "C05s"],
  ["DE", "ONE"], ["DR", "ONE"], ["DCE", "CUR"],
];
for (const [a, b] of PAIRS) paired(a, b);
console.log("\n—— 按波动折算（把两边的每笔波动都缩放到和不滚一样，看多出来的是本事还是仓位） ——");
const VPAIRS: [Key, Key][] = [["CUR", "ONE"], ["A3", "ONE"], ["A3", "CUR"], ["B1", "CUR"], ["BE", "CUR"], ["B2", "CUR"], ["B2", "ONE"], ["B2", "B2u"], ["C05s", "CUR"]];
for (const [a, b] of VPAIRS) paired(a, b, true);
