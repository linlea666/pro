import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// a throwaway database: env.ts reads DATA_DIR when first imported
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sl-history-"));
process.env.LOG_LEVEL = "error";
const { getDb } = await import("../src/lib/server/db.ts");
const { pruneStoredKlines, store } = await import("../src/lib/data/klines.ts");
const { findGaps, historyCoverage, syncHistory } = await import("../src/lib/data/history.ts");

const H = 3600;
const NOW = 1_800_000_000 - (1_800_000_000 % H);
const LISTED = NOW - 400 * 24 * H; // the exchange's first 1h bar: 400 days ago
const OUTAGE = [NOW - 300 * 24 * H, NOW - 300 * 24 * H + 5 * H]; // 4 bars the exchange never had
const bar = (t: number) => ({ t, o: 1, h: 2, l: 0.5, c: 1.5, v: 10 });

/** Binance klines for one 1h series, answering startTime / endTime / limit like the real API. */
let calls = 0;
globalThis.fetch = (async (url: string) => {
  calls++;
  const q = new URL(url).searchParams;
  const limit = Number(q.get("limit"));
  const start = q.has("startTime") ? Number(q.get("startTime")) / 1000 : LISTED;
  const end = q.has("endTime") ? Number(q.get("endTime")) / 1000 : NOW;
  const all: number[] = [];
  for (let t = Math.ceil(Math.max(start, LISTED) / H) * H; t <= Math.min(end, NOW); t += H) {
    if (!(t > OUTAGE[0] && t < OUTAGE[1])) all.push(t);
  }
  // SOL and ETH answer like the real API (taker buy volume in field 9); BTC like an older stub without it
  const full = q.get("symbol") !== "BTCUSDT";
  const rows = (q.has("startTime") ? all.slice(0, limit) : all.slice(-limit)).map((t) =>
    full ? [t * 1000, "1", "2", "0.5", "1.5", "10", t * 1000 + H * 1000 - 1, "15", 7, "4", "6", "0"] : [t * 1000, "1", "2", "0.5", "1.5", "10"],
  );
  return new Response(JSON.stringify(rows), { status: 200 });
}) as typeof fetch;

const count = () => (getDb().prepare("SELECT COUNT(*) n FROM candles WHERE coin = 'BTC' AND tf = '1h' AND source = 'binance-futures'").get() as { n: number }).n;

test("history: walks back to the exchange's first bar, then repairs a deleted stretch", async () => {
  // the live loader stored the newest 2000 bars
  store("BTC", "1h", "binance-futures", Array.from({ length: 2000 }, (_, k) => bar(NOW - (1999 - k) * H)));
  const opts = { nowSec: NOW, pauseMs: 0, coins: ["BTC"], tfs: ["1h" as const] };

  const r = await syncHistory(opts);
  assert.equal(r.error, undefined);
  assert.equal(r.complete, true);
  const first = getDb().prepare("SELECT MIN(t) t FROM candles WHERE coin = 'BTC' AND tf = '1h' AND source = 'binance-futures'").get() as { t: number };
  assert.equal(first.t, LISTED, "reaches the listing (400 days is inside the 2-year target)");
  assert.equal(count(), 400 * 24 + 1 - 4, "every bar the exchange has, nothing twice");
  const [c] = historyCoverage(NOW, ["BTC"], ["1h"]);
  assert.equal(c.complete, true);
  assert.equal(c.exchangeStart, LISTED);

  // the exchange's own outage was looked at once and remembered
  assert.deepEqual(findGaps("BTC", "1h"), [[OUTAGE[0], OUTAGE[1]]]);
  assert.equal(c.exchangeHoles, 1);
  assert.equal(c.gaps, 0);

  // delete a stretch by hand: the next run finds it and fetches it again, nothing else
  getDb().prepare("DELETE FROM candles WHERE coin = 'BTC' AND tf = '1h' AND source = 'binance-futures' AND t > ? AND t < ?").run(NOW - 50 * 24 * H, NOW - 40 * 24 * H);
  assert.equal(historyCoverage(NOW, ["BTC"], ["1h"])[0].gaps, 1);
  calls = 0;
  const again = await syncHistory(opts);
  assert.equal(again.filled, 10 * 24 - 1);
  assert.equal(again.added, 0);
  assert.equal(calls, 1, "the known outage is not asked for again");
  assert.equal(count(), 400 * 24 + 1 - 4);
  assert.equal(historyCoverage(NOW, ["BTC"], ["1h"])[0].complete, true);

  // nothing left to do: no requests at all
  calls = 0;
  await syncHistory(opts);
  assert.equal(calls, 0);
});

test("history: retention is by age per timeframe; daily bars are kept forever", () => {
  const D = 24 * H;
  store("ETH", "1h", "binance-futures", [bar(NOW - 800 * D), bar(NOW - 700 * D)]);
  store("ETH", "1d", "binance-futures", [bar(NOW - 3000 * D)]);
  const removed = pruneStoredKlines(NOW);
  assert.ok(removed >= 1);
  const ts = (tf: string) => (getDb().prepare("SELECT t FROM candles WHERE coin = 'ETH' AND tf = ?").all(tf) as { t: number }[]).map((x) => x.t);
  assert.deepEqual(ts("1h"), [NOW - 700 * D], "1h keeps 2 years");
  assert.deepEqual(ts("1d"), [NOW - 3000 * D]);
});

test("history: bars stored before taker volume was kept are asked for it once", async () => {
  const D = 24 * H;
  const stored = Array.from({ length: 1500 }, (_, k) => bar(NOW - (1499 - k) * H));
  store("SOL", "1h", "binance-futures", stored);
  const opts = { nowSec: NOW, pauseMs: 0, coins: ["SOL"], tfs: ["1h" as const], budgetMs: 60_000 };
  const r = await syncHistory(opts);
  assert.ok(r.tbv > 0);
  const missing = (getDb().prepare("SELECT COUNT(*) n FROM candles WHERE coin = 'SOL' AND tf = '1h' AND source = 'binance-futures' AND tbv IS NULL").get() as { n: number }).n;
  assert.equal(missing, 0, "every stored bar now carries taker volume");
  const one = getDb().prepare("SELECT tbv, v FROM candles WHERE coin = 'SOL' AND tf = '1h' AND t = ?").get(NOW - 10 * D) as { tbv: number; v: number };
  assert.deepEqual(one, { tbv: 4, v: 10 });
  assert.equal(historyCoverage(NOW, ["SOL"], ["1h"])[0].tbvPending, 0);
  // a later bar fetched without it never erases it
  store("SOL", "1h", "binance-futures", [bar(NOW - 10 * D)]);
  assert.equal((getDb().prepare("SELECT tbv FROM candles WHERE coin = 'SOL' AND tf = '1h' AND t = ?").get(NOW - 10 * D) as { tbv: number }).tbv, 4);
  const again = await syncHistory(opts);
  assert.equal(again.tbv, 0, "nothing asked twice");
  assert.equal(again.complete, true);
});

test("history: mark-price series are started and kept current here", async () => {
  const opts = { nowSec: NOW, pauseMs: 0, coins: ["ETH"], tfs: ["1h" as const], source: "binance-mark" as const };
  const r = await syncHistory(opts);
  assert.equal(r.complete, true);
  const n = (getDb().prepare("SELECT COUNT(*) n, MAX(t) last FROM candles WHERE coin = 'ETH' AND tf = '1h' AND source = 'binance-mark'").get() as { n: number; last: number });
  assert.equal(n.n, 400 * 24 + 1 - 4, "seeded, then walked back to the listing");
  assert.equal(n.last, NOW);
  const noTbv = (getDb().prepare("SELECT COUNT(*) n FROM candles WHERE source = 'binance-mark' AND tbv IS NOT NULL").get() as { n: number }).n;
  assert.equal(noTbv, 0, "mark prices carry no volume");
  // a later run only asks for bars after the newest one
  calls = 0;
  await syncHistory({ ...opts, nowSec: NOW + 3 * H });
  assert.equal(calls, 1);
});

test("history: a primary series nobody has loaded yet is started here", async () => {
  // e.g. 5-minute bars of a coin nobody opened: no page ever stores them
  const n = () => getDb().prepare("SELECT COUNT(*) n, MIN(t) first, MAX(t) last FROM candles WHERE coin = 'XRP' AND tf = '1h' AND source = 'binance-futures'").get() as { n: number; first: number; last: number };
  assert.equal(n().n, 0);
  const r = await syncHistory({ nowSec: NOW, pauseMs: 0, coins: ["XRP"], tfs: ["1h"] });
  assert.equal(r.error, undefined);
  assert.equal(r.complete, true);
  const s = n();
  assert.equal(s.n, 400 * 24 + 1 - 4, "seeded with the newest page, then walked back to the listing");
  assert.equal(s.first, LISTED);
  assert.equal(s.last, NOW);
  assert.equal(r.added, s.n);
  assert.equal(historyCoverage(NOW, ["XRP"], ["1h"])[0].complete, true);
});
