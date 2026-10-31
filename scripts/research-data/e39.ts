/**
 * E39（2026-10-31）：威科夫区间事件。用户看到竞品的“威科夫”页签（交易区间上下沿 + SC 等事件点），选了“完整威科夫页签”，
 * 上页面之前先测每个事件按字面去做有没有优势。吸筹那套（SC → 区间 → 量减扫低 → 站上区间高点）E30 已测过，
 * 这次补全：ST、LPS、派发一侧（BC / ST / UTAD / SOW / LPSY），并加上 1 小时。
 *
 *   node --experimental-strip-types scripts/research-data/e39.ts <dataDir>   [环境变量 TFS=1h,4h,1d / EXIT=chand|2r / WICK / DROP / VOLX / M]
 * 数据：e30-fetch.ts（<dataDir>/e30/<COIN>.json 的 d1、h4、funding）和 e31-fetch.ts（<dataDir>/e31/<COIN>.json 的 h1）。
 *
 * 跑之前定好的规则（看结果之前写下，不再改）：
 * - Binance 永续，10 个研究币，2020-01-01 起；样本外 = 2025-10-30 之后，样本内再分前后两半。ATR = 14 根 Wilder，量 = 成交额，
 *   均量 = 前 20 根。同 E30。
 * - 高潮（阶段 A 的开始）：SC = 创前 LOOK（60）根最低价，收盘比前 LOOK 根最高价低至少 DROP（6）倍 ATR，成交额 ≥ VOLX（2）倍均量，
 *   下影线 ≥ 1/3 根长（WICK=0 时不要求）。BC 镜像（创新高、收盘比最低价高 6 ATR、放量、上影线 ≥ 1/3）。
 * - 区间（TR）：SC 的区间下沿 RL = SC 最低价，上沿 RH = 之后 M（10）根的最高价（AR，自动反弹）；第 c+M 根收盘后才知道。
 *   RH − RL < 2 ATR 的不算。BC 镜像：上沿 = BC 最高价，下沿 = 之后 10 根最低价（自动回落）。一个币同时只看一个区间，最长 W（120）根。
 *   吸筹区间的结局：向上（SOS）= 收盘 > RH（c+M 之后）；失败 = 收盘 < RL − 0.5 ATR，或连续两根收盘 < RL。派发镜像。
 * - 事件和交易（都在确认那根收盘后、下一根开盘入场；止损到入场的距离要在 0.3–8 倍 ATR，同计划页，否则不做）：
 *   吸筹（做多）
 *   A1 SC 就接：SC 下一根开盘做多，止损 SC 最低价 − 0.2 ATR。（新手看到“SC”最可能做的事）
 *      第一次跑时只在“之后 10 根形成区间”的 SC 上开仓，偷看了未来（+0.2~0.3R 全来自这里），改成每个 SC 收盘就开；规则本身没变。
 *   A2 ST 二次测试：c+M 之后第一次从上方回到下沿 0.5 ATR 内（上一根最低价还在 RL + 0.5 ATR 之上），这根最低价没破 RL，
 *      成交额 < SC 那根；之前没有扫低。止损 RL − 0.2 ATR。
 *   A3 Spring：最低价 < RL、这根或下一根收盘回到 RL 之上、成交额 < SC 那根（= E30 L2）。止损 扫低最低价 − 0.2 ATR。每个区间只做第一次。
 *   A4 SOS 全部：第一次收盘 > RH。止损 SC 以来最低价 − 0.2 ATR。
 *   A5 SOS 且之前有 Spring（= E30 L1，比 A4 好才说明 Spring 有用）。
 *   A6 LPS：SOS 之后 30 根内，第一次回到 RH + 0.5 ATR 以内（期间没有收盘 < RH − 0.5 ATR，否则作废），
 *      之后第一次收盘高于回踩开始那根的最高价且在 RH 之上 → 做多；止损 回踩以来最低价 − 0.2 ATR。
 *   派发（做空）：D1 BC 就空、D2 ST、D3 UTAD（冲高没站稳）、D4 SOW 全部、D5 SOW 且之前有 UTAD、D6 LPSY，全部镜像。
 * - 离场 EXIT=chand（默认，同 E30）：3 倍 ATR 吊灯（按入场前一根 ATR，收盘后移动），最长 120 根；EXIT=2r：固定 2R 止盈，最长 60 根。
 *   同一根先算止损，跳空按开盘价成交。成本来回 0.15% + 持仓期资金费率。R = 入场到止损的距离。
 * - 样本不重叠：同一币、同一行、上一笔没出场之前不开新的一笔。
 * - 对照：每笔配 50 个随机入场（同币、2020 年起任一根开盘、同方向、同 ATR 倍数止损、同一种离场）。
 * - 判定（同 engine.ts 的 judge）：样本内 10 个币对随机 ≥ +0.1R、所有周期所有行一起 BH 校正后 q < 0.05、
 *   BTC、ETH、样本内前后两半、样本外方向都和整体一致，才算“有优势”。p 值用正态近似。
 * - 描述（不判优势）：每年几个区间、处在区间里的 K 线占比、区间结局；区间里收盘在下 / 中 / 上三分之一之后 10 / 30 根的涨跌
 *   （ATR 倍数）对照区间里所有 K 线。
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";

const dir = process.argv[2];
const TFS = (process.env.TFS ?? "1h,4h,1d").split(",");
const LOOK = Number(process.env.LOOK ?? 60);
const DROP = Number(process.env.DROP ?? 6);
const VOLX = Number(process.env.VOLX ?? 2);
const WICK = Number(process.env.WICK ?? 1);
const M = Number(process.env.M ?? 10);
const W = Number(process.env.W ?? 120);
const EXIT = process.env.EXIT ?? "chand";
const COST = 0.0015;
const START = Date.UTC(2020, 0, 1) / 1000;
const OOS = Date.UTC(2025, 9, 30) / 1000;
const MID = START + (OOS - START) / 2;

type Bar = { t: number; o: number; h: number; l: number; c: number; v: number; atr: number; vma: number };
type Trade = { coin: string; row: string; ei: number; xi: number; entry: number; stop: number; exit: number; r: number; riskAtr: number; dir: 1 | -1; rand?: number };
type TR = { coin: string; c: number; arm: number; end: number; acc: boolean; outcome: "out" | "fail" | "timeout"; RL: number; RH: number };

const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const sd = (a: number[]) => {
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1));
};
/** 双侧 p，正态近似 */
function pval(t: number) {
  if (!Number.isFinite(t)) return 1;
  const z = Math.abs(t) / Math.SQRT2;
  const k = 1 / (1 + 0.3275911 * z);
  const erf = 1 - ((((1.061405429 * k - 1.453152027) * k + 1.421413741) * k - 0.284496736) * k + 0.254829592) * k * Math.exp(-z * z);
  return 1 - erf;
}

function load(coin: string, tf: string) {
  const j30 = JSON.parse(readFileSync(`${dir}/e30/${coin}.json`, "utf8"));
  let rows: number[][];
  if (tf === "1h") {
    const p = `${dir}/e31/${coin}.json`;
    rows = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")).h1 : [];
  } else rows = tf === "4h" ? j30.h4 : j30.d1;
  const b: Bar[] = rows.map((r) => ({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5], atr: NaN, vma: NaN }));
  let atr = NaN, trSum = 0, vSum = 0;
  for (let i = 0; i < b.length; i++) {
    if (i >= 1) {
      const tr = Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c));
      if (i <= 14) trSum += tr;
      atr = i < 14 ? NaN : i === 14 ? trSum / 14 : (atr * 13 + tr) / 14;
      b[i].atr = atr;
    }
    if (i >= 20) {
      b[i].vma = vSum / 20;
      vSum -= b[i - 20].v;
    }
    vSum += b[i].v;
  }
  const fund = new Map<number, number>();
  const step = tf === "1h" ? 3600 : tf === "4h" ? 14400 : 86400;
  for (const [t, f] of j30.funding as number[][]) {
    const k = Math.floor(t / step) * step;
    fund.set(k, (fund.get(k) ?? 0) + f);
  }
  return { b, fund };
}

function walk(b: Bar[], ei: number, d: 1 | -1, stop0: number) {
  const a = b[ei - 1].atr;
  const entry = b[ei].o;
  const target = entry + d * 2 * Math.abs(entry - stop0);
  let stop = stop0, ext = entry;
  const maxI = Math.min(b.length - 1, ei + (EXIT === "2r" ? 59 : 119));
  for (let k = ei; k <= maxI; k++) {
    if (d === 1 ? b[k].l <= stop : b[k].h >= stop) return { xi: k, exit: d === 1 ? Math.min(stop, b[k].o) : Math.max(stop, b[k].o) };
    if (EXIT === "2r") {
      if (d === 1 ? b[k].h >= target : b[k].l <= target) return { xi: k, exit: d === 1 ? Math.max(target, b[k].o) : Math.min(target, b[k].o) };
    } else {
      ext = d === 1 ? Math.max(ext, b[k].h) : Math.min(ext, b[k].l);
      const s = ext - d * 3 * a;
      stop = d === 1 ? Math.max(stop, s) : Math.min(stop, s);
    }
  }
  return { xi: maxI, exit: b[maxI].c };
}

function settle(coin: string, row: string, b: Bar[], fund: Map<number, number>, ei: number, d: 1 | -1, stop: number): Trade {
  const w = walk(b, ei, d, stop);
  const entry = b[ei].o;
  let f = 0;
  for (let k = ei; k <= w.xi; k++) f += fund.get(b[k].t) ?? 0;
  const pct = (d * (w.exit - entry)) / entry - COST - d * f;
  const risk = Math.abs(entry - stop);
  return { coin, row, ei, xi: w.xi, entry, stop, exit: w.exit, r: (pct * entry) / risk, riskAtr: risk / b[ei - 1].atr, dir: d };
}

/** 一个币一个周期：找区间、记事件、开交易 */
function scan(coin: string, b: Bar[], fund: Map<number, number>) {
  const trades: Trade[] = [];
  const trs: TR[] = [];
  const lastExit = new Map<string, number>();
  const open = (row: string, ei: number, d: 1 | -1, stop: number) => {
    if (ei >= b.length - 1 || b[ei].t < START || !(b[ei - 1].atr > 0)) return;
    if ((lastExit.get(row) ?? -1) >= ei) return;
    const risk = Math.abs(b[ei].o - stop) / b[ei - 1].atr;
    if (risk < 0.3 || risk > 8 || (d === 1 ? stop >= b[ei].o : stop <= b[ei].o)) return;
    const t = settle(coin, row, b, fund, ei, d, stop);
    lastExit.set(row, t.xi);
    trades.push(t);
  };
  // A1 / D1：高潮那根收盘就知道，不能等之后 M 根看区间成不成立（那是偷看未来），所以单独扫一遍每个高潮
  for (let i = LOOK + 20; i < b.length - 2; i++) {
    const x = b[i];
    let hi = -Infinity, lo = Infinity;
    for (let k = i - LOOK; k < i; k++) (hi = Math.max(hi, b[k].h)), (lo = Math.min(lo, b[k].l));
    const vol = x.v >= VOLX * x.vma;
    const rng = x.h - x.l;
    if (x.l < lo && hi - x.c >= DROP * x.atr && vol && (!WICK || Math.min(x.o, x.c) - x.l >= rng / 3)) open("A1", i + 1, 1, x.l - 0.2 * x.atr);
    else if (x.h > hi && x.c - lo >= DROP * x.atr && vol && (!WICK || x.h - Math.max(x.o, x.c) >= rng / 3)) open("D1", i + 1, -1, x.h + 0.2 * x.atr);
  }
  let i = LOOK + 20;
  while (i < b.length - M - 2) {
    const x = b[i];
    let hi = -Infinity, lo = Infinity;
    for (let k = i - LOOK; k < i; k++) (hi = Math.max(hi, b[k].h)), (lo = Math.min(lo, b[k].l));
    const vol = x.v >= VOLX * x.vma;
    const rng = x.h - x.l;
    const sc = x.l < lo && hi - x.c >= DROP * x.atr && vol && (!WICK || Math.min(x.o, x.c) - x.l >= rng / 3);
    const bc = !sc && x.h > hi && x.c - lo >= DROP * x.atr && vol && (!WICK || x.h - Math.max(x.o, x.c) >= rng / 3);
    if (!sc && !bc) {
      i++;
      continue;
    }
    const d: 1 | -1 = sc ? 1 : -1;
    // 区间：吸筹以 SC 最低价为下沿、之后 M 根最高价为上沿；派发镜像。用“离高潮那一边” E（极端边）和“对面” O 写成方向无关
    const E = sc ? x.l : x.h;
    let O = sc ? -Infinity : Infinity;
    for (let k = i + 1; k <= i + M; k++) O = sc ? Math.max(O, b[k].h) : Math.min(O, b[k].l);
    if (Math.abs(O - E) < 2 * x.atr) {
      i++;
      continue;
    }
    const pre = sc ? "A" : "D";
    const arm = i + M;
    // 在“吸筹”坐标里写：below(p, q) = p 在 q 的外侧（吸筹 = 更低）
    const beyondE = (p: number, q: number) => (sc ? p < q : p > q);
    const ext = (y: Bar) => (sc ? y.l : y.h);
    const opp = (y: Bar) => (sc ? y.h : y.l);
    let extreme = E; // 高潮以来最外侧
    let springDone = false, stDone = false, swept = false;
    let end = Math.min(b.length - 2, i + W), outcome: TR["outcome"] = "timeout";
    for (let k = i + 1; k <= Math.min(b.length - 2, i + W); k++) {
      const y = b[k];
      const a = y.atr;
      if (k > arm) {
        // 失败：收盘越过 E 0.5 ATR，或连续两根收盘越过 E
        const fail = beyondE(y.c, E - d * 0.5 * a) || (beyondE(y.c, E) && beyondE(b[k - 1].c, E) && k - 1 > arm);
        // 离开区间（SOS / SOW）：收盘越过 O
        const out = sc ? y.c > O : y.c < O;
        if (fail) {
          outcome = "fail";
          end = k;
          break;
        }
        if (out) {
          outcome = "out";
          end = k;
          open(pre + "4", k + 1, d, extreme - d * 0.2 * a);
          if (springDone) open(pre + "5", k + 1, d, extreme - d * 0.2 * a);
          // LPS / LPSY：之后 30 根内回到 O ± 0.5 ATR 以内，再收盘越过回踩开始那根的另一端且在 O 之外
          let touch = -1, pullExt = 0;
          for (let j = k + 1; j <= Math.min(b.length - 2, k + 30); j++) {
            const z = b[j];
            if (sc ? z.c < O - 0.5 * z.atr : z.c > O + 0.5 * z.atr) break;
            if (touch < 0) {
              if (sc ? z.l <= O + 0.5 * z.atr : z.h >= O - 0.5 * z.atr) (touch = j), (pullExt = ext(z));
              continue;
            }
            pullExt = sc ? Math.min(pullExt, z.l) : Math.max(pullExt, z.h);
            if (sc ? z.c > b[touch].h && z.c > O : z.c < b[touch].l && z.c < O) {
              open(pre + "6", j + 1, d, pullExt - d * 0.2 * z.atr);
              break;
            }
          }
          break;
        }
        // ST：从区间里面回到 E 的 0.5 ATR 内，没越过 E，量比高潮小，之前没扫过
        if (!stDone && !swept && (sc ? y.l <= E + 0.5 * a && y.l >= E && b[k - 1].l > E + 0.5 * a : y.h >= E - 0.5 * a && y.h <= E && b[k - 1].h < E - 0.5 * a) && y.v < x.v) {
          stDone = true;
          open(pre + "2", k + 1, d, E - d * 0.2 * a);
        }
        // Spring / UTAD：越过 E、这根或下一根收盘回到 E 里面、量比高潮小
        if (beyondE(ext(y), E) && !beyondE(b[k - 1].c, E)) {
          const rec = !beyondE(y.c, E) ? k : !beyondE(b[k + 1].c, E) ? k + 1 : -1;
          swept = true;
          if (rec > 0) {
            const v = Math.max(y.v, rec > k ? b[k + 1].v : 0);
            if (v < x.v && !springDone) {
              springDone = true;
              const se = sc ? Math.min(y.l, b[rec].l) : Math.max(y.h, b[rec].h);
              open(pre + "3", rec + 1, d, se - d * 0.2 * b[rec].atr);
            }
          }
        }
      }
      extreme = sc ? Math.min(extreme, y.l) : Math.max(extreme, y.h);
      void opp;
    }
    trs.push({ coin, c: i, arm, end, acc: sc, outcome, RL: sc ? E : O, RH: sc ? O : E });
    i = end + 1;
  }
  return { trades, trs };
}

let seed = 39;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
function randomR(b: Bar[], fund: Map<number, number>, t: Trade, loI: number) {
  const out: number[] = [];
  for (let n = 0; n < 50; n++) {
    const ei = loI + 1 + Math.floor(rnd() * Math.max(1, b.length - loI - 3));
    if (ei >= b.length - 1 || !(b[ei - 1].atr > 0)) continue;
    const stop = b[ei].o - t.dir * t.riskAtr * b[ei - 1].atr;
    if (t.dir === 1 && stop <= 0) continue;
    out.push(settle("", "", b, fund, ei, t.dir, stop).r);
  }
  return mean(out);
}

const f2 = (x: number) => (Number.isFinite(x) ? (x >= 0 ? "+" : "") + x.toFixed(2) : "—");
const pc = (x: number) => (Number.isFinite(x) ? (x * 100).toFixed(0) + "%" : "—");

const ROWS: [string, string][] = [
  ["A1", "SC 抛售高潮就接（做多）"],
  ["A2", "ST 二次测试下沿就接（做多）"],
  ["A3", "Spring 量减扫低收回（做多）"],
  ["A4", "SOS 收盘站上区间上沿（做多，全部）"],
  ["A5", "SOS 且之前有 Spring（做多）"],
  ["A6", "LPS 突破后回踩上沿拐头（做多）"],
  ["D1", "BC 买入高潮就空"],
  ["D2", "ST 二次测试上沿就空"],
  ["D3", "UTAD 量减冲高回落（做空）"],
  ["D4", "SOW 收盘跌破区间下沿（做空，全部）"],
  ["D5", "SOW 且之前有 UTAD（做空）"],
  ["D6", "LPSY 跌破后反抽下沿拐头（做空）"],
];

const coinsAll = readdirSync(`${dir}/e30`).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
const order = ["BTC", "ETH", ...coinsAll.filter((c) => c !== "BTC" && c !== "ETH").sort()];
const others = order.filter((c) => c !== "BTC" && c !== "ETH");
const segs: [string, number, number][] = [
  ["全部 2020 起", START, Infinity],
  ["样本内", START, OOS],
  ["样本内前半", START, MID],
  ["样本内后半", MID, OOS],
  ["样本外 12 个月", OOS, Infinity],
];

console.log(`E39 威科夫区间事件  TFS=${TFS.join(",")} LOOK=${LOOK} DROP=${DROP}ATR VOLX=${VOLX} WICK=${WICK} M=${M} W=${W} EXIT=${EXIT}  成本 0.15% + 资金费率  样本外 2025-10-30 起`);

type Summary = { tf: string; row: string; n: number; diff: number; p: number; signs: number[]; q?: number };
const summary: Summary[] = [];
const descr: string[] = [];

for (const tf of TFS) {
  const data = Object.fromEntries(order.map((c) => [c, load(c, tf)]));
  const res = Object.fromEntries(order.map((c) => [c, scan(c, data[c].b, data[c].fund)]));
  for (const c of order) {
    const { b, fund } = data[c];
    const loI = Math.max(1, b.findIndex((x) => x.t >= START));
    for (const t of res[c].trades) t.rand = randomR(b, fund, t, loI);
  }
  const tIn = (c: string, t: Trade, lo: number, hi: number) => data[c].b[t.ei].t >= lo && data[c].b[t.ei].t < hi;
  const pick = (cs: string[], rk: string, lo: number, hi: number) => cs.flatMap((c) => res[c].trades.filter((t) => t.row === rk && tIn(c, t, lo, hi)));
  const stat = (ts: Trade[]) => {
    const d = ts.map((t) => t.r - t.rand!);
    return { n: ts.length, win: ts.filter((t) => t.r > 0).length / ts.length, r: mean(ts.map((t) => t.r)), rr: mean(ts.map((t) => t.rand!)), diff: mean(d), t: mean(d) / (sd(d) / Math.sqrt(d.length)) };
  };
  console.log(`\n\n######## ${tf} ########`);
  for (const [rk, rname] of ROWS) {
    console.log(`\n== ${tf} ${rk} ${rname} ==`);
    console.log("范围        段                笔数  胜率   平均R   随机R   差R     t");
    for (const [g, cs] of [["10 币", order], ["BTC", ["BTC"]], ["ETH", ["ETH"]], ["BTC+ETH", ["BTC", "ETH"]], ["其他 8 币", others]] as [string, string[]][])
      for (const [sname, lo, hi] of segs) {
        if ((g === "BTC" || g === "ETH") && sname !== "样本内") continue;
        if (g !== "10 币" && (sname === "样本内前半" || sname === "样本内后半")) continue;
        const s = stat(pick(cs, rk, lo, hi));
        console.log(`${g.padEnd(9)}  ${sname.padEnd(14)}  ${String(s.n).padStart(4)}  ${pc(s.win).padStart(4)}  ${f2(s.r).padStart(6)}  ${f2(s.rr).padStart(6)}  ${f2(s.diff).padStart(6)}  ${f2(s.t).padStart(5)}`);
      }
    const inS = stat(pick(order, rk, START, OOS));
    const signs = [stat(pick(["BTC"], rk, START, OOS)).diff, stat(pick(["ETH"], rk, START, OOS)).diff, stat(pick(order, rk, START, MID)).diff, stat(pick(order, rk, MID, OOS)).diff, stat(pick(order, rk, OOS, Infinity)).diff];
    summary.push({ tf, row: rk, n: inS.n, diff: inS.diff, p: inS.n >= 5 ? pval(inS.t) : 1, signs });
  }

  // 描述：区间有多常见、结局、区间里位置之后的走势
  const lines: string[] = [`\n== ${tf} 区间描述（2020 起） ==`];
  for (const [g, cs] of [["BTC+ETH", ["BTC", "ETH"]], ["其他 8 币", others]] as [string, string[]][]) {
    let bars = 0, inTr = 0, years = 0;
    const cnt = { acc: 0, dist: 0 };
    const out = { acc: { out: 0, fail: 0, timeout: 0 }, dist: { out: 0, fail: 0, timeout: 0 } };
    for (const c of cs) {
      const b = data[c].b;
      const lo = b.findIndex((x) => x.t >= START);
      if (lo < 0) continue;
      bars += b.length - lo;
      years += (b[b.length - 1].t - b[lo].t) / 86400 / 365;
      for (const r of res[c].trs) {
        if (b[r.c].t < START) continue;
        const k = r.acc ? "acc" : "dist";
        cnt[k]++;
        out[k][r.outcome]++;
        inTr += Math.max(0, r.end - r.arm);
      }
    }
    const pcts = (o: { out: number; fail: number; timeout: number }) => {
      const n = o.out + o.fail + o.timeout;
      return `离开区间 ${pc(o.out / n)}、失败 ${pc(o.fail / n)}、超时 ${pc(o.timeout / n)}`;
    };
    lines.push(`${g}：吸筹区间 ${cnt.acc} 个（每币每年 ${(cnt.acc / (years || 1)).toFixed(1)}），${pcts(out.acc)}；派发区间 ${cnt.dist} 个（每币每年 ${(cnt.dist / (years || 1)).toFixed(1)}），${pcts(out.dist)}；处在区间里（AR 之后）的 K 线占 ${pc(inTr / bars)}`);
    // 区间里收盘在下 / 中 / 上三分之一之后 10 / 30 根（只看 AR 之后、结局之前的 K 线）
    for (const h of [10, 30]) {
      const pos: Record<string, number[]> = { 下: [], 中: [], 上: [], 全: [] };
      for (const c of cs) {
        const b = data[c].b;
        for (const r of res[c].trs) {
          if (b[r.c].t < START) continue;
          for (let k = r.arm + 1; k < r.end && k + h < b.length; k++) {
            const f = (b[k].c - r.RL) / (r.RH - r.RL);
            if (f < 0 || f > 1) continue;
            const v = (b[k + h].c - b[k].c) / b[k].atr;
            pos[f < 1 / 3 ? "下" : f < 2 / 3 ? "中" : "上"].push(v);
            pos["全"].push(v);
          }
        }
      }
      lines.push(
        `  ${h} 根后（ATR 倍数，上涨比例）：` +
          (["下", "中", "上", "全"] as const)
            .map((k) => {
              const x = pos[k];
              const tt = k === "全" ? "" : ` t ${f2((mean(x) - mean(pos["全"])) / (sd(x) / Math.sqrt(x.length)))}`;
              return `${k === "全" ? "区间里全部" : k + "三分之一"} ${x.length} 根 ${f2(mean(x))} / ${pc(x.filter((v) => v > 0).length / x.length)}${tt}`;
            })
            .join("；"),
      );
    }
  }
  // BTC 最近 12 个月的区间清单（便于对照图）
  const b = data.BTC.b;
  const day = (t: number) => new Date(t * 1000).toISOString().slice(0, tf === "1d" ? 10 : 13).replace("T", " ");
  lines.push(`BTC 最近 12 个月的区间：`);
  for (const r of res.BTC.trs.filter((r) => b[r.c].t >= OOS)) {
    const ts = res.BTC.trades.filter((t) => t.ei > r.c && t.ei <= r.end + 32);
    lines.push(`  ${day(b[r.c].t)} ${r.acc ? "SC" : "BC"} 区间 ${r.RL.toPrecision(6)}–${r.RH.toPrecision(6)} → ${day(b[r.end].t)} ${{ out: "离开区间", fail: "失败", timeout: "超时" }[r.outcome]}` + ts.map((t) => ` | ${t.row} ${day(b[t.ei].t)} ${f2(t.r)}R`).join(""));
  }
  descr.push(...lines);
}

console.log(descr.join("\n"));

// BH 校正（所有周期所有行一起）
const ps = summary.map((s, k) => ({ k, p: s.p })).sort((a, b) => a.p - b.p);
const m = ps.length;
let prev = 1;
for (let j = m - 1; j >= 0; j--) {
  prev = Math.min(prev, (ps[j].p * m) / (j + 1));
  summary[ps[j].k].q = prev;
}
console.log("\n\n== 判定（样本内 10 币对随机；BH 校正 " + m + " 行；一致 = BTC / ETH / 前半 / 后半 / 样本外 和整体同号） ==");
console.log("周期  行   笔数   差R     q      BTC    ETH    前半   后半   样本外  结论");
for (const s of summary) {
  const same = s.signs.every((x) => Number.isFinite(x) && Math.sign(x) === Math.sign(s.diff));
  const verdict = s.n < 30 ? "样本不足" : s.diff >= 0.1 && (s.q ?? 1) < 0.05 && same ? "有优势" : s.diff <= -0.1 && (s.q ?? 1) < 0.05 && same ? "比随机差" : "没有优势";
  const name = ROWS.find((r) => r[0] === s.row)![1];
  console.log(`${s.tf.padEnd(4)}  ${s.row}  ${String(s.n).padStart(5)}  ${f2(s.diff).padStart(6)}  ${(s.q ?? 1).toFixed(3)}  ${s.signs.map((x) => f2(x).padStart(5)).join("  ")}  ${verdict}  ${name}`);
}
