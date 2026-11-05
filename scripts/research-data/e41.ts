/**
 * E41（2026-11-05）：趋势启动有没有可以顺着做的共同特征。用户：“8 万瀑布到 7.6 万、75,700 一路拉到 81,000，
 * 每次都逆势亏钱；这种行情启动时多少时间涨跌多少、回踩是不是和平时磨磨唧唧不一样，能不能抓住鱼身”。用户定只测 BTC / ETH。
 * 规则在跑之前定好（看结果之前写下，不再改；变体只换下面的环境变量）：
 *
 * - 数据：Binance 永续 K 线（e31-fetch.ts 的 1 小时 / 15 分钟，e30-fetch.ts 的 4 小时 / 日线、资金费率），
 *   归档缺的最近几天用 OKX 永续补。TF=1h（默认）/ 15m / 4h。ATR = 14 根 Wilder。多空对称，下面按做多写。
 * - 冲击（“这一段走得又快又干脆”）：第 k 根收盘时，最近 N 根的涨幅 c[k] − c[k−N] ≥ K × ATR(k−N)（用冲击之前的 ATR，
 *   免得冲击本身把 ATR 撑大）；干脆 = 效率 ER = |c[k] − c[k−N]| ÷ Σ|c[j] − c[j−1]| ≥ ER_MIN；放量 = 这 N 根平均成交额
 *   ≥ 1.5 倍之前 120 根平均。只在条件第一次成立的那根算一次（上一根不成立）。
 *   默认 1h：N = 12（半天）、K = 5、ER_MIN = 0.4；15m：N = 16（4 小时）；4h：N = 6（1 天）。
 * - 入场（每行一个币同时只持一笔；都在信号那根收盘后下一根开盘进）：
 *   A 速度：只看冲击；B 速度 + 干脆；C 速度 + 干脆 + 放量；
 *   D 鱼身（B 之后第一次回踩再起）：B 触发后 W（48）根内，回撤到冲击幅度（冲击段最低价 → 之后最高价）的 23.6%–61.8%
 *     且至少 1 倍 ATR，之后第一根收盘高于前 3 根最高价时进；回撤超过 61.8% 或收盘跌破冲击段最低价作废；
 *     止损 = 回踩最低价 − 0.2 ATR（0.3–8 倍 ATR 才做）；
 *   E 压缩后突破：之前 24 根的高低差 ≤ 4 倍 ATR，收盘越过这 24 根最高价；
 *   F 海龟基线：收盘越过之前 55 根最高价；
 *   G B + 顺日线：已收盘日线 EMA20 在 EMA50 之上（做空相反）。
 *   A / B / C / E / F / G 的初始止损 = 入场价 − 3 倍 ATR。
 * - 离场 EXIT=chand（默认）：3 倍 ATR 吊灯（从入场以来最高价回落 3 ATR，只在收盘后上移），最长 H 根（1h 240 / 15m 480 / 4h 120）；
 *   EXIT=hold：止损不动，拿 HOLD（24）根按收盘平，只看方向。同一根先算止损，跳空按开盘价成交。
 * - 成本来回 0.15% + 持仓期资金费率。R = 入场到初始止损的距离。
 * - 对照：每笔 50 个随机入场（同币、2020 年起任一根开盘、同方向、同 ATR 倍数止损、同离场规则）。
 * - 另给“先到哪个”：入场后先涨到 +6 ATR 还是先跌到 −3 ATR（随机游走约 1/3），以及吃到 ≥ 3R 的比例（“鱼身”）。
 * - 切分：2020-01-01 起；样本外 = 2025-11-05 之后 12 个月，样本内再分前后两半。
 *   达标：BTC + ETH 对随机 ≥ 0.1R、BH 校正后 q < 0.05、BTC / ETH / 前后两半 / 样本外都为正。
 * - 大行情描述（事后标注，不用于交易）：之字形（反转 ≥ Z = 12 倍 ATR）的每一段，起点到第一次 B 触发之间走掉了几成（鱼头），
 *   多少段根本没有 B 触发；B 触发里有几成落在这种大段里。
 *
 *   node --experimental-strip-types scripts/research-data/e41.ts <dataDir>   [环境变量 TF / N / K / ER / EXIT / COINS]
 */
import { readFileSync } from "node:fs";

const dir = process.argv[2];
const TF = process.env.TF ?? "1h";
const N = Number(process.env.N ?? { "15m": 16, "1h": 12, "4h": 6 }[TF]);
const K = Number(process.env.K ?? 5);
const ER_MIN = Number(process.env.ER ?? 0.4);
const VOLX = Number(process.env.VOLX ?? 1.5);
const EXIT = process.env.EXIT ?? "chand";
const H = { "15m": 480, "1h": 240, "4h": 120 }[TF]!;
const HOLD = 24;
const W = 48;
const Z = 12;
const COINS = (process.env.COINS ?? "BTC,ETH").split(",");
const COST = 0.0015;
const START = Date.UTC(2020, 0, 1) / 1000;
const OOS = Date.UTC(2025, 10, 5) / 1000;
const MID = START + (OOS - START) / 2;
const STEP = { "15m": 900, "1h": 3600, "4h": 14400 }[TF]!;

type Bar = { t: number; o: number; h: number; l: number; c: number; v: number; atr: number; day: number };
type Trade = { coin: string; row: string; ei: number; xi: number; dir: 1 | -1; riskAtr: number; r: number; first: number; entry: number; exit: number; stop: number; vol?: number; er?: number; day?: number };

function emaArr(xs: number[], n: number) {
  const k = 2 / (n + 1);
  let v = xs[0];
  return xs.map((x) => (v = x * k + v * (1 - k)));
}

function load(coin: string) {
  const j = TF === "4h" ? JSON.parse(readFileSync(`${dir}/e30/${coin}.json`, "utf8")) : JSON.parse(readFileSync(`${dir}/e31/${coin}.json`, "utf8"));
  const j30 = TF === "4h" ? j : JSON.parse(readFileSync(`${dir}/e30/${coin}.json`, "utf8"));
  const rows: number[][] = { "15m": j.m15, "1h": j.h1, "4h": j.h4 }[TF];
  const b: Bar[] = rows.map((r) => ({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5], atr: NaN, day: 0 }));
  let atr = NaN, sum = 0;
  for (let i = 1; i < b.length; i++) {
    const tr = Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c));
    if (i <= 14) {
      sum += tr;
      if (i === 14) atr = sum / 14;
    } else atr = (atr * 13 + tr) / 14;
    b[i].atr = atr;
  }
  // 日线方向：已收盘日线的 EMA20 对 EMA50（第 i 根收盘时，只用开盘早于今天 0 点的日线）
  const d1: number[][] = j30.d1;
  const e20 = emaArr(d1.map((r) => r[4]), 20), e50 = emaArr(d1.map((r) => r[4]), 50);
  let di = -1;
  for (const x of b) {
    const closeT = x.t + STEP;
    while (di + 1 < d1.length && d1[di + 1][0] + 86400 <= closeT) di++;
    x.day = di >= 50 ? Math.sign(e20[di] - e50[di]) : 0;
  }
  const fund = new Map<number, number>();
  for (const [t, f] of j30.funding as number[][]) {
    const k = Math.floor(t / STEP) * STEP;
    fund.set(k, (fund.get(k) ?? 0) + f);
  }
  return { b, fund };
}

const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const sd = (a: number[]) => {
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1));
};

/** 先到 +6 ATR 还是 −3 ATR（1 = 先到 +6，−1 = 先到 −3，0 = H 根内都没到） */
function firstHit(b: Bar[], ei: number, d: 1 | -1, entry: number, a: number) {
  const up = entry + d * 6 * a, dn = entry - d * 3 * a;
  for (let k = ei; k < Math.min(b.length, ei + H); k++) {
    const x = b[k];
    if (d === 1 ? x.l <= dn : x.h >= dn) return -1;
    if (d === 1 ? x.h >= up : x.l <= up) return 1;
  }
  return 0;
}

function settle(coin: string, row: string, b: Bar[], fund: Map<number, number>, ei: number, d: 1 | -1, entry: number, stop0: number): Trade {
  const risk = Math.abs(entry - stop0), a = b[ei - 1].atr;
  let stop = stop0, ext = entry, xi = -1, exit = NaN;
  const maxI = Math.min(b.length - 1, ei + (EXIT === "hold" ? HOLD : H) - 1);
  for (let k = ei; k <= maxI; k++) {
    const x = b[k];
    if (d === 1 ? x.l <= stop : x.h >= stop) {
      (xi = k), (exit = d === 1 ? Math.min(stop, k === ei ? Math.min(entry, x.o) : x.o) : Math.max(stop, k === ei ? Math.max(entry, x.o) : x.o));
      break;
    }
    if (EXIT === "chand") {
      ext = d === 1 ? Math.max(ext, x.h) : Math.min(ext, x.l);
      stop = d === 1 ? Math.max(stop, ext - 3 * x.atr) : Math.min(stop, ext + 3 * x.atr);
    }
  }
  if (xi < 0) (xi = maxI), (exit = b[maxI].c);
  let f = 0;
  for (let k = ei; k <= xi; k++) f += fund.get(b[k].t) ?? 0;
  const pct = (d * (exit - entry)) / entry - COST - d * f;
  return { coin, row, ei, xi, dir: d, riskAtr: risk / a, r: (pct * entry) / risk, first: firstHit(b, ei, d, entry, a), entry, exit, stop: stop0 };
}

type Sig = { k: number; d: 1 | -1 };
/** 每根收盘时的冲击 / 干脆 / 放量 */
function features(b: Bar[]) {
  const disp: number[] = new Array(b.length).fill(0), er: number[] = new Array(b.length).fill(0), vol: number[] = new Array(b.length).fill(0);
  for (let k = N + 130; k < b.length; k++) {
    const a = b[k - N].atr;
    if (!(a > 0)) continue;
    disp[k] = (b[k].c - b[k - N].c) / a;
    let path = 0;
    for (let j = k - N + 1; j <= k; j++) path += Math.abs(b[j].c - b[j - 1].c);
    er[k] = path > 0 ? Math.abs(b[k].c - b[k - N].c) / path : 0;
    let vw = 0, vb = 0;
    for (let j = k - N + 1; j <= k; j++) vw += b[j].v;
    for (let j = k - N - 120 + 1; j <= k - N; j++) vb += b[j].v;
    vol[k] = vb > 0 ? vw / N / (vb / 120) : 0;
  }
  return { disp, er, vol };
}

function scan(coin: string, b: Bar[], fund: Map<number, number>) {
  const { disp, er, vol } = features(b);
  const trades: Trade[] = [];
  const busy: Record<string, number> = {};
  const add = (row: string, ei: number, d: 1 | -1, entry: number, stop: number) => {
    if (ei >= b.length || b[ei].t < START) return;
    const key = row;
    if ((busy[key] ?? -1) >= ei) return;
    const t = settle(coin, row, b, fund, ei, d, entry, stop);
    busy[key] = t.xi;
    trades.push(t);
  };
  const chase = (row: string, k: number, d: 1 | -1) => {
    if (k + 1 >= b.length) return;
    const e = b[k + 1].o, a = b[k].atr;
    const n = trades.length;
    add(row, k + 1, d, e, e - d * 3 * a);
    if (trades.length > n) Object.assign(trades[n], { vol: vol[k], er: er[k], day: b[k].day * d });
  };
  const imp = (k: number, d: 1 | -1) => d * disp[k] >= K;
  const sigs: Record<string, Sig[]> = { A: [], B: [], C: [], E: [], F: [], G: [] };
  for (let k = 200; k < b.length - 1; k++) {
    for (const d of [1, -1] as const) {
      const A = imp(k, d), Ap = imp(k - 1, d);
      const B = A && er[k] >= ER_MIN, Bp = Ap && er[k - 1] >= ER_MIN;
      const C = B && vol[k] >= VOLX, Cp = Bp && vol[k - 1] >= VOLX;
      if (A && !Ap) chase("A", k, d), sigs.A.push({ k, d });
      if (B && !Bp) chase("B", k, d), sigs.B.push({ k, d });
      if (C && !Cp) chase("C", k, d);
      if (B && !Bp) chase("X", k, (-d) as 1 | -1);
      if (B && !Bp && b[k].day === d) chase("G", k, d);
      // E 压缩后突破
      let hi = -Infinity, lo = Infinity;
      for (let j = k - 24; j < k; j++) (hi = Math.max(hi, b[j].h)), (lo = Math.min(lo, b[j].l));
      const edge = d === 1 ? hi : lo;
      if (hi - lo <= 4 * b[k - 1].atr && d * (b[k].c - edge) > 0 && d * (b[k - 1].c - edge) <= 0) chase("E", k, d);
      // F 海龟 55
      let h55 = -Infinity, l55 = Infinity;
      for (let j = k - 55; j < k; j++) (h55 = Math.max(h55, b[j].h)), (l55 = Math.min(l55, b[j].l));
      const e55 = d === 1 ? h55 : l55;
      if (d * (b[k].c - e55) > 0 && d * (b[k - 1].c - e55) <= 0) chase("F", k, d);
    }
  }
  // D 鱼身：B 之后第一次回踩再起
  for (const { k, d } of sigs.B) {
    const hi = (x: Bar) => (d === 1 ? x.h : -x.l), lo = (x: Bar) => (d === 1 ? x.l : -x.h), cl = (x: Bar) => d * x.c;
    let L = Infinity;
    for (let j = k - N; j <= k; j++) L = Math.min(L, lo(b[j]));
    let Hh = -Infinity;
    for (let j = k - N; j <= k; j++) Hh = Math.max(Hh, hi(b[j]));
    let armed = false, PL = Infinity;
    for (let j = k + 1; j <= Math.min(b.length - 2, k + W); j++) {
      const x = b[j];
      if (!armed && hi(x) > Hh) {
        Hh = hi(x);
        PL = Infinity;
      }
      PL = Math.min(PL, lo(x));
      const leg = Hh - L, retr = (Hh - PL) / leg;
      if (retr > 0.618 || cl(x) < L) break;
      if (!armed && retr >= 0.236 && Hh - PL >= b[j].atr) {
        armed = true;
        continue;
      }
      if (armed) {
        let h3 = -Infinity;
        for (let q = j - 3; q < j; q++) h3 = Math.max(h3, hi(b[q]));
        if (cl(x) > h3) {
          const e = b[j + 1].o, a = b[j].atr, stop = d * (PL - 0.2 * a), risk = d * (e - stop);
          if (risk >= 0.3 * a && risk <= 8 * a) add("D", j + 1, d, e, stop);
          break;
        }
      }
    }
  }
  return { trades, sigsB: sigs.B, disp, er };
}

let seed = 41;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
function randomOf(b: Bar[], fund: Map<number, number>, t: Trade, loI: number) {
  const rs: number[] = [], fs: number[] = [];
  for (let n = 0; n < 50; n++) {
    const ei = loI + 1 + Math.floor(rnd() * (b.length - loI - 3));
    if (!(b[ei - 1].atr > 0)) continue;
    const e = b[ei].o, stop = e - t.dir * t.riskAtr * b[ei - 1].atr;
    if (stop <= 0) continue;
    const x = settle("", "", b, fund, ei, t.dir, e, stop);
    rs.push(x.r), fs.push(x.first);
  }
  return { r: mean(rs), first: fs.filter((x) => x === 1).length / fs.length, big: rs.filter((x) => x >= 3).length / rs.length };
}

/** 之字形（反转 ≥ Z 倍 ATR），返回每段 [起点 i, 终点 i, 方向] */
function zigzag(b: Bar[]) {
  const legs: [number, number, 1 | -1][] = [];
  let dirn: 1 | -1 = 1, piv = 0, ext = 0;
  for (let i = 15; i < b.length; i++) {
    const a = b[ext].atr;
    if (!(a > 0)) {
      ext = i;
      piv = i;
      continue;
    }
    if (dirn === 1) {
      if (b[i].h > b[ext].h) ext = i;
      else if (b[ext].h - b[i].l >= Z * a) legs.push([piv, ext, 1]), (piv = ext), (ext = i), (dirn = -1);
    } else {
      if (b[i].l < b[ext].l) ext = i;
      else if (b[i].h - b[ext].l >= Z * a) legs.push([piv, ext, -1]), (piv = ext), (ext = i), (dirn = 1);
    }
  }
  return legs;
}

const f2 = (x: number) => (Number.isFinite(x) ? (x >= 0 ? "+" : "") + x.toFixed(2) : "—");
const pc = (x: number) => (Number.isFinite(x) ? (x * 100).toFixed(0) + "%" : "—");
// 正态近似的双边 p
const pOf = (t: number) => {
  const z = Math.abs(t), u = 1 / (1 + 0.2316419 * z);
  const p = 0.3989423 * Math.exp((-z * z) / 2) * u * (0.3193815 + u * (-0.3565638 + u * (1.781478 + u * (-1.821256 + u * 1.330274))));
  return 2 * p;
};

const all: Trade[] = [];
const R = new Map<Trade, { r: number; first: number; big: number }>();
const T = new Map<Trade, number>();
const legInfo: string[] = [];
const SHOW = process.env.SHOW ? Date.parse(process.env.SHOW + "T00:00:00+08:00") / 1000 : NaN;
const shown: string[] = [];
const bj = (t: number) => new Date((t + 8 * 3600) * 1000).toISOString().slice(5, 16).replace("T", " ");
for (const c of COINS) {
  const { b, fund } = load(c);
  const loI = b.findIndex((x) => x.t >= START);
  const { trades, sigsB } = scan(c, b, fund);
  for (const t of trades) {
    all.push(t);
    T.set(t, b[t.ei].t);
    R.set(t, randomOf(b, fund, t, loI));
    if (b[t.ei].t >= SHOW)
      shown.push(`${c} ${t.row} ${t.dir === 1 ? "多" : "空"}  入场 ${bj(b[t.ei].t)} ${t.entry.toFixed(0)}  止损 ${t.stop.toFixed(0)}  离场 ${bj(b[t.xi].t)} ${t.exit.toFixed(0)}  ${f2(t.r)}R${t.xi >= b.length - 1 ? "（还拿着，按最新收盘）" : ""}`);
  }
  // 大行情描述
  const legs = zigzag(b).filter(([s]) => b[s].t >= START);
  let withB = 0, headSum: number[] = [], bars: number[] = [], pctMove: number[] = [];
  const inLeg = new Set<number>();
  for (const [s, e, d] of legs) {
    const size = d * ((d === 1 ? b[e].h : b[e].l) - (d === 1 ? b[s].l : b[s].h));
    bars.push(e - s);
    pctMove.push(size / (d === 1 ? b[s].l : b[s].h));
    const first = sigsB.find((x) => x.d === d && x.k > s && x.k < e);
    for (const x of sigsB) if (x.d === d && x.k > s && x.k < e) inLeg.add(x.k * d);
    if (!first) continue;
    withB++;
    headSum.push((d * (b[first.k].c - (d === 1 ? b[s].l : b[s].h))) / size);
  }
  const sB = sigsB.filter((x) => b[x.k].t >= START);
  const med = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[a.length >> 1] : NaN);
  legInfo.push(
    `${c}: 之字形大段（反转 ≥ ${Z} 倍 ATR）${legs.length} 段，中位 ${med(bars)} 根、幅度中位 ${pc(med(pctMove))}；` +
      `其中 ${pc(withB / legs.length)} 段中途出现过 B 触发，触发时这一段已走掉的中位 ${pc(med(headSum))}（鱼头）；` +
      `B 触发 ${sB.length} 次，落在同方向大段里（大段结束前）的 ${pc(sB.filter((x) => inLeg.has(x.k * x.d)).length / sB.length)}`,
  );
}

console.log(`E41 趋势启动（冲击）顺着做  TF=${TF} N=${N} K=${K} ER≥${ER_MIN} EXIT=${EXIT}  币：${COINS.join(" / ")}  成本 0.15% + 资金费率  随机 50 个/笔`);
const ROWS: [string, string][] = [
  ["A", `速度：${N} 根内走了 ≥ ${K} 倍 ATR，下一根追`],
  ["B", "速度 + 干脆（效率 ≥ " + ER_MIN + "），下一根追"],
  ["C", "速度 + 干脆 + 放量（≥ " + VOLX + " 倍），下一根追"],
  ["D", "鱼身：B 之后第一次回踩（23.6–61.8%）再起"],
  ["E", "压缩后突破（之前 24 根 ≤ 4 ATR）"],
  ["F", "海龟基线：越过 55 根高低点"],
  ["G", "B + 顺日线（EMA20 / 50）"],
  ["X", "反着做：B 之后下一根逆着进（抄底 / 摸顶）"],
];
const segs: [string, number, number][] = [
  ["全部 2020 起", START, Infinity],
  ["样本内前半", START, MID],
  ["样本内后半", MID, OOS],
  ["样本外 12 个月", OOS, Infinity],
];
const judge: { row: string; m: number; p: number; ok: boolean }[] = [];
for (const [rk, rname] of ROWS) {
  console.log(`\n== ${rk} ${rname} ==`);
  console.log("范围          段              笔数  胜率   平均R   随机R   差R     t    ≥3R  随机≥3R  先+6ATR 随机");
  const signs: number[] = [];
  let mAll = NaN, tAll = NaN;
  for (const g of (COINS.length > 1 ? [...COINS.map((c) => [c]), COINS] : [COINS]))
    for (const [sname, lo, hi] of segs) {
      const tot = g === COINS;
      const name = g.join("+");
      if (!tot && sname !== "全部 2020 起") continue;
      const ts = all.filter((t) => t.row === rk && g.includes(t.coin) && T.get(t)! >= lo && T.get(t)! < hi);
      if (!ts.length) continue;
      const rs = ts.map((t) => t.r), d = ts.map((t) => t.r - R.get(t)!.r);
      const tt = mean(d) / (sd(d) / Math.sqrt(d.length));
      if (tot && sname === "全部 2020 起") (mAll = mean(d)), (tAll = tt);
      else signs.push(mean(d));
      const first = ts.filter((t) => t.first === 1).length / ts.length, rf = mean(ts.map((t) => R.get(t)!.first));
      console.log(
        `${name.padEnd(12)}  ${sname.padEnd(13)}  ${String(ts.length).padStart(5)}  ${pc(rs.filter((x) => x > 0).length / rs.length).padStart(4)}  ${f2(mean(rs)).padStart(6)}  ${f2(mean(ts.map((t) => R.get(t)!.r))).padStart(6)}  ${f2(mean(d)).padStart(6)}  ${f2(tt).padStart(5)}  ${pc(rs.filter((x) => x >= 3).length / rs.length).padStart(4)}  ${pc(mean(ts.map((t) => R.get(t)!.big))).padStart(6)}   ${pc(first).padStart(5)}  ${pc(rf).padStart(4)}`,
      );
    }
  judge.push({ row: rk, m: mAll, p: pOf(tAll), ok: signs.every((x) => x > 0) });
}
// BH
const sorted = [...judge].sort((a, b) => a.p - b.p);
const q = new Map<string, number>();
let prev = 1;
for (let i = sorted.length - 1; i >= 0; i--) {
  prev = Math.min(prev, (sorted[i].p * sorted.length) / (i + 1));
  q.set(sorted[i].row, prev);
}
console.log("\n== 判定（BTC+ETH 全部对随机 ≥ 0.1R、q < 0.05、BTC / ETH / 前后两半 / 样本外都为正） ==");
for (const j of judge)
  console.log(`${j.row}  差R ${f2(j.m)}  q ${q.get(j.row)!.toFixed(3)}  各段同向 ${j.ok ? "是" : "否"}  → ${j.m >= 0.1 && q.get(j.row)! < 0.05 && j.ok ? "有优势" : j.m <= -0.1 && q.get(j.row)! < 0.05 ? "更差" : "没有可证明的优势"}`);
// 速度触发（A）按量能、干脆、日线方向分组：哪些特征把“趋势启动”和“平时的冲一下”分开
console.log("\n== A 的冲击按特征分组（BTC+ETH 全部 2020 起） ==");
console.log("分组                      笔数   平均R   差R     t    先+6ATR 随机");
const At = all.filter((t) => t.row === "A");
const grp = (name: string, f: (t: Trade) => boolean) => {
  const ts = At.filter(f);
  if (!ts.length) return;
  const d = ts.map((t) => t.r - R.get(t)!.r);
  console.log(`${name.padEnd(22)}  ${String(ts.length).padStart(5)}  ${f2(mean(ts.map((t) => t.r))).padStart(6)}  ${f2(mean(d)).padStart(6)}  ${f2(mean(d) / (sd(d) / Math.sqrt(d.length))).padStart(5)}   ${pc(ts.filter((t) => t.first === 1).length / ts.length).padStart(5)}  ${pc(mean(ts.map((t) => R.get(t)!.first))).padStart(4)}`);
};
grp("量 < 1 倍", (t) => t.vol! < 1);
grp("量 1–1.5 倍", (t) => t.vol! >= 1 && t.vol! < 1.5);
grp("量 1.5–2 倍", (t) => t.vol! >= 1.5 && t.vol! < 2);
grp("量 ≥ 2 倍", (t) => t.vol! >= 2);
grp("效率 < 0.4（来回拉扯）", (t) => t.er! < 0.4);
grp("效率 0.4–0.6", (t) => t.er! >= 0.4 && t.er! < 0.6);
grp("效率 ≥ 0.6（一路走）", (t) => t.er! >= 0.6);
grp("顺日线", (t) => t.day === 1);
grp("逆日线", (t) => t.day === -1);
grp("做多", (t) => t.dir === 1);
grp("做空", (t) => t.dir === -1);
if (shown.length) console.log("\n== " + process.env.SHOW + " 起的每一笔（北京时间，入场 = 信号后下一根开盘） ==\n" + shown.join("\n"));
console.log("\n== 大行情长什么样（事后标注） ==");
for (const l of legInfo) console.log(l);
