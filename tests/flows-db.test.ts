import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

// a throwaway database: env.ts reads DATA_DIR when first imported
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sl-flows-"));
process.env.LOG_LEVEL = "error";
const { migrate, SCHEMA_VERSION } = await import("../src/lib/server/db.ts");
const { syncEtfFlows, etfFlowDays } = await import("../src/lib/data/flows.ts");

test("migration 13: the ETF flow and premium tables on a v12 database", () => {
  const old = new Database(":memory:");
  migrate(old, 12);
  migrate(old);
  assert.equal(old.pragma("user_version", { simple: true }), SCHEMA_VERSION);
  assert.equal(SCHEMA_VERSION, 13);
  old.prepare("INSERT INTO etf_flows (day, flow, first_flow, first_at, updated_at) VALUES ('2026-10-21', 1, 1, 1, 1)").run();
  old.prepare("INSERT INTO premium_hourly (t, cb) VALUES (1, 2)").run();
  old.prepare("INSERT INTO premium_hourly (t, bn) VALUES (1, 3) ON CONFLICT(t) DO UPDATE SET bn = excluded.bn").run();
  assert.deepEqual(old.prepare("SELECT t, cb, bn, usdt FROM premium_hourly").all(), [{ t: 1, cb: 2, bn: 3, usdt: null }]);
});

test("ETF flow sync keeps the first published value, skips the source's holiday zeros and survives a bad response", async () => {
  let days: unknown[] = [
    { date: "2024-01-12", netFlowUsd: 203000000, totalNetAssetsUsd: null, perEtfUsd: { IBIT: 386000000, GBTC: -484100000, "bad key": 1 } },
    { date: "2024-01-15", netFlowUsd: 0, totalNetAssetsUsd: null },
    { date: "2026-10-21", netFlowUsd: 528400237.14, totalNetAssetsUsd: 109308814723.7 },
  ];
  let up = true;
  globalThis.fetch = (async () => (up ? new Response(JSON.stringify({ days })) : new Response("x", { status: 500 }))) as unknown as typeof fetch;
  const a = await syncEtfFlows();
  assert.deepEqual(a, { days: 2, added: 2, revised: 0, lastDay: "2026-10-21" });
  days = [{ date: "2026-10-21", netFlowUsd: 440600000, totalNetAssetsUsd: 109e9 }, { date: "2026-10-22", netFlowUsd: -1e8, totalNetAssetsUsd: 108e9 }];
  const b = await syncEtfFlows();
  assert.deepEqual(b, { days: 2, added: 1, revised: 1, lastDay: "2026-10-22" });
  const all = etfFlowDays();
  assert.deepEqual(all.map((x) => x.day), ["2024-01-12", "2026-10-21", "2026-10-22"]);
  assert.deepEqual(all[0].perEtf, { IBIT: 386000000, GBTC: -484100000 });
  assert.equal(all[1].flow, 440600000);
  assert.equal(all[1].firstFlow, 528400237.14);
  up = false;
  const c = await syncEtfFlows();
  assert.ok(c.error);
  assert.equal(etfFlowDays().length, 3);
});
