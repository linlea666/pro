/**
 * E44（2026-11-06）：博主的结构入场法。做多：“先反弹，突破前高（第一根反弹阳线的高点，或底部区间高点）；
 * 再次回落不刷新新低；下一次上涨突破前高就上车”，突破要看 1 小时收在关键位上方、再看 4 小时收线守住。
 * 做空对称：“跌破前低，反弹不过前高，再一次跌破，市价做空”。用户问能不能做成参考策略。只测 BTC / ETH。
 * 规则在跑之前定好（看结果之前写下，不再改；变体只换环境变量）：
 *
 * - 数据：Binance 永续 1 小时 K 线（e31-fetch.ts）、资金费率（e30-fetch.ts）；4 小时 = 1 小时按 UTC 0/4/8… 合成。
 *   ATR = 1 小时 14 根 Wilder。下面按做多写，做空镜像。
 * - 状态机（每根 1 小时收盘后更新）：
 *   ① 低点 L0：1 小时最低价是之前 LOOK（168 = 7 天）根的最低 → 新的 L0，之前的设置全部作废，从头开始；
 *   ② 前高 H1：L0 之后第一根阳线（收 > 开）的最高价（RANGE=1 变体：L0 之后 6 根的最高价，当作“底部区间高点”）；
 *   ③ 第一次突破 B1：之后某根 1 小时收盘 > H1；
 *   ④ 回落：B1 之后到过的最高价记为 H2（“前高”），之后有收盘 ≤ H2 − PULL（1）倍 ATR，且最低价一直没跌破 L0；回落最低价记为 P；
 *   ⑤ 再次突破 B2：回落之后，1 小时收盘 > H2；
 *   任何时候最低价跌破 L0 → 回到 ①（L0 换成新低）；从 L0 起超过 MAXBARS（240）根没走完 → 作废。
 * - 入场：
 *   S1 再次突破（1 小时收盘站上 H2，下一根开盘进）；
 *   S4 再次突破 + 4 小时收线守住：B2 之后第一根收盘的 4 小时 K 线收在 H2 之上才进（下一根开盘），没守住就放弃这次；
 *   F1 对照：第一次突破就进（B1 收盘，下一根开盘），“不等回落”；
 *   止损：S1 / S4 = P − 0.25 ATR；F1 = L0 − 0.25 ATR。风险 0.3–8 倍 ATR 才做。
 * - 离场 EXIT=chand（默认）：3 倍 1 小时 ATR 吊灯（只在收盘后上移），最长 240 根；EXIT=2r：固定 2R 止盈；同一根先算止损，跳空按开盘价。
 *   成本来回 0.15% + 持仓期资金费。R = 入场到止损。一个币、一条规则同时只持一笔。
 * - 对照：每笔 30 个随机入场（同币、2020 年起任一根开盘、同方向、同 ATR 倍数止损、同离场规则）；另 S1 对 F1、S4 对 S1。
 * - 切分：2020-01 起；样本外 = 2025-11-01 起，样本内再分前后两半。达标：对随机 ≥ 0.1R、BH q < 0.05、
 *   BTC / ETH / 前后两半 / 样本外都为正。
 *
 *   node --experimental-strip-types scripts/research-data/e44.ts <dataDir>   [环境变量 LOOK PULL RANGE EXIT COINS]
 */
import { readFileSync } from "node:fs";

const dir = process.argv[2];
const env = (k: string, d: string) => process.env[k] ?? d;
const LOOK = Number(env("LOOK", "168"));
const PULL = Number(env("PULL", "1"));
const RANGE = env("RANGE", "0") === "1";
const EXIT = env("EXIT", "chand");
const MAXBARS = Number(env("MAXBARS", "240"));
const COINS = env("COINS", "BTC,ETH").split(",");
const OOS = Date.UTC(2025, 10, 1) / 1000;
const COST = 0.0015;
const H = 3600;
type Bar = [number, number, number, number, number, number];

let seed = 44;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

function wilder(b: Bar[], n = 14) {
  const out = new Array(b.length).fill(NaN);
  let a = NaN, s = 0;
  for (let i = 1; i < b.length; i++) {
    const tr = Math.max(b[i][2] - b[i][3], Math.abs(b[i][2] - b[i - 1][4]), Math.abs(b[i][3] - b[i - 1][4]));
    if (i <= n) { s += tr; if (i === n) a = s / n; } else a = (a * (n - 1) + tr) / n;
    out[i] = a;
  }
  return out;
}

interface Trade { coin: string; rule: string; side: 1 | -1; t: number; r: number; rand: number[]; riskAtr: number; entry: number; stop: number; note: string }
const trades: Trade[] = [];

for (const coin of COINS) {
  const h1: Bar[] = JSON.parse(readFileSync(`${dir}/e31/${coin}.json`, "utf8")).h1;
  const funding: [number, number][] = JSON.parse(readFileSync(`${dir}/e30/${coin}.json`, "utf8")).funding;
  const fEnd = funding[funding.length - 1][0] + 8 * H;
  const atr = wilder(h1);
  const fundBetween = (a: number, b: number) => {
    let s = 0;
    for (const [t, r] of funding) if (t > a && t <= b) s += r;
    return s;
  };
  // simulate from bar i open, side, stop; returns R after cost or null (ran past data)
  const sim = (i: number, side: 1 | -1, stop: number): number | null => {
    const entry = h1[i][1];
    const risk = (entry - stop) * side;
    if (!(risk > 0)) return null;
    let st = stop, best = entry;
    const tp = entry + side * 2 * risk;
    for (let j = i; j < Math.min(h1.length, i + 240); j++) {
      const [, o, hi, lo, c] = h1[j];
      if (h1[j][0] + H > fEnd) return null;
      const exitAt = (px: number) => {
        const pct = (side * (px - entry)) / entry - COST - side * fundBetween(h1[i][0], h1[j][0] + H);
        return (pct * entry) / risk;
      };
      if (side > 0 ? lo <= st : hi >= st) return exitAt(side > 0 ? Math.min(o, st) : Math.max(o, st));
      if (EXIT === "2r" && (side > 0 ? hi >= tp : lo <= tp)) return exitAt(side > 0 ? Math.max(o, tp) : Math.min(o, tp));
      if (EXIT === "chand") {
        best = side > 0 ? Math.max(best, hi) : Math.min(best, lo);
        const ch = best - side * 3 * atr[j];
        st = side > 0 ? Math.max(st, ch) : Math.min(st, ch);
      }
      if (j === Math.min(h1.length, i + 240) - 1) return exitAt(c);
    }
    return null;
  };
  const randomR = (side: 1 | -1, riskAtr: number, n: number) => {
    const out: number[] = [];
    for (let k = 0; k < n * 3 && out.length < n; k++) {
      const i = 20 + Math.floor(rnd() * (h1.length - 300));
      const a = atr[i - 1];
      if (!(a > 0)) continue;
      const r = sim(i, side, h1[i][1] - side * riskAtr * a);
      if (r != null) out.push(r);
    }
    return out;
  };
  const busyUntil: Record<string, number> = {};
  const take = (rule: string, side: 1 | -1, k: number, stop: number, note: string) => {
    // k = signal bar (closed); enter at k+1 open
    const key = rule + side;
    if (k + 1 >= h1.length || (busyUntil[key] ?? -1) > k) return;
    const entry = h1[k + 1][1], a = atr[k];
    const riskAtr = ((entry - stop) * side) / a;
    if (!(riskAtr >= 0.3 && riskAtr <= 8)) return;
    const r = sim(k + 1, side, stop);
    if (r == null) return;
    // busy until exit: approximate by re-running to find exit bar
    let j = k + 1, st = stop, best = entry;
    const risk = (entry - stop) * side, tp = entry + side * 2 * risk;
    for (; j < Math.min(h1.length, k + 241); j++) {
      const [, , hi, lo] = h1[j];
      if (side > 0 ? lo <= st : hi >= st) break;
      if (EXIT === "2r" && (side > 0 ? hi >= tp : lo <= tp)) break;
      if (EXIT === "chand") { best = side > 0 ? Math.max(best, hi) : Math.min(best, lo); const ch = best - side * 3 * atr[j]; st = side > 0 ? Math.max(st, ch) : Math.min(st, ch); }
    }
    busyUntil[key] = j;
    trades.push({ coin, rule, side, t: h1[k][0], r, rand: randomR(side, riskAtr, 30), riskAtr, entry, stop, note });
  };

  for (const side of [1, -1] as const) {
    // mirror helpers: for shorts, "low" means high etc.
    const lo = (i: number) => (side > 0 ? h1[i][3] : -h1[i][2]);
    const hi = (i: number) => (side > 0 ? h1[i][2] : -h1[i][3]);
    const cl = (i: number) => side * h1[i][4];
    const green = (i: number) => side * (h1[i][4] - h1[i][1]) > 0;
    let st = 0; // 0 no L0, 1 have L0 waiting H1, 2 waiting B1, 3 after B1 tracking H2 / pullback, 4 pulled back waiting B2, 5 waiting 4h hold
    let L0 = 0, L0i = 0, H1 = 0, H2 = 0, P = 0, B2i = 0;
    let firstGreenSeen = false;
    for (let i = LOOK; i < h1.length - 1; i++) {
      // new 7-day extreme?
      let prev = Infinity;
      for (let j = i - LOOK; j < i; j++) prev = Math.min(prev, lo(j));
      if (lo(i) < prev || (st > 0 && lo(i) < L0)) {
        if (lo(i) < prev) {
          st = 1; L0 = lo(i); L0i = i; firstGreenSeen = false;
          continue;
        }
        st = 0; // broke L0 without being a 7-day extreme (cannot happen often) → wait for a fresh one
        continue;
      }
      if (st === 0) continue;
      if (i - L0i > MAXBARS) { st = 0; continue; }
      const a = atr[i];
      if (st === 1) {
        if (RANGE) {
          if (i - L0i >= 6) {
            H1 = -Infinity;
            for (let j = L0i + 1; j <= L0i + 6; j++) H1 = Math.max(H1, hi(j));
            st = 2;
          }
        } else if (!firstGreenSeen && green(i)) { H1 = hi(i); firstGreenSeen = true; st = 2; continue; }
        if (st === 1) continue;
      }
      if (st === 2) {
        if (cl(i) > H1) {
          st = 3; H2 = hi(i);
          const stopF = side > 0 ? L0 - 0.25 * a : -L0 + 0.25 * a;
          take("F1 第一次突破就进", side, i, stopF, "");
        }
        continue;
      }
      if (st === 3) {
        H2 = Math.max(H2, hi(i));
        if (cl(i) <= H2 - PULL * a) { st = 4; P = lo(i); }
        continue;
      }
      if (st === 4) {
        P = Math.min(P, lo(i));
        if (cl(i) > H2) {
          const stop = side > 0 ? P - 0.25 * a : -P + 0.25 * a;
          const real = (x: number) => side * x;
          take("S1 再次突破（1 小时收盘）", side, i, stop, `L0 ${real(L0)} 前高 ${real(H2)} 回落低 ${real(P)}`);
          B2i = i; st = 5;
          // B2 itself is the last hour of a 4-hour bar: that 4h close is above H2 already
          if ((h1[i][0] + H) % (4 * H) === 0) {
            take("S4 再次突破 + 4 小时收线守住", side, i, stop, `L0 ${real(L0)} 前高 ${real(H2)}`);
            st = 0;
          }
          continue;
        }
        continue;
      }
      if (st === 5) {
        P = Math.min(P, lo(i));
        const close4 = (h1[i][0] + H) % (4 * H) === 0;
        if (close4) {
          if (cl(i) > H2) {
            const stop = side > 0 ? P - 0.25 * a : -P + 0.25 * a;
            take("S4 再次突破 + 4 小时收线守住", side, i, stop, `L0 ${side * L0} 前高 ${side * H2}`);
          }
          // either way this setup is done; look for a fresh L0
          st = 0;
        }
        continue;
      }
    }
  }
}


const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const sd = (a: number[]) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
function normCdf(z: number) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}
const welch = (a: number[], b: number[]) => {
  if (a.length < 2 || b.length < 2) return { d: mean(a) - mean(b), p: 1 };
  const t = (mean(a) - mean(b)) / Math.sqrt(sd(a) ** 2 / a.length + sd(b) ** 2 / b.length);
  return { d: mean(a) - mean(b), p: 2 * (1 - normCdf(Math.abs(t))) };
};
function bh(ps: number[]) {
  const o = ps.map((p, i) => ({ p, i })).sort((x, y) => x.p - y.p);
  const q = new Array(ps.length).fill(1);
  let m = 1;
  for (let k = o.length - 1; k >= 0; k--) { m = Math.min(m, (o[k].p * ps.length) / (k + 1)); q[o[k].i] = m; }
  return q;
}
const f2 = (x: number) => (Number.isFinite(x) ? (x >= 0 ? "+" : "") + x.toFixed(2) : "—");
const ins = trades.filter((x) => x.t < OOS).map((x) => x.t).sort((a, b) => a - b);
const MID = ins[Math.floor(ins.length / 2)] ?? 0;
const segs = {
  BTC: (x: Trade) => x.coin === "BTC", ETH: (x: Trade) => x.coin === "ETH",
  前半: (x: Trade) => x.t < MID, 后半: (x: Trade) => x.t >= MID && x.t < OOS, 样本外: (x: Trade) => x.t >= OOS,
};
console.log(`E44 参数：LOOK=${LOOK} PULL=${PULL} RANGE=${RANGE ? 1 : 0} EXIT=${EXIT} MAXBARS=${MAXBARS} COINS=${COINS.join(",")}；样本内中点 ${new Date(MID * 1000).toISOString().slice(0, 10)}`);
console.log("行 | 笔数 | 平均 R | 胜率 | 随机 | 对随机 | p | q | 分段对随机（BTC ETH 前半 后半 样本外）");
const rows: { name: string; xs: Trade[] }[] = [];
const rules = [...new Set(trades.map((x) => x.rule))].sort();
for (const rule of rules) for (const side of [1, -1, 0]) {
  const xs = trades.filter((x) => x.rule === rule && (side === 0 || x.side === side));
  rows.push({ name: `${rule} ${side > 0 ? "做多" : side < 0 ? "做空" : "多空合计"}`, xs });
}
const res = rows.map((r) => ({ ...r, w: welch(r.xs.map((x) => x.r), r.xs.flatMap((x) => x.rand)) }));
const q = bh(res.map((r) => r.w.p));
res.forEach((r, k) => {
  const sg = Object.entries(segs).map(([n, f]) => {
    const a = r.xs.filter(f);
    return a.length < 5 ? `${n}:样本少` : `${n}:${f2(mean(a.map((x) => x.r)) - mean(a.flatMap((x) => x.rand)))}(${a.length})`;
  }).join(" ");
  console.log(`${r.name} | ${r.xs.length} | ${f2(mean(r.xs.map((x) => x.r)))} | ${((r.xs.filter((x) => x.r > 0).length / (r.xs.length || 1)) * 100).toFixed(0)}% | ${f2(mean(r.xs.flatMap((x) => x.rand)))} | ${f2(r.w.d)} | ${r.w.p.toFixed(3)} | ${q[k].toFixed(3)} | ${sg}`);
});
console.log();
console.log("配对（同一批设置）：");
const pair = (a: string, b: string) => {
  for (const side of [1, -1] as const) {
    const A = trades.filter((x) => x.rule.startsWith(a) && x.side === side), B = trades.filter((x) => x.rule.startsWith(b) && x.side === side);
    const w = welch(A.map((x) => x.r), B.map((x) => x.r));
    console.log(`${a} 对 ${b}（${side > 0 ? "做多" : "做空"}）：${A.length} 对 ${B.length} 笔，差 ${f2(w.d)}R，p ${w.p.toFixed(3)}`);
  }
};
pair("S1", "F1");
pair("S4", "S1");
console.log();
console.log("风险（入场到止损）中位，单位 1 小时 ATR：", rules.map((r) => {
  const s = trades.filter((x) => x.rule === r).map((x) => x.riskAtr).sort((a, b) => a - b);
  return `${r.slice(0, 2)} ${s[Math.floor(s.length / 2)]?.toFixed(2)}`;
}).join(" · "));
console.log();
console.log("== BTC 2026-08 以来的 S1 / S4 ==");
for (const x of trades.filter((x) => x.coin === "BTC" && x.rule[0] === "S" && x.t >= Date.UTC(2026, 7, 1) / 1000).sort((a, b) => a.t - b.t)) {
  console.log(`${new Date((x.t + 9 * H) * 1000).toISOString().slice(0, 16).replace("T", " ")}（北京，收盘）${x.rule.slice(0, 2)} ${x.side > 0 ? "多" : "空"} 入场 ${x.entry} 止损 ${x.stop.toFixed(0)} 结果 ${f2(x.r)}R ${x.note}`);
}
