/**
 * E38（2026-10-31）收集：按页面同一套代码（`analyzeAt`、`paAt`、`bigTrendAt`），逐根 4 小时收盘回放 BTC，
 * 记下每个模块当时的状态和新出现的信号，写成 JSONL，给 e38.ts 打分。只读本地库，不改任何规则。
 *   DATA_DIR=<库> node --experimental-strip-types scripts/research-data/e38-collect.ts <开始 UTC> <结束 UTC> <输出.jsonl>
 * 每行一根 4 小时 K 线（t = 开盘时刻，UTC 秒）：
 *   light / trend / trendScore / reso / resoStrong（同 signals.ts 的共振门槛）/ fib（方向、回撤比例）/ chan（这时看得到的买卖点）/
 *   td（这时看得到的 9、13 事件）/ s4（4 小时结构方向）/ ph4（4 小时行情阶段）/ day、week（结构方向，bigTrendAt）/
 *   d1Light、d1Trend（最近一根已收盘日线的红绿灯和趋势强度）/ pa（这一根刚入场的裸 K 形态）。
 */
import fs from "node:fs";
const [from, to, out] = process.argv.slice(2);
const { analyzeAt } = await import("../../src/lib/analysis.ts");
const { paAt } = await import("../../src/lib/pa.ts");
const { bigTrendAt } = await import("../../src/lib/bigtrend.ts");
const { currentParams } = await import("../../src/lib/server/params-store.ts");
const { atrSeries } = await import("../../src/lib/ta/risk.ts");
const { structureDirection, structureSeries } = await import("../../src/lib/ta/structure.ts");
const { phaseAt } = await import("../../src/lib/ta/phase.ts");

const ep = currentParams().engine;
const H4 = 14400, D1 = 86400;
const t0 = Date.parse(from) / 1000, t1 = Date.parse(to) / 1000;
const fd = fs.openSync(out, "w");
const dayCache = new Map<number, { light: string; trend: number; label: string }>();
let n = 0;
for (let t = t0; t <= t1; t += H4) {
  const a = await analyzeAt("BTC", "4h", t).catch(() => null); // the newest closed bar has no future to replay and is refused
  if (!a || a.lastClosedT !== t) continue;
  const c = a.candles;
  const atr = atrSeries(c);
  const ss = structureSeries(c, atr, ep.structure.swingAtr);
  const L = c.length - 1;
  const ph = phaseAt(c, atr, ss, L, ep.structure.swingAtr);
  const strong = Math.max(1, Math.round((a.indicators.total * ep.indicators.strongPct) / 100));
  const dOpen = Math.floor((t + H4) / D1) * D1 - D1; // last daily bar closed by this 4h close
  if (!dayCache.has(dOpen)) {
    const d = await analyzeAt("BTC", "1d", dOpen);
    dayCache.set(dOpen, { light: d.verdict.light, trend: d.trend.current, label: d.trend.label });
  }
  const big = await bigTrendAt("BTC", t + H4, ep.structure.swingAtr).catch(() => null);
  let pa: { kind: string; dir: number; entry: number; stop: number; ok: boolean }[] = [];
  try {
    const v = await paAt("BTC", "4h", t + H4);
    pa = (v.recent ?? []).filter((s) => s.eT === t && s.entry != null).map((s) => ({ kind: s.kind, dir: s.dir, entry: s.entry!, stop: s.stop, ok: s.ok, loc: s.loc, trend: s.trend } as never));
  } catch {}
  const row = {
    t, src: a.source, o: c[L].o, h: c[L].h, l: c[L].l, close: c[L].c, atr: atr[L],
    light: a.verdict.light, trend: a.trend.current, trendLabel: a.trend.label,
    reso: a.indicators.resonance.at(-1)?.net ?? 0, resoStrong: strong,
    fib: a.fib ? { dir: a.fib.direction, r: a.fib.currentRatio } : null,
    chan: a.chan.points.map((p) => ({ t: p.t, type: p.type, price: p.price })),
    td: a.td.events.filter((e) => e.t >= t - 30 * H4).map((e) => ({ t: e.t, side: e.side, kind: e.kind })),
    s4: structureDirection(ss[L]), ph4: ph ? { dir: ph.dir, stage: ph.stage } : null,
    day: big?.day.dir ?? null, week: big?.week.dir ?? null,
    d1: dayCache.get(dOpen), pa,
  };
  fs.writeSync(fd, JSON.stringify(row) + "\n");
  if (++n % 50 === 0) process.stderr.write(`  ${n} ${new Date(t * 1000).toISOString()}\n`);
}
fs.closeSync(fd);
console.log("done", n);
