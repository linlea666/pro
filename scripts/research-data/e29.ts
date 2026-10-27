/**
 * E29：日线 CVD 顶背离做空（@laogoxx 推文的规则）。规则在跑之前定好：
 *
 * - 数据：Binance 永续日线（UTC 0 点开盘），主动买入成交额 tbqv，Delta = 2·tbqv − 成交额，CVD = Delta 的累计；
 *   现货 CVD 同样算法用现货日线。CVD 的起点不影响背离：两个点之间 CVD 高低 = 这段时间 Delta 之和的正负。
 * - 摆动高点：第 i 天的最高价高于左边 P 天、且不低于右边 P 天（P 默认 3），第 i+P 天收盘才确认（不偷看）。
 *   摆动低点对称。
 * - 顶背离：新确认的摆动高点 i 与前高 j 比（MODE=peak：回看 5–LB 天里最高的摆动高点，LB 默认 60；
 *   MODE=last：紧挨着的上一个摆动高点），最高价更高，CVD 更低
 *   （(j, i] 的 Delta 之和 < 0）。底背离：摆动低点最低价更低、CVD 更高。
 *   SRC 选用哪条 CVD：perp（合约，默认）/ spot（现货）/ both（两条都背离）/ sum（合约 + 现货）/ none（不看 CVD，对照用）。
 * - 做空：顶背离确认那天的下一天开盘入场；止损 = 背离的那个高点 + 500 美元（ETH 按入场时 BTC 的同等比例），
 *   盘中最高价碰到就按止损价出（跳空按开盘价）；之后第一次确认底背离，在下一天开盘平仓（止盈，赚亏都平）。
 *   持仓中出现的新顶背离不加仓；不设最长持有期（MAXH 可选）。
 * - 成本：来回 0.15%（同 stats.ts），空单收付持仓期间的资金费率（为正时空单收钱）。
 * - R = 入场到止损的距离。对照：每笔交易配 50 个随机做空（同一段时间里任意一天开盘入场、同止损百分比、
 *   持有同样天数或先止损），另给同段时间一直持有现货的涨跌。
 * - 切分：2020-01-01 起；样本外 = 2025-10-25 之后（最近 12 个月），样本内再分前后两半。
 * - “坚持 1 个月”：从每一天开始照做 30 天（只做这 30 天里出现的信号，到期按收盘价平），看赚钱的比例。
 *
 *   node --experimental-strip-types scripts/research-data/e29.ts <dataDir>   [环境变量 P / LB / SRC / STOP / MAXH]
 */
import { readFileSync } from "node:fs";

const dir = process.argv[2];
const P = Number(process.env.P ?? 3);
const LB = Number(process.env.LB ?? 60);
const SRC = process.env.SRC ?? "perp";
const STOP = Number(process.env.STOP ?? 500);
const MAXH = Number(process.env.MAXH ?? 0);
const MODE = process.env.MODE ?? "peak";
const COST = 0.0015;
const START = Date.UTC(2020, 0, 1) / 1000;
const OOS = Date.UTC(2025, 9, 25) / 1000;
const DAY = 86400;

type Bar = { t: number; o: number; h: number; l: number; c: number; dp: number; ds: number };
type Trade = { coin: string; ei: number; xi: number; entry: number; stop: number; exit: number; why: string; r: number; pct: number; fund: number };

function load(coin: string) {
  const j = JSON.parse(readFileSync(`${dir}/e29/${coin}.json`, "utf8"));
  const spot = new Map<number, number>(j.spot.map((r: number[]) => [r[0], 2 * r[6] - r[5]]));
  const bars: Bar[] = j.perp.map((r: number[]) => ({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], dp: 2 * r[6] - r[5], ds: spot.get(r[0]) ?? NaN }));
  // 每天的资金费率之和（结算时刻落在这天里）
  const fund = new Map<number, number>();
  for (const [t, f] of j.funding as number[][]) {
    const d = Math.floor(t / DAY) * DAY;
    fund.set(d, (fund.get(d) ?? 0) + f);
  }
  return { bars, fund };
}

function deltaSum(b: Bar[], j: number, i: number, key: "dp" | "ds") {
  let s = 0;
  for (let k = j + 1; k <= i; k++) s += b[k][key];
  return s;
}

function diverges(b: Bar[], j: number, i: number, sign: number) {
  // sign = -1：顶背离要 CVD 更低；+1：底背离要 CVD 更高
  const p = deltaSum(b, j, i, "dp"), s = deltaSum(b, j, i, "ds");
  if (SRC === "perp") return sign * p > 0;
  if (SRC === "spot") return sign * s > 0;
  if (SRC === "none") return true; // 不看 CVD：只要价格创新高（新低）就算
  if (SRC === "both") return sign * p > 0 && sign * s > 0;
  return sign * (p + s) > 0;
}

/** 第 k 天收盘确认的背离（k = 摆动点 + P），返回摆动点下标或 -1 */
function signals(b: Bar[]) {
  const top = new Map<number, number>(), bottom = new Map<number, number>();
  const isHigh = (i: number) => {
    for (let k = i - P; k < i; k++) if (b[k].h >= b[i].h) return false;
    for (let k = i + 1; k <= i + P; k++) if (b[k].h > b[i].h) return false;
    return true;
  };
  const isLow = (i: number) => {
    for (let k = i - P; k < i; k++) if (b[k].l <= b[i].l) return false;
    for (let k = i + 1; k <= i + P; k++) if (b[k].l < b[i].l) return false;
    return true;
  };
  // MODE=peak（默认）：和回看 LB 天内最高（最低）的那个摆动点比，即“价格越过前高”，和 Coinglass 图上画的一致；
  // MODE=last：和紧挨着的上一个摆动点比。
  const highs: number[] = [], lows: number[] = [];
  const prev = (list: number[], i: number, better: (a: number, b: number) => boolean) => {
    const c = list.filter((j) => i - j >= 5 && i - j <= LB);
    if (!c.length) return -1;
    if (MODE === "last") return list[list.length - 1] === c[c.length - 1] ? c[c.length - 1] : -1;
    return c.reduce((a, j) => (better(j, a) ? j : a));
  };
  for (let i = P; i + P < b.length; i++) {
    if (isHigh(i)) {
      const j = prev(highs, i, (x, y) => b[x].h > b[y].h);
      if (j >= 0 && b[i].h > b[j].h && diverges(b, j, i, -1)) top.set(i + P, i);
      highs.push(i);
    }
    if (isLow(i)) {
      const j = prev(lows, i, (x, y) => b[x].l < b[y].l);
      if (j >= 0 && b[i].l < b[j].l && diverges(b, j, i, +1)) bottom.set(i + P, i);
      lows.push(i);
    }
  }
  return { top, bottom };
}

/** 从 ei 开盘做空，止损 stop，exitAt(k) 为真就在 k+1 开盘平；返回出场下标、价、原因 */
function walk(b: Bar[], ei: number, stop: number, exitAt: (k: number) => boolean, endI = b.length - 1) {
  for (let k = ei; k <= endI; k++) {
    if (b[k].h >= stop) return { xi: k, exit: Math.max(stop, b[k].o), why: "止损" };
    if (k < endI && exitAt(k)) return { xi: k + 1, exit: b[k + 1].o, why: "底背离" };
  }
  return { xi: endI, exit: b[endI].c, why: "到期" };
}

function settle(coin: string, b: Bar[], fund: Map<number, number>, ei: number, stop: number, w: { xi: number; exit: number; why: string }): Trade {
  const entry = b[ei].o;
  let f = 0;
  for (let k = ei; k <= w.xi; k++) f += fund.get(b[k].t) ?? 0;
  const pct = (entry - w.exit) / entry - COST + f;
  return { coin, ei, xi: w.xi, entry, stop, exit: w.exit, why: w.why, r: (pct * entry) / (stop - entry), pct, fund: f };
}

function run(coin: string, b: Bar[], fund: Map<number, number>, btcRatio: (t: number) => number, from: number, to: number, endI = b.length - 1) {
  const { top, bottom } = signals(b);
  const trades: Trade[] = [];
  let busyTill = -1;
  for (let k = 0; k + 1 <= endI; k++) {
    const pi = top.get(k);
    if (pi === undefined || k + 1 <= busyTill || b[k + 1].t < from || b[k + 1].t >= to) continue;
    const ei = k + 1;
    const stop = b[pi].h + STOP * btcRatio(b[ei].t);
    if (b[ei].o >= stop) continue;
    const w = walk(b, ei, stop, (x) => bottom.has(x) || (MAXH > 0 && x - ei + 1 >= MAXH), endI);
    const t = settle(coin, b, fund, ei, stop, w);
    trades.push(t);
    busyTill = t.xi;
  }
  return trades;
}

// 简单的可复现随机数
let seed = 29;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

function randomR(b: Bar[], fund: Map<number, number>, t: Trade, lo: number, hi: number) {
  const dist = (t.stop - t.entry) / t.entry, hold = t.xi - t.ei;
  const out: number[] = [];
  for (let n = 0; n < 50; n++) {
    const ei = lo + Math.floor(rnd() * Math.max(1, hi - lo - hold));
    if (ei + hold >= b.length) continue;
    const stop = b[ei].o * (1 + dist);
    const w = walk(b, ei, stop, (k) => k >= ei + hold - 1, Math.min(b.length - 1, ei + hold));
    out.push(settle("", b, fund, ei, stop, w).r);
  }
  return out.reduce((s, x) => s + x, 0) / out.length;
}

const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const sd = (a: number[]) => {
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1));
};
const f2 = (x: number) => (Number.isFinite(x) ? (x >= 0 ? "+" : "") + x.toFixed(2) : "—");
const pc = (x: number) => (Number.isFinite(x) ? (x >= 0 ? "+" : "") + (x * 100).toFixed(1) + "%" : "—");
const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);

const data = { BTC: load("BTC"), ETH: load("ETH") };
const btc = data.BTC.bars;
const btcByT = new Map(btc.map((x) => [x.t, x.o]));

console.log(`E29 日线 CVD 背离做空  P=${P} LB=${LB} SRC=${SRC} MODE=${MODE} STOP=${STOP}${MAXH ? ` MAXH=${MAXH}` : ""}  成本 0.15% + 资金费率`);
const IS_MID = START + (OOS - START) / 2;
const segs: [string, number, number][] = [
  ["全部 2020-01 起", START, Infinity],
  ["样本内前半", START, IS_MID],
  ["样本内后半", IS_MID, OOS],
  ["样本外（最近 12 个月）", OOS, Infinity],
];
const all: Record<string, Trade[]> = {};
for (const coin of ["BTC", "ETH"] as const) {
  const { bars, fund } = data[coin];
  const ratioMap = new Map(bars.map((x) => [x.t, coin === "BTC" ? 1 : x.o / (btcByT.get(x.t) ?? x.o)]));
  all[coin] = run(coin, bars, fund, (t) => ratioMap.get(t) ?? NaN, START, Infinity);
}

for (const [name, lo, hi] of segs) {
  console.log(`\n== ${name} ==`);
  console.log("币   笔数  胜率   平均R   随机R   差R    t     中位持有  止损/底背离/到期  平均每笔   资金费  同期持有");
  for (const coin of ["BTC", "ETH"] as const) {
    const { bars, fund } = data[coin];
    const ts = all[coin].filter((t) => bars[t.ei].t >= lo && bars[t.ei].t < hi);
    const loI = bars.findIndex((x) => x.t >= lo), hiI = hi === Infinity ? bars.length : bars.findIndex((x) => x.t >= hi);
    const rs = ts.map((t) => t.r), rr = ts.map((t) => randomR(bars, fund, t, loI, hiI));
    const diff = rs.map((x, k) => x - rr[k]);
    const tstat = mean(diff) / (sd(diff) / Math.sqrt(diff.length));
    const holds = ts.map((t) => t.xi - t.ei + 1).sort((a, b) => a - b);
    const why = ["止损", "底背离", "到期"].map((w) => ts.filter((t) => t.why === w).length).join("/");
    const hold = (bars[hiI - 1].c - bars[loI].o) / bars[loI].o;
    console.log(
      `${coin}  ${String(ts.length).padStart(4)}  ${pc(ts.filter((t) => t.r > 0).length / ts.length).padStart(6)}  ${f2(mean(rs)).padStart(6)}  ${f2(mean(rr)).padStart(6)}  ${f2(mean(diff)).padStart(6)}  ${f2(tstat).padStart(5)}  ${String(holds[Math.floor(holds.length / 2)] ?? "—").padStart(6)} 天  ${why.padStart(10)}       ${pc(mean(ts.map((t) => t.pct))).padStart(7)}  ${pc(mean(ts.map((t) => t.fund))).padStart(6)}  ${pc(hold).padStart(8)}`,
    );
  }
}

// 每笔交易清单（BTC）
console.log("\n== BTC 每笔（入场日 = 背离确认后一天开盘） ==");
for (const t of all.BTC) {
  const b = data.BTC.bars;
  console.log(`${day(b[t.ei].t)} 入 ${t.entry.toFixed(0)} 止损 ${t.stop.toFixed(0)}（${pc((t.stop - t.entry) / t.entry)}）→ ${day(b[t.xi].t)} ${t.why === "到期" ? "仍持有，按最新收盘" : t.why} ${t.exit.toFixed(0)}  ${f2(t.r)}R ${pc(t.pct)}`);
}

// 按每笔固定风险 1% 算：累计、最大回撤、最长连亏、去掉最好两笔
console.log("\n== 每笔亏到止损 = 本金 1% 时 ==");
for (const coin of ["BTC", "ETH"] as const) {
  const rs = all[coin].map((t) => t.r);
  let eq = 0, peak = 0, dd = 0, streak = 0, worst = 0;
  for (const r of rs) {
    eq += r;
    peak = Math.max(peak, eq);
    dd = Math.min(dd, eq - peak);
    streak = r < 0 ? streak + 1 : 0;
    worst = Math.max(worst, streak);
  }
  const top2 = [...rs].sort((a, b) => b - a).slice(0, 2);
  console.log(`${coin}：累计 ${f2(eq)}%（${rs.length} 笔），最大回撤 ${f2(dd)}%，最长连亏 ${worst} 笔，最好两笔 ${top2.map(f2).join(" / ")}R，去掉这两笔累计 ${f2(eq - top2[0] - top2[1])}%`);
}

// “坚持 1 个月”
console.log("\n== 从任意一天开始照做 30 天（只做这 30 天里出现的信号，到期按收盘平） ==");
for (const coin of ["BTC", "ETH"] as const) {
  const { bars, fund } = data[coin];
  const ratioMap = new Map(bars.map((x) => [x.t, coin === "BTC" ? 1 : x.o / (btcByT.get(x.t) ?? x.o)]));
  let win = 0, lose = 0, none = 0;
  const pnl: number[] = [];
  const s0 = bars.findIndex((x) => x.t >= START);
  for (let s = s0; s + 30 < bars.length; s++) {
    const ts = run(coin, bars, fund, (t) => ratioMap.get(t) ?? NaN, bars[s].t, bars[s + 30].t, s + 29);
    if (!ts.length) {
      none++;
      continue;
    }
    const p = ts.reduce((a, t) => a + t.pct, 0);
    pnl.push(p);
    if (p > 0) win++;
    else lose++;
  }
  const n = win + lose + none;
  pnl.sort((a, b) => a - b);
  console.log(`${coin}：${n} 个起点，没出信号 ${pc(none / n)}，赚 ${pc(win / n)}，亏 ${pc(lose / n)}；有交易的 30 天收益中位 ${pc(pnl[Math.floor(pnl.length / 2)])}，最差 ${pc(pnl[0])}`);
}
