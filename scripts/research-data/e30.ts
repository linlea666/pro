/**
 * E30：强底部 vs 弱低点（@Ryder2087 的示意图）。规则在跑之前定好：
 *
 * - 数据：Binance 永续 K 线（e30-fetch.ts），默认日线；TF=4h 用 4 小时。ATR = 14 根 Wilder，量 = 成交额。
 * - ① 强势下跌 + ② 抛售高潮：第 c 根创前 LOOK（60）根最低价，收盘低于前 LOOK 根最高价至少 DROP（6）倍 ATR，
 *   成交额 ≥ VOLX（2）倍前 20 根均量，下影线 ≥ 1/3 根长。
 * - ③ 区间：区间低点 RL = 高潮那根的最低价；区间高点 RH = 之后 M（10）根里的最高价（第 c+M 根收盘后才知道，
 *   之前不会有突破，因为突破要收盘高于 RH）；RH − RL < 2 ATR 的不算区间。一个币同时只看一个区间，最长 W（120）根。
 * - 区间的结局（先到为准）：向上 = 收盘 > RH；向下 = 收盘 < RL − 0.5 ATR，或连续两根收盘 < RL；都没有 = 超时。
 * - ④ 扫低收回：最低价 < RL，且这根或下一根收盘回到 RL 之上（没先触发“向下”）。量减 = 这次扫低（含下一根）的
 *   成交额 < 高潮那根（VDEC=1 时还要比上一次扫低小）。“强底部” = 至少 SWEEPS（1）次量减的扫低收回。
 * - 弱低点：区间里 RL 一次都没被扫，但出现过“扫高回落”（最高价 > RH、收盘回到 RH 之下，只在 c+M 之后算）。
 *
 * 交易（每行配 50 个随机入场：同币、同一段时间里任一根开盘、同方向、同 ATR 倍数的止损、同一种离场）：
 * - L1 强底部突破做多：强底部之后第一次收盘 > RH，下一根开盘入场；止损 = 高潮以来最低价 − 0.2 ATR。
 * - L0 对照：区间突破做多，但之前没有量减的扫低收回（要证明“扫低 + 量减”有用，L1 要比 L0 好）。
 * - L2 早进：量减的扫低收回那根（或下一根）收盘确认后，下一根开盘做多，止损 = 扫低最低价 − 0.2 ATR；同一区间只进第一次。
 * - S1 弱低点跌破做空：弱低点之后的“向下”，下一根开盘入场；止损 = 区间以来最高价 + 0.2 ATR。
 * - S0 对照：“向下”但之前没有扫高回落。
 * - 离场 EXIT=chand（默认）：3 倍 ATR 吊灯（按入场时 ATR，收盘后上移），最长 120 根；EXIT=fixed：持有 20 根按收盘平。
 * - 成本来回 0.15%（同 stats.ts），计入资金费率。R = 入场到止损的距离。
 * - 另给区间结局表：强底部 / 扫低但量没减 / 低点没被扫 三类区间，最后向上、向下、超时各多少。
 * - 切分：2020-01-01 起；样本外 = 2025-10-25 之后，样本内再分前后两半。
 *
 *   node --experimental-strip-types scripts/research-data/e30.ts <dataDir>   [环境变量 TF / DROP / VOLX / M / SWEEPS / VDEC / EXIT]
 */
import { readFileSync, readdirSync } from "node:fs";

const dir = process.argv[2];
const TF = process.env.TF ?? "1d";
const LOOK = Number(process.env.LOOK ?? 60);
const DROP = Number(process.env.DROP ?? 6);
const VOLX = Number(process.env.VOLX ?? 2);
const M = Number(process.env.M ?? 10);
const W = Number(process.env.W ?? 120);
const SWEEPS = Number(process.env.SWEEPS ?? 1);
const VDEC = Number(process.env.VDEC ?? 0);
const EXIT = process.env.EXIT ?? "chand";
const BOXN = Number(process.env.BOXN ?? 20);
const BOXW = Number(process.env.BOXW ?? 4);
const COST = 0.0015;
const START = Date.UTC(2020, 0, 1) / 1000;
const OOS = Date.UTC(2025, 9, 25) / 1000;
const MID = START + (OOS - START) / 2;

type Bar = { t: number; o: number; h: number; l: number; c: number; v: number; atr: number; vma: number };
type Trade = { coin: string; row: string; ei: number; xi: number; entry: number; stop: number; exit: number; r: number; riskAtr: number; dir: 1 | -1 };
type Range = { coin: string; c: number; end: number; kind: "strong" | "sweepHiVol" | "untouched"; outcome: "up" | "down" | "timeout"; weak: boolean; trendUp: boolean; highSweep?: boolean; anySweep?: boolean };

function load(coin: string) {
  const j = JSON.parse(readFileSync(`${dir}/e30/${coin}.json`, "utf8"));
  const rows: number[][] = TF === "4h" ? j.h4 : j.d1;
  const b: Bar[] = rows.map((r) => ({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5], atr: NaN, vma: NaN }));
  let atr = NaN;
  for (let i = 1; i < b.length; i++) {
    const tr = Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c));
    atr = i < 14 ? NaN : i === 14 ? mean(b.slice(1, 15).map((x, k) => Math.max(x.h - x.l, Math.abs(x.h - b[k].c), Math.abs(x.l - b[k].c)))) : (atr * 13 + tr) / 14;
    b[i].atr = atr;
    if (i >= 20) b[i].vma = mean(b.slice(i - 20, i).map((x) => x.v));
  }
  const fund = new Map<number, number>();
  const step = TF === "4h" ? 14400 : 86400;
  for (const [t, f] of j.funding as number[][]) {
    const k = Math.floor(t / step) * step;
    fund.set(k, (fund.get(k) ?? 0) + f);
  }
  return { b, fund };
}

function mean(a: number[]) {
  return a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
}
function sd(a: number[]) {
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1));
}

/** 从 ei 开盘入场；返回出场下标和价格 */
function walk(b: Bar[], ei: number, d: 1 | -1, stop0: number) {
  const a = b[ei - 1].atr;
  let stop = stop0, ext = b[ei].o;
  const maxI = Math.min(b.length - 1, ei + (EXIT === "fixed" ? 19 : 119));
  for (let k = ei; k <= maxI; k++) {
    if (d === 1 ? b[k].l <= stop : b[k].h >= stop) return { xi: k, exit: d === 1 ? Math.min(stop, b[k].o) : Math.max(stop, b[k].o) };
    if (EXIT === "chand") {
      ext = d === 1 ? Math.max(ext, b[k].h) : Math.min(ext, b[k].l);
      const s = ext - d * 3 * a;
      stop = d === 1 ? Math.max(stop, s) : Math.min(stop, s);
    }
  }
  return { xi: maxI, exit: b[maxI].c };
}

function settle(coin: string, row: string, b: Bar[], fund: Map<number, number>, ei: number, d: 1 | -1, stop: number): Trade {
  const w = walk(b, ei, d, stop);
  const entry = b[ei].o;
  let f = 0;
  for (let k = ei; k <= w.xi; k++) f += fund.get(b[k].t) ?? 0;
  const pct = (d * (w.exit - entry)) / entry - COST - d * f;
  const risk = Math.abs(entry - stop);
  return { coin, row, ei, xi: w.xi, entry, stop, exit: w.exit, r: (pct * entry) / risk, riskAtr: risk / b[ei - 1].atr, dir: d };
}

type Follow = { c: number; RL: number; RH: number; cv: number; arm: number; box: boolean; trendUp: boolean };
/** 区间里第一次进入某种状态的时刻（确认那根收盘），用来看之后 10 / 30 根的走势 */
type State = { coin: string; k: number; kind: "strong" | "bull" | "bear"; trendUp: boolean };
const states: State[] = [];

/** 从区间开始跟到结局；cv = 量减的门槛（箱体模式为 Infinity，不看量），arm 之后才算突破和扫高 */
function follow(coin: string, b: Bar[], fund: Map<number, number>, f: Follow, trades: Trade[]) {
  const { c, RL, RH, cv, arm, box } = f;
  const [UP1, UP0, EARLY, DN1, DN0] = box ? ["B1", "B0", "B2", "D1", "D0"] : ["L1", "L0", "L2", "S1", "S0"];
  let lowest = RL, highest = RH;
  let goodSweeps = 0, anySweep = false, lastSweepV = cv, early = false, highSweep = false;
  let end = Math.min(b.length - 1, c + W), outcome: Range["outcome"] = "timeout";
  for (let k = c + 1; k <= Math.min(b.length - 2, c + W); k++) {
    const y = b[k];
    // 向下：收盘 < RL − 0.5 ATR，或连续两根收盘 < RL
    const down = y.c < RL - 0.5 * y.atr || (y.c < RL && b[k - 1].c < RL && k - 1 > c);
    // 箱体模式对称：收盘 > RH + 0.5 ATR，或连续两根收盘 > RH；高潮模式按原图，收盘 > RH 就算
    const up = k > arm && (box ? y.c > RH + 0.5 * y.atr || (y.c > RH && b[k - 1].c > RH && k - 1 > c) : y.c > RH);
    if (down) {
      outcome = "down";
      end = k;
      const row = highSweep && !anySweep ? DN1 : !highSweep && !anySweep ? DN0 : "";
      if (row && b[k + 1].t >= START) trades.push(settle(coin, row, b, fund, k + 1, -1, highest + 0.2 * y.atr));
      break;
    }
    if (up) {
      outcome = "up";
      end = k;
      const row = goodSweeps >= SWEEPS && !highSweep ? UP1 : !anySweep && !highSweep ? UP0 : "";
      if (row && b[k + 1].t >= START) trades.push(settle(coin, row, b, fund, k + 1, 1, lowest - 0.2 * y.atr));
      break;
    }
    // 扫低收回：上一根收盘还在 RL 之上，这根最低 < RL，且这根或下一根收盘回到 RL 之上
    if (y.l < RL && b[k - 1].c >= RL) {
      const rec = y.c >= RL ? k : b[k + 1].c >= RL ? k + 1 : -1;
      if (rec > 0) {
        if (!anySweep && !highSweep && box && b[rec].t >= START) states.push({ coin, k: rec, kind: "bull", trendUp: f.trendUp });
        anySweep = true;
        const v = Math.max(y.v, rec > k ? b[k + 1].v : 0);
        const ok = v < cv && (!VDEC || v < lastSweepV);
        if (ok && !goodSweeps && !box && b[rec].t >= START) states.push({ coin, k: rec, kind: "strong", trendUp: f.trendUp });
        if (ok) goodSweeps++;
        lastSweepV = v;
        const sl = Math.min(y.l, b[rec].l);
        if (ok && !highSweep && !early && rec + 1 < b.length && b[rec + 1].t >= START) {
          early = true;
          trades.push(settle(coin, EARLY, b, fund, rec + 1, 1, sl - 0.2 * b[rec].atr));
        }
      }
    }
    lowest = Math.min(lowest, y.l);
    // 扫高回落：最高 > RH，收盘回到 RH 之下
    // 扫高回落：上一根收盘还在 RH 之下，这根最高 > RH，且这根或下一根收盘回到 RH 之下（和扫低对称）
    if (k > arm && y.h > RH && b[k - 1].c <= RH) {
      const rec = y.c <= RH ? k : b[k + 1].c <= RH ? k + 1 : -1;
      if (rec > 0) {
        if (!highSweep && !anySweep && box && b[rec].t >= START) states.push({ coin, k: rec, kind: "bear", trendUp: f.trendUp });
        highSweep = true;
      }
    }
    highest = Math.max(highest, y.h);
  }
  const kind: Range["kind"] = goodSweeps >= SWEEPS ? "strong" : anySweep ? "sweepHiVol" : "untouched";
  return { end, outcome, kind, highSweep, anySweep };
}

function scan(coin: string, b: Bar[], fund: Map<number, number>) {
  const trades: Trade[] = [];
  const ranges: Range[] = [];
  let i = LOOK + 20;
  while (i < b.length - 2) {
    const x = b[i];
    let hi = -Infinity, lo = Infinity;
    for (let k = i - LOOK; k < i; k++) (hi = Math.max(hi, b[k].h)), (lo = Math.min(lo, b[k].l));
    const climax = x.l < lo && hi - x.c >= DROP * x.atr && x.v >= VOLX * x.vma && Math.min(x.o, x.c) - x.l >= (x.h - x.l) / 3;
    let RH = -Infinity;
    for (let k = i + 1; k <= Math.min(b.length - 1, i + M); k++) RH = Math.max(RH, b[k].h);
    if (!climax || !(RH - x.l >= 2 * x.atr) || i + M >= b.length - 1) {
      i++;
      continue;
    }
    const r = follow(coin, b, fund, { c: i, RL: x.l, RH, cv: x.v, arm: i + M, box: false, trendUp: false }, trades);
    if (x.t >= START) ranges.push({ coin, c: i, end: r.end, kind: r.kind, outcome: r.outcome, weak: r.highSweep && !r.anySweep, trendUp: false });
    i = r.end + 1;
  }
  return { trades, ranges };
}

/** 贝格先生的 Liq 结构：任意震荡箱体（最近 BOXN 根的高低差 ≤ BOXW 倍 ATR），不要求先有抛售高潮 */
function scanBox(coin: string, b: Bar[], fund: Map<number, number>) {
  const trades: Trade[] = [];
  const ranges: Range[] = [];
  let i = Math.max(200, BOXN + 20);
  while (i < b.length - 2) {
    let hi = -Infinity, lo = Infinity;
    for (let k = i - BOXN + 1; k <= i; k++) (hi = Math.max(hi, b[k].h)), (lo = Math.min(lo, b[k].l));
    if (!(hi - lo <= BOXW * b[i].atr)) {
      i++;
      continue;
    }
    let sma = 0;
    for (let k = i - 199; k <= i; k++) sma += b[k].c / 200;
    const r = follow(coin, b, fund, { c: i, RL: lo, RH: hi, cv: Infinity, arm: i, box: true, trendUp: b[i].c > sma }, trades);
    if (b[i].t >= START) ranges.push({ coin, c: i, end: r.end, kind: r.kind, outcome: r.outcome, weak: r.highSweep && !r.anySweep, trendUp: b[i].c > sma, highSweep: r.highSweep, anySweep: r.anySweep });
    i = Math.max(r.end + 1, i + 1) + BOXN - 1;
  }
  return { trades, ranges };
}

let seed = 30;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
function randomR(b: Bar[], fund: Map<number, number>, t: Trade, loI: number, hiI: number) {
  const out: number[] = [];
  for (let n = 0; n < 50; n++) {
    const ei = loI + 1 + Math.floor(rnd() * Math.max(1, hiI - loI - 2));
    if (ei >= b.length - 1 || !(b[ei - 1].atr > 0)) continue;
    const stop = b[ei].o - t.dir * t.riskAtr * b[ei - 1].atr;
    if (t.dir === 1 && stop <= 0) continue;
    out.push(settle("", "", b, fund, ei, t.dir, stop).r);
  }
  return mean(out);
}

const f2 = (x: number) => (Number.isFinite(x) ? (x >= 0 ? "+" : "") + x.toFixed(2) : "—");
const pc = (x: number) => (Number.isFinite(x) ? (x * 100).toFixed(0) + "%" : "—");
const day = (t: number) => new Date(t * 1000).toISOString().slice(0, TF === "4h" ? 13 : 10).replace("T", " ");

const coins = readdirSync(`${dir}/e30`).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
const order = ["BTC", "ETH", ...coins.filter((c) => c !== "BTC" && c !== "ETH").sort()];
const data = Object.fromEntries(order.map((c) => [c, load(c)]));
const res = Object.fromEntries(
  order.map((c) => {
    const a = scan(c, data[c].b, data[c].fund), x = scanBox(c, data[c].b, data[c].fund);
    return [c, { trades: [...a.trades, ...x.trades], ranges: a.ranges, boxes: x.ranges }];
  }),
);

console.log(`E30 强底部 vs 弱低点 / Liq 箱体  TF=${TF} BOXN=${BOXN} BOXW=${BOXW}ATR LOOK=${LOOK} DROP=${DROP}ATR VOLX=${VOLX} M=${M} W=${W} SWEEPS=${SWEEPS} VDEC=${VDEC} EXIT=${EXIT}  成本 0.15% + 资金费率`);

const ROWS: [string, string][] = [
  ["L1", "强底部突破做多（扫低收回+量减 → 站上区间高点）"],
  ["L0", "对照：区间突破做多，之前低点没被扫"],
  ["L2", "早进：量减的扫低收回后就做多"],
  ["S1", "弱低点跌破做空（扫高回落、低点没扫 → 跌破）"],
  ["S0", "对照：跌破做空，之前没扫高"],
  ["B1", "Liq 看涨箱体突破做多（下沿被扫收回、上沿没被扫 → 向上突破）"],
  ["B0", "对照：箱体向上突破，上下沿都没被扫"],
  ["B2", "早进：箱体下沿假跌破收回后就做多"],
  ["D1", "Liq 看跌箱体跌破做空（上沿被扫回落、下沿没被扫 → 向下跌破）"],
  ["D0", "对照：箱体向下跌破，上下沿都没被扫"],
];
const GROUPS: [string, string[]][] = [
  ["BTC", ["BTC"]],
  ["ETH", ["ETH"]],
  ["BTC+ETH", ["BTC", "ETH"]],
  ["其他 8 币", order.filter((c) => c !== "BTC" && c !== "ETH")],
];
const segs: [string, number, number][] = [
  ["全部 2020 起", START, Infinity],
  ["样本内前半", START, MID],
  ["样本内后半", MID, OOS],
  ["样本外 12 个月", OOS, Infinity],
];

const rand = new Map<Trade, number>();
for (const c of order) {
  const { b, fund } = data[c];
  const loI = b.findIndex((x) => x.t >= START);
  for (const t of res[c].trades) rand.set(t, randomR(b, fund, t, loI, b.length));
}

for (const [rk, rname] of ROWS) {
  console.log(`\n== ${rk} ${rname} ==`);
  console.log("范围              段              笔数  胜率   平均R   随机R   差R     t");
  for (const [g, cs] of GROUPS)
    for (const [sname, lo, hi] of segs) {
      const ts = cs.flatMap((c) => res[c].trades.filter((t) => t.row === rk && data[c].b[t.ei].t >= lo && data[c].b[t.ei].t < hi));
      if (g !== "BTC+ETH" && g !== "其他 8 币" && sname !== "全部 2020 起") continue;
      const rs = ts.map((t) => t.r), d = ts.map((t) => t.r - rand.get(t)!);
      const tt = mean(d) / (sd(d) / Math.sqrt(d.length));
      console.log(
        `${g.padEnd(10)}  ${sname.padEnd(14)}  ${String(ts.length).padStart(4)}  ${pc(rs.filter((x) => x > 0).length / rs.length).padStart(4)}  ${f2(mean(rs)).padStart(6)}  ${f2(mean(ts.map((t) => rand.get(t)!))).padStart(6)}  ${f2(mean(d)).padStart(6)}  ${f2(tt).padStart(5)}`,
      );
    }
}

// 区间结局表按整段区间分类会有偏差（跌破那一下本身就算“扫过低点”，离哪边近就先到哪边），
// 所以改看“进入某种状态之后 10 / 30 根的涨跌（ATR 倍数）”，对照同一批币、同一段时间里所有 K 线（按大级别同向分组）。
console.log("\n== 进入状态之后的走势（收盘价变化 ÷ 当时 ATR；大级别 = 收盘在 200 根均线上 / 下） ==");
console.log("范围        状态                                大级别   次数   10根后上涨  均值ATR   对照上涨 对照均值   差的t     30根后上涨  均值ATR   对照上涨 对照均值   差的t");
const fwd = (c: string, k: number, h: number) => {
  const b = data[c].b;
  return k + h < b.length ? (b[k + h].c - b[k].c) / b[k].atr : NaN;
};
const smaUp = (c: string, k: number) => {
  const b = data[c].b;
  if (k < 199) return false;
  let m = 0;
  for (let j = k - 199; j <= k; j++) m += b[j].c / 200;
  return b[k].c > m;
};
const SN: [State["kind"], string][] = [
  ["strong", "强底部（高潮后第一次量减扫低收回）"],
  ["bull", "看涨 Liq（箱体下沿被扫收回、上沿没扫）"],
  ["bear", "看跌 Liq（箱体上沿被扫回落、下沿没扫）"],
];
for (const [g, cs] of [["BTC+ETH", ["BTC", "ETH"]], ["其他 8 币", GROUPS[3][1]]] as [string, string[]][])
  for (const [kind, name] of SN)
    for (const tr of kind === "strong" ? [null] : [true, false]) {
      const ev = states.filter((e) => cs.includes(e.coin) && e.kind === kind && (tr === null || e.trendUp === tr));
      const cells: string[] = [];
      for (const h of [10, 30]) {
        const x = ev.map((e) => fwd(e.coin, e.k, h)).filter(Number.isFinite);
        const base: number[] = [];
        for (const c of cs) {
          const bb = data[c].b;
          for (let k = 200; k < bb.length; k++) if (bb[k].t >= START && (tr === null || smaUp(c, k) === tr)) base.push(fwd(c, k, h));
        }
        const bs = base.filter(Number.isFinite);
        const tt = (mean(x) - mean(bs)) / (sd(x) / Math.sqrt(x.length));
        cells.push(`${pc(x.filter((v) => v > 0).length / x.length).padStart(6)}  ${f2(mean(x)).padStart(7)}  ${pc(bs.filter((v) => v > 0).length / bs.length).padStart(7)}  ${f2(mean(bs)).padStart(7)}  t ${f2(tt).padStart(5)}`);
      }
      console.log(`${g.padEnd(8)}  ${name.padEnd(26)}  ${(tr === null ? "全部" : tr ? "向上" : "向下").padEnd(4)}  ${String(ev.length).padStart(5)}    ${cells.join("     ")}`);
    }

const KN: Record<Range["kind"], string> = { strong: "强底部（量减扫低）", sweepHiVol: "扫低但量没减", untouched: "低点没被扫" };
for (const c of ["BTC", "ETH"]) {
  const b = data[c].b;
  console.log(`\n== ${c} 每个区间（高潮日 → 结局）和交易 ==`);
  for (const r of res[c].ranges) {
    const ts = res[c].trades.filter((t) => t.row[0] !== "B" && t.row[0] !== "D" && t.ei > r.c && t.ei <= r.end + 1);
    console.log(
      `${day(b[r.c].t)} 高潮低点 ${b[r.c].l.toPrecision(6)}  ${KN[r.kind]}${r.weak ? "·弱低点" : ""} → ${day(b[r.end].t)} ${{ up: "向上", down: "向下", timeout: "超时" }[r.outcome]}` +
        ts.map((t) => `  | ${t.row} ${day(b[t.ei].t)} 入 ${t.entry.toPrecision(6)} 止损 ${t.stop.toPrecision(6)}（${t.riskAtr.toFixed(1)} ATR）→ ${day(b[t.xi].t)} ${t.exit.toPrecision(6)} ${f2(t.r)}R`).join(""),
    );
  }
}
