/**
 * E47（2026-11-07）：博主（@mi_yu_ns，原图是黄金 15 分钟）的“EMA20 × 15 分钟”做多法：
 *   ① K 线从下方上穿 EMA20、而且这根已经收盘，确认；
 *   ② 在 K 线位于 EMA20 上方的情况下，K 线碰到 EMA20 时做多。
 * 用户问有没有道理、对我们有没有帮助。只测 BTC / ETH（Binance 永续），主测 15 分钟，另看 1 小时 / 4 小时。
 * 规则在跑之前定好（看结果之前写下，不再改；变体只换环境变量）：
 *
 * - 数据：e31-fetch.ts（1 小时、15 分钟）、e30-fetch.ts（4 小时、日线、资金费率）。交易从 2021-01-01 起（之前只用来预热）。
 *   EMA20 = 收盘价 20 期指数均线；ATR = 14 根 Wilder。下面按做多写，做空镜像（博主只说做多，做空只作参考）。
 * - 入场（一个币、一条规则、一个方向同时只持一笔，样本不重叠）：
 *   X 上穿收盘：这根收盘 > EMA20、上一根收盘 ≤ 上一根 EMA20 → 下一根开盘进；止损 = 最近 10 根最低价 − 0.25 ATR。
 *   T 碰到就进：之前 3 根收盘都在 EMA20 上方、上一根最低价没碰到 EMA20，这根最低价 ≤ 上一根的 EMA20 值 e（开盘 > e）
 *     → 在 e 挂单成交；止损 = e − TS（1）倍 ATR；同一根碰到止损按止损算（保守）。
 *   T2 碰到后收回：同样的“碰到”，但这根收盘回到 EMA20 上方 → 下一根开盘进；止损 = 这根最低价 − 0.25 ATR。
 *   风险 0.3–8 倍 ATR 才做。
 * - 离场 EXIT：ema（默认，方法本身的逻辑）= 止损，或收盘跌回 EMA20 下方后下一根开盘走；
 *   chand = 3 倍 ATR 吊灯（收盘后上移）；2r = 固定 2R 止盈。最长 240 根。同一根先算止损，跳空按开盘价。
 * - 成本：来回 0.15%（项目口径，含滑点）+ 持仓期资金费；另列 0.07%（挂单进、吃单出的实际手续费）和 0（不算成本）。
 *   R = 入场到止损。
 * - 过滤（只在信号那根收盘时已收盘的 K 线上看）：
 *   全部；顺日线 = 日线结构方向（structureDirection，同计划页）和交易方向相同；
 *   大一级也在 EMA20 上方 = 15 分钟看 1 小时、1 小时看 4 小时、4 小时看日线，最后一根已收盘的收盘在它的 EMA20 之上（做空相反）。
 * - 对照：每笔 30 个随机入场（同币、2021 年起任一根开盘、同方向、同 ATR 倍数止损、同离场、同成本）。
 *   另给“每次全仓 1 倍”的复利累计对同期买入持有（只是直观对照，不是判定）。
 * - 切分：样本外 = 2025-11-01 起，样本内再分前后两半。达标：对随机 ≥ 0.1R、BH q < 0.05、BTC / ETH / 前后两半 / 样本外都为正。
 *
 *   node --experimental-strip-types scripts/research-data/e47.ts <dataDir>   [环境变量 TF=15m|1h|4h EXIT TS COINS SIDES]
 */
import { readFileSync } from "node:fs";
import { atrSeries } from "../../src/lib/ta/risk.ts";
import { structureDirection, structureSeries } from "../../src/lib/ta/structure.ts";
import type { Candle } from "../../src/lib/types.ts";

const dir = process.argv[2];
const env = (k: string, d: string) => process.env[k] ?? d;
const TF = env("TF", "15m");
const EXIT = env("EXIT", "ema");
const TS = Number(env("TS", "1"));
const COINS = env("COINS", "BTC,ETH").split(",");
const SIDES = env("SIDES", "1,-1").split(",").map(Number) as (1 | -1)[];
const START = Date.UTC(2021, 0, 1) / 1000;
const OOS = Date.UTC(2025, 10, 1) / 1000;
const COSTS = [0.0015, 0.0007, 0];
const MAXH = 240;
const SEC: Record<string, number> = { "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };
const HIGHER: Record<string, string> = { "15m": "1h", "1h": "4h", "4h": "1d" };
type Bar = [number, number, number, number, number, number];

let seed = 47;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

const toC = (b: Bar[]): Candle[] => b.map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }));
function ema(b: Bar[], n = 20) {
  const out = new Array(b.length).fill(NaN);
  const k = 2 / (n + 1);
  let e = NaN;
  for (let i = 0; i < b.length; i++) {
    if (i === n - 1) { let s = 0; for (let j = 0; j < n; j++) s += b[j][4]; e = s / n; }
    else if (i >= n) e = b[i][4] * k + e * (1 - k);
    out[i] = e;
  }
  return out;
}
/** index of the last bar of `hi` (period hs) that has closed by time `t` */
function aligner(hi: Bar[], hs: number) {
  let j = -1;
  return (t: number) => {
    while (j + 1 < hi.length && hi[j + 1][0] + hs <= t) j++;
    return j;
  };
}

/** one result: gross % move (side-signed, incl. funding), risk as % of entry */
interface Res { g: number; rp: number; hold: number }
interface Trade { coin: string; rule: string; side: 1 | -1; t: number; res: Res; rand: Res[]; riskAtr: number; fd: boolean; fh: boolean }
const trades: Trade[] = [];
const bh: Record<string, string> = {};

const rOf = (x: Res, cost: number) => (x.g - cost) / x.rp;

for (const coin of COINS) {
  const e31 = JSON.parse(readFileSync(`${dir}/e31/${coin}.json`, "utf8"));
  const e30 = JSON.parse(readFileSync(`${dir}/e30/${coin}.json`, "utf8"));
  const frames: Record<string, Bar[]> = { "15m": e31.m15, "1h": e31.h1, "4h": e30.h4, "1d": e30.d1 };
  const b = frames[TF];
  const S = SEC[TF];
  const funding: [number, number][] = e30.funding;
  const fT = funding.map((f) => f[0]);
  const fP = [0];
  for (const f of funding) fP.push(fP[fP.length - 1] + f[1]);
  const fEnd = fT[fT.length - 1] + 8 * 3600;
  const lb = (x: number) => { let lo = 0, hi = fT.length; while (lo < hi) { const m = (lo + hi) >> 1; if (fT[m] <= x) lo = m + 1; else hi = m; } return lo; };
  const fundBetween = (a: number, z: number) => fP[lb(z)] - fP[lb(a)]; // funding with a < t <= z

  const E = ema(b);
  const A = atrSeries(toC(b));
  const d1 = frames["1d"];
  const dss = structureSeries(toC(d1), atrSeries(toC(d1)));
  const hb = frames[HIGHER[TF]];
  const hE = ema(hb);
  const alD = aligner(d1, 86400), alH = aligner(hb, SEC[HIGHER[TF]]);
  const dayDir: number[] = [], hiPos: number[] = [];
  for (let i = 0; i < b.length; i++) {
    const tc = b[i][0] + S;
    const di = alD(tc);
    dayDir.push(di < 30 ? 0 : structureDirection(dss[di]));
    const hi = alH(tc);
    hiPos.push(hi < 20 ? 0 : Math.sign(hb[hi][4] - hE[hi]));
  }
  const first = b.findIndex((x) => x[0] >= START);

  /** simulate from bar i: entry price px filled during bar i (limit, `intrabar`) or at its open */
  const sim = (i: number, side: 1 | -1, px: number, stop: number, intrabar: boolean): { res: Res; exit: number } | null => {
    const risk = (px - stop) * side;
    if (!(risk > 0)) return null;
    let st = stop, best = px;
    const tp = px + side * 2 * risk;
    const out = (j: number, x: number, endT: number) => ({
      res: { g: (side * (x - px)) / px - side * fundBetween(b[i][0], endT), rp: risk / px, hold: j - i + 1 }, exit: j,
    });
    const last = Math.min(b.length, i + MAXH) - 1;
    for (let j = i; j <= last; j++) {
      const [t, o, hi, lo, c] = b[j];
      if (t + S > fEnd) return null;
      if (j > i || !intrabar) {
        if (side > 0 ? lo <= st : hi >= st) return out(j, j === i && intrabar ? st : side > 0 ? Math.min(o, st) : Math.max(o, st), t + S);
      } else if (side > 0 ? lo <= st : hi >= st) return out(j, st, t + S);
      if (EXIT === "2r" && (side > 0 ? hi >= tp : lo <= tp)) return out(j, j === i && intrabar ? tp : side > 0 ? Math.max(o, tp) : Math.min(o, tp), t + S);
      if (EXIT === "chand") {
        best = side > 0 ? Math.max(best, hi) : Math.min(best, lo);
        const ch = best - side * 3 * A[j];
        st = side > 0 ? Math.max(st, ch) : Math.min(st, ch);
      }
      if (EXIT === "ema" && side * (c - E[j]) < 0 && j + 1 < b.length) {
        if (b[j + 1][0] + S > fEnd) return null;
        return out(j + 1, b[j + 1][1], b[j + 1][0]);
      }
      if (j === last) return out(j, c, t + S);
    }
    return null;
  };
  const randoms = (side: 1 | -1, riskAtr: number, n: number) => {
    const res: Res[] = [];
    for (let k = 0; k < n * 3 && res.length < n; k++) {
      const i = first + Math.floor(rnd() * (b.length - first - MAXH - 2));
      const a = A[i - 1];
      if (!(a > 0)) continue;
      const r = sim(i, side, b[i][1], b[i][1] - side * riskAtr * a, false);
      if (r) res.push(r.res);
    }
    return res;
  };

  const busy: Record<string, number> = {};
  const take = (rule: string, side: 1 | -1, k: number, sig: number, px: number, stop: number, intrabar: boolean) => {
    // k = bar the trade starts in; sig = bar whose close the filters look at
    const key = rule + side;
    if (k >= b.length || (busy[key] ?? -1) >= k) return;
    const a = A[sig];
    const riskAtr = ((px - stop) * side) / a;
    if (!(riskAtr >= 0.3 && riskAtr <= 8)) return;
    const r = sim(k, side, px, stop, intrabar);
    if (!r) return;
    busy[key] = r.exit;
    trades.push({ coin, rule, side, t: b[sig][0], res: r.res, rand: randoms(side, riskAtr, 30), riskAtr, fd: dayDir[sig] === side, fh: hiPos[sig] === side });
  };

  for (const side of SIDES) {
    const above = (i: number) => side * (b[i][4] - E[i]) > 0;
    for (let i = Math.max(first, 30); i < b.length - 1; i++) {
      const [, o, hi, lo, c] = b[i];
      // X: close crosses EMA20 (this close above, previous close at or below)
      if (above(i) && !above(i - 1)) {
        let ext = side > 0 ? Infinity : -Infinity;
        for (let j = i - 9; j <= i; j++) ext = side > 0 ? Math.min(ext, b[j][3]) : Math.max(ext, b[j][2]);
        take("X 上穿收盘", side, i + 1, i, b[i + 1][1], ext - side * 0.25 * A[i], false);
      }
      // touch: 3 closes above, previous bar didn't touch, this bar reaches previous EMA value
      const e = E[i - 1];
      const prevTouched = side > 0 ? b[i - 1][3] <= E[i - 2] : b[i - 1][2] >= E[i - 2];
      const touches = side > 0 ? lo <= e && o > e : hi >= e && o < e;
      if (above(i - 1) && above(i - 2) && above(i - 3) && !prevTouched && touches) {
        take("T 碰到就进", side, i, i - 1, e, e - side * TS * A[i - 1], true);
        if (above(i)) take("T2 碰到后收回", side, i + 1, i, b[i + 1][1], (side > 0 ? lo : hi) - side * 0.25 * A[i], false);
      }
    }
  }
  // buy & hold over the trading period, for the 1x compounding comparison
  const p0 = b[first][1], p1 = b[b.length - 1][4];
  bh[coin] = `${(((p1 / p0) - 1) * 100).toFixed(0)}%`;
}

const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const sd = (a: number[]) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
function normCdf(z: number) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}
const welch = (a: number[], b: number[]) => {
  if (a.length < 2 || b.length < 2) return { d: mean(a) - mean(b), p: 1 };
  const t = (mean(a) - mean(b)) / Math.sqrt(sd(a) ** 2 / a.length + sd(b) ** 2 / b.length);
  return { d: mean(a) - mean(b), p: 2 * (1 - normCdf(Math.abs(t))) };
};
function bhq(ps: number[]) {
  const o = ps.map((p, i) => ({ p, i })).sort((x, y) => x.p - y.p);
  const q = new Array(ps.length).fill(1);
  let m = 1;
  for (let k = o.length - 1; k >= 0; k--) { m = Math.min(m, (o[k].p * ps.length) / (k + 1)); q[o[k].i] = m; }
  return q;
}
const f2 = (x: number) => (Number.isFinite(x) ? (x >= 0 ? "+" : "") + x.toFixed(2) : "—");
const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
const ins = trades.filter((x) => x.t < OOS).map((x) => x.t).sort((a, b) => a - b);
const MID = ins[Math.floor(ins.length / 2)] ?? 0;
const segs = {
  BTC: (x: Trade) => x.coin === "BTC", ETH: (x: Trade) => x.coin === "ETH",
  前半: (x: Trade) => x.t < MID, 后半: (x: Trade) => x.t >= MID && x.t < OOS, 样本外: (x: Trade) => x.t >= OOS,
};
const C0 = COSTS[0];
console.log(`E47 参数：TF=${TF} EXIT=${EXIT} TS=${TS} COINS=${COINS.join(",")}；2021-01-01 起，样本外 2025-11-01 起，样本内中点 ${new Date(MID * 1000).toISOString().slice(0, 10)}；同期买入持有 ${Object.entries(bh).map(([k, v]) => `${k} ${v}`).join(" ")}`);
console.log("R 按来回成本 0.15%（另列 0.07% / 0 时的平均 R 和对随机）。");
console.log("行 | 笔数 | 平均 R | 胜率 | 随机 | 对随机 | p | q | 分段对随机（BTC ETH 前半 后半 样本外）| 成本 0.07%：平均 / 对随机 | 不算成本：平均 / 对随机 | 风险中位 % | 持有中位根数");
const filters: [string, (x: Trade) => boolean][] = [["全部", () => true], ["顺日线", (x) => x.fd], ["大一级在 EMA 同侧", (x) => x.fh]];
const rows: { name: string; xs: Trade[] }[] = [];
const rules = [...new Set(trades.map((x) => x.rule))].sort();
for (const side of SIDES) for (const rule of rules) for (const [fn, ff] of filters) {
  rows.push({ name: `${side > 0 ? "做多" : "做空"} ${rule} · ${fn}`, xs: trades.filter((x) => x.rule === rule && x.side === side && ff(x)) });
}
const res = rows.map((r) => ({ ...r, w: welch(r.xs.map((x) => rOf(x.res, C0)), r.xs.flatMap((x) => x.rand.map((y) => rOf(y, C0)))) }));
const q = bhq(res.map((r) => r.w.p));
res.forEach((r, k) => {
  const xs = r.xs;
  const sg = Object.entries(segs).map(([n, f]) => {
    const a = xs.filter(f);
    return a.length < 5 ? `${n}:样本少` : `${n}:${f2(mean(a.map((x) => rOf(x.res, C0))) - mean(a.flatMap((x) => x.rand.map((y) => rOf(y, C0)))))}(${a.length})`;
  }).join(" ");
  const alt = COSTS.slice(1).map((cst) => {
    const m = mean(xs.map((x) => rOf(x.res, cst)));
    return `${f2(m)} / ${f2(m - mean(xs.flatMap((x) => x.rand.map((y) => rOf(y, cst)))))}`;
  }).join(" | ");
  const rp = xs.map((x) => x.res.rp).sort((a, b) => a - b), hd = xs.map((x) => x.res.hold).sort((a, b) => a - b);
  const win = xs.filter((x) => rOf(x.res, C0) > 0).length / (xs.length || 1);
  console.log(`${r.name} | ${xs.length} | ${f2(mean(xs.map((x) => rOf(x.res, C0))))} | ${pct(win)} | ${f2(mean(xs.flatMap((x) => x.rand.map((y) => rOf(y, C0)))))} | ${f2(r.w.d)} | ${r.w.p.toFixed(3)} | ${q[k].toFixed(3)} | ${sg} | ${alt} | ${((rp[rp.length >> 1] ?? 0) * 100).toFixed(2)}% | ${hd[hd.length >> 1] ?? 0}`);
});

console.log();
console.log("每次全仓 1 倍、按时间顺序复利（同一规则同一方向不重叠；成本 0.15% / 0.07% / 0），对同期买入持有：");
for (const coin of COINS) for (const side of SIDES) for (const rule of rules) {
  const xs = trades.filter((x) => x.coin === coin && x.rule === rule && x.side === side).sort((a, b) => a.t - b.t);
  const eq = COSTS.map((cst) => xs.reduce((m, x) => m * Math.max(0, 1 + x.res.g - cst), 1));
  const bars = xs.reduce((s, x) => s + x.res.hold, 0);
  console.log(`${coin} ${side > 0 ? "做多" : "做空"} ${rule}：${xs.length} 笔，累计 ${eq.map((e) => `${((e - 1) * 100).toFixed(0)}%`).join(" / ")}，持仓 ${bars} 根 · 买入持有 ${bh[coin]}`);
}

console.log();
console.log("最近 12 个月（样本外）按月，做多 T 碰到就进 · 全部，成本 0.15%：");
const byM: Record<string, number[]> = {};
for (const x of trades.filter((x) => x.t >= OOS && x.side === 1 && x.rule.startsWith("T "))) {
  const m = new Date(x.t * 1000).toISOString().slice(0, 7);
  (byM[m] ??= []).push(rOf(x.res, C0));
}
console.log(Object.entries(byM).sort().map(([m, a]) => `${m} ${a.length} 笔 ${f2(mean(a))}R`).join(" · "));
