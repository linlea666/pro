/**
 * E38b（2026-10-31）：E38 在 BTC 2025-06 起的 4 小时上，“跟着行情阶段 4h 的状态持仓”排第一（错开对照第 97 百分位），
 * 但在 9/22–10/31 那段下跌里垫底。17 个模块里挑出来的第一名，先在 10 个币、2021-10 起的全部 4 小时上复核。
 *   DATA_DIR=<研究库> node --experimental-strip-types scripts/research-data/e38b.ts [输出.txt]
 *
 * 跑之前定好的规则（看结果之前写下，不再改）：
 * 状态同 e38.ts：行情阶段 4h（下跌一侧到“转强”+1、其余 −1；上涨一侧到“转弱”−1、其余 +1）；另做结构 4h 方向、TD 13（信号后一直拿）、
 *   一直拿多作对照。每根 4 小时收盘按状态持仓到下一根收盘，每换一份仓扣 0.075%。前 300 根预热。
 * 对照：同一币同一条状态序列循环平移随机位置，每币 300 次；报“每年多赚的百分点”= 真实 − 平移的平均，和真实在平移里的百分位。
 * 切分：样本外 = 2025-10-30 起；样本内再分前后两半。达标（才考虑页面上说阶段“有用”）：10 币合计百分位 ≥ 95，
 *   BTC、ETH、前后两半、样本外“多赚”都为正。只有 10 个币、一个周期，仍要和 E33 的描述口径一致：阶段只描述，不当信号。
 */
import fs from "node:fs";
import { loadHistory } from "../../src/lib/research/run.ts";
import { RESEARCH_COINS } from "../../src/lib/symbols.ts";
import { atrSeries } from "../../src/lib/ta/risk.ts";
import { structureDirection, structureSeries } from "../../src/lib/ta/structure.ts";
import { phaseAt } from "../../src/lib/ta/phase.ts";
import { computeTd } from "../../src/lib/ta/td.ts";

const outFile = process.argv[2];
const OOS = Date.parse("2025-10-30T00:00:00Z") / 1000;
const nowSec = Date.parse("2026-10-30T20:00:00Z") / 1000;
const COST = 0.075, WARM = 300, N_SHIFT = 300;
let seed = 381;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const out: string[] = [];
const say = (s = "") => (out.push(s), console.log(s));

type Part = "is1" | "is2" | "oos";
const pnl = (pos: number[], ret: number[], from: number, to: number) => {
  let s = 0, prev = 0;
  for (let i = from; i < to; i++) { s += pos[i] * ret[i] - Math.abs(pos[i] - prev) * COST; prev = pos[i]; }
  return s;
};
const res: Record<string, { coin: string; real: Record<Part | "all", number>; shift: Record<Part | "all", number>; pct: number; years: number }[]> = {};
for (const coin of RESEARCH_COINS) {
  const c = loadHistory(coin, "4h", nowSec);
  if (c.length < WARM + 1000) continue;
  const atr = atrSeries(c);
  const ss = structureSeries(c, atr, 2);
  const td = computeTd(c);
  const ret = c.map((x, i) => (i + 1 < c.length ? (c[i + 1].c / x.c - 1) * 100 : 0));
  const states: Record<string, number[]> = { "行情阶段 4h": [], "结构 4h": [], "TD 13（信号后一直拿）": [], "一直拿多": [] };
  const t13 = new Map(td.events.filter((e) => e.kind === "countdown13").map((e) => [e.i, e.side === "buy" ? 1 : -1]));
  let l13 = 0;
  for (let i = 0; i < c.length; i++) {
    const p = i >= WARM ? phaseAt(c, atr, ss, i, 2) : null;
    states["行情阶段 4h"].push(!p ? 0 : p.dir === 1 ? (p.stage === 4 ? 1 : -1) : p.stage === 4 ? -1 : 1);
    states["结构 4h"].push(ss[i] ? structureDirection(ss[i]) : 0);
    l13 = t13.get(i) ?? l13;
    states["TD 13（信号后一直拿）"].push(l13);
    states["一直拿多"].push(1);
  }
  const iO = c.findIndex((x) => x.t >= OOS);
  const mid = Math.floor((WARM + iO) / 2);
  const parts: Record<Part | "all", [number, number]> = { is1: [WARM, mid], is2: [mid, iO], oos: [iO, c.length - 1], all: [WARM, c.length - 1] };
  const years = ((c.length - 1 - WARM) * 4) / 24 / 365;
  for (const [name, pos] of Object.entries(states)) {
    const real = Object.fromEntries(Object.entries(parts).map(([k, [a, b]]) => [k, pnl(pos, ret, a, b)])) as Record<Part | "all", number>;
    const shift = { is1: 0, is2: 0, oos: 0, all: 0 } as Record<Part | "all", number>;
    let below = 0;
    for (let k = 0; k < N_SHIFT; k++) {
      const off = WARM + Math.floor(rnd() * (c.length - 2 * WARM));
      const sh = pos.map((_, i) => (i < WARM ? 0 : pos[WARM + ((i - WARM + off) % (c.length - WARM))]));
      for (const [kk, [a, b]] of Object.entries(parts)) shift[kk as Part] += pnl(sh, ret, a, b) / N_SHIFT;
      if (pnl(sh, ret, WARM, c.length - 1) < real.all) below++;
    }
    (res[name] ??= []).push({ coin, real, shift, pct: (below / N_SHIFT) * 100, years });
  }
}
const f1 = (x: number) => (x >= 0 ? "+" : "") + x.toFixed(1);
say("E38b 跟着状态持仓，10 个币 4 小时，2021-10 起（前 300 根预热），样本外 = 2025-10-30 起");
say("“多赚” = 真实累计 − 循环平移对照的平均（百分点）；百分位 = 真实在 300 次平移里排第几");
for (const [name, rs] of Object.entries(res)) {
  say(`\n=== ${name}`);
  say("币      真实累计%   平移平均%   多赚     每年多赚   百分位   前半多赚  后半多赚  样本外多赚");
  let tr = 0, ts = 0, y = 0;
  const d = (r: (typeof rs)[number], k: Part | "all") => r.real[k] - r.shift[k];
  for (const r of rs) {
    tr += r.real.all; ts += r.shift.all; y += r.years;
    say(`${r.coin.padEnd(8)}${f1(r.real.all).padStart(9)}${f1(r.shift.all).padStart(12)}${f1(d(r, "all")).padStart(9)}${f1(d(r, "all") / r.years).padStart(10)}${r.pct.toFixed(0).padStart(9)}${f1(d(r, "is1")).padStart(10)}${f1(d(r, "is2")).padStart(10)}${f1(d(r, "oos")).padStart(11)}`);
  }
  const sum = (k: Part | "all") => rs.reduce((a, r) => a + d(r, k), 0) / rs.length;
  const avgPct = rs.reduce((a, r) => a + r.pct, 0) / rs.length;
  say(`平均    ${f1(tr / rs.length).padStart(9)}${f1(ts / rs.length).padStart(12)}${f1(sum("all")).padStart(9)}${f1((sum("all") * rs.length) / y).padStart(10)}${avgPct.toFixed(0).padStart(9)}${f1(sum("is1")).padStart(10)}${f1(sum("is2")).padStart(10)}${f1(sum("oos")).padStart(11)}`);
  say(`高于平移中位的币：${rs.filter((r) => r.pct > 50).length} / ${rs.length}；≥ 95 的：${rs.filter((r) => r.pct >= 95).length}`);
}
if (outFile) fs.writeFileSync(outFile, out.join("\n") + "\n");
