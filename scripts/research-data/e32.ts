/**
 * E32：BOS → FVG / 订单块 → 回踩确认入场 → 前高止盈（SMC 入场法，@DeFiTracer 的推文）。规则在跑之前定好：
 *
 * - 数据：Binance 永续 K 线。TF=4h（默认）/ 1d 读 e30-fetch.ts 的 <dataDir>/e30，TF=1h / 15m 读 e31-fetch.ts 的
 *   <dataDir>/e31；资金费率都读 e30。ATR = 14 根 Wilder。多空对称，下面按做多写。
 * - 摆动点：左右各 P（3）根的分形高 / 低点，第 i+P 根收盘后才确认。
 * - BOS：收盘高于最近一个已确认、还没被收盘越过的摆动高点 SH。一个摆动点只用一次。
 * - 推动段：SH 之后到 BOS 那根之间的最低点 L（含）到 BOS 那根。
 * - FVG：推动段里最后一个看涨缺口（b[j-1].高 < b[j+1].低），区间 [b[j-1].高, b[j+1].低]。
 * - 订单块 OB：推动段里 BOS 之前最后一根阴线（收 < 开），区间 [低, 高]。
 * - 目标：BOS 之后、回踩之前走出的最高价 TH（推文里“前一个高点 / 流动性”）。
 * - 等回踩：BOS 之后 W（30）根内，最低价碰到区间上沿。期间收盘跌破 L 就作废；没碰到就放弃。
 * - 入场（每个 BOS、每种区间各一笔，一个币一行同时只持一笔）：
 *   F1 / O1 碰到区间之后 W 根内第一根“看涨确认”（收盘高于上一根最高价）收盘后下一根开盘做多；确认前跌破 L 作废；
 *   F0 / O0 碰到区间上沿就进（限价成交在上沿，跳空低开按开盘价）；
 *   Z0 对照：BOS 收盘后下一根开盘直接追。
 * - 止损：入场时 L 与回踩以来最低价的较低者 − 0.2 ATR；风险须在 0.3–8 倍 ATR，否则不做。
 * - 离场 EXIT=target（默认，推文的做法）：止盈 TH（入场价已在 TH 之上或离 TH 不到 0.5R 的不做）、止损不动，最长 H（60）根按收盘平；
 *   EXIT=chand：3 倍 ATR 吊灯（同 E30），最长 120 根。同一根先算止损，跳空按开盘价成交。
 * - 成本来回 0.15% + 资金费率。R = 入场到止损的距离。
 * - 对照：每笔 50 个随机入场（同币、2020 年起任一根开盘、同方向、同 ATR 倍数止损、止盈在同样的 R 倍数、同最长持有）。
 *   另外 F1 / O1 对 Z0 看“等回踩”有没有用，F1 / O1 对 F0 / O0 看“等确认”有没有用（只看差R，不配对）。
 * - 切分：2020-01-01 起（1h / 15m 也一样）；样本外 = 2025-10-28 之后，样本内再分前后两半。
 *
 *   node --experimental-strip-types scripts/research-data/e32.ts <dataDir>   [环境变量 TF / P / W / H / EXIT]
 */
import { readFileSync, readdirSync } from "node:fs";

const dir = process.argv[2];
const TF = process.env.TF ?? "4h";
const P = Number(process.env.P ?? 3);
const W = Number(process.env.W ?? 30);
const H = Number(process.env.H ?? 60);
const EXIT = process.env.EXIT ?? "target";
const COST = 0.0015;
const START = Date.UTC(2020, 0, 1) / 1000;
const OOS = Date.UTC(2025, 9, 28) / 1000;
const MID = START + (OOS - START) / 2;
const STEP = { "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 }[TF]!;

type Bar = { t: number; o: number; h: number; l: number; c: number; atr: number };
type Trade = { coin: string; row: string; ei: number; xi: number; dir: 1 | -1; entry: number; stop: number; tgtR: number; riskAtr: number; r: number };

function load(coin: string) {
  const src = TF === "4h" || TF === "1d" ? "e30" : "e31";
  const j = JSON.parse(readFileSync(`${dir}/${src}/${coin}.json`, "utf8"));
  const rows: number[][] = { "15m": j.m15, "1h": j.h1, "4h": j.h4, "1d": j.d1 }[TF];
  const b: Bar[] = rows.map((r) => ({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], atr: NaN }));
  let atr = NaN, sum = 0;
  for (let i = 1; i < b.length; i++) {
    const tr = Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c));
    if (i <= 14) {
      sum += tr;
      if (i === 14) atr = sum / 14;
    } else atr = (atr * 13 + tr) / 14;
    b[i].atr = atr;
  }
  const fund = new Map<number, number>();
  const fj = src === "e30" ? j : JSON.parse(readFileSync(`${dir}/e30/${coin}.json`, "utf8"));
  for (const [t, f] of fj.funding as number[][]) {
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

/** 从 ei 入场（价格 entry）走到离场；tgtR = 止盈的 R 倍数（NaN 表示不设止盈） */
function settle(coin: string, row: string, b: Bar[], fund: Map<number, number>, ei: number, d: 1 | -1, entry: number, stop0: number, tgtR: number): Trade {
  const risk = Math.abs(entry - stop0), a = b[ei - 1].atr;
  const tgt = entry + d * tgtR * risk;
  let stop = stop0, ext = entry, xi = -1, exit = NaN;
  const maxI = Math.min(b.length - 1, ei + (EXIT === "chand" ? 119 : H - 1));
  for (let k = ei; k <= maxI; k++) {
    const x = b[k];
    if (d === 1 ? x.l <= stop : x.h >= stop) {
      (xi = k), (exit = d === 1 ? Math.min(stop, k === ei ? Math.min(entry, x.o) : x.o) : Math.max(stop, k === ei ? Math.max(entry, x.o) : x.o));
      break;
    }
    if (EXIT === "target" && (d === 1 ? x.h >= tgt : x.l <= tgt)) {
      (xi = k), (exit = d === 1 ? Math.max(tgt, k === ei ? tgt : x.o) : Math.min(tgt, k === ei ? tgt : x.o));
      break;
    }
    if (EXIT === "chand") {
      ext = d === 1 ? Math.max(ext, x.h) : Math.min(ext, x.l);
      stop = d === 1 ? Math.max(stop, ext - 3 * a) : Math.min(stop, ext + 3 * a);
    }
  }
  if (xi < 0) (xi = maxI), (exit = b[maxI].c);
  let f = 0;
  for (let k = ei; k <= xi; k++) f += fund.get(b[k].t) ?? 0;
  const pct = (d * (exit - entry)) / entry - COST - d * f;
  return { coin, row, ei, xi, dir: d, entry, stop: stop0, tgtR, riskAtr: risk / a, r: (pct * entry) / risk };
}

function scan(coin: string, b: Bar[], fund: Map<number, number>) {
  const trades: Trade[] = [];
  const busy: Record<string, number> = {};
  const add = (t: Trade | null) => {
    if (!t || b[t.ei].t < START) return;
    const key = t.row;
    if ((busy[key] ?? -1) >= t.ei) return;
    busy[key] = t.xi;
    trades.push(t);
  };
  for (const d of [1, -1] as const) {
    const hi = (x: Bar) => (d === 1 ? x.h : -x.l), lo = (x: Bar) => (d === 1 ? x.l : -x.h);
    const cl = (x: Bar) => d * x.c, op = (x: Bar) => d * x.o;
    let sh = -1; // 最近一个已确认、还没被越过的摆动点（做多 = 高点）
    for (let k = 2 * P + 20; k < b.length - 2; k++) {
      const i = k - P; // 第 k 根收盘时确认 i 是不是摆动点
      let isSw = true;
      for (let j = i - P; j <= i + P; j++) if (j !== i && hi(b[j]) >= hi(b[i])) isSw = false;
      if (isSw) sh = i;
      if (sh < 0 || !(cl(b[k]) > hi(b[sh]))) continue;
      // BOS
      const swing = sh;
      sh = -1;
      let li = swing;
      for (let j = swing; j <= k; j++) if (lo(b[j]) < lo(b[li])) li = j;
      const L = lo(b[li]), atr = b[k].atr;
      if (!(atr > 0)) continue;
      let fvg: [number, number] | null = null, ob: [number, number] | null = null;
      for (let j = li + 1; j <= k; j++) if (j + 1 <= k && hi(b[j - 1]) < lo(b[j + 1])) fvg = [hi(b[j - 1]), lo(b[j + 1])];
      for (let j = li; j < k; j++) if (cl(b[j]) < op(b[j])) ob = [lo(b[j]), hi(b[j])];
      // Z0：BOS 后直接追
      {
        const e = op(b[k + 1]), stop = L - 0.2 * atr, risk = e - stop;
        if (risk >= 0.3 * atr && risk <= 8 * atr) add(settle(coin, "Z0", b, fund, k + 1, d, d * e, d * stop, NaN));
      }
      for (const [tag, zone] of [["F", fvg], ["O", ob]] as const) {
        if (!zone || !(zone[1] < cl(b[k]))) continue;
        let th = hi(b[k]), touch = -1;
        for (let j = k + 1; j <= Math.min(b.length - 2, k + W); j++) {
          if (lo(b[j]) <= zone[1]) {
            touch = j;
            break;
          }
          if (cl(b[j]) < L) break;
          th = Math.max(th, hi(b[j]));
        }
        if (touch < 0) continue;
        // 0：碰到上沿就进
        {
          // 当根的最低价在成交时还不知道，所以碰到就进的止损只用 L
          const e = Math.min(zone[1], op(b[touch])), stop0 = L - 0.2 * atr, risk0 = e - stop0;
          const tgtR = (th - e) / risk0;
          if (risk0 >= 0.3 * atr && risk0 <= 8 * atr && (EXIT === "chand" || tgtR >= 0.5)) add(settle(coin, tag + "0", b, fund, touch, d, d * e, d * stop0, EXIT === "target" ? tgtR : NaN));
        }
        // 1：碰到之后第一根收盘高于上一根最高价，下一根开盘进
        let low = Math.min(L, lo(b[touch]));
        for (let j = touch; j <= Math.min(b.length - 2, touch + W); j++) {
          low = Math.min(low, lo(b[j]));
          if (low < L) break;
          if (cl(b[j]) > hi(b[j - 1])) {
            const e = op(b[j + 1]), a2 = b[j].atr, stop = low - 0.2 * a2, risk = e - stop, tgtR = (th - e) / risk;
            if (risk >= 0.3 * a2 && risk <= 8 * a2 && (EXIT === "chand" || tgtR >= 0.5)) add(settle(coin, tag + "1", b, fund, j + 1, d, d * e, d * stop, EXIT === "target" ? tgtR : NaN));
            break;
          }
        }
      }
    }
  }
  return trades;
}

let seed = 32;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
function randomR(b: Bar[], fund: Map<number, number>, t: Trade, loI: number) {
  const out: number[] = [];
  for (let n = 0; n < 50; n++) {
    const ei = loI + 1 + Math.floor(rnd() * (b.length - loI - 3));
    if (!(b[ei - 1].atr > 0)) continue;
    const e = b[ei].o, stop = e - t.dir * t.riskAtr * b[ei - 1].atr;
    if (stop <= 0) continue;
    out.push(settle("", "", b, fund, ei, t.dir, e, stop, t.tgtR).r);
  }
  return mean(out);
}

const f2 = (x: number) => (Number.isFinite(x) ? (x >= 0 ? "+" : "") + x.toFixed(2) : "—");
const pc = (x: number) => (Number.isFinite(x) ? (x * 100).toFixed(0) + "%" : "—");

const coins = readdirSync(`${dir}/e30`).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
const order = ["BTC", "ETH", ...coins.filter((c) => c !== "BTC" && c !== "ETH").sort()];
const all: Trade[] = [];
const rand = new Map<Trade, number>();
const T = new Map<Trade, number>();
for (const c of order) {
  const { b, fund } = load(c);
  const loI = b.findIndex((x) => x.t >= START);
  for (const t of scan(c, b, fund)) {
    all.push(t);
    T.set(t, b[t.ei].t);
    rand.set(t, randomR(b, fund, t, loI));
  }
}

console.log(`E32 BOS → FVG / OB 回踩确认  TF=${TF} P=${P} W=${W} H=${H} EXIT=${EXIT}  成本 0.15% + 资金费率  随机 50 个/笔`);
const ROWS: [string, string][] = [
  ["Z0", "对照：BOS 收盘后直接追"],
  ["F0", "回到 FVG 上沿就进"],
  ["F1", "回到 FVG + 看涨确认后进（推文）"],
  ["O0", "回到订单块上沿就进"],
  ["O1", "回到订单块 + 看涨确认后进（推文）"],
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
for (const [rk, rname] of ROWS) {
  console.log(`\n== ${rk} ${rname} ==`);
  console.log("范围        段              笔数  胜率   平均R   随机R   差R     t   止盈R中位");
  for (const [g, cs] of GROUPS)
    for (const [sname, lo, hi] of segs) {
      if (g !== "BTC+ETH" && g !== "其他 8 币" && sname !== "全部 2020 起") continue;
      const ts = all.filter((t) => t.row === rk && cs.includes(t.coin) && T.get(t)! >= lo && T.get(t)! < hi);
      const rs = ts.map((t) => t.r), d = ts.map((t) => t.r - rand.get(t)!);
      const tt = mean(d) / (sd(d) / Math.sqrt(d.length));
      const tg = ts.map((t) => t.tgtR).filter(Number.isFinite).sort((a, b) => a - b);
      console.log(
        `${g.padEnd(9)}  ${sname.padEnd(13)}  ${String(ts.length).padStart(5)}  ${pc(rs.filter((x) => x > 0).length / rs.length).padStart(4)}  ${f2(mean(rs)).padStart(6)}  ${f2(mean(ts.map((t) => rand.get(t)!))).padStart(6)}  ${f2(mean(d)).padStart(6)}  ${f2(tt).padStart(5)}  ${tg.length ? tg[tg.length >> 1].toFixed(2) : "—"}`,
      );
    }
}
