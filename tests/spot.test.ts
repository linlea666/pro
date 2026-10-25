import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

// a throwaway database: env.ts reads DATA_DIR when first imported
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sl-spot-"));
process.env.LOG_LEVEL = "error";
const { getDb, migrate, SCHEMA_VERSION } = await import("../src/lib/server/db.ts");
const { syncSpotDaily, spotSeries, fngPoints } = await import("../src/lib/data/spot.ts");
const v = await import("../src/lib/spot/valuation.ts");
const st = await import("../src/lib/spot/stack.ts");
const { parseOpinionZones, validateOpinionZones, DEFAULT_OPINION_ZONES } = await import("../src/lib/spot/opinion.ts");

/** Small deterministic PRNG */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/** A contiguous daily series from `start` with the given prices; supply 20M, no MVRV / F&G unless given. */
function series(price: number[], extra: Partial<Pick<import("../src/lib/spot/valuation.ts").SpotSeries, "mvrv" | "fng">> = {}, start = "2014-01-01"): import("../src/lib/spot/valuation.ts").SpotSeries {
  const d0 = v.dayNum(start);
  return {
    day: price.map((_, i) => v.dayStr(d0 + i)),
    price,
    supply: price.map(() => 20e6),
    mvrv: extra.mvrv ?? price.map(() => null),
    fng: extra.fng ?? price.map(() => null),
  };
}

test("expanding percentile: equals the plain count of earlier values ≤ today, skips nulls, needs the minimum history", () => {
  const r = rng(3);
  const x = Array.from({ length: 600 }, () => (r() < 0.1 ? null : Math.round(r() * 50)));
  const fast = v.expandingPercentile(x, 100);
  const seen: number[] = [];
  x.forEach((val, i) => {
    if (val == null) return assert.equal(fast[i], null);
    const want = seen.length >= 100 ? seen.filter((y) => y <= val).length / seen.length : null;
    assert.equal(fast[i], want, `day ${i}`);
    seen.push(val);
  });
  assert.deepEqual(v.expandingPercentile([1, 2, 3, 2], 2), [null, null, 1, 2 / 3]);
});

test("rulers: Mayer and 200-week average math; truncating the series changes nothing before the cut", () => {
  const p = Array.from({ length: 2000 }, (_, i) => i + 1);
  const s = series(p, { mvrv: p.map((_, i) => 1 + (i % 7) / 10) });
  const r = v.rulers(s);
  assert.equal(r.ma200[198], null);
  assert.equal(r.ma200[199], 100.5);
  assert.ok(Math.abs(r.mayer[1500]! - 1501 / (1501 - 99.5)) < 1e-12);
  // 200 weekly closes: every 7th day back, first available on day 199 × 7
  assert.equal(r.wma200[1392], null);
  assert.ok(Math.abs(r.wma200[1393]! - (1394 - 7 * 99.5)) < 1e-9);
  assert.ok(Math.abs(r.wmaMult[1999]! - 2000 / (2000 - 696.5)) < 1e-12);
  assert.ok(Math.abs(r.realized[10]! - 11 / 1.3) < 1e-12);
  assert.equal(r.marketCap[0], 20e6);
  const cut = v.rulers(series(p.slice(0, 1600), { mvrv: s.mvrv.slice(0, 1600) }));
  for (const k of ["ma200", "mayer", "wma200", "wmaMult", "realized"] as const) assert.deepEqual(cut[k], r[k].slice(0, 1600), k);
  for (const k of ["mvrv", "mayer", "wmaMult"] as const) assert.deepEqual(cut.pct[k], r.pct[k].slice(0, 1600), `pct ${k}`);
});

test("spotNow: low lines, their prices and the last episode; 52-week high", () => {
  const p = Array.from({ length: 2000 }, (_, i) => 100 + 50 * Math.sin(i / 60));
  const mvrv = p.map((_, i) => (i >= 1700 && i <= 1720 ? 0.9 : 1.5));
  const s = series(p, { mvrv });
  const n = v.spotNow(s);
  assert.equal(n.day, s.day[1999]);
  const m = n.lowLines.find((x) => x.key === "mvrv1")!;
  assert.ok(Math.abs(m.price! - p[1999] / 1.5) < 1e-9, "MVRV 1 = the realized price");
  assert.equal(m.inZone, false);
  assert.equal(m.lastDay, s.day[1720]);
  assert.equal(m.lastStart, s.day[1700]);
  assert.equal(m.daysSince, 279);
  const mayer = n.lowLines.find((x) => x.key === "mayer08")!;
  assert.ok(Math.abs(mayer.price! - 0.8 * n.mayer.ma200!) < 1e-9);
  assert.equal(n.lowLines.find((x) => x.key === "wma")!.price, n.wma.wma200);
  const hi = Math.max(...p.slice(1635));
  assert.equal(n.high52w.price, hi);
  assert.equal(n.mayer.zone, v.pctZone(n.mayer.pct));
});

test("episodes: days in a zone within 90 days are one episode; the verdict never claims an edge", () => {
  const p = Array.from({ length: 2000 }, (_, i) => 100 * 1.001 ** i);
  const mvrv = p.map((_, i) => ((i >= 100 && i <= 110) || (i >= 150 && i <= 160) || (i >= 300 && i <= 305) ? 0.8 : 1.5));
  const e = v.episodes(series(p, { mvrv }), "mvrv1");
  assert.equal(e.totalDays, 28);
  assert.deepEqual(
    e.rows.map((x) => [x.start, x.end, x.days]),
    [
      [v.dayStr(v.dayNum("2014-01-01") + 100), v.dayStr(v.dayNum("2014-01-01") + 160), 22],
      [v.dayStr(v.dayNum("2014-01-01") + 300), v.dayStr(v.dayNum("2014-01-01") + 305), 6],
    ],
  );
  // a steady rise: every day's 1-year multiple is the same, so episode and baseline match
  const y1 = e.summary[0];
  assert.equal(y1.n, 2);
  assert.ok(Math.abs(e.rows[0].horizons[0].mult! - 1.001 ** 365) < 1e-9);
  assert.ok(Math.abs(y1.ratio! - 1) < 1e-9);
  assert.match(y1.verdict, /^样本不足（只有 2 段），各段方向/);
  assert.equal(v.episodeVerdict(5, true), "样本不足（只有 5 段），各段方向一致");
});

test("capZonePrices and the planner's reference prices", () => {
  const z = v.capZonePrices(20e6, [{ label: "囤货区", from: 1.2e12, to: 1.5e12 }, { label: "恐慌区", from: 0, to: 1e12 }]);
  assert.deepEqual(
    z.map((x) => [x.priceFrom, x.priceTo]),
    [
      [60000, 75000],
      [0, 50000],
    ],
  );
  const now = v.spotNow(series(Array.from({ length: 1500 }, (_, i) => 100 + i), { mvrv: Array.from({ length: 1500 }, () => 2) }));
  const refs = v.spotRefs(now, z);
  assert.ok(refs.some((r) => r.kind === "calc" && r.label === "200 周均线"));
  assert.deepEqual(refs.filter((r) => r.kind === "opinion").map((r) => r.price), [60000, 75000, 50000], "a zero edge is not a reference");
});

test("Fear & Greed block: Chinese band, a week and a month ago", () => {
  const pts = Array.from({ length: 40 }, (_, i) => ({ day: v.dayStr(v.dayNum("2026-01-01") + i), value: i + 10 }));
  const b = v.fngBlock(pts)!;
  assert.equal(b.value, 49);
  assert.equal(b.label, "中性");
  assert.equal(b.ago7, 42);
  assert.equal(b.ago30, 19);
  assert.equal(b.pct, null, "under two years of history: no percentile");
  assert.deepEqual([0, 25, 26, 46, 47, 54, 55, 75, 76, 100].map(v.fngLabel), ["极度恐惧", "极度恐惧", "恐惧", "恐惧", "中性", "中性", "贪婪", "贪婪", "极度贪婪", "极度贪婪"]);
});

const EX: import("../src/lib/spot/stack.ts").StackInput = {
  budget: 40000,
  headPrice: 75000,
  floorPrice: 45000,
  levels: 4,
  shape: "pyramid",
  dcaShare: 0,
  reserveShare: 0,
  horizonDays: 180,
  fomoPct: 0.15,
  fomoWeeks: 8,
};

test("ladder: levels from head to floor, pyramid 15/20/25/40 for four levels, cumulative cost", () => {
  assert.deepEqual(st.levelPrices(EX), [75000, 65000, 55000, 45000]);
  const g = st.levelPrices({ ...EX, spacing: "geometric" });
  assert.equal(g[0], 75000);
  assert.equal(g[3], 45000);
  assert.ok(Math.abs(g[1] / g[0] - g[2] / g[1]) < 1e-12, "geometric: equal ratios");
  assert.deepEqual(st.levelWeights("pyramid", 4), [0.15, 0.2, 0.25, 0.4]);
  assert.deepEqual(st.levelWeights("pyramid", 5), [1, 2, 3, 4, 5].map((k) => k / 15));
  assert.deepEqual(st.levelWeights("equal", 3), [1 / 3, 1 / 3, 1 / 3]);
  assert.deepEqual(st.levelWeights("custom", 3, [1, 1, 2]), [0.25, 0.25, 0.5]);
  const l = st.buildLadder({ ...EX, dcaShare: 0.4, reserveShare: 0.1 }, [{ label: "200 周均线", price: 66000, kind: "calc" }]);
  assert.equal(l.ladderUsd, 20000);
  assert.equal(l.dcaWeeks, 26);
  assert.deepEqual(l.rows.map((r) => r.usd), [3000, 4000, 5000, 8000]);
  assert.ok(Math.abs(l.rows[3].cumBtc - l.rows.reduce((a, r) => a + r.btc, 0)) < 1e-12);
  assert.ok(Math.abs(l.rows[1].cumAvgCost - 7000 / (l.rows[0].btc + l.rows[1].btc)) < 1e-9);
  assert.equal(l.rows[1].snapTo?.price, 66000, "within 3% of 65,000");
  assert.equal(l.rows[0].snapTo, null);
  assert.deepEqual(st.snapLevels([75000, 65000], [{ label: "x", price: 66000, kind: "opinion" }]).map((x) => x.price), [75000, 66000]);
  assert.deepEqual(st.validateStack(EX), []);
  assert.ok(st.validateStack({ ...EX, floorPrice: 80000, levels: 7, reserveShare: 0.6 }).length >= 3);
});

test("scenarios: the user's example (4 万 U, 75k/65k/55k/45k pyramid) — a crash to 40k gets 0.7405 BTC before fees", () => {
  const noFee = st.scenarios({ ...EX, fee: 0 }, { crashPrice: 40000 });
  const crash = noFee.find((x) => x.key === "crash")!;
  assert.ok(Math.abs(crash.btc - 0.7405) < 0.001, String(crash.btc));
  assert.equal(crash.ladderFilled, 4);
  assert.ok(Math.abs(crash.lumpBtc - 40000 / 75000) < 1e-12);
  assert.equal(crash.cashLeft, 0);
  assert.ok(Math.abs(crash.pnlAtBottom - (crash.btc * 40000 - 40000)) < 1e-9);
  // the E23 example's middle path: down to 60k fills two levels, the rest is bought at 80k
  const mid = noFee.find((x) => x.key === "mid")!;
  assert.equal(mid.bottom, 60000);
  assert.ok(Math.abs(mid.btc - 0.528) < 0.001, String(mid.btc));
  // with the 0.1% fee every buy gets 0.999 of the coins
  const fee = st.scenarios(EX, { crashPrice: 40000 }).find((x) => x.key === "crash")!;
  assert.ok(Math.abs(fee.btc - crash.btc * 0.999) < 1e-12);
  // head is the bottom: the rise past head × 1.15 spreads the unfilled levels (anti-FOMO)
  const top = noFee.find((x) => x.key === "top")!;
  assert.equal(top.fomo, true);
  assert.equal(top.ladderFilled, 1);
  // reserve: triggers only when the path reaches its price
  const withRes = st.scenarios({ ...EX, reserveShare: 0.1, dcaShare: 0.4 }, { reservePrice: 50000 });
  assert.deepEqual(withRes.map((x) => x.reserveAt), ["end", "end", "trigger"]);
});

test("replay: a flat market gives every scheme the same coins; anti-FOMO buys on a steady rise", () => {
  const n = 1600;
  const flat = { day: series(Array(n).fill(100), {}, "2015-01-01").day, price: Array(n).fill(100), reserve: Array(n).fill(false) };
  const plan = { ...EX, dcaShare: 0.4, reserveShare: 0.1 };
  const r = st.replay(plan, flat, { currentPrice: 75000 })!;
  assert.equal(r.starts, n - 1 - 180 - 60 + 1);
  for (const x of [r.vsLump, r.vsDca]) for (const k of ["median", "p10", "p90"] as const) assert.ok(Math.abs(x[k] - 1) < 1e-9, `${k} ${x[k]}`);
  // rising 1% a day, ladder only: the head fills on the start day, the price passes head × 1.15 on day 15,
  // and the other 85% goes in over 8 weekly buys from there
  const up = Array.from({ length: n }, (_, i) => 100 * 1.01 ** i);
  const hist = { day: flat.day, price: up, reserve: flat.reserve };
  const ladderOnly = { ...EX, dcaShare: 0, reserveShare: 0 };
  const a = st.replay(ladderOnly, hist, { currentPrice: 75000, series: true })!;
  let want = 0.15;
  for (let j = 0; j < 8; j++) want += 0.85 / 8 / 1.01 ** (15 + 7 * j);
  assert.ok(Math.abs(a.series!.vsLump[0] - want) < 1e-9, `${a.series!.vsLump[0]} vs ${want}`);
  const noFomo = st.replay({ ...ladderOnly, fomoPct: 1000 }, hist, { currentPrice: 75000 })!;
  assert.ok(a.vsLump.median > noFomo.vsLump.median, "without anti-FOMO the rest is bought at the horizon, higher");
  // the reserve buys on the first signal day
  const sig = { ...flat, price: up, reserve: flat.reserve.map((_, i) => i % 400 === 10) };
  const res = st.replay({ ...EX, dcaShare: 0.5, reserveShare: 0.5 }, sig, { currentPrice: 75000, series: true })!;
  let dcaWant = 0.5 / 1.01 ** 10;
  for (let j = 0; j < 26; j++) dcaWant += 0.5 / 26 / 1.01 ** (7 * j);
  assert.ok(Math.abs(res.series!.vsLump[0] - dcaWant) < 1e-9, `${res.series!.vsLump[0]} vs ${dcaWant}`);
  // the wire format round-trips
  const h = st.expandHistory({ start: "2015-01-01", price: [1, 2, 3], reserve: "010" });
  assert.deepEqual(h, { day: ["2015-01-01", "2015-01-02", "2015-01-03"], price: [1, 2, 3], reserve: [false, true, false] });
});

test("opinion zones: validation and a safe fallback", () => {
  assert.equal(validateOpinionZones(JSON.stringify(DEFAULT_OPINION_ZONES)), null);
  assert.match(validateOpinionZones("{")!, /JSON/);
  assert.match(validateOpinionZones({ source: "x", date: "", zones: [] })!, /1–8/);
  assert.match(validateOpinionZones({ source: "x", date: "", zones: [{ label: "a", from: 2, to: 1 }] })!, /下沿/);
  assert.match(validateOpinionZones({ source: "x", date: "", zones: [{ label: "一二三四五六七八九十一二三四五六七八九十一", from: 1, to: 2 }] })!, /20/);
  assert.deepEqual(parseOpinionZones("nonsense"), { value: DEFAULT_OPINION_ZONES, bad: true });
  assert.equal(parseOpinionZones(JSON.stringify({ source: " s ", date: "d", zones: [{ label: "a", from: 0, to: 1 }] })).value.source, "s");
});

test("migration 12: the spot table on a fresh database and on a v11 one", () => {
  const fresh = new Database(":memory:");
  migrate(fresh);
  assert.equal(fresh.pragma("user_version", { simple: true }), SCHEMA_VERSION);
  const old = new Database(":memory:");
  migrate(old, 11);
  old.prepare("INSERT INTO coins (id, name, sort, added_at) VALUES ('BTC', 'Bitcoin', 0, 1)").run();
  migrate(old);
  assert.equal(old.pragma("user_version", { simple: true }), SCHEMA_VERSION);
  old.prepare("INSERT INTO spot_daily (asset, day, price, updated_at) VALUES ('BTC', '2026-10-20', 1, 1)").run();
  assert.deepEqual(old.prepare("SELECT asset, day, price, supply, mvrv, fng FROM spot_daily").all(), [{ asset: "BTC", day: "2026-10-20", price: 1, supply: null, mvrv: null, fng: null }]);
  assert.equal((old.prepare("SELECT COUNT(*) n FROM coins").get() as { n: number }).n, 1);
});

test("sync: Coin Metrics pages and Fear & Greed upsert their own columns; a failing source does not block the other", async () => {
  getDb();
  const urls: string[] = [];
  let cmUp = true;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const cmRow = (day: string, p: number) => ({ asset: "btc", time: `${day}T00:00:00.000000000Z`, PriceUSD: String(p), SplyCur: "19000000", CapMVRVCur: "1.5" });
  globalThis.fetch = (async (input: string) => {
    urls.push(input);
    const u = new URL(input);
    if (u.host === "community-api.coinmetrics.io") {
      if (!cmUp) return json({ error: "down" }, 500);
      // the full download comes in two pages; later syncs get the recent days
      if (u.searchParams.get("start_time") === "2010-07-18" && !u.searchParams.get("next_page_token"))
        return json({ data: [cmRow("2026-10-15", 100), cmRow("2026-10-16", 101)], next_page_url: `${input}&next_page_token=x` });
      if (u.searchParams.get("next_page_token")) return json({ data: [cmRow("2026-10-18", 103), cmRow("2026-10-19", 104)] });
      return json({ data: [cmRow("2026-10-16", 101), cmRow("2026-10-19", 105), cmRow("2026-10-20", 106)] });
    }
    if (u.host === "api.alternative.me") {
      const day = (d: string) => String(Date.parse(`${d}T00:00:00Z`) / 1000);
      return json({ data: [{ value: "63", timestamp: day("2026-10-21") }, { value: "20", timestamp: day("2026-10-16") }] });
    }
    return json({}, 404);
  }) as typeof fetch;

  const a = await syncSpotDaily();
  assert.deepEqual(a, { cmDays: 4, fngDays: 2, lastDay: "2026-10-19" });
  assert.ok(urls.some((x) => x.includes("fng/?limit=0")), "the whole Fear & Greed history first");
  // a missing day (10-17) is carried forward without a Fear & Greed value
  const s = spotSeries()!;
  assert.deepEqual(s.day, ["2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18", "2026-10-19"]);
  assert.deepEqual(s.price, [100, 101, 101, 103, 104]);
  assert.deepEqual(s.fng, [null, 20, null, null, null]);
  assert.deepEqual(fngPoints().map((x) => x.day), ["2026-10-16", "2026-10-21"]);

  urls.length = 0;
  const b = await syncSpotDaily();
  assert.equal(b.lastDay, "2026-10-20");
  assert.ok(urls[0].includes("start_time=2026-10-16"), "refetch from 3 days before the last stored price");
  assert.ok(urls.some((x) => x.includes("fng/?limit=10")));
  assert.equal(spotSeries()!.price.at(-2), 105, "revised values replace the old ones");
  assert.deepEqual(spotSeries()!.fng.slice(0, 2), [null, 20], "a price update keeps the Fear & Greed column");

  cmUp = false;
  const c = await syncSpotDaily();
  assert.match(c.error!, /coinmetrics/);
  assert.equal(c.fngDays, 2, "Fear & Greed still updated");
});

test("bottom list: weekly RSI on every 7th close, Pi Cycle, and episodes of the first half-lit day per cycle", async () => {
  const b = await import("../src/lib/spot/bottoms.ts");
  // weekly RSI: steady weekly gains → 100; one interleaved series per weekday
  const up = Array.from({ length: 7 * 20 }, (_, i) => 100 + Math.floor(i / 7));
  const r = b.weeklyRsi(up);
  assert.equal(r[7 * 14 - 1], null);
  assert.equal(r[7 * 14 + 6], 100);
  // alternating +2 / −1 weeks: Wilder average gain 1 / loss 0.5 after the seed → RSI near 66.7
  const alt = [100];
  for (let w = 1; w <= 60; w++) alt.push(alt[w - 1] + (w % 2 ? 2 : -1));
  const daily = alt.flatMap((p) => Array(7).fill(p));
  const ra = b.weeklyRsi(daily)[daily.length - 1]!;
  assert.ok(Math.abs(ra - 66.7) < 2, String(ra));
  // ema seeds with the first value and is null before n days
  assert.deepEqual(b.ema([1, 1, 1, 4], 3).map((x) => (x == null ? null : Math.round(x * 100) / 100)), [null, null, 1, 2.5]);

  // a 6-year series: a long rise, a crash to a third, a slow recovery; MVRV < 1 during the crash
  const n = 6 * 365;
  const p = Array.from({ length: n }, (_, i) => (i < 1500 ? 100 + i : i < 1600 ? 1600 - (i - 1500) * 10 : 600 + (i - 1600) * 2));
  const s = series(p, { mvrv: p.map((_, i) => (i >= 1550 && i < 1700 ? 0.9 : 1.5)) });
  const L = b.bottomList(s, v.rulers(s))!;
  assert.equal(L.items.length, 6);
  assert.equal(L.litCount, L.items.filter((x) => x.lit).length);
  assert.equal(L.episodes.length, 1, JSON.stringify(L.episodes.map((e) => e.start)));
  const e = L.episodes[0];
  assert.ok(e.lit.length >= b.BOTTOM_RULES.half);
  assert.ok(e.drawdownPct <= 0);
  assert.equal(e.low, Math.min(...p.slice(v.dayNum(e.start) - v.dayNum(s.day[0]), v.dayNum(e.start) - v.dayNum(s.day[0]) + 731)));
  const age = v.dayNum(s.day[n - 1]) - v.dayNum(e.start);
  assert.deepEqual(L.higher.map((h) => h.n), b.BOTTOM_RULES.horizons.map((h) => (age >= h ? 1 : 0)));
  assert.ok(age >= 365);
  assert.equal(L.furtherDrop!.n, 1);
  // price lines report where they light and how far that is
  const w = L.items.find((x) => x.key === "ma200")!;
  assert.ok(w.price != null && w.distPct != null && !w.lit && w.distPct < 0);
});
