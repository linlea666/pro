/**
 * E43（2026-11-06）：扫低之后“资金费率转负 + 持仓量一口气砍掉一截”是不是更像底部（“黄金坑”），
 * “费率还是正的、持仓量没怎么掉”是不是说明多头没洗出去、还要磨底。用户贴推文（BTC 扫到 74,800 一带后收回），
 * 问能不能做成盯盘 / 趋势页的参考。另测 capital41-indicators 的 Crypto Perp Stress（多头挤兑风险 / 空头挤兑风险 / 洗完）。
 * 规则在跑之前定好（看结果之前写下，不再改；变体只换下面的环境变量）：
 *
 * - 数据：Binance 永续 1 小时 K 线（e31-fetch.ts）、资金费率（e30-fetch.ts，8 小时一次）、每小时持仓量（e43-fetch.ts，
 *   公开归档 metrics，BTC 2020-09 起、ETH 2021-12 起）。只用 BTC / ETH。
 * - 事件（“扫低”）：1 小时 K 线最低价跌破之前 WIN（168 = 7 天）根的最低价；同一币 COOL（168）小时内只算第一次。
 *   DD > 0 时另要求收盘离之前 30 天最高价已跌 ≥ DD（默认 0，不要求）。SFP=1 时只要“扫一下就收回”（收盘回到之前最低价之上）。
 * - 事件那根收盘时的状态（只用当时已知的数据）：
 *   费率：已结算的最近一次资金费率（FUND=last）或最近三次平均（FUND=avg3）< 0 为“转负”，> 0 为“正”；
 *   持仓量：最近 OIH（24）小时变化，落在本币之前 365 天同长度变化的最低 OIQ（10%）为“骤降”，高于 OIKEEP（50%）分位为“没怎么掉”；
 *   G 黄金坑 = 费率转负 + 持仓骤降；N 没洗出去 = 费率为正 + 持仓没怎么掉；F 只费率转负；O 只持仓骤降；全部 = 所有事件。
 * - 结果（下一根开盘做多）：持有 24 / 72 / 168 小时按收盘平；R = 入场时日线 ATR14（上一根已收盘日线）；扣 0.15% 和持有期资金费。
 *   “是不是底”：之后 7 天 / 30 天有没有跌破事件那根的最低价，30 天内又跌了多少（%），30 天后涨跌。
 * - 对照：① 每个事件 50 个随机时点（同币、有持仓量数据的任一小时、同持有期）做多；② 组之间配对：G 对 N、G 对 全部、N 对 全部。
 *   t 检验（Welch），比例用两比例 z；全表 BH。
 * - 切分：样本外 = 2025-11-01 之后（最近 12 个月），样本内再分前后两半；达标：G 对 N（或对随机）≥ 0.1R、q < 0.05、
 *   BTC / ETH / 前后两半 / 样本外方向都一致。
 * - Capital41 Crypto Perp Stress（基差换成资金费率，其余照原脚本 1 小时默认参数）：
 *   拥挤做多 = 最近资金费率 ≥ 0.03%（3 倍基准），拥挤做空 ≤ −0.01%；OI 冲高 / 洗出 = 每小时持仓量变化的 3 根 EMA ≥ 1% / ≤ −1.2%；
 *   下影爆仓 = 下影 > 0.8 ATR + 量 > 50 根均量 1.2 倍 + 收在 K 线上部 55% 以上（上影镜像）；
 *   LSQ 多头挤兑风险 = 拥挤做多 + OI 冲高 + 下影爆仓 → 做空；SSQ 空头挤兑风险 → 做多；
 *   RESET 洗完 = |费率| ≤ 0.005%（换算原脚本基差 0.1%，按基准费率附近）+ OI 洗出 + ATR < 20 根均值 0.9 倍 → 做多（只算之前 24 根没出现过的第一次）。
 *   持有 24 / 72 小时，对随机同方向。
 *
 *   node --experimental-strip-types scripts/research-data/e43.ts <dataDir>   [环境变量 WIN COOL DD SFP FUND OIH OIQ OIKEEP COINS]
 */
import { readFileSync } from "node:fs";
import { oiChangeRank, settledFunding, sweptLow } from "../../src/lib/ta/flush.ts";
import type { Candle } from "../../src/lib/types.ts";

const dir = process.argv[2];
const env = (k: string, d: string) => process.env[k] ?? d;
const WIN = Number(env("WIN", "168"));
const COOL = Number(env("COOL", "168"));
const DD = Number(env("DD", "0"));
const SFP = env("SFP", "0") === "1";
const FUND = env("FUND", "last");
const OIH = Number(env("OIH", "24"));
const OIQ = Number(env("OIQ", "0.1"));
const OIKEEP = Number(env("OIKEEP", "0.5"));
const FNEG = Number(env("FNEG", "0")); // 费率低于这个算“转负”（变体：0.00005 = 低于基准 0.01% 的一半）
const COINS = env("COINS", "BTC,ETH").split(",");
const OOS = Date.UTC(2025, 10, 1) / 1000;
const COST = 0.0015;
const HOLDS = [24, 72, 168];
const H = 3600;

type Bar = [number, number, number, number, number, number];
interface Ev {
  coin: string;
  t: number; // bar open
  grp: { G: boolean; N: boolean; F: boolean; O: boolean };
  fund: number;
  oiChg: number;
  oiPct: number;
  r: Record<number, number>; // R after cost
  pct: Record<number, number>;
  brk7: boolean;
  brk30: boolean | null;
  fall30: number | null;
  ret30: number | null;
  rand: Record<number, number[]>;
  low: number;
  close: number;
}

// deterministic random
let seed = 43;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

function atrSeries(b: Bar[], n = 14): number[] {
  const out: number[] = new Array(b.length).fill(NaN);
  let a = NaN;
  for (let i = 1; i < b.length; i++) {
    const tr = Math.max(b[i][2] - b[i][3], Math.abs(b[i][2] - b[i - 1][4]), Math.abs(b[i][3] - b[i - 1][4]));
    if (i < n) continue;
    if (i === n) {
      let s = 0;
      for (let j = 1; j <= n; j++) s += Math.max(b[j][2] - b[j][3], Math.abs(b[j][2] - b[j - 1][4]), Math.abs(b[j][3] - b[j - 1][4]));
      a = s / n;
    } else a = (a * (n - 1) + tr) / n;
    out[i] = a;
  }
  return out;
}

const allEv: Ev[] = [];
const c41: { coin: string; kind: string; t: number; side: 1 | -1; r: Record<number, number>; rand: Record<number, number[]> }[] = [];
const nowInfo: string[] = [];

for (const coin of COINS) {
  const h1: Bar[] = JSON.parse(readFileSync(`${dir}/e31/${coin}.json`, "utf8")).h1;
  const e30 = JSON.parse(readFileSync(`${dir}/e30/${coin}.json`, "utf8"));
  const d1: Bar[] = e30.d1;
  const funding: [number, number][] = e30.funding;
  const oiRows: [number, number][] = JSON.parse(readFileSync(`${dir}/e43/${coin}-oi.json`, "utf8"));
  const oi = new Map(oiRows.map(([t, v]) => [t, v]));
  const oiSeries = { t: oiRows.map((r) => r[0]), oi: oiRows.map((r) => r[1]) };
  const fs = { t: funding.map((r) => r[0]), rate: funding.map((r) => r[1]) };
  const hc: Candle[] = h1.map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }));
  const fundEnd = funding[funding.length - 1][0];
  const lastT = Math.min(h1[h1.length - 1][0], fundEnd + 8 * H);
  const idx = new Map(h1.map((b, i) => [b[0], i]));
  const atrD = atrSeries(d1);
  const dIdx = new Map(d1.map((b, i) => [b[0], i]));
  const atrH = atrSeries(h1);
  // funding known at time T: last print with t ≤ T
  let fp = 0;
  const fundAt = (T: number, avg3: boolean) => {
    while (fp + 1 < funding.length && funding[fp + 1][0] <= T) fp++;
    while (fp > 0 && funding[fp][0] > T) fp--;
    if (funding[fp][0] > T) return NaN;
    if (!avg3) return funding[fp][1];
    if (fp < 2) return NaN;
    return (funding[fp][1] + funding[fp - 1][1] + funding[fp - 2][1]) / 3;
  };
  const fundBetween = (a: number, b: number) => {
    let s = 0;
    for (const [t, r] of funding) if (t > a && t <= b) s += r;
    return s;
  };
  // OI change over OIH hours ending at T (bar close)
  const oiChg = (T: number, w: number) => {
    const a = oi.get(T - w * H), b = oi.get(T);
    return a && b ? b / a - 1 : NaN;
  };
  const firstOi = oiRows[0][0];
  const dAtr = (t: number) => {
    const day = Math.floor(t / 86400) * 86400 - 86400; // last closed day before entry
    const i = dIdx.get(day);
    return i != null ? atrD[i] : NaN;
  };
  const longR = (i: number, hold: number) => {
    // enter at open of bar i, exit at close of bar i+hold-1
    const j = i + hold - 1;
    if (j >= h1.length || h1[j][0] + H > lastT) return null;
    const entry = h1[i][1], exit = h1[j][4];
    const a = dAtr(h1[i][0]);
    if (!(a > 0)) return null;
    const pct = exit / entry - 1 - COST - fundBetween(h1[i][0], h1[j][0] + H);
    return { r: (pct * entry) / a, pct };
  };
  const sideR = (i: number, hold: number, side: 1 | -1) => {
    const j = i + hold - 1;
    if (j >= h1.length || h1[j][0] + H > lastT) return null;
    const entry = h1[i][1], exit = h1[j][4];
    const a = dAtr(h1[i][0]);
    if (!(a > 0)) return null;
    const pct = side * (exit / entry - 1) - COST - side * fundBetween(h1[i][0], h1[j][0] + H);
    return (pct * entry) / a;
  };
  const oiIdx: number[] = [];
  for (let i = 0; i < h1.length; i++) if (h1[i][0] >= firstOi + 365 * 86400 && oi.has(h1[i][0] + H)) oiIdx.push(i);
  const randomR = (hold: number, side: 1 | -1, n: number) => {
    const out: number[] = [];
    for (let k = 0; k < n * 3 && out.length < n; k++) {
      const i = oiIdx[Math.floor(rnd() * oiIdx.length)] + 1;
      const r = side === 1 ? longR(i, hold)?.r : sideR(i, hold, side);
      if (r != null && Number.isFinite(r)) out.push(r);
    }
    return out;
  };

  let lastEv = -Infinity;
  // C41 state
  const volSma = (i: number, n: number) => {
    let s = 0;
    for (let j = i - n + 1; j <= i; j++) s += h1[j][5];
    return s / n;
  };
  let oiEma = NaN;
  let lastReset = -Infinity;
  const atrAvg = (i: number) => {
    let s = 0;
    for (let j = i - 19; j <= i; j++) s += atrH[j];
    return s / 20;
  };
  for (let i = WIN + 1; i < h1.length - 1; i++) {
    const b = h1[i];
    const T = b[0] + H; // close time
    if (T > lastT) break;
    // C41 OI ema of hourly change
    const ch1 = oiChg(T, 1);
    if (Number.isFinite(ch1)) oiEma = Number.isFinite(oiEma) ? oiEma + (2 / 4) * (ch1 * 100 - oiEma) : ch1 * 100;
    if (T < firstOi + 365 * 86400) continue;

    // ---- C41 Crypto Perp Stress ----
    {
      const f = fundAt(T, false);
      const atr = atrH[i];
      const rng = b[2] - b[3];
      const vs = volSma(i, 50);
      const volSpike = vs > 0 && b[5] > vs * 1.2;
      const upW = b[2] - Math.max(b[1], b[4]);
      const dnW = Math.min(b[1], b[4]) - b[3];
      const liqUp = upW > atr * 0.8 && volSpike && rng > 0 && b[4] <= b[2] - rng * 0.55;
      const liqDn = dnW > atr * 0.8 && volSpike && rng > 0 && b[4] >= b[3] + rng * 0.55;
      const crowdL = f >= 0.0003, crowdS = f <= -0.0001;
      const build = oiEma >= 1, flush = oiEma <= -1.2;
      const add = (kind: string, side: 1 | -1) => {
        const r: Record<number, number> = {};
        const rand: Record<number, number[]> = {};
        for (const hd of [24, 72]) {
          const x = sideR(i + 1, hd, side);
          if (x == null) return;
          r[hd] = x;
          rand[hd] = randomR(hd, side, 50);
        }
        c41.push({ coin, kind, t: b[0], side, r, rand });
      };
      if (crowdL && build && liqDn) add("LSQ 多头挤兑风险 → 做空", -1);
      if (crowdS && build && liqUp) add("SSQ 空头挤兑风险 → 做多", 1);
      const reset = Math.abs(f) <= 0.00005 && flush && atr < atrAvg(i) * 0.9;
      if (reset && i - lastReset > 24) add("RESET 洗完 → 做多", 1);
      if (reset) lastReset = i;
    }

    // ---- sweep events ----
    // 扫低、费率、持仓分位用页面同一份规则（src/lib/ta/flush.ts）
    const prevLow = sweptLow(hc, i, WIN);
    if (prevLow == null) continue;
    if (i - lastEv < COOL) continue;
    if (SFP && !(b[4] >= prevLow)) continue;
    if (DD > 0) {
      let hi = 0;
      for (let j = Math.max(0, i - 720); j <= i; j++) hi = Math.max(hi, h1[j][2]);
      if (b[4] / hi - 1 > -DD) continue;
    }
    lastEv = i;
    const f = FUND === "avg3" ? fundAt(T, true) : (settledFunding(fs, T) ?? NaN);
    const rank = oiChangeRank(oiSeries, T, OIH, 365);
    if (!Number.isFinite(f) || !rank) continue;
    const pctl = rank.pct;
    const flushed = pctl <= OIQ;
    const kept = pctl > OIKEEP;
    const neg = FNEG > 0 ? f < FNEG : f < 0, pos = !neg && f > 0;
    const ev: Ev = {
      coin, t: b[0], fund: f, oiChg: rank.chg, oiPct: pctl, low: b[3], close: b[4],
      grp: { G: neg && flushed, N: pos && kept, F: neg && !flushed, O: flushed && !neg },
      r: {}, pct: {}, brk7: false, brk30: null, fall30: null, ret30: null, rand: {},
    };
    let ok = true;
    for (const hd of HOLDS) {
      const x = longR(i + 1, hd);
      if (!x) { ok = false; break; }
      ev.r[hd] = x.r;
      ev.pct[hd] = x.pct;
      ev.rand[hd] = randomR(hd, 1, 50);
    }
    if (!ok) continue;
    let mn7 = Infinity, mn30 = Infinity;
    for (let j = i + 1; j <= i + 720 && j < h1.length; j++) {
      if (j <= i + 168) mn7 = Math.min(mn7, h1[j][3]);
      mn30 = Math.min(mn30, h1[j][3]);
    }
    ev.brk7 = mn7 < b[3];
    if (i + 720 < h1.length && h1[i + 720][0] + H <= lastT) {
      ev.brk30 = mn30 < b[3];
      ev.fall30 = Math.max(0, 1 - mn30 / b[3]);
      ev.ret30 = h1[i + 720][4] / b[4] - 1;
    }
    allEv.push(ev);
  }
  // current state (end of data)
  {
    const T = lastT;
    nowInfo.push(`${coin} 数据到 ${new Date(T * 1000).toISOString().slice(0, 16)}：最近资金费率 ${(fundAt(T, false) * 100).toFixed(4)}%，持仓量 24 小时 ${(oiChg(T, 24) * 100).toFixed(1)}%`);
  }
}

// ---------- stats ----------
const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const sd = (a: number[]) => {
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1));
};
function normCdf(z: number) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}
function welch(a: number[], b: number[]) {
  if (a.length < 2 || b.length < 2) return { d: mean(a) - mean(b), t: NaN, p: 1 };
  const se = Math.sqrt(sd(a) ** 2 / a.length + sd(b) ** 2 / b.length);
  const t = (mean(a) - mean(b)) / se;
  return { d: mean(a) - mean(b), t, p: 2 * (1 - normCdf(Math.abs(t))) };
}
function prop(a: boolean[], b: boolean[]) {
  const pa = a.filter(Boolean).length / (a.length || 1), pb = b.filter(Boolean).length / (b.length || 1);
  const p = (a.filter(Boolean).length + b.filter(Boolean).length) / (a.length + b.length || 1);
  const se = Math.sqrt(p * (1 - p) * (1 / (a.length || 1) + 1 / (b.length || 1)));
  const z = se > 0 ? (pa - pb) / se : 0;
  return { pa, pb, z, p: 2 * (1 - normCdf(Math.abs(z))) };
}
function bh(ps: number[]) {
  const o = ps.map((p, i) => ({ p, i })).sort((x, y) => x.p - y.p);
  const q = new Array(ps.length).fill(1);
  let m = 1;
  for (let k = o.length - 1; k >= 0; k--) {
    m = Math.min(m, (o[k].p * ps.length) / (k + 1));
    q[o[k].i] = m;
  }
  return q;
}
const pc = (x: number) => (x * 100).toFixed(0) + "%";
const f2 = (x: number) => (Number.isFinite(x) ? (x >= 0 ? "+" : "") + x.toFixed(2) : "—");
const isT = (e: { t: number }) => e.t < OOS;
const inT = allEv.filter(isT);
const tMid = inT.length ? (inT[0].t + inT[inT.length - 1].t) / 2 : 0;
// t sorted per coin; compute global mid on in-sample sorted times
{
  const ts = inT.map((e) => e.t).sort((a, b) => a - b);
  if (ts.length) (globalThis as any).MID = ts[Math.floor(ts.length / 2)];
}
const MID: number = (globalThis as any).MID ?? tMid;
const seg = (e: { t: number; coin: string }) => ({
  btc: e.coin === "BTC", eth: e.coin === "ETH", h1: e.t < OOS && e.t < MID, h2: e.t < OOS && e.t >= MID, oos: e.t >= OOS,
});

console.log(`E43 参数：WIN=${WIN} COOL=${COOL} DD=${DD} SFP=${SFP ? 1 : 0} FUND=${FUND} FNEG=${FNEG} OIH=${OIH} OIQ=${OIQ} OIKEEP=${OIKEEP} COINS=${COINS.join(",")}`);
console.log(`样本外从 2025-11-01 起；样本内中点 ${new Date(MID * 1000).toISOString().slice(0, 10)}`);
for (const s of nowInfo) console.log(s);
console.log();

const groups: [string, (e: Ev) => boolean][] = [
  ["G 黄金坑（费率转负 + 持仓骤降）", (e) => e.grp.G],
  ["N 没洗出去（费率为正 + 持仓没怎么掉）", (e) => e.grp.N],
  ["F 只费率转负", (e) => e.grp.F],
  ["O 只持仓骤降", (e) => e.grp.O],
  ["全部扫低事件", () => true],
];
console.log("== 1. 各组描述（样本内 + 样本外合计）==");
console.log("组 | 笔数 BTC/ETH | 7 天内跌破这根低点 | 30 天内跌破 | 30 天内又跌中位 | 30 天后涨跌中位 | 24h R | 72h R | 7 天 R | 7 天 R 对随机");
for (const [name, fn] of groups) {
  const g = allEv.filter(fn);
  const g30 = g.filter((e) => e.brk30 != null);
  const med = (a: number[]) => {
    const s = [...a].sort((x, y) => x - y);
    return s.length ? s[Math.floor(s.length / 2)] : NaN;
  };
  const rr = (h: number) => mean(g.map((e) => e.r[h]));
  const rnd168 = mean(g.flatMap((e) => e.rand[168]));
  console.log(
    `${name} | ${g.length} (${g.filter((e) => e.coin === "BTC").length}/${g.filter((e) => e.coin === "ETH").length}) | ${pc(g.filter((e) => e.brk7).length / (g.length || 1))} | ${pc(g30.filter((e) => e.brk30).length / (g30.length || 1))} | ${pc(med(g30.map((e) => e.fall30!)))} | ${(med(g30.map((e) => e.ret30!)) * 100).toFixed(1)}% | ${f2(rr(24))} | ${f2(rr(72))} | ${f2(rr(168))} | ${f2(rr(168) - rnd168)}`,
  );
}

console.log();
console.log("== 2. 检验（R 为日线 ATR，做多，扣成本和资金费）==");
type Row = { name: string; d: number; p: number; n: string; segs: string; extra?: string };
const rows: Row[] = [];
const segNames = ["btc", "eth", "h1", "h2", "oos"] as const;
function cmpRow(name: string, a: Ev[], b: Ev[] | "rand", hold: number) {
  const val = (e: Ev) => e.r[hold];
  const one = (aa: Ev[], bb: Ev[] | "rand") => {
    if (bb === "rand") return welch(aa.map(val), aa.flatMap((e) => e.rand[hold]));
    return welch(aa.map(val), bb.map(val));
  };
  const all = one(a, b);
  const segs = segNames
    .map((s) => {
      const aa = a.filter((e) => seg(e)[s]);
      const bb = b === "rand" ? "rand" : b.filter((e) => seg(e)[s]);
      if (aa.length < 3 || (bb !== "rand" && bb.length < 3)) return `${s}:样本少`;
      return `${s}:${f2(one(aa, bb).d)}(${aa.length})`;
    })
    .join(" ");
  rows.push({ name, d: all.d, p: all.p, n: `${a.length}${b === "rand" ? "" : " 对 " + b.length}`, segs });
}
const G = allEv.filter((e) => e.grp.G), N = allEv.filter((e) => e.grp.N), F = allEv.filter((e) => e.grp.F), O = allEv.filter((e) => e.grp.O);
const notN = allEv.filter((e) => !e.grp.N), negAll = allEv.filter((e) => e.grp.G || e.grp.F), notNeg = allEv.filter((e) => !(e.grp.G || e.grp.F));
const flAll = allEv.filter((e) => e.grp.G || e.grp.O), notFl = allEv.filter((e) => !(e.grp.G || e.grp.O));
for (const h of HOLDS) {
  // 事后加的三行（看过主口径 G 只有 3 笔之后）：把两个条件拆开，各自对“没有这个条件”的扫低
  cmpRow(`[事后] N 没洗出去 对 其他扫低（${h}h）`, N, notN, h);
  cmpRow(`[事后] 费率转负（G+F）对 费率不负（${h}h）`, negAll, notNeg, h);
  cmpRow(`[事后] 持仓骤降（G+O）对 没骤降（${h}h）`, flAll, notFl, h);
  cmpRow(`G 对 N（${h}h）`, G, N, h);
  cmpRow(`G 对 随机（${h}h）`, G, "rand", h);
  cmpRow(`G 对 全部扫低（${h}h）`, G, allEv, h);
  cmpRow(`N 对 全部扫低（${h}h）`, N, allEv, h);
  cmpRow(`F 只费率转负 对 全部（${h}h）`, F, allEv, h);
  cmpRow(`O 只持仓骤降 对 全部（${h}h）`, O, allEv, h);
  cmpRow(`全部扫低 对 随机（${h}h）`, allEv, "rand", h);
}
// proportions: break of the low
const prow: Row[] = [];
function pRow(name: string, a: Ev[], b: Ev[], key: "brk7" | "brk30") {
  const aa = a.filter((e) => e[key] != null), bb = b.filter((e) => e[key] != null);
  const r = prop(aa.map((e) => !!e[key]), bb.map((e) => !!e[key]));
  const segs = segNames
    .map((s) => {
      const x = aa.filter((e) => seg(e)[s]), y = bb.filter((e) => seg(e)[s]);
      if (x.length < 3 || y.length < 3) return `${s}:样本少`;
      const q = prop(x.map((e) => !!e[key]), y.map((e) => !!e[key]));
      return `${s}:${pc(q.pa)}/${pc(q.pb)}`;
    })
    .join(" ");
  prow.push({ name, d: r.pa - r.pb, p: r.p, n: `${aa.length} 对 ${bb.length}`, segs, extra: `${pc(r.pa)} 对 ${pc(r.pb)}` });
}
pRow("[事后] 30 天内跌破低点：N 对 其他", N, notN, "brk30");
pRow("[事后] 30 天内跌破低点：费率转负 对 不负", negAll, notNeg, "brk30");
pRow("[事后] 30 天内跌破低点：持仓骤降 对 没骤降", flAll, notFl, "brk30");
pRow("7 天内跌破低点：G 对 N", G, N, "brk7");
pRow("30 天内跌破低点：G 对 N", G, N, "brk30");
pRow("7 天内跌破低点：G 对 全部", G, allEv, "brk7");
pRow("30 天内跌破低点：G 对 全部", G, allEv, "brk30");
pRow("7 天内跌破低点：N 对 全部", N, allEv, "brk7");
pRow("30 天内跌破低点：N 对 全部", N, allEv, "brk30");

const all = [...rows, ...prow];
const q = bh(all.map((r) => r.p));
console.log("行 | 笔数 | 差（R 或比例） | p | q（全表 BH） | 分段（BTC ETH 前半 后半 样本外）");
all.forEach((r, k) => {
  const d = r.extra ? `${r.extra}（差 ${(r.d * 100).toFixed(0)} 个百分点）` : f2(r.d);
  console.log(`${r.name} | ${r.n} | ${d} | ${r.p.toFixed(3)} | ${q[k].toFixed(3)} | ${r.segs}`);
});

console.log();
console.log("== 3. Capital41 Crypto Perp Stress（基差换资金费率），对同方向随机 ==");
const kinds = [...new Set(c41.map((x) => x.kind))];
const crow: Row[] = [];
for (const k of kinds) {
  for (const hd of [24, 72]) {
    // non-overlap: keep events at least hd hours apart per coin
    const xs: typeof c41 = [];
    const last = new Map<string, number>();
    for (const x of c41.filter((y) => y.kind === k)) {
      if (x.t - (last.get(x.coin) ?? -Infinity) < hd * H) continue;
      last.set(x.coin, x.t);
      xs.push(x);
    }
    const w = welch(xs.map((x) => x.r[hd]), xs.flatMap((x) => x.rand[hd]));
    const segs = segNames
      .map((s) => {
        const a = xs.filter((x) => seg(x)[s]);
        if (a.length < 3) return `${s}:样本少`;
        return `${s}:${f2(mean(a.map((x) => x.r[hd])) - mean(a.flatMap((x) => x.rand[hd])))}(${a.length})`;
      })
      .join(" ");
    crow.push({ name: `${k}（${hd}h）`, d: w.d, p: w.p, n: `${xs.length}，平均 ${f2(mean(xs.map((x) => x.r[hd])))}R`, segs });
  }
}
const cq = bh(crow.map((r) => r.p));
crow.forEach((r, k) => console.log(`${r.name} | ${r.n} | 对随机 ${f2(r.d)} | p ${r.p.toFixed(3)} | q ${cq[k].toFixed(3)} | ${r.segs}`));

console.log();
console.log("== 4. 全部费率转负的扫低（G、F）和 2025-10 以来的 N ==");
for (const e of [...allEv.filter((e) => e.grp.G || e.grp.F), ...allEv.filter((e) => e.grp.N && e.t >= Date.UTC(2025, 9, 1) / 1000)]) {
  console.log(
    `${e.coin} ${new Date((e.t + 8 * H) * 1000).toISOString().slice(0, 16).replace("T", " ")}（北京）${e.grp.G ? "G" : e.grp.F ? "F" : "N"} 低 ${e.low} 费率 ${(e.fund * 100).toFixed(4)}% 持仓 ${OIH}h ${(e.oiChg * 100).toFixed(1)}%（分位 ${pc(e.oiPct)}） 7 天 ${f2(e.r[168])}R 7 天内跌破 ${e.brk7 ? "是" : "否"} 30 天内又跌 ${e.fall30 == null ? "—" : pc(e.fall30)}`,
  );
}
