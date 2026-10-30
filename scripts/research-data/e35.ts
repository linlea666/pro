/**
 * E35：第三方 App 的“指标聚合评级”（30M / 1H / 4H / 24H 各给 看多 / 观望 / 看空）有没有优势，和我们的多指标共振放在同一套对照里比。
 * 规则在跑之前定好：
 *
 * - 数据：Binance 永续，BTC / ETH。30 分钟由 15 分钟合成，1 小时 / 15 分钟读 e31-fetch.ts 的 <dataDir>/e31，4 小时 / 日线读
 *   e30-fetch.ts 的 <dataDir>/e30。只用已收盘 K 线，信号那根收盘后下一根开盘入场。ATR = 14 根 Wilder，R = 入场时 1 倍 ATR。
 * - 评级用 TradingView 公开的“技术评级”（Technical Ratings）规则代替截图里的 App（它列的 RSI、AO、Woodies CCI、MACD、
 *   Williams %R、MA / EMA / SMA、均线交叉、VWMA、布林带是同一类东西）：
 *   均线组 15 项：SMA / EMA 10、20、30、50、100、200（均线在收盘下 = 多）、一目均衡（转换线 > 基准线且收盘在云上 = 多）、
 *   VWMA 20、HMA 9；振荡器组 11 项：RSI 14（<30 且上拐 = 多，>70 且下拐 = 空）、随机 14,3,3（K、D < 20 且 K > D = 多）、
 *   CCI 20（< −100 且上拐）、ADX 14（> 20 且 +DI 上穿 −DI）、AO（上穿 0 或 0 上方碟形）、动量 10（上升）、MACD（主线 > 信号线）、
 *   随机 RSI 3,3,14,14（收盘在 50 均线下且 K、D < 20、K > D）、威廉 %R 14（< −80 且上拐）、多空力量（收盘在 50 均线上且空头力量 < 0 上拐）、
 *   终极振荡 7,14,28（> 70 = 多，< 30 = 空）。每组取平均，总评 = 两组平均；> 0.1 看多、> 0.5 强烈看多，镜像看空，其余观望。
 * - 我们的：`computeIndicators` 的 28 指标净票数上穿 ±强共振门槛（`reso_bull` / `reso_bear`，同研究框架）。
 * - 行：每个周期 × {TV 总评进入看多 / 看空、进入强烈看多 / 看空、只看均线组、只看振荡器组、我们的共振} × 两种离场：
 *   fix = 固定持有 H 根（30M 16 根、1H 24 根、4H 12 根、1D 10 根），hold = 一直拿到评级离开这一档（最长 5H 根）。
 *   一个币一行同时只持一笔（样本不重叠）。成本来回 0.15%。
 * - 对照：每笔 30 个随机入场（同币、同一段、同方向、同持有根数），看差 R。
 * - 切分：样本外 = 2025-10-30 之后，样本内再分前后两半；BTC / ETH 分开。判定同 engine.ts 的 judge：差 ≥ 0.1R、BH 校正后显著、
 *   BTC / ETH / 前后两半 / 样本外方向一致。
 *
 *   node --experimental-strip-types scripts/research-data/e35.ts <dataDir>   [环境变量 TFS=30m,1h,4h,1d  START=2020-01-01]
 */
import { readFileSync } from "node:fs";
import { computeIndicators } from "../../src/lib/ta/indicators.ts";
import { DEFAULT_ENGINE_PARAMS } from "../../src/lib/params.ts";
import type { Candle } from "../../src/lib/types.ts";

const dir = process.argv[2];
const TFS = (process.env.TFS ?? "30m,1h,4h,1d").split(",");
const START = Date.parse(process.env.START ?? "2020-01-01") / 1000;
const OOS = Date.UTC(2025, 9, 30) / 1000;
const MID = START + (OOS - START) / 2;
const COST = 0.0015;
const HOLD: Record<string, number> = { "30m": 16, "1h": 24, "4h": 12, "1d": 10 };
const NRAND = 30;

function load(coin: string, tf: string): Candle[] {
  const src = tf === "4h" || tf === "1d" ? "e30" : "e31";
  const j = JSON.parse(readFileSync(`${dir}/${src}/${coin}.json`, "utf8"));
  const rows: number[][] = tf === "30m" ? j.m15 : { "1h": j.h1, "4h": j.h4, "1d": j.d1 }[tf];
  const c = rows.map((r) => ({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] }));
  if (tf !== "30m") return c;
  const out: Candle[] = [];
  for (const x of c) {
    const k = Math.floor(x.t / 1800) * 1800;
    const last = out[out.length - 1];
    if (last && last.t === k) {
      last.h = Math.max(last.h, x.h);
      last.l = Math.min(last.l, x.l);
      last.c = x.c;
      last.v += x.v;
    } else out.push({ ...x, t: k });
  }
  return out;
}

// ---------------------------------------------------------------- indicator helpers
const N = (n: number) => new Array(n).fill(NaN) as number[];
function sma(a: number[], p: number) {
  const o = N(a.length);
  let s = 0, k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!Number.isFinite(a[i])) { s = 0; k = 0; continue; }
    s += a[i]; k++;
    if (k > p) { s -= a[i - p]; k--; }
    if (k === p) o[i] = s / p;
  }
  return o;
}
function ema(a: number[], p: number) {
  const o = N(a.length), al = 2 / (p + 1);
  let e = NaN, s = 0, k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!Number.isFinite(a[i])) continue;
    if (k < p) { s += a[i]; k++; if (k === p) e = s / p; }
    else e = a[i] * al + e * (1 - al);
    o[i] = e;
  }
  return o;
}
function rma(a: number[], p: number) {
  const o = N(a.length);
  let e = NaN, s = 0, k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!Number.isFinite(a[i])) continue;
    if (k < p) { s += a[i]; k++; if (k === p) e = s / p; }
    else e = (e * (p - 1) + a[i]) / p;
    o[i] = e;
  }
  return o;
}
function wma(a: number[], p: number) {
  const o = N(a.length), den = (p * (p + 1)) / 2;
  for (let i = p - 1; i < a.length; i++) {
    let s = 0;
    for (let j = 0; j < p; j++) s += a[i - j] * (p - j);
    o[i] = s / den;
  }
  return o;
}
const hi = (a: number[], i: number, p: number) => { let m = -Infinity; for (let j = i - p + 1; j <= i; j++) m = Math.max(m, a[j]); return m; };
const lo = (a: number[], i: number, p: number) => { let m = Infinity; for (let j = i - p + 1; j <= i; j++) m = Math.min(m, a[j]); return m; };
function rsiOf(c: number[], p: number) {
  const up = c.map((x, i) => (i ? Math.max(0, x - c[i - 1]) : NaN)), dn = c.map((x, i) => (i ? Math.max(0, c[i - 1] - x) : NaN));
  const u = rma(up, p), d = rma(dn, p);
  return u.map((x, i) => (d[i] === 0 ? 100 : 100 - 100 / (1 + x / d[i])));
}
function stochK(src: number[], h: number[], l: number[], p: number) {
  return src.map((x, i) => { if (i < p - 1) return NaN; const H = hi(h, i, p), L = lo(l, i, p); return H === L ? 50 : (100 * (x - L)) / (H - L); });
}

/** TradingView 技术评级：返回每根的 均线组、振荡器组、总评（−1..1） */
function tvRating(b: Candle[]) {
  const n = b.length, c = b.map((x) => x.c), h = b.map((x) => x.h), l = b.map((x) => x.l), v = b.map((x) => x.v);
  const hl2 = b.map((x) => (x.h + x.l) / 2);
  const mas: number[][] = [];
  for (const p of [10, 20, 30, 50, 100, 200]) mas.push(sma(c, p), ema(c, p));
  const sv = sma(v, 20), vw = sma(c.map((x, i) => x * v[i]), 20).map((x, i) => x / sv[i]);
  const w9 = wma(c, 9), hma = wma(wma(c, 4).map((x, i) => 2 * x - w9[i]), 3);
  const don = (p: number, i: number) => (i >= p - 1 ? (hi(h, i, p) + lo(l, i, p)) / 2 : NaN);
  const rsi = rsiOf(c, 14);
  const k = sma(stochK(c, h, l, 14), 3), d = sma(k, 3);
  const tp = b.map((x) => (x.h + x.l + x.c) / 3), tpm = sma(tp, 20);
  const cci = tp.map((x, i) => { if (i < 19) return NaN; let md = 0; for (let j = i - 19; j <= i; j++) md += Math.abs(tp[j] - tpm[i]); return (x - tpm[i]) / (0.015 * (md / 20)); });
  const tr = b.map((x, i) => (i ? Math.max(x.h - x.l, Math.abs(x.h - c[i - 1]), Math.abs(x.l - c[i - 1])) : x.h - x.l));
  const pdm = b.map((x, i) => { if (!i) return 0; const u = x.h - h[i - 1], dd = l[i - 1] - x.l; return u > dd && u > 0 ? u : 0; });
  const mdm = b.map((x, i) => { if (!i) return 0; const u = x.h - h[i - 1], dd = l[i - 1] - x.l; return dd > u && dd > 0 ? dd : 0; });
  const atr14 = rma(tr, 14), pdi = rma(pdm, 14).map((x, i) => (100 * x) / atr14[i]), mdi = rma(mdm, 14).map((x, i) => (100 * x) / atr14[i]);
  const adx = rma(pdi.map((x, i) => (100 * Math.abs(x - mdi[i])) / (x + mdi[i] || 1)), 14);
  const s34 = sma(hl2, 34), ao = sma(hl2, 5).map((x, i) => x - s34[i]);
  const mom = c.map((x, i) => (i >= 10 ? x - c[i - 10] : NaN));
  const e26 = ema(c, 26), macd = ema(c, 12).map((x, i) => x - e26[i]), sig = ema(macd, 9);
  const srsiK = sma(stochK(rsi, rsi, rsi, 14), 3), srsiD = sma(srsiK, 3);
  const wr = c.map((x, i) => { if (i < 13) return NaN; const H = hi(h, i, 14), L = lo(l, i, 14); return H === L ? -50 : (-100 * (H - x)) / (H - L); });
  const e13 = ema(c, 13), ma50 = sma(c, 50);
  const bear = l.map((x, i) => x - e13[i]), bull = h.map((x, i) => x - e13[i]);
  const bp = b.map((x, i) => (i ? Math.min(x.l, c[i - 1]) : NaN)), tr2 = b.map((x, i) => (i ? Math.max(x.h, c[i - 1]) - bp[i] : NaN));
  const avg = (p: number, i: number) => { let s = 0, t = 0; for (let j = i - p + 1; j <= i; j++) { s += c[j] - bp[j]; t += tr2[j]; } return s / t; };
  const uo = c.map((_, i) => (i >= 29 ? (100 * (4 * avg(7, i) + 2 * avg(14, i) + avg(28, i))) / 7 : NaN));
  // 也合成 cloud 用的转换线、基准线、先行带（先行带向前移 26 根：当前的云是 26 根前算的）
  const conv = N(n), base = N(n), lead1 = N(n), lead2 = N(n);
  for (let i = 0; i < n; i++) {
    conv[i] = don(9, i); base[i] = don(26, i);
    if (i >= 26) { lead1[i] = (don(9, i - 26) + don(26, i - 26)) / 2; lead2[i] = don(52, i - 26); }
  }
  const sgn = (b2: boolean, s2: boolean) => (b2 ? 1 : s2 ? -1 : 0);
  const maG = N(n), osG = N(n), all = N(n);
  for (let i = 260; i < n; i++) {
    const m: number[] = mas.map((a) => sgn(a[i] < c[i], a[i] > c[i]));
    const top = Math.max(lead1[i], lead2[i]), bot = Math.min(lead1[i], lead2[i]);
    m.push(sgn(conv[i] > base[i] && c[i] > top, conv[i] < base[i] && c[i] < bot), sgn(vw[i] < c[i], vw[i] > c[i]), sgn(hma[i] < c[i], hma[i] > c[i]));
    const up = c[i] > ma50[i], dn = c[i] < ma50[i];
    const o: number[] = [
      sgn(rsi[i] < 30 && rsi[i] > rsi[i - 1], rsi[i] > 70 && rsi[i] < rsi[i - 1]),
      sgn(k[i] < 20 && d[i] < 20 && k[i] > d[i], k[i] > 80 && d[i] > 80 && k[i] < d[i]),
      sgn(cci[i] < -100 && cci[i] > cci[i - 1], cci[i] > 100 && cci[i] < cci[i - 1]),
      sgn(adx[i] > 20 && pdi[i - 1] < mdi[i - 1] && pdi[i] > mdi[i], adx[i] > 20 && pdi[i - 1] > mdi[i - 1] && pdi[i] < mdi[i]),
      sgn((ao[i] > 0 && ao[i - 1] <= 0) || (ao[i] > 0 && ao[i - 2] > ao[i - 1] && ao[i] > ao[i - 1]), (ao[i] < 0 && ao[i - 1] >= 0) || (ao[i] < 0 && ao[i - 2] < ao[i - 1] && ao[i] < ao[i - 1])),
      sgn(mom[i] > mom[i - 1], mom[i] < mom[i - 1]),
      sgn(macd[i] > sig[i], macd[i] < sig[i]),
      sgn(dn && srsiK[i] < 20 && srsiD[i] < 20 && srsiK[i] > srsiD[i], up && srsiK[i] > 80 && srsiD[i] > 80 && srsiK[i] < srsiD[i]),
      sgn(wr[i] < -80 && wr[i] > wr[i - 1], wr[i] > -20 && wr[i] < wr[i - 1]),
      sgn(up && bear[i] < 0 && bear[i] > bear[i - 1], dn && bull[i] > 0 && bull[i] < bull[i - 1]),
      sgn(uo[i] > 70, uo[i] < 30),
    ];
    maG[i] = m.reduce((s, x) => s + x, 0) / m.length;
    osG[i] = o.reduce((s, x) => s + x, 0) / o.length;
    all[i] = (maG[i] + osG[i]) / 2;
  }
  return { maG, osG, all, atr: atr14 };
}

// ---------------------------------------------------------------- trades
type Trade = { coin: string; t: number; r: number; base: number };
let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const seg = (t: number) => (t >= OOS ? 2 : t >= MID ? 1 : 0);

function run(coin: string, b: Candle[], atr: number[], state: number[], dir: 1 | -1, H: number, mode: "fix" | "hold", out: Trade[]) {
  const n = b.length;
  const ret = (i: number, L: number, d: number) => (d * (b[i + 1 + L - 1].c - b[i + 1].o) - COST * b[i + 1].o) / atr[i];
  // 同一段里能用的随机入场点
  const pool: number[][] = [[], [], []];
  for (let i = 260; i < n - 5 * H - 2; i++) if (b[i].t >= START && Number.isFinite(atr[i])) pool[seg(b[i].t)].push(i);
  let free = 0;
  for (let i = 261; i < n - 5 * H - 2; i++) {
    if (b[i].t < START || i < free) continue;
    if (!(state[i] === dir && state[i - 1] !== dir)) continue;
    let L = H;
    if (mode === "hold") { L = 1; while (L < 5 * H && state[i + L] === dir) L++; }
    const r = ret(i, L, dir);
    const p = pool[seg(b[i].t)];
    let s = 0;
    for (let k = 0; k < NRAND; k++) s += ret(p[Math.floor(rnd() * p.length)], L, dir);
    out.push({ coin, t: b[i].t, r, base: s / NRAND });
    free = i + L + 1;
  }
}

const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const tstat = (a: number[]) => { const m = mean(a), s = Math.sqrt(a.reduce((q, x) => q + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); return (m / s) * Math.sqrt(a.length); };
const pOf = (t: number) => { const z = Math.abs(t); const y = 1 / (1 + 0.2316419 * z); const q = 0.3989423 * Math.exp((-z * z) / 2) * y * (0.3193815 + y * (-0.3565638 + y * (1.781478 + y * (-1.821256 + y * 1.330274)))); return 2 * q; };

type Row = { key: string; trades: Trade[] };
const rows: Row[] = [];
for (const tf of TFS) {
  const data = ["BTC", "ETH"].map((coin) => {
    const b = load(coin, tf);
    const tv = tvRating(b);
    const panel = computeIndicators(b, b.length - 1, DEFAULT_ENGINE_PARAMS.indicators);
    const strong = Math.max(1, Math.round((panel.readings.length * DEFAULT_ENGINE_PARAMS.indicators.strongPct) / 100));
    const cut = (a: number[], th: number) => a.map((x) => (x > th ? 1 : x < -th ? -1 : 0));
    // 我们的共振：净票数 ≥ 门槛为多，≤ −门槛为空（进入这一档 = reso_bull / reso_bear）
    const ours = panel.net.map((x) => (x >= strong ? 1 : x <= -strong ? -1 : 0));
    return { coin, b, atr: tv.atr, states: { "TV总评": cut(tv.all, 0.1), "TV强烈": cut(tv.all, 0.5), "TV均线组": cut(tv.maG, 0.1), "TV振荡器组": cut(tv.osG, 0.1), "我们的共振": ours } as Record<string, number[]> };
  });
  for (const name of Object.keys(data[0].states))
    for (const mode of ["fix", "hold"] as const)
      for (const dir of [1, -1] as const) {
        const trades: Trade[] = [];
        for (const d of data) run(d.coin, d.b, d.atr, d.states[name], dir, HOLD[tf], mode, trades);
        rows.push({ key: `${tf} ${name} ${dir > 0 ? "看多" : "看空"} ${mode === "fix" ? `持${HOLD[tf]}根` : "拿到变档"}`, trades });
      }
  // 状态分布（当前时点落在各档的比例），说明这种评级大部分时间在说什么
  for (const d of data) {
    const s = d.states["TV总评"].slice(260), c = (v: number) => ((100 * s.filter((x) => x === v).length) / s.length).toFixed(0);
    console.log(`${tf} ${d.coin} TV 总评时间占比：看多 ${c(1)}% / 观望 ${c(0)}% / 看空 ${c(-1)}%`);
  }
}

const stat = rows.map((row) => {
  const part = (f: (t: Trade) => boolean) => mean(row.trades.filter(f).map((t) => t.r - t.base));
  const ins = row.trades.filter((t) => t.t < OOS).map((t) => t.r - t.base);
  return {
    key: row.key, n: row.trades.length, r: mean(row.trades.map((t) => t.r)), base: mean(row.trades.map((t) => t.base)), d: mean(ins), t: tstat(ins), p: pOf(tstat(ins)),
    btc: part((t) => t.coin === "BTC" && t.t < OOS), eth: part((t) => t.coin === "ETH" && t.t < OOS),
    h1: part((t) => seg(t.t) === 0), h2: part((t) => seg(t.t) === 1), oos: part((t) => seg(t.t) === 2), nOos: row.trades.filter((t) => t.t >= OOS).length,
    win: (100 * row.trades.filter((t) => t.r > 0).length) / row.trades.length, q: 1, ok: false,
  };
});
// BH 校正（按样本内 p）
const order = stat.map((s, i) => i).sort((a, b) => stat[a].p - stat[b].p);
let prev = 1;
for (let k = order.length - 1; k >= 0; k--) { const s = stat[order[k]]; prev = Math.min(prev, (s.p * order.length) / (k + 1)); s.q = prev; }
const f = (x: number) => (Number.isFinite(x) ? (x >= 0 ? "+" : "") + x.toFixed(2) : "  —");
console.log(`\n样本内 ${new Date(START * 1000).toISOString().slice(0, 10)} – 2025-10-30，样本外之后；差 = 对同币同段同方向同持有根数随机入场的 R 差（R = 1 ATR，扣 0.15%）`);
console.log("行 | 笔数 | 胜率 | 平均R | 随机R | 差(样本内) | t | q | BTC | ETH | 前半 | 后半 | 样本外(笔) | 判定");
for (const s of stat) {
  const same = [s.btc, s.eth, s.h1, s.h2, s.oos].every((x) => Math.sign(x) === Math.sign(s.d));
  const verdict = s.n < 30 ? "样本不足" : Math.abs(s.d) >= 0.1 && s.q < 0.05 && same ? (s.d > 0 ? "有优势" : "历史上不利") : "无可证明的优势";
  console.log(`${s.key} | ${s.n} | ${s.win.toFixed(0)}% | ${f(s.r)} | ${f(s.base)} | ${f(s.d)} | ${s.t.toFixed(1)} | ${s.q.toFixed(2)} | ${f(s.btc)} | ${f(s.eth)} | ${f(s.h1)} | ${f(s.h2)} | ${f(s.oos)} (${s.nOos}) | ${verdict}`);
}
