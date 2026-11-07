/**
 * E45（2026-11-07）：AHR999“深熊在 < 0.45 筑底结束、向上突破 0.45 后，回踩 0.45 几乎都会获得强支撑”这个说法对不对。
 * 用户贴 @Bulldata_ 推文（举 2016 年中、2019 年底、2023 年 3 月 / 9 月，现在“刚突破 0.45 迎来首次回踩，和 2023-03 相似”），
 * 问对不对、现在 0.45 对应 BTC 多少钱。规则在跑之前定好（看结果之前写下，不再改；变体只换下面的环境变量）：
 *
 * - 数据：Coin Metrics 社区接口 BTC 每日 PriceUSD（2010-07 起，和囤币页同一来源），缓存在 <dataDir>/cm-btc.json。
 * - AHR999 = (价格 / 200 日定投成本) × (价格 / 币龄估值)；200 日定投成本 = 最近 200 天（含当天）价格的几何平均；
 *   币龄估值 = 10^(5.84 × log10(币龄天数) − 17.01)，币龄从 2009-01-03 起算。和 ahr999 原文、各家看板同一公式。
 * - 事件：
 *   突破：AHR 收在 ≥ LINE（0.45）、前一天 < LINE，且之前 LOOK（90）天里至少 MINBELOW（30）天 < LINE（“在绿区筑过底”）。
 *   站上确认：突破后 AHR 到过 ≥ LINE × (1 + LIFT)（LIFT 0.2 → 0.54），之前没收在 LINE × (1 − TOL)（TOL 0.1 → 0.405）以下；
 *     先跌回去的算“突破失败”（也列出来）。
 *   回踩：站上确认后，AHR 第一次收在 ≤ LINE × (1 + BAND)（BAND 0.1 → 0.495）的那天；回踩之后要再到过 ≥ 0.54 才算下一次回踩；
 *     收在 0.405 以下之后重新等突破。
 *   守住：回踩后 HOLD（90）天内 AHR 没收在 LINE × (1 − TOL) 以下（宽松）；另给严格版（没收在 LINE 以下）和
 *     “价格没跌破回踩前那段绿区的最低价”（博主说的 higher low）。
 * - 结果：回踩那天收盘买入，30 / 90 / 180 / 365 天后涨跌、365 天内最大回撤、之后 365 天 AHR 最低、之后跌回 < 0.45 的天数。
 * - 对照：所有 AHR 在 [LINE × (1 − TOL), LINE × (1 + BAND)] 的日子（不管是不是回踩），以及 2012 年起所有日子，同样的持有期。
 *   样本只有个位数，不做显著性，只列事件和比例。
 * - 现在：最新 AHR，以及当天 AHR = 0.45 / 1.2 对应的价格（解 ln AHR = (399/200) lnP − (前 199 天 ln 价之和)/200 − lnV），
 *   以及“价格一直停在这条线上”时这条线 30 / 90 天后在哪。
 *
 *   node --experimental-strip-types scripts/research-data/e45.ts <dataDir>   [环境变量 LINE LIFT BAND TOL LOOK MINBELOW HOLD NOW]
 *   NOW = 现价（可选，用来算现在的 AHR）。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const dir = process.argv[2] ?? ".";
const env = (k: string, d: string) => Number(process.env[k] ?? d);
const LINE = env("LINE", "0.45");
const LIFT = env("LIFT", "0.2");
const BAND = env("BAND", "0.1");
const TOL = env("TOL", "0.1");
const LOOK = env("LOOK", "90");
const MINBELOW = env("MINBELOW", "30");
const HOLD = env("HOLD", "90");
const NOW = process.env.NOW ? Number(process.env.NOW) : null;
const HI = LINE * (1 + LIFT), NEAR = LINE * (1 + BAND), FAIL = LINE * (1 - TOL);

type Row = { t: string; p: number };
async function load(): Promise<Row[]> {
  const f = `${dir}/cm-btc.json`;
  if (existsSync(f)) return JSON.parse(readFileSync(f, "utf8"));
  const rows: Row[] = [];
  let url: string | null = "https://community-api.coinmetrics.io/v4/timeseries/asset-metrics?assets=btc&metrics=PriceUSD&frequency=1d&page_size=10000&start_time=2010-07-18";
  while (url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`coinmetrics ${r.status}`);
    const j: any = await r.json();
    for (const x of j.data) if (x.PriceUSD) rows.push({ t: x.time.slice(0, 10), p: +x.PriceUSD });
    url = j.next_page_url ?? null;
  }
  writeFileSync(f, JSON.stringify(rows));
  return rows;
}

const rows = await load();
const n = rows.length;
const P = rows.map((r) => r.p);
const LP = P.map(Math.log);
const GENESIS = Date.UTC(2009, 0, 3);
const ageOf = (t: string) => (Date.parse(t + "T00:00:00Z") - GENESIS) / 864e5;
const lnV = (t: string) => Math.LN10 * (5.84 * Math.log10(ageOf(t)) - 17.01);
const addDays = (t: string, d: number) => new Date(Date.parse(t + "T00:00:00Z") + d * 864e5).toISOString().slice(0, 10);

const A: (number | null)[] = new Array(n).fill(null);
let s = 0;
for (let i = 0; i < n; i++) {
  s += LP[i];
  if (i >= 200) s -= LP[i - 200];
  if (i >= 199) A[i] = Math.exp(2 * LP[i] - s / 200 - lnV(rows[i].t));
}
// contiguous days check
for (let i = 1; i < n; i++) if (addDays(rows[i - 1].t, 1) !== rows[i].t) throw new Error(`gap at ${rows[i].t}`);

const f2 = (x: number | null | undefined, d = 2) => (x == null ? "—" : x.toFixed(d));
const pct = (x: number | null | undefined) => (x == null ? "—" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(0)}%`);
const money = (x: number) => (x >= 100 ? Math.round(x).toLocaleString("en-US") : x.toFixed(2));
const fwd = (i: number, h: number) => (i + h < n ? P[i + h] / P[i] - 1 : null);
const mdd = (i: number, h: number) => {
  let m = 0;
  for (let k = i + 1; k <= Math.min(n - 1, i + h); k++) m = Math.min(m, P[k] / P[i] - 1);
  return i + 1 < n ? m : null;
};
const minA = (i: number, h: number) => {
  let m = Infinity;
  for (let k = i + 1; k <= Math.min(n - 1, i + h); k++) if (A[k] != null) m = Math.min(m, A[k]!);
  return m === Infinity ? null : m;
};
const daysBelow = (i: number, h: number, lv: number) => {
  let c = 0;
  for (let k = i + 1; k <= Math.min(n - 1, i + h); k++) if (A[k]! < lv) c++;
  return c;
};

console.log(`E45 AHR999 回踩 ${LINE}（LIFT ${LIFT} → ${f2(HI, 3)}，回踩 ≤ ${f2(NEAR, 3)}，失败 < ${f2(FAIL, 3)}，之前 ${LOOK} 天里 ≥ ${MINBELOW} 天在线下，守住看 ${HOLD} 天）`);
console.log(`数据 ${rows[0].t} – ${rows[n - 1].t}，${n} 天；AHR 从 ${rows[199].t} 起\n`);

// ---- 绿区段（AHR < LINE 的连续段，相隔 < 30 天合并）
type Seg = { a: number; b: number; low: number; lowAt: number; minA: number };
const segs: Seg[] = [];
for (let i = 199; i < n; i++) {
  if (A[i]! >= LINE) continue;
  const last = segs.at(-1);
  if (last && i - last.b <= 30) { last.b = i; } else segs.push({ a: i, b: i, low: P[i], lowAt: i, minA: A[i]! });
  const g = segs.at(-1)!;
  if (P[i] < g.low) { g.low = P[i]; g.lowAt = i; }
  g.minA = Math.min(g.minA, A[i]!);
}
console.log(`绿区段（AHR < ${LINE}，相隔 30 天内合并）：`);
for (const g of segs) {
  const days = rows.slice(g.a, g.b + 1).length;
  let inZone = 0;
  for (let k = g.a; k <= g.b; k++) if (A[k]! < LINE) inZone++;
  console.log(`  ${rows[g.a].t} – ${rows[g.b].t}  ${days} 天（线下 ${inZone} 天）  最低 AHR ${f2(g.minA)}  最低价 ${money(g.low)}（${rows[g.lowAt].t}）`);
}

// ---- 突破 / 回踩 状态机
type Ev = { kind: "breakout" | "fail" | "retest"; i: number; extra?: string; brk?: number; zoneLow?: number; zoneLowAt?: number; n?: number };
const evs: Ev[] = [];
let state: "idle" | "brk" | "up" | "retested" = "idle";
let brkAt = -1, zoneLow = Infinity, zoneLowAt = -1, retN = 0;
for (let i = 200; i < n; i++) {
  const a = A[i]!, prev = A[i - 1]!;
  if (state !== "idle" && a < FAIL) {
    if (state === "brk") evs.push({ kind: "fail", i, brk: brkAt });
    state = "idle";
  }
  if (state === "idle") {
    if (a >= LINE && prev < LINE) {
      let below = 0, lo = Infinity, loAt = -1;
      for (let k = Math.max(199, i - LOOK); k < i; k++) if (A[k]! < LINE) below++;
      // 回踩前那段绿区的最低价：之前 365 天内 AHR < LINE 的日子里的最低价
      for (let k = Math.max(199, i - 365); k < i; k++) if (A[k]! < LINE && P[k] < lo) { lo = P[k]; loAt = k; }
      if (below >= MINBELOW) {
        state = "brk"; brkAt = i; zoneLow = lo; zoneLowAt = loAt; retN = 0;
        evs.push({ kind: "breakout", i, extra: `之前 ${LOOK} 天里 ${below} 天在线下` });
      }
    }
    continue;
  }
  if ((state === "brk" || state === "retested") && a >= HI) { state = "up"; continue; }
  if (state === "up" && a <= NEAR) {
    retN++;
    evs.push({ kind: "retest", i, brk: brkAt, zoneLow, zoneLowAt, n: retN });
    state = "retested";
  }
}

console.log(`\n突破与回踩（回踩那天收盘买入；HOLD 天内 AHR 最低、价格最大回撤；“破低”= 之后 365 天价格跌破回踩前那段绿区的最低价）：`);
const retests = evs.filter((e) => e.kind === "retest");
for (const e of evs) {
  if (e.kind === "breakout") { console.log(`\n▶ 突破 ${rows[e.i].t}  价 ${money(P[e.i])}  AHR ${f2(A[e.i])}（${e.extra}）`); continue; }
  if (e.kind === "fail") { console.log(`  ✕ 突破失败：没到 ${f2(HI)} 就收在 ${f2(FAIL)} 以下 ${rows[e.i].t}  价 ${money(P[e.i])}`); continue; }
  const i = e.i;
  const ma = minA(i, HOLD), ma365 = minA(i, 365);
  const heldLoose = ma != null && i + HOLD < n ? ma >= FAIL : null;
  const heldStrict = ma != null && i + HOLD < n ? ma >= LINE : null;
  let brokeLow: boolean | null = null, brokeAt = "";
  if (i + 1 < n) {
    brokeLow = false;
    for (let k = i + 1; k <= Math.min(n - 1, i + 365); k++) if (P[k] < e.zoneLow!) { brokeLow = true; brokeAt = rows[k].t; break; }
    if (!brokeLow && i + 365 >= n) brokeLow = null;
  }
  console.log(`  ↘ 第 ${e.n} 次回踩 ${rows[i].t}  价 ${money(P[i])}  AHR ${f2(A[i])}`
    + `  | 30 天 ${pct(fwd(i, 30))}  90 天 ${pct(fwd(i, 90))}  180 天 ${pct(fwd(i, 180))}  365 天 ${pct(fwd(i, 365))}`
    + `  | ${HOLD} 天内 AHR 最低 ${f2(ma)}、最大回撤 ${pct(mdd(i, HOLD))}；365 天内 AHR 最低 ${f2(ma365)}、回撤 ${pct(mdd(i, 365))}、线下 ${daysBelow(i, 365, LINE)} 天`
    + `  | 守住（宽松 / 严格）${heldLoose == null ? "—" : heldLoose ? "是" : "否"} / ${heldStrict == null ? "—" : heldStrict ? "是" : "否"}`
    + `  | 绿区最低 ${money(e.zoneLow!)}（${rows[e.zoneLowAt!].t}）${brokeLow == null ? " 破低 —" : brokeLow ? ` 破低：${brokeAt}` : " 没破低"}`);
}

const done = retests.filter((e) => e.i + HOLD < n);
// 筑底后一年内的回踩（博主说的那种）和之后的（牛市结束往下走的时候路过 0.45）分开
for (const [name, pick] of [["突破后一年内的回踩（筑底后）", (e: Ev) => e.i - e.brk! <= 365], ["突破一年以后的回踩（牛市后往下走路过）", (e: Ev) => e.i - e.brk! > 365]] as const) {
  const g = done.filter(pick);
  const l = g.filter((e) => minA(e.i, HOLD)! >= FAIL).length, st = g.filter((e) => minA(e.i, HOLD)! >= LINE).length;
  console.log(`  ${name}：${g.length} 次，${HOLD} 天内没跌破 ${f2(FAIL, 3)} ${l} 次、没跌破 ${LINE} ${st} 次：${g.map((e) => rows[e.i].t + (minA(e.i, HOLD)! >= FAIL ? "✓" : "✕")).join(" ")}`);
}
const loose = done.filter((e) => minA(e.i, HOLD)! >= FAIL).length;
const strict = done.filter((e) => minA(e.i, HOLD)! >= LINE).length;
console.log(`\n汇总：突破 ${evs.filter((e) => e.kind === "breakout").length} 次，突破失败 ${evs.filter((e) => e.kind === "fail").length} 次，回踩 ${retests.length} 次（${HOLD} 天已走完 ${done.length} 次）`);
console.log(`  ${HOLD} 天内 AHR 没跌破 ${f2(FAIL, 3)}（宽松）：${loose}/${done.length}；没跌破 ${LINE}（严格）：${strict}/${done.length}`);
const med = (xs: number[]) => { const v = [...xs].sort((a, b) => a - b); return v.length ? (v.length % 2 ? v[(v.length - 1) >> 1] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) : null; };
for (const h of [30, 90, 180, 365]) {
  const r = retests.map((e) => fwd(e.i, h)).filter((x): x is number => x != null);
  const up = r.filter((x) => x > 0).length;
  // 对照：AHR 在 [FAIL, NEAR] 的所有日子；2012 年起所有日子
  const band: number[] = [], all: number[] = [];
  for (let i = 199; i + h < n; i++) {
    if (rows[i].t < "2012-01-01") continue;
    const x = fwd(i, h)!;
    all.push(x);
    if (A[i]! >= FAIL && A[i]! <= NEAR) band.push(x);
  }
  const upB = band.filter((x) => x > 0).length / band.length, upA = all.filter((x) => x > 0).length / all.length;
  console.log(`  ${String(h).padStart(3)} 天后：回踩 ${r.length} 次上涨 ${up} 次、中位 ${pct(med(r))}  | 对照 AHR 在 ${f2(FAIL, 3)}–${f2(NEAR, 3)} 的 ${band.length} 天：上涨 ${(upB * 100).toFixed(0)}%、中位 ${pct(med(band))}  | 2012 年起所有 ${all.length} 天：上涨 ${(upA * 100).toFixed(0)}%、中位 ${pct(med(all))}`);
}

// ---- 0.45 附近的“支撑”：所有从上方第一次碰到 [LINE, NEAR] 的日子（不要求之前在绿区筑底），之后是否 HOLD 天内跌破 FAIL
{
  let armed = false, touches = 0, broke = 0;
  const list: string[] = [];
  for (let i = 200; i < n; i++) {
    const a = A[i]!;
    if (a >= HI) armed = true;
    if (armed && a <= NEAR) {
      armed = false;
      if (i + HOLD >= n) { list.push(`${rows[i].t}(未走完)`); continue; }
      touches++;
      const b = minA(i, HOLD)! < FAIL;
      if (b) broke++;
      list.push(`${rows[i].t}${b ? "✕" : "✓"}`);
    }
  }
  console.log(`\n不管之前有没有在绿区筑底：AHR 从 ≥ ${f2(HI)} 第一次回到 ≤ ${f2(NEAR, 3)} 共 ${touches} 次（已走完），${HOLD} 天内跌破 ${f2(FAIL, 3)} 的 ${broke} 次（✓ 守住 ✕ 跌破）：`);
  console.log("  " + list.join("  "));
}

// ---- 现在
const L = n - 1;
const s199 = LP.slice(L - 198, L + 1).reduce((a, b) => a + b, 0); // 明天之前的 199 天（含最后一天）
const priceAt = (target: number, t: string, sum199: number) => Math.exp((Math.log(target) + sum199 / 200 + lnV(t)) * 200 / 399);
const s199Today = LP.slice(L - 199, L).reduce((a, b) => a + b, 0); // 最后一天之前的 199 天
console.log(`\n现在：${rows[L].t} 收盘 ${money(P[L])}，AHR ${f2(A[L], 3)}；200 日几何均价 ${money(Math.exp(LP.slice(L - 199, L + 1).reduce((a, b) => a + b, 0) / 200))}，币龄估值 ${money(Math.exp(lnV(rows[L].t)))}`);
for (const tg of [LINE, NEAR, HI, 1.2]) console.log(`  ${rows[L].t} 当天 AHR = ${tg} 对应价格 ${money(priceAt(tg, rows[L].t, s199Today))}`);
const tNext = addDays(rows[L].t, 1);
for (const tg of [LINE, 1.2]) console.log(`  ${tNext} 当天 AHR = ${tg} 对应价格 ${money(priceAt(tg, tNext, s199))}`);
if (NOW) {
  const a = Math.exp((399 / 200) * Math.log(NOW) - s199 / 200 - lnV(tNext));
  console.log(`  现价 ${money(NOW)} 按 ${tNext} 算 AHR ${f2(a, 3)}`);
}
// 价格一直停在 0.45 线上时，这条线怎么走
{
  const lp = LP.slice();
  const dates = rows.map((r) => r.t);
  const marks: string[] = [];
  for (let d = 1; d <= 180; d++) {
    const t = addDays(dates.at(-1)!, 1);
    const sum = lp.slice(lp.length - 199).reduce((a, b) => a + b, 0);
    const p = priceAt(LINE, t, sum);
    lp.push(Math.log(p)); dates.push(t);
    if ([7, 30, 60, 90, 180].includes(d)) marks.push(`${t} ${money(p)}`);
  }
  console.log(`  价格一直停在 ${LINE} 线上时这条线的位置：${marks.join("；")}`);
}
// 最近一年的 AHR 走势（每周一个）
console.log(`\n最近 400 天 AHR（每 7 天一个，含价格）：`);
const wk: string[] = [];
for (let i = L - 399; i <= L; i += 7) wk.push(`${rows[i].t.slice(2)} ${f2(A[i])} ${money(P[i])}`);
for (let k = 0; k < wk.length; k += 4) console.log("  " + wk.slice(k, k + 4).join("  |  "));
