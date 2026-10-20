import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sl-archive-"));
process.env.LOG_LEVEL = "error";
const { getDb } = await import("../src/lib/server/db.ts");
const { hourlyOpenInterest, syncOpenInterestArchive, unzipSingle } = await import("../src/lib/data/archive.ts");
const { openInterestSeries } = await import("../src/lib/data/perp.ts");

/** A one-file zip as the archive serves it: local header, deflated data, central directory. */
function zip(name: string, text: string, descriptor = false): Uint8Array {
  const data = zlib.deflateRawSync(Buffer.from(text));
  const nm = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(descriptor ? 8 : 0, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(descriptor ? 0 : data.length, 18);
  local.writeUInt32LE(descriptor ? 0 : text.length, 22);
  local.writeUInt16LE(nm.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(text.length, 24);
  central.writeUInt16LE(nm.length, 28);
  return new Uint8Array(Buffer.concat([local, nm, data, central, nm]));
}

const DAY = 86400;
const NOW = Date.parse("2026-10-20T12:00:00Z") / 1000;
/** the archive in this test starts on 2026-09-01 */
const FIRST = "2026-09-01";
const csvFor = (d: string) => {
  const rows = ["create_time,symbol,sum_open_interest,sum_open_interest_value,count_toptrader_long_short_ratio"];
  // out of order on purpose, five-minute rows; the first row of each hour wins
  for (let h = 23; h >= 0; h--) for (const m of ["05", "00"]) rows.push(`${d} ${String(h).padStart(2, "0")}:${m}:00,BTCUSDT,${1000 + h + (m === "05" ? 0.5 : 0)},${(1000 + h) * 50000},""`);
  return rows.join("\n");
};

let requested: string[] = [];
globalThis.fetch = (async (url: string) => {
  requested.push(url);
  const d = /metrics-(\d{4}-\d{2}-\d{2})\.zip$/.exec(url)?.[1];
  if (!d || d < FIRST) return new Response("not found", { status: 404 });
  return new Response(Buffer.from(zip(`BTCUSDT-metrics-${d}.csv`, csvFor(d), d.endsWith("5"))));
}) as typeof fetch;

test("archive: zip files with and without a data descriptor; one row per hour", () => {
  const text = csvFor("2026-10-01");
  assert.equal(unzipSingle(zip("a.csv", text)), text);
  assert.equal(unzipSingle(zip("a.csv", text, true)), text);
  const rows = hourlyOpenInterest(text);
  assert.equal(rows.length, 24);
  assert.equal(rows[0].t, Date.parse("2026-10-01T00:00:00Z") / 1000);
  assert.equal(rows[5].oi, 1005, "the hh:00 row, not the hh:05 one");
  assert.equal(rows[5].value, 1005 * 50000);
});

test("archive: walks back to the first day, skips days already stored, then only re-checks recent weeks", async () => {
  const d = getDb();
  // the live sync already holds 2026-10-10 (24 hours)
  const ten = Date.parse("2026-10-10T00:00:00Z") / 1000;
  for (let h = 0; h < 24; h++) d.prepare("INSERT INTO open_interest (coin, source, t, oi, oi_value) VALUES ('BTC', 'binance-futures', ?, 1, 1)").run(ten + h * 3600);

  requested = [];
  const r = await syncOpenInterestArchive({ coins: ["BTC"], pauseMs: 0, nowSec: NOW });
  assert.equal(r.error, undefined);
  assert.equal(r.complete, true);
  // 2026-09-01 … 2026-10-18 is 48 days; one was stored already; 14 misses mark the start
  assert.equal(r.days, 47);
  assert.equal(requested.filter((u) => u.includes("2026-10-10")).length, 0, "a stored day is not fetched");
  assert.equal(requested.length, 47 + 14);
  const n = (d.prepare("SELECT COUNT(*) n, MIN(t) first FROM open_interest WHERE coin = 'BTC'").get() as { n: number; first: number });
  assert.equal(n.n, 48 * 24);
  assert.equal(n.first, Date.parse(`${FIRST}T00:00:00Z`) / 1000);
  assert.equal((d.prepare("SELECT oi FROM open_interest WHERE t = ?").get(ten) as { oi: number }).oi, 1, "the live row is kept");

  // complete: the next run only looks at the last weeks, and everything there is stored
  requested = [];
  const again = await syncOpenInterestArchive({ coins: ["BTC"], pauseMs: 0, nowSec: NOW + DAY });
  assert.equal(again.complete, true);
  assert.deepEqual(requested.map((u) => u.slice(-14, -4)), ["2026-10-19"], "only the new day");

  // read back for the plans: oldest first, within the range asked for
  const s = openInterestSeries("BTC", ten + 5 * 3600, ten - 2 * 3600)!;
  assert.deepEqual(s.t, Array.from({ length: 8 }, (_, k) => ten + (k - 2) * 3600));
  assert.equal(s.oi[2], 1, "the live row");
  assert.equal(openInterestSeries("ETH", NOW), null);
});
