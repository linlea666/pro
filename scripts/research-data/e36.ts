/**
 * E36：博主的“MACD、RSI、布林带至少两个互相印证才进场；1 小时找机会、4 小时看趋势”。规则在跑之前定好：
 *
 * - 数据：Binance 永续 BTC / ETH，1 小时读 e31-fetch.ts 的 <dataDir>/e31，4 小时读 e30-fetch.ts 的 <dataDir>/e30，2020-01 起。
 *   信号那根 1 小时收盘后下一根开盘入场；4 小时只用这根 1 小时收盘时已经收盘的 4 小时 K 线。ATR = 14 根 Wilder（1 小时）。
 * - 三个 1 小时信号（多空镜像，下面按做多写）：
 *   MACD 12/26/9 金叉（主线上穿信号线）；RSI 14 从 30 下方收回到 30 上方；
 *   布林 20/2 收口后突破：前 5 根内有一根带宽在之前 120 根里最低的 20%，这根收盘从上轨下方站到上轨上方。
 * - 印证：一个信号在这根出现，另一个同方向的信号在这根或之前 3 根内出现（任两个）。也单独测每个信号。
 * - 4 小时过滤：无 / EMA（4 小时收盘在 EMA50 之上才做多）/ 结构（`structureDirection` 为上升才做多，同计划页）。
 * - 离场：fix = 拿 24 根，R = 入场时 1 倍 ATR；stop = 止损 1.5 ATR、止盈 2R、最长 48 根（同一根先算止损，跳空按开盘价），R = 止损距离。
 *   一个币一行同时只持一笔，成本来回 0.15%。
 * - 对照：每笔 30 个随机入场（同币、同一段、同方向、同离场规则）。两种随机：全部 K 线（“对随机”）和同样满足 4 小时过滤的 K 线
 *   （“对同向随机”，看指标印证在 4 小时方向之外有没有多出东西）。判定看后者；没有过滤的行两者相同。
 * - 切分：样本外 = 2025-10-30 之后，样本内再分前后两半；判定同 engine.ts 的 judge（差 ≥ 0.1R、BH 校正后显著、BTC / ETH / 前后两半 / 样本外同向）。
 *
 *   node --experimental-strip-types scripts/research-data/e36.ts <dataDir>   [环境变量 LOOK=3 SQ=0.2]
 */
import { readFileSync } from "node:fs";
import { structureSeries, structureDirection } from "../../src/lib/ta/structure.ts";
import type { Candle } from "../../src/lib/types.ts";

const dir = process.argv[2];
const LOOK = Number(process.env.LOOK ?? 3);
const SQ = Number(process.env.SQ ?? 0.2);
const START = Date.UTC(2020, 0, 1) / 1000;
const OOS = Date.UTC(2025, 9, 30) / 1000;
const MID = START + (OOS - START) / 2;
const COST = 0.0015;
const HOLD = 24, MAXH = 48, STOP = 1.5, TGT = 2;
const NRAND = 30;

function load(coin: string, src: string, key: string): Candle[] {
  const j = JSON.parse(readFileSync(`${dir}/${src}/${coin}.json`, "utf8"));
  return (j[key] as number[][]).map((r) => ({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] }));
}
function ema(a: number[], p: number) {
  const o = new Array(a.length).fill(NaN), al = 2 / (p + 1);
  let e = NaN;
  for (let i = 0; i < a.length; i++) {
    if (!Number.isFinite(a[i])) continue;
    e = Number.isFinite(e) ? a[i] * al + e * (1 - al) : a[i];
    if (i >= p - 1) o[i] = e;
  }
  return o;
}
function rma(a: number[], p: number) {
  const o = new Array(a.length).fill(NaN);
  let e = NaN, s = 0, k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!Number.isFinite(a[i])) continue;
    if (k < p) { s += a[i]; k++; if (k === p) e = s / p; }
    else e = (e * (p - 1) + a[i]) / p;
    o[i] = e;
  }
  return o;
}
const atrOf = (b: Candle[]) => rma(b.map((x, i) => (i ? Math.max(x.h - x.l, Math.abs(x.h - b[i - 1].c), Math.abs(x.l - b[i - 1].c)) : NaN)), 14);

/** 三个信号：每根 +1 / −1 / 0 */
function signals(b: Candle[]) {
  const n = b.length, c = b.map((x) => x.c);
  const e26 = ema(c, 26), macd = ema(c, 12).map((x, i) => x - e26[i]), sig = ema(macd, 9);
  const up = c.map((x, i) => (i ? Math.max(0, x - c[i - 1]) : NaN)), dn = c.map((x, i) => (i ? Math.max(0, c[i - 1] - x) : NaN));
  const ru = rma(up, 14), rd = rma(dn, 14), rsi = ru.map((x, i) => (rd[i] === 0 ? 100 : 100 - 100 / (1 + x / rd[i])));
  const mid = new Array(n).fill(NaN), upper = new Array(n).fill(NaN), lower = new Array(n).fill(NaN), bw = new Array(n).fill(NaN);
  let s = 0, s2 = 0;
  for (let i = 0; i < n; i++) {
    s += c[i]; s2 += c[i] * c[i];
    if (i >= 20) { s -= c[i - 20]; s2 -= c[i - 20] ** 2; }
    if (i >= 19) {
      const m = s / 20, sd = Math.sqrt(Math.max(0, s2 / 20 - m * m));
      mid[i] = m; upper[i] = m + 2 * sd; lower[i] = m - 2 * sd; bw[i] = (4 * sd) / m;
    }
  }
  const squeezed = new Array(n).fill(false);
  for (let i = 140; i < n; i++) {
    let below = 0;
    for (let j = i - 120; j < i; j++) if (bw[j] < bw[i]) below++;
    squeezed[i] = below <= 120 * SQ;
  }
  const M = new Array(n).fill(0), R = new Array(n).fill(0), B = new Array(n).fill(0);
  for (let i = 141; i < n; i++) {
    if (macd[i] > sig[i] && macd[i - 1] <= sig[i - 1]) M[i] = 1;
    else if (macd[i] < sig[i] && macd[i - 1] >= sig[i - 1]) M[i] = -1;
    if (rsi[i] > 30 && rsi[i - 1] <= 30) R[i] = 1;
    else if (rsi[i] < 70 && rsi[i - 1] >= 70) R[i] = -1;
    let sq = false;
    for (let j = i - 5; j < i; j++) sq ||= squeezed[j];
    if (sq && c[i] > upper[i] && c[i - 1] <= upper[i - 1]) B[i] = 1;
    else if (sq && c[i] < lower[i] && c[i - 1] >= lower[i - 1]) B[i] = -1;
  }
  const any = (a: number[], i: number, d: number) => { for (let j = Math.max(0, i - LOOK); j <= i; j++) if (a[j] === d) return true; return false; };
  const two = new Array(n).fill(0);
  for (let i = 0; i < n; i++)
    for (const d of [1, -1]) {
      const sets = [M, R, B];
      for (let a = 0; a < 3; a++) {
        if (sets[a][i] !== d) continue;
        for (let k = 0; k < 3; k++) if (k !== a && any(sets[k], i, d)) two[i] = d;
      }
    }
  return { "MACD 金叉死叉": M, "RSI 超卖超买收回": R, "布林收口突破": B, "任两个印证": two } as Record<string, number[]>;
}

/** 每根 1 小时收盘时已收盘的 4 小时 K 线给出的方向 */
function higher(b1: Candle[], b4: Candle[]) {
  const c4 = b4.map((x) => x.c), e50 = ema(c4, 50);
  const st = structureSeries(b4, atrOf(b4)).map(structureDirection);
  const emaDir = new Array(b1.length).fill(0), stDir = new Array(b1.length).fill(0);
  let j = -1;
  for (let i = 0; i < b1.length; i++) {
    while (j + 1 < b4.length && b4[j + 1].t + 14400 <= b1[i].t + 3600) j++;
    if (j < 50) continue;
    emaDir[i] = c4[j] > e50[j] ? 1 : c4[j] < e50[j] ? -1 : 0;
    stDir[i] = st[j];
  }
  return { "无": null, "EMA": emaDir, "结构": stDir } as Record<string, number[] | null>;
}

type Trade = { coin: string; t: number; r: number; baseAll: number; baseF: number };
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const seg = (t: number) => (t >= OOS ? 2 : t >= MID ? 1 : 0);

/** 从信号那根 i 的下一根开盘入场，返回 R 和离场那根 */
function trade(b: Candle[], atr: number[], i: number, d: number, mode: string): [number, number] {
  const e = b[i + 1].o, a = atr[i];
  if (mode === "fix") { const x = i + HOLD; return [(d * (b[x].c - e) - COST * e) / a, x]; }
  const risk = STOP * a, stop = e - d * risk, tgt = e + d * TGT * risk;
  for (let k = i + 1; k <= i + MAXH; k++) {
    const x = b[k];
    if (d > 0 ? x.l <= stop : x.h >= stop) { const px = d > 0 ? Math.min(stop, x.o) : Math.max(stop, x.o); return [(d * (px - e) - COST * e) / risk, k]; }
    if (d > 0 ? x.h >= tgt : x.l <= tgt) { const px = d > 0 ? Math.max(tgt, k > i + 1 ? x.o : tgt) : Math.min(tgt, k > i + 1 ? x.o : tgt); return [(d * (px - e) - COST * e) / risk, k]; }
  }
  const x = i + MAXH;
  return [(d * (b[x].c - e) - COST * e) / risk, x];
}

const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const tstat = (a: number[]) => { const m = mean(a), s = Math.sqrt(a.reduce((q, x) => q + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); return (m / s) * Math.sqrt(a.length); };
const pOf = (t: number) => { const z = Math.abs(t); const y = 1 / (1 + 0.2316419 * z); const q = 0.3989423 * Math.exp((-z * z) / 2) * y * (0.3193815 + y * (-0.3565638 + y * (1.781478 + y * (-1.821256 + y * 1.330274)))); return 2 * q; };

const data = ["BTC", "ETH"].map((coin) => {
  const b = load(coin, "e31", "h1"), b4 = load(coin, "e30", "h4");
  return { coin, b, atr: atrOf(b), sig: signals(b), hi: higher(b, b4) };
});

const rows: { key: string; trades: Trade[] }[] = [];
for (const filt of ["无", "EMA", "结构"])
  for (const name of Object.keys(data[0].sig))
    for (const mode of ["fix", "stop"])
      for (const d of [1, -1]) {
        const trades: Trade[] = [];
        for (const x of data) {
          const { b, atr } = x, n = b.length, f = x.hi[filt], s = x.sig[name];
          const poolAll: number[][] = [[], [], []], poolF: number[][] = [[], [], []];
          for (let i = 200; i < n - MAXH - 2; i++) {
            if (b[i].t < START || !Number.isFinite(atr[i])) continue;
            poolAll[seg(b[i].t)].push(i);
            if (!f || f[i] === d) poolF[seg(b[i].t)].push(i);
          }
          const base = (p: number[]) => { let s2 = 0; for (let k = 0; k < NRAND; k++) s2 += trade(b, atr, p[Math.floor(rnd() * p.length)], d, mode)[0]; return s2 / NRAND; };
          let free = 0;
          for (let i = 200; i < n - MAXH - 2; i++) {
            if (b[i].t < START || i < free || s[i] !== d || (f && f[i] !== d) || !Number.isFinite(atr[i])) continue;
            const [r, xi] = trade(b, atr, i, d, mode), g = seg(b[i].t);
            trades.push({ coin: x.coin, t: b[i].t, r, baseAll: base(poolAll[g]), baseF: base(poolF[g]) });
            free = xi + 1;
          }
        }
        rows.push({ key: `4H过滤:${filt} ${name} ${d > 0 ? "做多" : "做空"} ${mode === "fix" ? `拿${HOLD}根` : `止损${STOP}ATR止盈${TGT}R`}`, trades });
      }

const stat = rows.map((row) => {
  const ins = row.trades.filter((t) => t.t < OOS);
  const df = (t: Trade) => t.r - t.baseF;
  const part = (fn: (t: Trade) => boolean) => mean(row.trades.filter(fn).map(df));
  const tt = tstat(ins.map(df));
  return {
    key: row.key, n: row.trades.length, win: (100 * row.trades.filter((t) => t.r > 0).length) / Math.max(1, row.trades.length),
    r: mean(ins.map((t) => t.r)), all: mean(ins.map((t) => t.r - t.baseAll)), d: mean(ins.map(df)), t: tt, p: pOf(tt), q: 1,
    btc: part((t) => t.coin === "BTC" && t.t < OOS), eth: part((t) => t.coin === "ETH" && t.t < OOS),
    h1: part((t) => seg(t.t) === 0), h2: part((t) => seg(t.t) === 1), oos: part((t) => seg(t.t) === 2), nOos: row.trades.filter((t) => t.t >= OOS).length,
    rOos: mean(row.trades.filter((t) => t.t >= OOS).map((t) => t.r)),
  };
});
const order = stat.map((_, i) => i).sort((a, b) => stat[a].p - stat[b].p);
let prev = 1;
for (let k = order.length - 1; k >= 0; k--) { const s = stat[order[k]]; prev = Math.min(prev, (s.p * order.length) / (k + 1)); s.q = prev; }
const f = (x: number) => (Number.isFinite(x) ? (x >= 0 ? "+" : "") + x.toFixed(2) : "  —");
console.log(`E36 BTC / ETH 1 小时，印证窗口 ${LOOK} 根，收口 = 最低 ${SQ * 100}%；样本内 2020-01-01 – 2025-10-30，样本外之后；成本 0.15%`);
console.log("行 | 笔数 | 胜率 | 平均R(样本内) | 对随机 | 对同向随机 | t | q | BTC | ETH | 前半 | 后半 | 样本外差(笔) | 样本外平均R | 判定");
for (const s of stat) {
  const same = [s.btc, s.eth, s.h1, s.h2, s.oos].every((x) => Math.sign(x) === Math.sign(s.d));
  const v = s.n < 30 ? "样本不足" : Math.abs(s.d) >= 0.1 && s.q < 0.05 && same ? (s.d > 0 ? "有优势" : "历史上不利") : "无可证明的优势";
  console.log(`${s.key} | ${s.n} | ${s.win.toFixed(0)}% | ${f(s.r)} | ${f(s.all)} | ${f(s.d)} | ${s.t.toFixed(1)} | ${s.q.toFixed(2)} | ${f(s.btc)} | ${f(s.eth)} | ${f(s.h1)} | ${f(s.h2)} | ${f(s.oos)} (${s.nOos}) | ${f(s.rOos)} | ${v}`);
}
