/**
 * E46（2026-11-07）：波动压到一年里很低之后，是不是更容易走出大行情、往哪边。用户回看 8/19 拉升前“波动压到一年最低 1%”，
 * 问盯盘 / 趋势页能不能加“波动压到什么程度”的提示；用户在决策卡上选“先测再加”。规则在跑之前定好（看结果之前写下，不再改）：
 *
 * - 数据：Binance 永续 1 小时 K 线（data.binance.vision 月度归档，2019-09 起），BTC / ETH，文件 <dir>/<SYM>-1h-YYYY-MM.csv。
 * - 压缩程度 q：和页面同一口径（`quietRanks`，impulse.ts）：每个 UTC 日 0 点之前 168 根 1 小时收益的标准差，
 *   在之前 365 天里的分位。分组：极低 q ≤ 5%、很低 5–10%、安静 10–33%、正常 33–67%、动荡 ≥ 67%。
 * - 结果（从当天 0 点开盘价 P0 起）：
 *   ① 之后 1 / 3 / 7 天的最大偏离 max(最高 / P0 − 1, 1 − 最低 / P0)，除以之前 365 天所有日子同长度最大偏离的中位数（“是平时的几倍”）；
 *   ② 大行情 = 7 天最大偏离 ≥ 平时的 2 倍；
 *   ③ 方向：7 天后收盘涨的比例；大行情里往上的比例（先到 2 倍的那一边）；
 *   ④ 之后 7 天的 1 小时波动（标准差）是一年中位的几倍（绝对水平，不是和之前 7 天比——那个必然变大）。
 * - 样本：每天一个（重叠，用来看比例）；“段”= 第一次进入 q ≤ 10% 且之前 14 天都不在里面，用来数独立的次数和做检验。
 *   检验：段的大行情比例对所有日子（两比例 z），各分组的 ① 对所有日子（Welch t，按段的第一天）。
 * - 切分：样本外 = 2025-11-01 起（最近 12 个月），样本内再分前后两半；BTC、ETH 分开。
 * - 页面能说“压缩之后更容易出大行情”的条件：段的大行情比例比所有日子高 ≥ 10 个百分点，BTC / ETH、前后两半、样本外方向一致。
 *   方向（涨跌比例）要说“偏涨 / 偏跌”同样要各段一致，否则只写“涨跌都有”。
 *
 *   node --experimental-strip-types scripts/research-data/e46.ts <dir>   [COINS=BTC,ETH]
 */
import { readFileSync, readdirSync } from "node:fs";
import { quietRanks } from "../../src/lib/ta/impulse.ts";
import type { Candle } from "../../src/lib/types.ts";

const dir = process.argv[2];
const COINS = (process.env.COINS ?? "BTC,ETH").split(",");
const OOS = Date.parse("2025-11-01T00:00:00Z") / 1000;
const DAY = 86400;
// LONG=1（看完主结果后加的变体，不改主表的规则）：另看 14 / 30 天，大行情 = 30 天最大偏离 ≥ 平时 2 倍
const LONG = process.env.LONG === "1";
const H = LONG ? [1, 3, 7, 14, 30] : [1, 3, 7];
const BIG_H = LONG ? 30 : 7;

type Row = { coin: string; t: number; q: number; r: Record<number, number>; big: boolean; bigUp: boolean | null; up7: boolean; vol7: number; ep: boolean };

function load(sym: string): Candle[] {
  const out: Candle[] = [];
  for (const f of readdirSync(dir).filter((x) => x.startsWith(`${sym}USDT-1h-`) && x.endsWith(".csv")).sort())
    for (const l of readFileSync(`${dir}/${f}`, "utf8").trim().split("\n")) {
      const x = l.split(",");
      if (x[0] === "open_time") continue;
      out.push({ t: Math.round(+x[0] / 1000), o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[5] });
    }
  return out.sort((a, b) => a.t - b.t).filter((c, i, a) => i === 0 || c.t !== a[i - 1].t);
}

const median = (a: number[]) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

const rows: Row[] = [];
for (const coin of COINS) {
  const h = load(coin);
  const idx = new Map(h.map((c, i) => [c.t, i]));
  const q = quietRanks(h);
  const days = [...q.keys()].sort((a, b) => a - b);
  // per day: max excursion over 1/3/7 days, next-7d stdev
  const exc = new Map<number, Record<number, number>>();
  const sd7 = new Map<number, number>();
  const meta = new Map<number, { bigUp: boolean | null; up7: boolean }>();
  const allDays = [...new Set(h.map((c) => Math.floor(c.t / DAY) * DAY))].sort((a, b) => a - b);
  for (const d of allDays) {
    const i = idx.get(d);
    if (i == null || i + Math.max(...H) * 24 > h.length) continue;
    const p0 = h[i].o;
    const e: Record<number, number> = {};
    for (const n of H) {
      let hi = -Infinity, lo = Infinity;
      for (let k = i; k < i + n * 24; k++) { hi = Math.max(hi, h[k].h); lo = Math.min(lo, h[k].l); }
      e[n] = Math.max(hi / p0 - 1, 1 - lo / p0);
    }
    exc.set(d, e);
    let s = 0, s2 = 0;
    for (let k = i + 1; k < i + 168; k++) { const r = Math.log(h[k].c / h[k - 1].c); s += r; s2 += r * r; }
    sd7.set(d, Math.sqrt((s2 - (s * s) / 167) / 166));
    meta.set(d, { bigUp: null, up7: h[i + 167].c > p0 });
  }
  const exDays = [...exc.keys()].sort((a, b) => a - b);
  const pos = new Map(exDays.map((d, k) => [d, k]));
  let lastIn = -1e12;
  for (const d of days) {
    const k = pos.get(d);
    if (k == null || k < 365) continue;
    // "usual" = median over the previous 365 days whose windows have already closed (no look-ahead)
    const prev = exDays.slice(k - 365, k - Math.max(...H));
    const base: Record<number, number> = {};
    for (const n of H) base[n] = median(prev.map((x) => exc.get(x)![n]));
    const baseSd = median(prev.map((x) => sd7.get(x)!));
    const e = exc.get(d)!;
    const r: Record<number, number> = {};
    for (const n of H) r[n] = e[n] / base[n];
    const big = r[BIG_H] >= 2;
    let bigUp: boolean | null = null;
    if (big) {
      const i = idx.get(d)!, p0 = h[i].o, lim = 2 * base[BIG_H];
      for (let j = i; j < i + BIG_H * 24; j++) {
        if (h[j].h / p0 - 1 >= lim) { bigUp = true; break; }
        if (1 - h[j].l / p0 >= lim) { bigUp = false; break; }
      }
    }
    const qq = q.get(d)!;
    const ep = qq <= 0.1 && d - lastIn > 14 * DAY;
    if (qq <= 0.1) lastIn = d;
    rows.push({ coin, t: d, q: qq, r, big, bigUp, up7: meta.get(d)!.up7, vol7: sd7.get(d)! / baseSd, ep });
  }
}

const groups: [string, (q: number) => boolean][] = [
  ["极低 ≤5%", (q) => q <= 0.05],
  ["很低 5–10%", (q) => q > 0.05 && q <= 0.1],
  ["安静 10–33%", (q) => q > 0.1 && q < 1 / 3],
  ["正常 33–67%", (q) => q >= 1 / 3 && q < 2 / 3],
  ["动荡 ≥67%", (q) => q >= 2 / 3],
  ["所有日子", () => true],
];
const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
const f2 = (x: number) => x.toFixed(2);

function table(sel: Row[], title: string) {
  console.log(`\n${title}（天数按日，重叠）`);
  console.log(`  分组          天数  ${H.map((n) => `${n}天偏离倍数`).join("  ")}  大行情(${BIG_H}天≥2倍)  其中往上  7天后收涨  之后7天波动/一年中位`);
  for (const [name, g] of groups) {
    const s = sel.filter((x) => g(x.q));
    if (!s.length) continue;
    const big = s.filter((x) => x.big);
    const bu = big.filter((x) => x.bigUp === true).length;
    console.log(`  ${name.padEnd(12)} ${String(s.length).padStart(5)}  ${H.map((n) => f2(median(s.map((x) => x.r[n])))).join("  ")}  ${pct(big.length / s.length).padStart(6)}  ${big.length ? pct(bu / big.length) : "—"}  ${pct(s.filter((x) => x.up7).length / s.length)}  ${f2(median(s.map((x) => x.vol7)))}`);
  }
}

function zProp(a: number, n: number, b: number, m: number) {
  const p = (a + b) / (n + m);
  return (a / n - b / m) / Math.sqrt(p * (1 - p) * (1 / n + 1 / m));
}

function episodes(sel: Row[], title: string) {
  const ep = sel.filter((x) => x.ep);
  const big = ep.filter((x) => x.big);
  const all = sel;
  const ab = all.filter((x) => x.big).length;
  const up = ep.filter((x) => x.up7).length;
  const au = all.filter((x) => x.up7).length;
  const z = ep.length ? zProp(big.length, ep.length, ab, all.length) : NaN;
  console.log(`  ${title.padEnd(16)} 段 ${String(ep.length).padStart(3)}：大行情 ${ep.length ? pct(big.length / ep.length) : "—"}（所有日子 ${pct(ab / all.length)}，差 ${ep.length ? ((big.length / ep.length - ab / all.length) * 100).toFixed(0) : "—"} 个百分点，z ${Number.isFinite(z) ? z.toFixed(2) : "—"}）；大行情里往上 ${big.length ? `${big.filter((x) => x.bigUp).length}/${big.length}` : "—"}；7 天后收涨 ${ep.length ? pct(up / ep.length) : "—"}（所有日子 ${pct(au / all.length)}）；7 天偏离中位 ${ep.length ? f2(median(ep.map((x) => x.r[7]))) : "—"} 倍`);
}

const first = rows.length ? Math.min(...rows.map((r) => r.t)) : 0;
const ins = rows.filter((r) => r.t < OOS);
const mid = median(ins.map((r) => r.t));
console.log(`E46 波动压缩之后（${COINS.join(" / ")}，从 ${new Date(first * 1000).toISOString().slice(0, 10)} 起；样本外 2025-11-01 起）`);
table(rows, "全部");
for (const c of COINS) table(rows.filter((r) => r.coin === c), c);
console.log(`\n“段”（第一次进入 q ≤ 10%，之前 14 天都不在里面）对所有日子：`);
episodes(rows, "全部");
for (const c of COINS) episodes(rows.filter((r) => r.coin === c), c);
episodes(ins.filter((r) => r.t < mid), "样本内前半");
episodes(ins.filter((r) => r.t >= mid), "样本内后半");
episodes(rows.filter((r) => r.t >= OOS), "样本外（12 个月）");
console.log(`\n每一段（第一天 · 币 · q · 7 天偏离倍数 · 大行情方向 · 7 天后涨跌）：`);
for (const r of rows.filter((x) => x.ep)) console.log(`  ${new Date(r.t * 1000).toISOString().slice(0, 10)} ${r.coin} q ${(r.q * 100).toFixed(0)}% · ${f2(r.r[7])} 倍 · ${r.big ? (r.bigUp ? "大行情往上" : "大行情往下") : "—"} · ${r.up7 ? "涨" : "跌"}`);
