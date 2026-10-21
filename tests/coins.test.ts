import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// a throwaway database: env.ts reads DATA_DIR when first imported
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sl-coins-"));
process.env.LOG_LEVEL = "error";
const { getState, setState } = await import("../src/lib/server/settings.ts");
const { addCoin, allCoins, coinIds, findCoin, MAX_ACTIVE_COINS, setCoinEnabled, updateCoin } = await import("../src/lib/server/coins.ts");
const { RESEARCH_COINS } = await import("../src/lib/symbols.ts");

const DAY = 86400;
const NOW = Date.now() / 1000;
/** Binance futures daily klines: SUI listed 400 days ago, OLD stopped trading 10 days ago, anything else unknown */
let calls = 0;
globalThis.fetch = (async (url: string) => {
  calls++;
  const q = new URL(url).searchParams;
  const sym = q.get("symbol");
  const life: Record<string, [number, number]> = { SUIUSDT: [NOW - 400 * DAY, NOW], OLDUSDT: [NOW - 900 * DAY, NOW - 10 * DAY] };
  for (let i = 0; i < 20; i++) life[`X${i}USDT`] = [NOW - 50 * DAY, NOW];
  const span = life[sym!];
  if (!span) return new Response(JSON.stringify({ code: -1121, msg: "Invalid symbol." }), { status: 400 });
  const t = q.has("startTime") ? span[0] : span[1];
  return new Response(JSON.stringify([[Math.floor(t / DAY) * DAY * 1000, "1", "2", "0.5", "1.5", "10"]]), { status: 200 });
}) as typeof fetch;

test("starts as the built-in ten, which stay the research pool", () => {
  assert.deepEqual(coinIds(), RESEARCH_COINS);
  assert.ok(allCoins().every((c) => c.research && c.builtin && c.enabled));
  assert.equal(findCoin("btc")?.id, "BTC");
});

test("adding checks the Binance perpetual and restarts the history jobs", async () => {
  setState("job.historyComplete", "1");
  const r = await addCoin({ id: "sui", name: "Sui" });
  assert.ok(r.ok);
  assert.equal(coinIds().at(-1), "SUI");
  const sui = findCoin("SUI")!;
  assert.equal(sui.research, false);
  assert.equal(sui.name, "Sui");
  assert.ok(Math.abs(sui.listedAt! - (NOW - 400 * DAY)) < 2 * DAY);
  assert.equal(getState("job.historyComplete"), "0");
  // research and the overall scorecard keep the fixed pool
  assert.ok(!RESEARCH_COINS.includes("SUI"));
});

test("unknown, delisted, malformed and duplicate coins are refused", async () => {
  for (const [id, re] of [["NOPE", /没有 NOPEUSDT/], ["OLD", /3 天没有新 K 线/], ["S-1", /2–15 位/], ["SUI", /已经在列表里/]] as const) {
    const r = await addCoin({ id });
    assert.ok(!r.ok && re.test(r.error), `${id}: ${!r.ok && r.error}`);
  }
  assert.ok(!findCoin("NOPE") && !findCoin("OLD"));
});

test("hiding keeps the row; showing again re-checks; at least one coin stays", async () => {
  assert.ok((await setCoinEnabled("ETH", false)).ok);
  assert.ok(!coinIds().includes("ETH"));
  assert.equal(findCoin("ETH"), undefined);
  assert.equal(allCoins().find((c) => c.id === "ETH")?.enabled, false);
  const before = calls;
  assert.ok((await setCoinEnabled("ETH", true)).ok === false); // ETHUSDT is not in the stub: the check runs and fails
  assert.ok(calls > before);
  for (const id of coinIds().slice(1)) await setCoinEnabled(id, false);
  const last = await setCoinEnabled(coinIds()[0], false);
  assert.ok(!last.ok && /至少要留一个币/.test(last.error));
});

test("at most MAX_ACTIVE_COINS are shown", async () => {
  for (let i = 0; coinIds().length < MAX_ACTIVE_COINS; i++) assert.ok((await addCoin({ id: `X${i}` })).ok);
  const r = await addCoin({ id: "X19" });
  assert.ok(!r.ok && /最多同时显示/.test(r.error));
});

test("rename and reorder", () => {
  const ids = allCoins().map((c) => c.id);
  assert.ok(updateCoin(ids[1], { move: -1 }).ok);
  assert.deepEqual(allCoins().slice(0, 2).map((c) => c.id), [ids[1], ids[0]]);
  assert.ok(updateCoin("btc", { name: "  比特币 BTC ", intro: "简介" }).ok);
  const btc = allCoins().find((c) => c.id === "BTC")!;
  assert.equal(btc.name, "比特币 BTC");
  assert.equal(btc.intro, "简介");
  assert.ok(!updateCoin("NOPE", { move: 1 }).ok);
});
