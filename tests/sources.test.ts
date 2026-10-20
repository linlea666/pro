import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sl-sources-"));
process.env.LOG_LEVEL = "error";
const { getDb, migrate, SCHEMA_VERSION } = await import("../src/lib/server/db.ts");
const { getKlines, pruneStoredKlines, readStored, resetDataSources, store } = await import("../src/lib/data/klines.ts");
const { getPerpSnapshot, perpHistoryStats, syncPerpHistory } = await import("../src/lib/data/perp.ts");

const H = 3600;
const NOW = Math.floor(Date.now() / 1000 / H) * H;
const bar = (t: number, c = 100) => ({ t, o: c, h: c + 1, l: c - 1, c, v: 10 });

/** Which exchanges answer, and what they say. */
const up = { fapi: true, okx: true, spot: true };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
globalThis.fetch = (async (input: string) => {
  const u = new URL(input);
  const q = u.searchParams;
  if (u.host === "fapi.binance.com") {
    if (!up.fapi) return json({ code: 0, msg: "Service unavailable from a restricted location" }, 451);
    if (u.pathname === "/fapi/v1/klines") {
      const limit = Number(q.get("limit"));
      const end = q.has("endTime") ? Number(q.get("endTime")) / 1000 : NOW;
      const ts = Array.from({ length: limit }, (_, k) => Math.floor(end / H) * H - (limit - 1 - k) * H);
      return json(ts.map((t) => [t * 1000, "200", "201", "199", "200", "5"]));
    }
    if (u.pathname === "/fapi/v1/premiumIndex") return json({ markPrice: "200.5", lastFundingRate: "0.0001", nextFundingTime: (NOW + 4 * H) * 1000 });
    if (u.pathname === "/fapi/v1/openInterest") return json({ openInterest: "1234.5" });
    if (u.pathname === "/fapi/v1/fundingRate") {
      const start = Number(q.get("startTime")) / 1000;
      const rows = [];
      for (let t = NOW - 10 * 24 * H; t <= NOW; t += 8 * H) if (t >= start) rows.push({ fundingTime: t * 1000, fundingRate: "0.0002", markPrice: "200" });
      return json(rows.slice(0, Number(q.get("limit"))));
    }
    if (u.pathname === "/futures/data/openInterestHist") {
      const start = Number(q.get("startTime")) / 1000;
      const rows = [];
      // open interest grows by 10 an hour, over the last 30 hours
      for (let t = NOW - 30 * H; t <= NOW - H; t += H) if (t >= start) rows.push({ timestamp: t * 1000, sumOpenInterest: String(1000 + (t - (NOW - 30 * H)) / H * 10), sumOpenInterestValue: "1" });
      return json(rows.slice(0, Number(q.get("limit"))));
    }
  }
  if (u.host === "www.okx.com") {
    if (!up.okx) return json({}, 503);
    if (u.pathname.startsWith("/api/v5/market/")) {
      assert.equal(q.get("instId"), "BTC-USDT-SWAP", "the fallback is the OKX perpetual, not spot");
      // newest first; volume in the coin is column 6
      if (u.pathname.endsWith("history-candles")) return json({ code: "0", data: [] });
      return json({ code: "0", data: Array.from({ length: 300 }, (_, k) => [String((NOW - k * H) * 1000), "150", "151", "149", "150", "999", "7", "0", "1"]) });
    }
    if (u.pathname === "/api/v5/public/funding-rate") return json({ code: "0", data: [{ fundingRate: "-0.00005", fundingTime: String((NOW + 2 * H) * 1000), nextFundingTime: String((NOW + 10 * H) * 1000) }] });
    if (u.pathname === "/api/v5/public/open-interest") return json({ code: "0", data: [{ oiCcy: "777" }] });
    if (u.pathname === "/api/v5/public/mark-price") return json({ code: "0", data: [{ markPx: "150.2" }] });
  }
  if (u.host === "data-api.binance.vision") {
    if (!up.spot) return json({}, 503);
    return json([[NOW * 1000, "100", "101", "99", "100", "3"]]);
  }
  throw new Error(`unexpected request ${input}`);
}) as typeof fetch;

test("migration: an old database keeps its candles, labelled as Binance spot", () => {
  const d = new Database(":memory:");
  migrate(d, 5);
  d.prepare("INSERT INTO klines VALUES ('BTC', '1h', 3600, 1, 2, 0.5, 1.5, 9)").run();
  migrate(d);
  assert.equal(d.pragma("user_version", { simple: true }), SCHEMA_VERSION);
  assert.deepEqual(d.prepare("SELECT coin, tf, source, t, v FROM candles").all(), [{ coin: "BTC", tf: "1h", source: "binance-spot", t: 3600, v: 9 }]);
  assert.equal((d.prepare("SELECT COUNT(*) n FROM klines").get() as { n: number }).n, 0, "the old table is emptied but kept for a rollback");
});

test("sources: perpetuals first; a fallback is stored as its own series and never mixed in", async () => {
  getDb();
  up.fapi = false;
  resetDataSources();
  const a = await getKlines("BTC", "1h", 300);
  assert.equal(a.source, "okx-swap");
  assert.equal(a.candles[a.candles.length - 1].c, 150);
  assert.equal(a.candles[0].v, 7);
  assert.equal(readStored("BTC", "1h", "binance-futures", 1000).length, 0);

  up.fapi = true;
  resetDataSources();
  const b = await getKlines("BTC", "1h", 300);
  assert.equal(b.source, "binance-futures");
  assert.ok(b.candles.every((x) => x.c === 200), "no OKX bar in the Binance series");
  assert.ok(readStored("BTC", "1h", "okx-swap", 1000).every((x) => x.c === 150), "no Binance bar in the OKX series");

  // everyone down: the freshest stored series, labelled local
  up.fapi = up.okx = up.spot = false;
  resetDataSources();
  const c = await getKlines("BTC", "1h", 300);
  assert.equal(c.source, "local");
  assert.equal(c.stored, "binance-futures");
  up.fapi = up.okx = up.spot = true;
});

test("retention: fallback series keep only about the analysis window", () => {
  store("ETH", "1h", "okx-swap", Array.from({ length: 3000 }, (_, k) => bar(NOW - (2999 - k) * H)));
  store("ETH", "1h", "binance-futures", Array.from({ length: 3000 }, (_, k) => bar(NOW - (2999 - k) * H)));
  pruneStoredKlines(NOW);
  assert.equal(readStored("ETH", "1h", "okx-swap", 5000).length, 2501);
  assert.equal(readStored("ETH", "1h", "binance-futures", 5000).length, 3000, "the primary keeps 2 years of 1h");
});

test("perp: funding and open-interest history, and the live snapshot with an OKX fallback", async () => {
  const r = await syncPerpHistory({ nowSec: NOW, coins: ["BTC"], pauseMs: 0 });
  assert.equal(r.error, undefined);
  assert.equal(r.funding, 31);
  assert.equal(r.openInterest, 30);
  const again = await syncPerpHistory({ nowSec: NOW, coins: ["BTC"], pauseMs: 0 });
  assert.equal(again.funding, 0, "only new settlements are fetched");

  const s = perpHistoryStats("BTC", NOW);
  assert.equal(s.intervalHours, 8);
  assert.ok(Math.abs(s.avgRate7d! - 0.0002) < 1e-12);
  // 24 hours ago: 1000 + 6×10 = 1060; latest: 1000 + 29×10 = 1290
  assert.equal(s.oiChange24hPct, Math.round(((1290 - 1060) / 1060) * 1000) / 10);

  const live = await getPerpSnapshot("BTC");
  assert.equal(live.source, "binance-futures");
  assert.equal(live.fundingRate, 0.0001);
  assert.equal(live.openInterest, 1234.5);

  up.fapi = false;
  const okx = await getPerpSnapshot("ETH");
  assert.equal(okx.source, "okx-swap");
  assert.equal(okx.fundingRate, -0.00005);
  assert.equal(okx.openInterest, 777);
  assert.equal(okx.intervalHours, 8, "from OKX's next settlement when there is no stored history");
  up.fapi = true;
});
