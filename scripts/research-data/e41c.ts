/**
 * E41c（2026-11-05）：用户要“搜推特 / 其他网站上类似的趋势启动指标或策略，回测、互相补充看能不能更优”，以 BTC 为准、ETH 参考。
 * 找到的、能用 K 线复现的公开做法（规则在跑之前定好，看结果之前写下，不再改）：
 *
 * N1 日内噪音区突破（Zarattini、Aziz、Barbon 2024「Beat the Market」，Concretum 也做了 BTC 日内趋势，说毛夏普约 1.6）：
 *    一天 = UTC 0 点起。σ(h) = 之前 14 天、同一个小时收盘相对当天开盘的涨跌绝对值的平均；
 *    上沿 = max(当天开盘, 昨天收盘) × (1 + σ)，下沿 = min(…) × (1 − σ)。1 小时收盘在上沿之上 → 下一根开盘做多，下沿之下做空；
 *    多单在收盘跌回 max(上沿, 当天 VWAP) 之下时下一根开盘平（空单对称）；每天最后一根收盘全部平掉；一天可以做多次。
 * N2 拉里·威廉斯波动突破（韩国“변동성 돌파”、TradingView 很多 BTC 版本，k = 0.5）：当天开盘 ± 0.5 × 昨天高低差，
 *    盘中先碰到哪边就在那个价进（同一根两边都碰到当天不做），拿到当天收盘。另一行只做多（原版）。
 * N3 TTM 挤压释放（布林 20 / 2 倍收进肯特纳 20 / 1.5 倍 ATR 里至少 6 根，之后第一次放开），方向 = TTM 动量的符号，
 *    下一根开盘进，初始止损 3 倍 ATR + 3 倍 ATR 吊灯（同 E41）。1 小时、4 小时。
 * N4 Supertrend(10, 3) 翻转 + ADX(14) > 20，下一根开盘进，下一次反向翻转时平。1 小时、4 小时。
 * N5 ADX 启动：ADX(14) 从下往上穿过 25，方向 = +DI / −DI 大的一边，进出同 N3。1 小时、4 小时。
 * N6 日线唐奇安组合（Zarattini、Pagani、Barbon 2025「Catching Crypto Trends」的简化版，只做多）：回看 10 / 20 / 30 / 60 / 90 / 150 / 250 天，
 *    每个模型收盘创回看新高就持有，收盘跌破回看高低中线就空仓；仓位 = 七个模型的平均。用 Binance 现货日线（2017-08 起）。
 *    报总收益、年化波动、夏普（0 利率）、最大回撤，对照一直持有，和把仓位序列循环错开 500 次的随机对照（同 E38 尺子 A）。
 * 互相补充：N1、N2 的每笔按 E41b 的“之前 7 天波动”分三档，看“之前安静”是不是在别人的方法上也成立。
 *
 * 对照（N1–N5）：每笔 50 个随机入场：同币、同方向、2020 年起任一根开盘进，拿同样多根 K 线后按收盘平。
 * 单位 R = 入场时 1 倍 ATR（交易周期），收益扣来回 0.15% + 持仓期资金费率。切分：2020 起；样本外 = 2025-11-05 之后；样本内分前后两半。
 * 达标（以 BTC 为准）：对随机 ≥ 0.1R、BH 校正后 q < 0.05、前后两半和样本外都为正；ETH 只参考。
 *
 *   node --experimental-strip-types scripts/research-data/e41c.ts <dataDir>    [COINS=BTC,ETH]
 *   <dataDir>/e30、e31 同 E41；<dataDir>/spot/<COIN>.json = Binance 现货日线 [[t,o,h,l,c,qv]]。
 */
import { readFileSync } from "node:fs";

const dir = process.argv[2];
const COINS = (process.env.COINS ?? "BTC,ETH").split(",");
const COST = 0.0015;
const START = Date.UTC(2020, 0, 1) / 1000;
const OOS = Date.UTC(2025, 10, 5) / 1000;
const MID = START + (OOS - START) / 2;
const ST_N = Number(process.env.ST_N ?? 10), ST_M = Number(process.env.ST_M ?? 3), ADXT = Number(process.env.ADXT ?? 20), ADXS = Number(process.env.ADXS ?? 25);

type Bar = { t: number; o: number; h: number; l: number; c: number; v: number; atr: number };
type Trade = { coin: string; row: string; ei: number; xi: number; dir: 1 | -1; entry: number; exit: number; r: number; t: number; qv: number };

const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const sd = (a: number[]) => {
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1));
};

function bars(rows: number[][]): Bar[] {
  const b: Bar[] = rows.map((r) => ({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5], atr: NaN }));
  let atr = NaN, sum = 0;
  for (let i = 1; i < b.length; i++) {
    const tr = Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c));
    if (i <= 14) {
      sum += tr;
      if (i === 14) atr = sum / 14;
    } else atr = (atr * 13 + tr) / 14;
    b[i].atr = atr;
  }
  return b;
}

function fundMap(coin: string, step: number) {
  const j = JSON.parse(readFileSync(`${dir}/e30/${coin}.json`, "utf8"));
  const m = new Map<number, number>();
  for (const [t, f] of j.funding as number[][]) {
    const k = Math.floor(t / step) * step;
    m.set(k, (m.get(k) ?? 0) + f);
  }
  return m;
}

/** 之前 7 天 1 小时收益标准差在之前 365 天里的分位（按 UTC 日，E41b 同口径） */
function quietMap(h1: Bar[]) {
  const rv = new Map<number, number>();
  let cur = -1;
  for (let i = 168; i < h1.length; i++) {
    const d = Math.floor(h1[i].t / 86400) * 86400;
    if (d === cur) continue;
    cur = d;
    const r: number[] = [];
    for (let j = i - 167; j < i; j++) r.push(Math.log(h1[j].c / h1[j - 1].c));
    rv.set(d, sd(r));
  }
  const days = [...rv.keys()].sort((a, b) => a - b), q = new Map<number, number>();
  days.forEach((d, k) => {
    if (k < 365) return;
    let lo = 0;
    for (let j = k - 365; j < k; j++) if (rv.get(days[j])! < rv.get(d)!) lo++;
    q.set(d, lo / 365);
  });
  return q;
}

function mk(coin: string, row: string, b: Bar[], fund: Map<number, number>, ei: number, xi: number, d: 1 | -1, entry: number, exit: number, qv: number): Trade {
  let f = 0;
  for (let k = ei; k <= xi; k++) f += fund.get(b[k].t) ?? 0;
  const pct = (d * (exit - entry)) / entry - COST - d * f;
  return { coin, row, ei, xi, dir: d, entry, exit, r: (pct * entry) / b[ei - 1].atr, t: b[ei].t, qv };
}

function chandelier(b: Bar[], ei: number, d: 1 | -1, H: number) {
  const entry = b[ei].o;
  let stop = entry - d * 3 * b[ei - 1].atr, ext = entry;
  for (let k = ei; k < Math.min(b.length, ei + H); k++) {
    const x = b[k];
    if (d === 1 ? x.l <= stop : x.h >= stop) return { xi: k, exit: d === 1 ? Math.min(stop, k === ei ? Math.min(entry, x.o) : x.o) : Math.max(stop, k === ei ? Math.max(entry, x.o) : x.o) };
    ext = d === 1 ? Math.max(ext, x.h) : Math.min(ext, x.l);
    stop = d === 1 ? Math.max(stop, ext - 3 * x.atr) : Math.min(stop, ext + 3 * x.atr);
  }
  const xi = Math.min(b.length - 1, ei + H - 1);
  return { xi, exit: b[xi].c };
}

// ---------- 指标 ----------
function sma(xs: number[], n: number) {
  const out = new Array(xs.length).fill(NaN);
  let s = 0;
  for (let i = 0; i < xs.length; i++) {
    s += xs[i];
    if (i >= n) s -= xs[i - n];
    if (i >= n - 1) out[i] = s / n;
  }
  return out;
}
function stdev(xs: number[], n: number) {
  const m = sma(xs, n);
  return xs.map((_, i) => {
    if (i < n - 1) return NaN;
    let s = 0;
    for (let j = i - n + 1; j <= i; j++) s += (xs[j] - m[i]) ** 2;
    return Math.sqrt(s / n);
  });
}
function dmi(b: Bar[], n = 14) {
  const adx = new Array(b.length).fill(NaN), pdi = new Array(b.length).fill(NaN), mdi = new Array(b.length).fill(NaN);
  let tr = 0, pd = 0, md = 0, ax = NaN;
  const dx: number[] = [];
  for (let i = 1; i < b.length; i++) {
    const up = b[i].h - b[i - 1].h, dn = b[i - 1].l - b[i].l;
    const p = up > dn && up > 0 ? up : 0, m = dn > up && dn > 0 ? dn : 0;
    const t = Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c));
    if (i <= n) (tr += t), (pd += p), (md += m);
    else (tr = tr - tr / n + t), (pd = pd - pd / n + p), (md = md - md / n + m);
    if (i < n) continue;
    pdi[i] = (100 * pd) / tr;
    mdi[i] = (100 * md) / tr;
    const x = (100 * Math.abs(pdi[i] - mdi[i])) / (pdi[i] + mdi[i] || 1);
    dx.push(x);
    if (dx.length === n) ax = mean(dx);
    else if (dx.length > n) ax = (ax * (n - 1) + x) / n;
    adx[i] = ax;
  }
  return { adx, pdi, mdi };
}

// ---------- N1 噪音区、N2 威廉斯 ----------
function intraday(coin: string, b: Bar[], fund: Map<number, number>, qmap: Map<number, number>) {
  const out: Trade[] = [];
  // 按 UTC 日切
  const days: number[][] = [];
  for (let i = 0; i < b.length; i++) {
    const d = Math.floor(b[i].t / 86400);
    if (!days.length || Math.floor(b[days[days.length - 1][0]].t / 86400) !== d) days.push([]);
    days[days.length - 1].push(i);
  }
  for (let di = 15; di < days.length; di++) {
    const idx = days[di];
    if (idx.length !== 24 || b[idx[0]].t < START) continue;
    const open = b[idx[0]].o, prevIdx = days[di - 1], prevClose = b[prevIdx[prevIdx.length - 1]].c;
    const qv = qmap.get(Math.floor(b[idx[0]].t / 86400) * 86400) ?? NaN;
    // ---- N1
    const sig: number[] = [];
    let ok = true;
    for (let h = 0; h < 24; h++) {
      let s = 0;
      for (let k = di - 14; k < di; k++) {
        const dk = days[k];
        if (dk.length !== 24) {
          ok = false;
          break;
        }
        s += Math.abs(b[dk[h]].c / b[dk[0]].o - 1);
      }
      sig.push(s / 14);
    }
    if (ok) {
      let pos: 0 | 1 | -1 = 0, ei = -1, pv = 0, vv = 0;
      for (let h = 0; h < 24; h++) {
        const i = idx[h], x = b[i];
        pv += ((x.h + x.l + x.c) / 3) * x.v;
        vv += x.v;
        const vwap = vv > 0 ? pv / vv : x.c;
        const ub = Math.max(open, prevClose) * (1 + sig[h]), lb = Math.min(open, prevClose) * (1 - sig[h]);
        if (h === 23) {
          if (pos !== 0) out.push(mk(coin, "N1", b, fund, ei, i, pos, b[ei].o, x.c, qv));
          break;
        }
        if (pos === 1 && x.c < Math.max(ub, vwap)) out.push(mk(coin, "N1", b, fund, ei, i + 1, 1, b[ei].o, b[i + 1].o, qv)), (pos = 0);
        else if (pos === -1 && x.c > Math.min(lb, vwap)) out.push(mk(coin, "N1", b, fund, ei, i + 1, -1, b[ei].o, b[i + 1].o, qv)), (pos = 0);
        if (pos === 0 && h <= 21) {
          if (x.c > ub) (pos = 1), (ei = i + 1);
          else if (x.c < lb) (pos = -1), (ei = i + 1);
        }
      }
    }
    // ---- N2
    let ph = -Infinity, pl = Infinity;
    for (const i of prevIdx) (ph = Math.max(ph, b[i].h)), (pl = Math.min(pl, b[i].l));
    const up = open + 0.5 * (ph - pl), dn = open - 0.5 * (ph - pl);
    for (let h = 0; h < 24; h++) {
      const i = idx[h], x = b[i];
      const hu = x.h >= up, hd = x.l <= dn;
      if (hu && hd) break;
      if (hu || hd) {
        const d: 1 | -1 = hu ? 1 : -1, lv = hu ? up : dn;
        const e = d === 1 ? Math.max(lv, x.o) : Math.min(lv, x.o);
        if (i > 0) {
          const t = mk(coin, "N2", b, fund, i, idx[23], d, e, b[idx[23]].c, qv);
          out.push(t);
          if (d === 1) out.push({ ...t, row: "N2L" });
        }
        break;
      }
    }
  }
  return out;
}

// ---------- N3 / N4 / N5 ----------
function swingTF(coin: string, tf: string, b: Bar[], fund: Map<number, number>) {
  const out: Trade[] = [];
  const H = tf === "1h" ? 240 : 120;
  const c = b.map((x) => x.c);
  const m20 = sma(c, 20), s20 = stdev(c, 20);
  const tr = b.map((x, i) => (i ? Math.max(x.h - x.l, Math.abs(x.h - b[i - 1].c), Math.abs(x.l - b[i - 1].c)) : x.h - x.l));
  const a20 = sma(tr, 20);
  const sqz = b.map((_, i) => m20[i] + 2 * s20[i] < m20[i] + 1.5 * a20[i] && m20[i] - 2 * s20[i] > m20[i] - 1.5 * a20[i]);
  // TTM 动量：linreg(close − ((HH20 + LL20) / 2 + SMA20) / 2, 20) 的最后一点
  const dev = b.map((x, i) => {
    if (i < 19) return NaN;
    let hh = -Infinity, ll = Infinity;
    for (let j = i - 19; j <= i; j++) (hh = Math.max(hh, b[j].h)), (ll = Math.min(ll, b[j].l));
    return x.c - ((hh + ll) / 2 + m20[i]) / 2;
  });
  const mom = b.map((_, i) => {
    if (i < 40) return NaN;
    let sx = 0, sy = 0, sxy = 0, sxx = 0;
    for (let k = 0; k < 20; k++) {
      const y = dev[i - 19 + k];
      (sx += k), (sy += y), (sxy += k * y), (sxx += k * k);
    }
    const slope = (20 * sxy - sx * sy) / (20 * sxx - sx * sx), icpt = (sy - slope * sx) / 20;
    return icpt + slope * 19;
  });
  // Supertrend(10, 3)
  const atr10: number[] = [];
  {
    let a = NaN, s = 0;
    for (let i = 0; i < b.length; i++) {
      if (i < ST_N) {
        s += tr[i];
        a = i === ST_N - 1 ? s / ST_N : NaN;
      } else a = (a * (ST_N - 1) + tr[i]) / ST_N;
      atr10.push(a);
    }
  }
  const stDir = new Array(b.length).fill(0);
  let fu = NaN, fl = NaN, dirn = 1;
  for (let i = 10; i < b.length; i++) {
    const hl2 = (b[i].h + b[i].l) / 2, bu = hl2 + ST_M * atr10[i], bl = hl2 - ST_M * atr10[i];
    fu = !Number.isFinite(fu) || bu < fu || b[i - 1].c > fu ? bu : fu;
    fl = !Number.isFinite(fl) || bl > fl || b[i - 1].c < fl ? bl : fl;
    if (dirn === 1 && b[i].c < fl) dirn = -1;
    else if (dirn === -1 && b[i].c > fu) dirn = 1;
    stDir[i] = dirn;
  }
  const { adx, pdi, mdi } = dmi(b);
  const busy: Record<string, number> = {};
  const add = (row: string, k: number, d: 1 | -1, exitFn: () => { xi: number; exit: number }) => {
    if (k + 1 >= b.length || b[k + 1].t < START || (busy[row] ?? -1) >= k + 1) return;
    const { xi, exit } = exitFn();
    busy[row] = xi;
    out.push(mk(coin, row, b, fund, k + 1, xi, d, b[k + 1].o, exit, NaN));
  };
  for (let k = 60; k < b.length - 1; k++) {
    // N3
    let run = 0;
    for (let j = k - 1; j >= 0 && sqz[j]; j--) run++;
    if (!sqz[k] && run >= 6 && Number.isFinite(mom[k]) && mom[k] !== 0) {
      const d: 1 | -1 = mom[k] > 0 ? 1 : -1;
      add(`N3-${tf}`, k, d, () => chandelier(b, k + 1, d, H));
    }
    // N4
    if (stDir[k] !== stDir[k - 1] && stDir[k - 1] !== 0 && adx[k] > ADXT) {
      const d = stDir[k] as 1 | -1;
      add(`N4-${tf}`, k, d, () => {
        for (let j = k + 1; j < b.length; j++) if (stDir[j] !== d) return { xi: Math.min(b.length - 1, j + 1), exit: b[Math.min(b.length - 1, j + 1)].o };
        return { xi: b.length - 1, exit: b[b.length - 1].c };
      });
    }
    // N5
    if (adx[k] > ADXS && adx[k - 1] <= ADXS) {
      const d: 1 | -1 = pdi[k] > mdi[k] ? 1 : -1;
      add(`N5-${tf}`, k, d, () => chandelier(b, k + 1, d, H));
    }
  }
  return out;
}

let seed = 4103;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
function randomR(coin: string, b: Bar[], fund: Map<number, number>, t: Trade, loI: number) {
  const len = t.xi - t.ei, rs: number[] = [];
  for (let n = 0; n < 50; n++) {
    const ei = loI + 1 + Math.floor(rnd() * (b.length - loI - len - 3));
    if (!(b[ei - 1].atr > 0)) continue;
    rs.push(mk(coin, "", b, fund, ei, ei + len, t.dir, b[ei].o, b[ei + len].c, NaN).r);
  }
  return mean(rs);
}

const f2 = (x: number) => (Number.isFinite(x) ? (x >= 0 ? "+" : "") + x.toFixed(2) : "—");
const pc = (x: number) => (Number.isFinite(x) ? (x * 100).toFixed(0) + "%" : "—");
const pOf = (t: number) => {
  const z = Math.abs(t), u = 1 / (1 + 0.2316419 * z);
  return 2 * 0.3989423 * Math.exp((-z * z) / 2) * u * (0.3193815 + u * (-0.3565638 + u * (1.781478 + u * (-1.821256 + u * 1.330274))));
};

const all: Trade[] = [];
const RR = new Map<Trade, number>();
for (const coin of COINS) {
  const j31 = JSON.parse(readFileSync(`${dir}/e31/${coin}.json`, "utf8")), j30 = JSON.parse(readFileSync(`${dir}/e30/${coin}.json`, "utf8"));
  const h1 = bars(j31.h1), h4 = bars(j30.h4);
  const f1 = fundMap(coin, 3600), f4 = fundMap(coin, 14400);
  const q = quietMap(h1);
  const sets: [Bar[], Map<number, number>, Trade[]][] = [
    [h1, f1, [...intraday(coin, h1, f1, q), ...swingTF(coin, "1h", h1, f1)]],
    [h4, f4, swingTF(coin, "4h", h4, f4)],
  ];
  for (const [b, f, ts] of sets) {
    const loI = b.findIndex((x) => x.t >= START);
    for (const t of ts) {
      all.push(t);
      RR.set(t, randomR(coin, b, f, t, loI));
    }
  }
}

console.log(`E41c 外部的趋势启动做法  币：${COINS.join(" / ")}（以 BTC 为准）  成本 0.15% + 资金费率  随机 50 个/笔（同方向、同持有根数）  R = 入场时 1 倍 ATR`);
const ROWS: [string, string][] = [
  ["N1", "1h 日内噪音区突破（Zarattini），VWAP 跟踪，当天平"],
  ["N2", "1h 威廉斯波动突破 k = 0.5，多空，拿到当天收盘"],
  ["N2L", "同上，只做多（原版）"],
  ["N3-1h", "1h TTM 挤压释放，3 ATR 吊灯"],
  ["N3-4h", "4h TTM 挤压释放，3 ATR 吊灯"],
  ["N4-1h", "1h Supertrend(10,3) 翻转 + ADX > 20，反向翻转平"],
  ["N4-4h", "4h Supertrend(10,3) 翻转 + ADX > 20，反向翻转平"],
  ["N5-1h", "1h ADX 上穿 25，3 ATR 吊灯"],
  ["N5-4h", "4h ADX 上穿 25，3 ATR 吊灯"],
];
const segs: [string, number, number][] = [
  ["全部 2020 起", START, Infinity],
  ["样本内前半", START, MID],
  ["样本内后半", MID, OOS],
  ["样本外 12 个月", OOS, Infinity],
];
const judge: { row: string; m: number; p: number; ok: boolean }[] = [];
for (const [rk, name] of ROWS) {
  console.log(`\n== ${rk} ${name} ==`);
  console.log("币     段              笔数  胜率   平均R   随机R   差R     t    平均持有根数");
  for (const coin of COINS) {
    const signs: number[] = [];
    let m0 = NaN, t0 = NaN;
    for (const [sname, lo, hi] of segs) {
      const ts = all.filter((t) => t.row === rk && t.coin === coin && t.t >= lo && t.t < hi);
      if (!ts.length) continue;
      const d = ts.map((t) => t.r - RR.get(t)!), tt = mean(d) / (sd(d) / Math.sqrt(d.length));
      if (sname === "全部 2020 起") (m0 = mean(d)), (t0 = tt);
      else signs.push(mean(d));
      console.log(
        `${coin.padEnd(5)}  ${sname.padEnd(13)}  ${String(ts.length).padStart(5)}  ${pc(ts.filter((t) => t.r > 0).length / ts.length).padStart(4)}  ${f2(mean(ts.map((t) => t.r))).padStart(6)}  ${f2(mean(ts.map((t) => RR.get(t)!))).padStart(6)}  ${f2(mean(d)).padStart(6)}  ${f2(tt).padStart(5)}   ${mean(ts.map((t) => t.xi - t.ei)).toFixed(1)}`,
      );
    }
    if (coin === "BTC") judge.push({ row: rk, m: m0, p: pOf(t0), ok: signs.every((x) => x > 0) });
  }
}
const sorted = [...judge].sort((a, b) => a.p - b.p), q = new Map<string, number>();
let prev = 1;
for (let i = sorted.length - 1; i >= 0; i--) {
  prev = Math.min(prev, (sorted[i].p * sorted.length) / (i + 1));
  q.set(sorted[i].row, prev);
}
console.log("\n== 判定（BTC：对随机 ≥ 0.1R、q < 0.05、前后两半和样本外都为正） ==");
for (const j of judge)
  console.log(`${j.row.padEnd(6)} 差R ${f2(j.m)}  q ${q.get(j.row)!.toFixed(3)}  各段为正 ${j.ok ? "是" : "否"}  → ${j.m >= 0.1 && q.get(j.row)! < 0.05 && j.ok ? "有优势" : j.m <= -0.1 && q.get(j.row)! < 0.05 ? "更差" : "没有可证明的优势"}`);

console.log("\n== 互相补充：N1 / N2 按之前 7 天波动分三档（E41b 口径），全部 2020 起 ==");
console.log("行    币     分组                笔数   平均R   差R     t");
for (const rk of ["N1", "N2"])
  for (const coin of COINS)
    for (const [gname, f] of [
      ["之前安静（最低 1/3）", (x: number) => x < 1 / 3],
      ["之前中等", (x: number) => x >= 1 / 3 && x < 2 / 3],
      ["之前动荡（最高 1/3）", (x: number) => x >= 2 / 3],
    ] as const) {
      const ts = all.filter((t) => t.row === rk && t.coin === coin && Number.isFinite(t.qv) && f(t.qv));
      const d = ts.map((t) => t.r - RR.get(t)!);
      console.log(`${rk.padEnd(4)}  ${coin.padEnd(5)}  ${gname.padEnd(18)}  ${String(ts.length).padStart(5)}  ${f2(mean(ts.map((t) => t.r))).padStart(6)}  ${f2(mean(d)).padStart(6)}  ${f2(mean(d) / (sd(d) / Math.sqrt(d.length))).padStart(5)}`);
    }

// ---------- N6 日线唐奇安组合 ----------
console.log("\n== N6 日线唐奇安组合（只做多，Binance 现货日线），每换 1 份仓扣 0.075% ==");
console.log("币     段               总收益    年化波动  夏普   最大回撤  持仓时间  一直持有收益  一直持有夏普  错开对照百分位");
const LB = [10, 20, 30, 60, 90, 150, 250];
for (const coin of COINS) {
  const d = bars(JSON.parse(readFileSync(`${dir}/spot/${coin}.json`, "utf8")));
  const state = LB.map(() => 0);
  const expo = new Array(d.length).fill(0);
  for (let i = 251; i < d.length; i++) {
    LB.forEach((L, m) => {
      let hh = -Infinity, ll = Infinity;
      for (let j = i - L; j < i; j++) (hh = Math.max(hh, d[j].h)), (ll = Math.min(ll, d[j].l));
      if (d[i].c > hh) state[m] = 1;
      else if (d[i].c < (hh + ll) / 2) state[m] = 0;
    });
    expo[i] = mean(state);
  }
  const ret = d.map((x, i) => (i ? x.c / d[i - 1].c - 1 : 0));
  const perf = (ex: number[], lo: number, hi: number) => {
    let eq = 1, peak = 1, dd = 0, inMkt = 0, n = 0;
    const rs: number[] = [];
    for (let i = 1; i < d.length; i++) {
      if (d[i].t < lo || d[i].t >= hi) continue;
      const r = ex[i - 1] * ret[i] - Math.abs(ex[i - 1] - (ex[i - 2] ?? 0)) * 0.00075;
      rs.push(r);
      eq *= 1 + r;
      peak = Math.max(peak, eq);
      dd = Math.max(dd, 1 - eq / peak);
      inMkt += ex[i - 1] > 0 ? 1 : 0;
      n++;
    }
    return { tot: eq - 1, vol: sd(rs) * Math.sqrt(365), sh: (mean(rs) / sd(rs)) * Math.sqrt(365), dd, inMkt: inMkt / n };
  };
  for (const [sname, lo, hi] of segs) {
    const p = perf(expo, lo, hi), bh = perf(expo.map(() => 1), lo, hi);
    const idx: number[] = [];
    d.forEach((x, i) => x.t >= lo && x.t < hi && idx.push(i));
    let below = 0;
    for (let s = 0; s < 500; s++) {
      const sh = 1 + Math.floor(rnd() * (idx.length - 2));
      const ex2 = expo.slice();
      idx.forEach((ii, k) => (ex2[ii] = expo[idx[(k + sh) % idx.length]]));
      if (perf(ex2, lo, hi).sh < p.sh) below++;
    }
    console.log(
      `${coin.padEnd(5)}  ${sname.padEnd(13)}  ${(p.tot * 100).toFixed(0).padStart(7)}%  ${(p.vol * 100).toFixed(0).padStart(6)}%  ${p.sh.toFixed(2).padStart(5)}  ${(p.dd * 100).toFixed(0).padStart(6)}%  ${pc(p.inMkt).padStart(6)}  ${(bh.tot * 100).toFixed(0).padStart(10)}%  ${bh.sh.toFixed(2).padStart(10)}  ${String(Math.round((below / 500) * 100)).padStart(10)}`,
    );
  }
}
