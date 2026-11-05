/**
 * E41b（2026-11-05）：用户追加两个思路——① 趋势那天波动都大（BTC 近一年日涨跌很少超过 2–3%），能不能用“当天已经走了多少”
 * 这类波动因子，或者和其他因子结合；② RedPanda「BTC Spot Demand Proxy v1.4」（Coinbase 对 USDT 现货的溢价，扣 USDT/USD，
 * 30 天 Z 分数、最近 4 根里 ≥ 75% 同向变化、日线同向确认）。只测 BTC / ETH，1 小时，进出场和对照同 E41（下一根开盘追、
 * 初始止损 3 倍 ATR、3 倍 ATR 吊灯最长 240 根、成本 0.15% + 资金费率、每笔 50 个同向同止损随机入场）。规则在跑之前定好：
 *
 * 波动（2020 年起）：
 * - 当天 = UTC 0 点开始（北京 8 点）。日常涨跌 = 之前 60 根已收盘日线收盘涨跌绝对值的中位数（BTC 最近一年约 1.2%）。
 * - V1 当天已走 ≥ M（2）倍日常涨跌：1 小时收盘相对当天开盘的涨跌第一次达到，顺这个方向追（一天一个方向最多一次）。
 * - V2 V1 + 放量（同 E41 C：最近 12 根平均成交额 ≥ 之前 120 根 1.5 倍）。
 * - V3 V1 + 之前安静：今天之前 7 天的 1 小时收益标准差，排在之前 365 天（每天取一个值）的最低 30%（“平时磨磨唧唧，突然放大”）。
 * - 另把 E41 的 C（12 根 ≥ 5 ATR + 放量）按“之前 7 天波动”分三档、按“当天已走几倍日常涨跌”分组，看波动能不能再筛一遍。
 * 溢价（Coinbase 现货 ÷（Binance 现货 × Coinbase USDT-USD）− 1，单位 bp；数据 2023-10 起，E26 的 fetch.ts 加补到今天）：
 * - Z = 当前溢价对最近 720 根（30 天）的 Z 分数；连续性 = 最近 4 次变化里 ≥ 3 次和方向同向；
 *   日线同向 = 上一个完整 UTC 日的平均溢价高于之前 30 天日均值（做空相反）。
 * - P1 RedPanda 观察条件：Z ≥ 1.5 + 连续性 + 日线同向 → 做多（≤ −1.5 做空），第一次成立那根；P2 只看 Z ≥ 1.5；
 * - P3 / P4：E41 C 的冲击，溢价 Z 和冲击同向（> 0）/ 反向，看溢价能不能区分冲击。ETH 用 ETH 自己的 Coinbase 溢价。
 * - 事后加的（看了 C 按波动分组之后才加，只作参考，不进 BH）：Cq = C + 之前 7 天波动在最低 1/3。
 * - 溢价各行从 2023-11-15 起；样本外 = 2025-11-05 之后，样本内前后两半。
 *
 *   node --experimental-strip-types scripts/research-data/e41b.ts <dataDir>   [M / VQ / ZT]
 *   <dataDir>/e30、e31 同 E41；<dataDir>/prem 放 E26 格式的 cb / bn / usdt / eth-cb / eth-bn.json（[秒, 收盘]）。
 */
import { readFileSync } from "node:fs";

const dir = process.argv[2];
const TF = "1h";
const N = 12, K = 5, ER_MIN = 0.4, VOLX = 1.5;
const EXIT = "chand";
const H = 240, HOLD = 24;
const M = Number(process.env.M ?? 2);
const VQ = Number(process.env.VQ ?? 0.3);
const ZT = Number(process.env.ZT ?? 1.5);
const COINS = ["BTC", "ETH"];
const COST = 0.0015;
const START = Date.UTC(2020, 0, 1) / 1000;
const PSTART = Date.UTC(2023, 10, 15) / 1000;
const OOS = Date.UTC(2025, 10, 5) / 1000;
const STEP = 3600;

type Bar = { t: number; o: number; h: number; l: number; c: number; v: number; atr: number; day: number };
type Trade = { coin: string; row: string; ei: number; xi: number; dir: 1 | -1; riskAtr: number; r: number; first: number; entry: number; exit: number; stop: number; vol?: number; er?: number; day?: number };

function emaArr(xs: number[], n: number) {
  const k = 2 / (n + 1);
  let v = xs[0];
  return xs.map((x) => (v = x * k + v * (1 - k)));
}

function load(coin: string) {
  const j = TF === "4h" ? JSON.parse(readFileSync(`${dir}/e30/${coin}.json`, "utf8")) : JSON.parse(readFileSync(`${dir}/e31/${coin}.json`, "utf8"));
  const j30 = TF === "4h" ? j : JSON.parse(readFileSync(`${dir}/e30/${coin}.json`, "utf8"));
  const rows: number[][] = { "15m": j.m15, "1h": j.h1, "4h": j.h4 }[TF];
  const b: Bar[] = rows.map((r) => ({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5], atr: NaN, day: 0 }));
  let atr = NaN, sum = 0;
  for (let i = 1; i < b.length; i++) {
    const tr = Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c));
    if (i <= 14) {
      sum += tr;
      if (i === 14) atr = sum / 14;
    } else atr = (atr * 13 + tr) / 14;
    b[i].atr = atr;
  }
  // 日线方向：已收盘日线的 EMA20 对 EMA50（第 i 根收盘时，只用开盘早于今天 0 点的日线）
  const d1: number[][] = j30.d1;
  const e20 = emaArr(d1.map((r) => r[4]), 20), e50 = emaArr(d1.map((r) => r[4]), 50);
  let di = -1;
  for (const x of b) {
    const closeT = x.t + STEP;
    while (di + 1 < d1.length && d1[di + 1][0] + 86400 <= closeT) di++;
    x.day = di >= 50 ? Math.sign(e20[di] - e50[di]) : 0;
  }
  const fund = new Map<number, number>();
  for (const [t, f] of j30.funding as number[][]) {
    const k = Math.floor(t / STEP) * STEP;
    fund.set(k, (fund.get(k) ?? 0) + f);
  }
  return { b, fund };
}

const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const sd = (a: number[]) => {
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1));
};

/** 先到 +6 ATR 还是 −3 ATR（1 = 先到 +6，−1 = 先到 −3，0 = H 根内都没到） */
function firstHit(b: Bar[], ei: number, d: 1 | -1, entry: number, a: number) {
  const up = entry + d * 6 * a, dn = entry - d * 3 * a;
  for (let k = ei; k < Math.min(b.length, ei + H); k++) {
    const x = b[k];
    if (d === 1 ? x.l <= dn : x.h >= dn) return -1;
    if (d === 1 ? x.h >= up : x.l <= up) return 1;
  }
  return 0;
}

function settle(coin: string, row: string, b: Bar[], fund: Map<number, number>, ei: number, d: 1 | -1, entry: number, stop0: number): Trade {
  const risk = Math.abs(entry - stop0), a = b[ei - 1].atr;
  let stop = stop0, ext = entry, xi = -1, exit = NaN;
  const maxI = Math.min(b.length - 1, ei + (EXIT === "hold" ? HOLD : H) - 1);
  for (let k = ei; k <= maxI; k++) {
    const x = b[k];
    if (d === 1 ? x.l <= stop : x.h >= stop) {
      (xi = k), (exit = d === 1 ? Math.min(stop, k === ei ? Math.min(entry, x.o) : x.o) : Math.max(stop, k === ei ? Math.max(entry, x.o) : x.o));
      break;
    }
    if (EXIT === "chand") {
      ext = d === 1 ? Math.max(ext, x.h) : Math.min(ext, x.l);
      stop = d === 1 ? Math.max(stop, ext - 3 * x.atr) : Math.min(stop, ext + 3 * x.atr);
    }
  }
  if (xi < 0) (xi = maxI), (exit = b[maxI].c);
  let f = 0;
  for (let k = ei; k <= xi; k++) f += fund.get(b[k].t) ?? 0;
  const pct = (d * (exit - entry)) / entry - COST - d * f;
  return { coin, row, ei, xi, dir: d, riskAtr: risk / a, r: (pct * entry) / risk, first: firstHit(b, ei, d, entry, a), entry, exit, stop: stop0 };
}

type Sig = { k: number; d: 1 | -1 };
/** 每根收盘时的冲击 / 干脆 / 放量 */
function features(b: Bar[]) {
  const disp: number[] = new Array(b.length).fill(0), er: number[] = new Array(b.length).fill(0), vol: number[] = new Array(b.length).fill(0);
  for (let k = N + 130; k < b.length; k++) {
    const a = b[k - N].atr;
    if (!(a > 0)) continue;
    disp[k] = (b[k].c - b[k - N].c) / a;
    let path = 0;
    for (let j = k - N + 1; j <= k; j++) path += Math.abs(b[j].c - b[j - 1].c);
    er[k] = path > 0 ? Math.abs(b[k].c - b[k - N].c) / path : 0;
    let vw = 0, vb = 0;
    for (let j = k - N + 1; j <= k; j++) vw += b[j].v;
    for (let j = k - N - 120 + 1; j <= k - N; j++) vb += b[j].v;
    vol[k] = vb > 0 ? vw / N / (vb / 120) : 0;
  }
  return { disp, er, vol };
}

let seed = 411;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
function randomOf(b: Bar[], fund: Map<number, number>, t: Trade, loI: number) {
  const rs: number[] = [], fs: number[] = [];
  for (let n = 0; n < 50; n++) {
    const ei = loI + 1 + Math.floor(rnd() * (b.length - loI - 3));
    if (!(b[ei - 1].atr > 0)) continue;
    const e = b[ei].o, stop = e - t.dir * t.riskAtr * b[ei - 1].atr;
    if (stop <= 0) continue;
    const x = settle("", "", b, fund, ei, t.dir, e, stop);
    rs.push(x.r), fs.push(x.first);
  }
  return { r: mean(rs), first: fs.filter((x) => x === 1).length / fs.length, big: rs.filter((x) => x >= 3).length / rs.length };
}


function premium(coin: string, b: Bar[]) {
  const rd = (f: string) => new Map<number, number>(JSON.parse(readFileSync(`${dir}/prem/${f}.json`, "utf8")));
  const cb = rd(coin === "BTC" ? "cb" : "eth-cb"), bn = rd(coin === "BTC" ? "bn" : "eth-bn"), us = rd("usdt");
  const p = b.map((x) => {
    const c = cb.get(x.t), n = bn.get(x.t), u = us.get(x.t);
    return c && n && u ? (c / (n * u) - 1) * 10000 : NaN;
  });
  const z = new Array(b.length).fill(NaN), imp = new Array(b.length).fill(0), day = new Array(b.length).fill(0);
  // 日均溢价
  const dmean = new Map<number, number>();
  {
    const acc = new Map<number, number[]>();
    b.forEach((x, i) => Number.isFinite(p[i]) && (acc.get(Math.floor(x.t / 86400)) ?? acc.set(Math.floor(x.t / 86400), []).get(Math.floor(x.t / 86400))!).push(p[i]));
    for (const [d, a] of acc) if (a.length >= 20) dmean.set(d, a.reduce((s, v) => s + v, 0) / a.length);
  }
  for (let i = 720; i < b.length; i++) {
    if (!Number.isFinite(p[i])) continue;
    const w: number[] = [];
    for (let j = i - 719; j <= i; j++) if (Number.isFinite(p[j])) w.push(p[j]);
    if (w.length < 684) continue;
    const m = w.reduce((s, v) => s + v, 0) / w.length, s = Math.sqrt(w.reduce((q, v) => q + (v - m) ** 2, 0) / (w.length - 1));
    z[i] = s > 0 ? (p[i] - m) / s : NaN;
    let up = 0, dn = 0;
    for (let j = i - 3; j <= i; j++) if (Number.isFinite(p[j]) && Number.isFinite(p[j - 1])) (p[j] > p[j - 1] ? up++ : p[j] < p[j - 1] ? dn++ : 0);
    imp[i] = up >= 3 ? 1 : dn >= 3 ? -1 : 0;
    const d0 = Math.floor(b[i].t / 86400) - 1, last = dmean.get(d0);
    const prev: number[] = [];
    for (let d = d0 - 30; d < d0; d++) if (dmean.has(d)) prev.push(dmean.get(d)!);
    if (last !== undefined && prev.length >= 25) day[i] = Math.sign(last - prev.reduce((s, v) => s + v, 0) / prev.length);
  }
  return { z, imp, day };
}

/** 当天开盘、日常涨跌、之前 7 天波动的分位 */
function dayInfo(b: Bar[], d1: number[][]) {
  const dayOpen = new Array(b.length).fill(NaN), base = new Array(b.length).fill(NaN), qv = new Array(b.length).fill(NaN);
  const absRet = d1.map((r, i) => (i ? Math.abs(r[4] / d1[i - 1][4] - 1) : NaN));
  const dIdx = new Map<number, number>(d1.map((r, i) => [r[0], i]));
  // 每天开盘前 7 天 1 小时收益标准差
  const rv = new Map<number, number>();
  let cur = -1;
  for (let i = 0; i < b.length; i++) {
    const d = Math.floor(b[i].t / 86400) * 86400;
    if (d !== cur) {
      cur = d;
      if (i >= 168) {
        const r: number[] = [];
        for (let j = i - 167; j < i; j++) r.push(Math.log(b[j].c / b[j - 1].c));
        rv.set(d, sd(r));
      }
    }
  }
  // 当天开盘价 = 当天第一根 1 小时开盘
  let open = NaN, od = -1;
  const days = [...rv.keys()].sort((a, b2) => a - b2), rvs = days.map((d) => rv.get(d)!);
  const rvQ = new Map<number, number>();
  days.forEach((d, k) => {
    if (k < 365) return;
    const v = rvs[k];
    let lo = 0;
    for (let j = k - 365; j < k; j++) if (rvs[j] < v) lo++;
    rvQ.set(d, lo / 365);
  });
  for (let i = 0; i < b.length; i++) {
    const d = Math.floor(b[i].t / 86400) * 86400;
    if (d !== od) (od = d), (open = b[i].o);
    dayOpen[i] = open;
    const di = dIdx.get(d);
    if (di !== undefined && di >= 61) {
      const a = absRet.slice(di - 60, di).sort((x, y) => x - y);
      base[i] = (a[29] + a[30]) / 2;
    }
    qv[i] = rvQ.get(d) ?? NaN;
  }
  return { dayOpen, base, qv };
}

type Tagged = Trade & { tag: Record<string, number> };
const all: Tagged[] = [];
const RR = new Map<Trade, { r: number; first: number; big: number }>();
const TT = new Map<Trade, number>();
for (const c of COINS) {
  const { b, fund } = load(c);
  const j30 = JSON.parse(readFileSync(`${dir}/e30/${c}.json`, "utf8"));
  const { disp, er, vol } = features(b);
  const { dayOpen, base, qv } = dayInfo(b, j30.d1);
  const pr = premium(c, b);
  const loI = b.findIndex((x) => x.t >= START);
  const busy: Record<string, number> = {};
  const trades: Tagged[] = [];
  const go = (row: string, k: number, d: 1 | -1, from = START) => {
    if (k + 1 >= b.length || b[k + 1].t < from || (busy[row] ?? -1) >= k + 1) return;
    const e = b[k + 1].o, a = b[k].atr;
    const t = settle(c, row, b, fund, k + 1, d, e, e - d * 3 * a) as Tagged;
    t.tag = { qv: qv[k], dm: (d * (b[k].c / dayOpen[k] - 1)) / base[k], pz: d * pr.z[k] };
    busy[row] = t.xi;
    trades.push(t);
  };
  const doneDay = new Set<string>();
  for (let k = 200; k < b.length - 1; k++) {
    for (const d of [1, -1] as const) {
      const imp = (i: number) => d * disp[i] >= K && er[i] >= ER_MIN && vol[i] >= VOLX;
      if (imp(k) && !imp(k - 1)) {
        go("C", k, d);
        if (qv[k] < 1 / 3) go("Cq", k, d);
        if (d * pr.z[k] > 0) go("P3", k, d, PSTART);
        else if (d * pr.z[k] <= 0) go("P4", k, d, PSTART);
        if (b[k].t >= PSTART) go("Cp", k, d, PSTART);
      }
      const dm = (d * (b[k].c / dayOpen[k] - 1)) / base[k];
      const key = `${Math.floor(b[k].t / 86400)}:${d}`;
      if (dm >= M && !doneDay.has(key)) {
        doneDay.add(key);
        go("V1", k, d);
        if (vol[k] >= VOLX) go("V2", k, d);
        if (qv[k] <= VQ) go("V3", k, d);
      }
      const P1 = (i: number) => d * pr.z[i] >= ZT && pr.imp[i] === d && pr.day[i] === d;
      const P2 = (i: number) => d * pr.z[i] >= ZT;
      if (P1(k) && !P1(k - 1)) go("P1", k, d, PSTART);
      if (P2(k) && !P2(k - 1)) go("P2", k, d, PSTART);
    }
  }
  const SHOW = process.env.SHOW ? Date.parse(process.env.SHOW + "T00:00:00+08:00") / 1000 : NaN;
  const bj = (t: number) => new Date((t + 8 * 3600) * 1000).toISOString().slice(5, 16).replace("T", " ");
  for (const t of trades)
    if (b[t.ei].t >= SHOW)
      console.log(`${c} ${t.row} ${t.dir === 1 ? "多" : "空"}  入场 ${bj(b[t.ei].t)} ${t.entry.toFixed(0)}  止损 ${t.stop.toFixed(0)}  离场 ${bj(b[t.xi].t)} ${t.exit.toFixed(0)}  ${t.r >= 0 ? "+" : ""}${t.r.toFixed(2)}R  之前7天波动分位 ${(t.tag.qv * 100).toFixed(0)}%  当天已走 ${t.tag.dm.toFixed(1)} 倍  溢价Z ${t.tag.pz.toFixed(1)}${t.xi >= b.length - 1 ? "（还拿着）" : ""}`);
  for (const t of trades) {
    all.push(t);
    TT.set(t, b[t.ei].t);
    RR.set(t, randomOf(b, fund, t, loI));
  }
}

const f2 = (x: number) => (Number.isFinite(x) ? (x >= 0 ? "+" : "") + x.toFixed(2) : "—");
const pc = (x: number) => (Number.isFinite(x) ? (x * 100).toFixed(0) + "%" : "—");
const pOf = (t: number) => {
  const z = Math.abs(t), u = 1 / (1 + 0.2316419 * z);
  return 2 * 0.3989423 * Math.exp((-z * z) / 2) * u * (0.3193815 + u * (-0.3565638 + u * (1.781478 + u * (-1.821256 + u * 1.330274))));
};
console.log(`E41b 波动因子和 Coinbase 溢价  1h  M=${M} VQ=${VQ} ZT=${ZT}  BTC / ETH  成本 0.15% + 资金费率  随机 50 个/笔`);
const ROWS: [string, string, number][] = [
  ["C", "对照：E41 的 C（12 根 ≥ 5 ATR + 放量）", START],
  ["V1", `当天已走 ≥ ${M} 倍日常涨跌，追`, START],
  ["V2", "V1 + 放量", START],
  ["V3", `V1 + 之前 7 天安静（最低 ${VQ * 100}%）`, START],
  ["Cq", "事后加的：C + 之前 7 天安静（最低 1/3）", START],
  ["Cp", "对照：C，只算 2023-11-15 起（溢价有数据）", PSTART],
  ["P1", `RedPanda 观察条件：溢价 Z ≥ ${ZT} + 连续 + 日线同向`, PSTART],
  ["P2", `只看溢价 Z ≥ ${ZT}`, PSTART],
  ["P3", "C 且溢价 Z 和冲击同向", PSTART],
  ["P4", "C 且溢价 Z 和冲击反向", PSTART],
];
const judge: { row: string; m: number; p: number; ok: boolean }[] = [];
for (const [rk, rname, st] of ROWS) {
  const mid = st + (OOS - st) / 2;
  const segs: [string, number, number][] = [
    ["全部", st, Infinity],
    ["样本内前半", st, mid],
    ["样本内后半", mid, OOS],
    ["样本外 12 个月", OOS, Infinity],
  ];
  console.log(`\n== ${rk} ${rname} ==`);
  console.log("范围          段              笔数  胜率   平均R   随机R   差R     t    先+6ATR 随机");
  const signs: number[] = [];
  let mAll = NaN, tAll = NaN;
  for (const g of [["BTC"], ["ETH"], COINS])
    for (const [sname, lo, hi] of segs) {
      const name = g.length > 1 ? "BTC+ETH" : g[0];
      if (g.length === 1 && sname !== "全部") continue;
      const ts = all.filter((t) => t.row === rk && g.includes(t.coin) && TT.get(t)! >= lo && TT.get(t)! < hi);
      if (!ts.length) continue;
      const rs = ts.map((t) => t.r), d = ts.map((t) => t.r - RR.get(t)!.r);
      const tt = mean(d) / (sd(d) / Math.sqrt(d.length));
      if (g.length > 1 && sname === "全部") (mAll = mean(d)), (tAll = tt);
      else signs.push(mean(d));
      console.log(
        `${name.padEnd(12)}  ${sname.padEnd(13)}  ${String(ts.length).padStart(5)}  ${pc(rs.filter((x) => x > 0).length / rs.length).padStart(4)}  ${f2(mean(rs)).padStart(6)}  ${f2(mean(ts.map((t) => RR.get(t)!.r))).padStart(6)}  ${f2(mean(d)).padStart(6)}  ${f2(tt).padStart(5)}   ${pc(ts.filter((t) => t.first === 1).length / ts.length).padStart(5)}  ${pc(mean(ts.map((t) => RR.get(t)!.first))).padStart(4)}`,
      );
    }
  if (rk !== "C" && rk !== "Cp" && rk !== "Cq") judge.push({ row: rk, m: mAll, p: pOf(tAll), ok: signs.every((x) => x > 0) });
}
const sorted = [...judge].sort((a, b) => a.p - b.p);
const q = new Map<string, number>();
let prev = 1;
for (let i = sorted.length - 1; i >= 0; i--) {
  prev = Math.min(prev, (sorted[i].p * sorted.length) / (i + 1));
  q.set(sorted[i].row, prev);
}
console.log("\n== 判定（新行之间 BH；对随机 ≥ 0.1R、q < 0.05、BTC / ETH / 前后两半 / 样本外都为正） ==");
for (const j of judge)
  console.log(`${j.row}  差R ${f2(j.m)}  q ${q.get(j.row)!.toFixed(3)}  各段同向 ${j.ok ? "是" : "否"}  → ${j.m >= 0.1 && q.get(j.row)! < 0.05 && j.ok ? "有优势" : j.m <= -0.1 && q.get(j.row)! < 0.05 ? "更差" : "没有可证明的优势"}`);

console.log("\n== C 的冲击按波动分组（BTC+ETH 2020 起） ==");
console.log("分组                          笔数   平均R   差R     t    先+6ATR 随机");
const Ct = all.filter((t) => t.row === "C");
const grp = (name: string, ts: Tagged[]) => {
  if (!ts.length) return;
  const d = ts.map((t) => t.r - RR.get(t)!.r);
  console.log(`${name.padEnd(26)}  ${String(ts.length).padStart(5)}  ${f2(mean(ts.map((t) => t.r))).padStart(6)}  ${f2(mean(d)).padStart(6)}  ${f2(mean(d) / (sd(d) / Math.sqrt(d.length))).padStart(5)}   ${pc(ts.filter((t) => t.first === 1).length / ts.length).padStart(5)}  ${pc(mean(ts.map((t) => RR.get(t)!.first))).padStart(4)}`);
};
grp("之前 7 天安静（最低 1/3）", Ct.filter((t) => t.tag.qv < 1 / 3));
grp("之前 7 天中等", Ct.filter((t) => t.tag.qv >= 1 / 3 && t.tag.qv < 2 / 3));
grp("之前 7 天波动大（最高 1/3）", Ct.filter((t) => t.tag.qv >= 2 / 3));
grp("当天已走 < 1 倍日常", Ct.filter((t) => t.tag.dm < 1));
grp("当天已走 1–2 倍", Ct.filter((t) => t.tag.dm >= 1 && t.tag.dm < 2));
grp("当天已走 ≥ 2 倍", Ct.filter((t) => t.tag.dm >= 2));
console.log("\n== C 的冲击按溢价分组（2023-11-15 起） ==");
const Cq = all.filter((t) => t.row === "Cp");
grp("溢价 Z ≥ 1 同向", Cq.filter((t) => t.tag.pz >= 1));
grp("溢价 Z 0–1 同向", Cq.filter((t) => t.tag.pz >= 0 && t.tag.pz < 1));
grp("溢价 Z 0 到 −1（反向）", Cq.filter((t) => t.tag.pz < 0 && t.tag.pz > -1));
grp("溢价 Z ≤ −1（反向）", Cq.filter((t) => t.tag.pz <= -1));
