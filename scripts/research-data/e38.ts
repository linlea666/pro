/**
 * E38（2026-10-31）：用户问“拿 8/17–9/22 上涨和 9/22–10/31 下跌这两段，回测项目里的各个模块，看哪个最能抓住行情”。
 * 输入是 e38-collect.ts 的 JSONL（按页面同一套代码逐根 4 小时收盘回放 BTC，2025-06 起）。
 *   node --experimental-strip-types scripts/research-data/e38.ts <e38.jsonl> [输出.txt]
 *
 * 跑之前定好的规则（看结果之前写下，不再改）：
 * 两段（北京时间，4 小时收盘）：上涨 8/17 00:00（63,114）→ 9/22 08:00（86,589）；下跌 9/22 08:00 → 10/31 04:00（数据末尾）。
 * 尺子 A“跟着状态持仓”：每根 4 小时收盘时按模块的状态持仓（+1 多 / −1 空 / 0 空仓），拿到下一根收盘；
 *   每换一次仓（|Δ仓位| 每 1 份）扣 0.075%（一来一回 0.15%，同 stats.ts）。报：累计收益（百分点）、
 *   吃到这一段涨跌幅的几成（= 累计收益 ÷ |这一段每根涨跌之和|）、换仓次数、最大回撤。
 *   状态：红绿灯 4h / 1d（绿 +1、红 −1、黄 0）；趋势强度 4h / 1d（上涨 +1、下跌 −1、震荡 0）；
 *   指标共振 4h（净票 ≥ 门槛 +1、≤ −门槛 −1，否则 0；另一版“翻转后一直拿到反向翻转”）；结构 4h / 日线 / 周线方向；
 *   周 + 日一致；行情阶段 4h（下跌一侧到“转强”+1、其余 −1；上涨一侧到“转弱”−1、其余 +1）；
 *   TD 9、TD 13、缠论买卖点、EMA 12/26（都是“信号后一直拿到反向信号”）；斐波那契（最近一段向上且回撤 < 61.8% +1，向下同理 −1，否则 0）。
 *   对照：把同一条状态序列整体错开一个随机的位置（循环平移，换仓次数、持仓时间、多空比例都不变，只是对不上真实走势），
 *   做 500 次，报真实结果排在第几百分位（≥ 95 才算“比运气好”）。
 * 尺子 B“每个信号做一笔”：信号那根收盘入场；止损 = 模块自己的（裸 K）否则 1.5 倍 4 小时 ATR；2R 止盈；最多拿 30 根；
 *   同一根同时碰到止损和止盈算止损。报：笔数、和这一段方向相同的比例、合计 R、平均 R。
 *   全部历史（2025-06 起）另给对随机：同方向、同止损距离、随机时点（每笔 5 个）的平均 R 差。
 * 两段只有一个币、约 2.5 个月，任何结论都是“这一段的样子”，要和全部历史、和已有研究（E12、E19、E20、E24、E25、E34、E35、E37）对照。
 */
import fs from "node:fs";

type Row = {
  t: number; o: number; h: number; l: number; close: number; atr: number; light: string; trend: number; trendLabel: string;
  reso: number; resoStrong: number; fib: { dir: string; r: number } | null; chan: { t: number; type: string; price: number }[];
  td: { t: number; side: string; kind: string }[]; s4: number; ph4: { dir: number; stage: number } | null; day: number | null; week: number | null;
  d1?: { light: string; trend: number; label: string }; pa: { kind: string; dir: number; entry: number; stop: number; ok: boolean; loc: string | null; trend: string }[];
};
const [inp, outFile] = process.argv.slice(2);
const rows: Row[] = fs.readFileSync(inp, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const H4 = 14400;
const out: string[] = [];
const say = (s = "") => out.push(s);
const bjOpen = (s: string) => Date.parse(s.replace(" ", "T") + ":00+08:00") / 1000 - H4; // a close time in Beijing → that bar's open
const SEG = {
  up: { name: "上涨 8/17 00:00 → 9/22 08:00", a: bjOpen("2026-08-17 00:00"), b: bjOpen("2026-09-22 08:00") },
  down: { name: "下跌 9/22 08:00 → 10/31 04:00", a: bjOpen("2026-09-22 08:00"), b: rows[rows.length - 1].t },
  all: { name: `全部 ${new Date(rows[0].t * 1000).toISOString().slice(0, 10)} 起`, a: rows[0].t, b: rows[rows.length - 1].t },
};
const idxOf = (t: number) => rows.findIndex((r) => r.t === t);
const sign = (x: number) => (x > 0 ? 1 : x < 0 ? -1 : 0);
const label = (s: string) => (/上涨/.test(s) ? 1 : /下跌/.test(s) ? -1 : 0);
const lightOf = (s?: string) => (s === "green" ? 1 : s === "red" ? -1 : 0);

// ---------- events seen for the first time at each row ----------
const seen = new Set<string>();
const firstSeen = (i: number, key: string) => (seen.has(key) ? false : (seen.add(key), true));
type Ev = { i: number; dir: 1 | -1; stop?: number };
const EV: Record<string, Ev[]> = {};
const add = (k: string, e: Ev) => (EV[k] ??= []).push(e);
// EMA 12/26 on the 4h closes
const ema = (n: number) => { const k = 2 / (n + 1); let v = rows[0].close; return rows.map((r) => (v = r.close * k + v * (1 - k))); };
const e12 = ema(12), e26 = ema(26);
for (let i = 0; i < rows.length; i++) {
  const r = rows[i];
  for (const e of r.td) {
    if (!firstSeen(i, `td:${e.t}:${e.side}:${e.kind}`) || i === 0) continue;
    add(`TD ${e.kind === "setup9" ? 9 : 13}`, { i, dir: e.side === "buy" ? 1 : -1 });
  }
  for (const p of r.chan) {
    if (!firstSeen(i, `chan:${p.t}:${p.type}`) || i === 0) continue;
    add("缠论买卖点", { i, dir: p.type.includes("买") ? 1 : -1 });
    add(`缠论 ${p.type.slice(0, 1)}类`, { i, dir: p.type.includes("买") ? 1 : -1 });
  }
  if (i > 0) {
    const p = rows[i - 1];
    if (r.reso >= r.resoStrong && p.reso < p.resoStrong) add("指标共振", { i, dir: 1 });
    if (r.reso <= -r.resoStrong && p.reso > -p.resoStrong) add("指标共振", { i, dir: -1 });
    if (e12[i] > e26[i] && e12[i - 1] <= e26[i - 1]) add("EMA 金叉死叉", { i, dir: 1 });
    if (e12[i] < e26[i] && e12[i - 1] >= e26[i - 1]) add("EMA 金叉死叉", { i, dir: -1 });
    const inZone = (x: Row) => !!x.fib && x.fib.r >= 0.382 && x.fib.r <= 0.618;
    if (inZone(r) && !(inZone(p) && p.fib!.dir === r.fib!.dir)) add("斐波那契 38.2–61.8% 回调区", { i, dir: r.fib!.dir === "up" ? 1 : -1 });
    const lp = lightOf(r.light), lq = lightOf(p.light);
    if (lp !== 0 && lp !== lq) add("红绿灯 4h 变色", { i, dir: lp as 1 | -1 });
    if (r.s4 !== 0 && r.s4 !== p.s4) add("结构 4h 转向", { i, dir: r.s4 as 1 | -1 });
    const ph = (x: Row) => (x.ph4 && x.ph4.stage === 4 ? x.ph4.dir : 0);
    if (ph(r) !== 0 && ph(r) !== ph(p)) add("行情阶段 4h 转强/转弱", { i, dir: ph(r) as 1 | -1 });
  }
  for (const s of r.pa) {
    add("裸 K 全部形态", { i, dir: s.dir as 1 | -1, stop: s.stop });
    if (s.loc && s.loc !== "mid") add("裸 K 关键位上", { i, dir: s.dir as 1 | -1, stop: s.stop });
  }
}

// ---------- states ----------
const latch = (k: string) => { const m = new Map<number, number>(); for (const e of EV[k] ?? []) m.set(e.i, e.dir); let s = 0; return rows.map((_, i) => (s = m.get(i) ?? s)); };
const STATES: [string, number[]][] = [
  ["红绿灯 4h", rows.map((r) => lightOf(r.light))],
  ["红绿灯 日线", rows.map((r) => lightOf(r.d1?.light))],
  ["趋势强度 4h", rows.map((r) => label(r.trendLabel))],
  ["趋势强度 日线", rows.map((r) => label(r.d1?.label ?? ""))],
  ["指标共振 4h（过门槛才持仓）", rows.map((r) => (r.reso >= r.resoStrong ? 1 : r.reso <= -r.resoStrong ? -1 : 0))],
  ["指标共振 4h（翻转后一直拿）", latch("指标共振")],
  ["结构 4h", rows.map((r) => r.s4)],
  ["结构 日线", rows.map((r) => r.day ?? 0)],
  ["结构 周线", rows.map((r) => r.week ?? 0)],
  ["周线 + 日线一致", rows.map((r) => (r.day && r.day === r.week ? r.day : 0))],
  ["行情阶段 4h", rows.map((r) => (!r.ph4 ? 0 : r.ph4.dir === 1 ? (r.ph4.stage === 4 ? 1 : -1) : r.ph4.stage === 4 ? -1 : 1))],
  ["TD 9（信号后一直拿）", latch("TD 9")],
  ["TD 13（信号后一直拿）", latch("TD 13")],
  ["缠论买卖点（信号后一直拿）", latch("缠论买卖点")],
  ["EMA 12/26（信号后一直拿）", latch("EMA 金叉死叉")],
  ["斐波那契（顺最近一段、回撤 < 61.8%）", rows.map((r) => (r.fib && r.fib.r < 0.618 ? (r.fib.dir === "up" ? 1 : -1) : 0))],
  ["一直拿多（对照）", rows.map(() => 1)],
];
let seed = 38;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const COST = 0.075;
function follow(pos: number[], a: number, b: number) {
  const ia = idxOf(a), ib = idxOf(b);
  let pnl = 0, move = 0, flips = 0, peak = 0, dd = 0, inMkt = 0, prev = 0;
  for (let i = ia; i < ib; i++) {
    const r = (rows[i + 1].close / rows[i].close - 1) * 100;
    move += r;
    const p = pos[i];
    const ch = Math.abs(p - (i === ia ? 0 : prev));
    if (ch && i !== ia) flips++;
    pnl += p * r - ch * COST;
    if (p) inMkt++;
    peak = Math.max(peak, pnl); dd = Math.max(dd, peak - pnl);
    prev = p;
  }
  return { pnl, move, cap: (pnl / Math.abs(move)) * 100, flips, dd, inMkt: (inMkt / (ib - ia)) * 100, n: ib - ia };
}
function shiftPct(pos: number[], a: number, b: number, real: number) {
  let below = 0;
  for (let k = 0; k < 500; k++) {
    const off = 1 + Math.floor(rnd() * (pos.length - 2));
    const sh = pos.map((_, i) => pos[(i + off) % pos.length]);
    if (follow(sh, a, b).pnl < real) below++;
  }
  return (below / 500) * 100;
}
const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - [...s].reduce((x, ch) => x + (ch.charCodeAt(0) > 255 ? 2 : 1), 0)));
const f1 = (x: number) => (x >= 0 ? "+" : "") + x.toFixed(1);
say(`E38 两段行情各模块回测（BTC 4 小时，按页面同一套代码逐根回放；数据 ${new Date(rows[0].t * 1000).toISOString().slice(0, 10)} 起 ${rows.length} 根）`);
say();
say("=== 尺子 A：跟着模块的状态持仓（多 / 空 / 空仓），每换一份仓扣 0.075% ===");
for (const k of ["up", "down", "all"] as const) {
  const S = SEG[k];
  const base = follow(rows.map(() => 1), S.a, S.b);
  say(`\n--- ${S.name}：这一段每根涨跌之和 ${f1(base.move)}%（${base.n} 根）`);
  say(`${pad("模块", 40)}累计%    吃到几成   换仓   最大回撤%  持仓时间%  错开对照的百分位`);
  const res = STATES.map(([name, pos]) => { const f = follow(pos, S.a, S.b); return { name, ...f, pct: name.startsWith("一直") ? NaN : shiftPct(pos, S.a, S.b, f.pnl) }; }).sort((x, y) => y.pnl - x.pnl);
  for (const r of res) say(`${pad(r.name, 40)}${pad(f1(r.pnl), 9)}${pad(k === "all" ? "—" : f1(r.cap) + "%", 11)}${pad(String(r.flips), 7)}${pad(r.dd.toFixed(1), 11)}${pad(r.inMkt.toFixed(0), 11)}${isNaN(r.pct) ? "" : r.pct.toFixed(0)}`);
}

// ---------- yardstick B ----------
function trade(i: number, dir: 1 | -1, stop?: number) {
  const e = rows[i].close, atr = rows[i].atr;
  const st = stop != null && (dir > 0 ? stop < e : stop > e) ? stop : e - dir * 1.5 * atr;
  const risk = Math.abs(e - st), tgt = e + dir * 2 * risk;
  for (let j = i + 1; j < rows.length && j <= i + 30; j++) {
    const b = rows[j];
    if (dir > 0 ? b.l <= st : b.h >= st) return -1;
    if (dir > 0 ? b.h >= tgt : b.l <= tgt) return 2;
  }
  const j = Math.min(rows.length - 1, i + 30);
  return (dir * (rows[j].close - e)) / risk;
}
function randomR(dir: 1 | -1, riskAtr: number) {
  let s = 0;
  for (let k = 0; k < 5; k++) {
    const i = Math.floor(rnd() * (rows.length - 31));
    s += trade(i, dir, rows[i].close - dir * riskAtr * rows[i].atr);
  }
  return s / 5;
}
say();
say("=== 尺子 B：每个信号做一笔（信号收盘入场，止损 = 模块自己的或 1.5 倍 ATR，2R 止盈，最多 30 根）===");
for (const k of ["up", "down", "all"] as const) {
  const S = SEG[k];
  const segDir = k === "up" ? 1 : k === "down" ? -1 : 0;
  say(`\n--- ${S.name}`);
  say(`${pad("信号", 34)}笔数  同向%   合计R    平均R${k === "all" ? "   对随机" : ""}`);
  const res = Object.entries(EV).map(([name, evs]) => {
    const xs = evs.filter((e) => rows[e.i].t >= S.a && rows[e.i].t < S.b);
    const rs = xs.map((e) => trade(e.i, e.dir, e.stop));
    const sum = rs.reduce((a, b) => a + b, 0);
    let vs = NaN;
    if (k === "all" && xs.length) {
      vs = xs.reduce((a, e, j) => { const ra = Math.abs(rows[e.i].close - (e.stop ?? rows[e.i].close - e.dir * 1.5 * rows[e.i].atr)) / rows[e.i].atr; return a + rs[j] - randomR(e.dir, ra); }, 0) / xs.length;
    }
    return { name, n: xs.length, w: xs.length ? (xs.filter((e) => e.dir === segDir).length / xs.length) * 100 : NaN, sum, avg: xs.length ? sum / xs.length : NaN, vs };
  }).sort((x, y) => y.sum - x.sum);
  for (const r of res) say(`${pad(r.name, 34)}${pad(String(r.n), 6)}${pad(k === "all" ? "—" : isNaN(r.w) ? "—" : r.w.toFixed(0), 8)}${pad(f1(r.sum), 9)}${pad(isNaN(r.avg) ? "—" : f1(r.avg), 8)}${k === "all" && !isNaN(r.vs) ? f1(r.vs) : ""}`);
}
const text = out.join("\n");
console.log(text);
if (outFile) fs.writeFileSync(outFile, text + "\n");
