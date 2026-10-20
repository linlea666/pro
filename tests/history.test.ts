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
  const rows = (q.has("startTime") ? all.slice(0, limit) : all.slice(-limit)).map((t) => [t * 1000, "1", "2", "0.5", "1.5", "10"]);
  return new Response(JSON.stringify(rows), { status: 200 });
}) as typeof fetch;

const count = () => (getDb().prepare("SELECT COUNT(*) n FROM klines WHERE coin = 'BTC' AND tf = '1h'").get() as { n: number }).n;

test("history: walks back to the exchange's first bar, then repairs a deleted stretch", async () => {
  // the live loader stored the newest 2000 bars
  store("BTC", "1h", Array.from({ length: 2000 }, (_, k) => bar(NOW - (1999 - k) * H)));
  const opts = { nowSec: NOW, pauseMs: 0, coins: ["BTC"], tfs: ["1h" as const] };

  const r = await syncHistory(opts);
  assert.equal(r.error, undefined);
  assert.equal(r.complete, true);
  const first = getDb().prepare("SELECT MIN(t) t FROM klines WHERE coin = 'BTC' AND tf = '1h'").get() as { t: number };
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
  getDb().prepare("DELETE FROM klines WHERE coin = 'BTC' AND tf = '1h' AND t > ? AND t < ?").run(NOW - 50 * 24 * H, NOW - 40 * 24 * H);
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
  store("ETH", "1h", [bar(NOW - 800 * D), bar(NOW - 700 * D)]);
  store("ETH", "1d", [bar(NOW - 3000 * D)]);
  const removed = pruneStoredKlines(NOW);
  assert.ok(removed >= 1);
  const ts = (tf: string) => (getDb().prepare("SELECT t FROM klines WHERE coin = 'ETH' AND tf = ?").all(tf) as { t: number }[]).map((x) => x.t);
  assert.deepEqual(ts("1h"), [NOW - 700 * D], "1h keeps 2 years");
  assert.deepEqual(ts("1d"), [NOW - 3000 * D]);
});
