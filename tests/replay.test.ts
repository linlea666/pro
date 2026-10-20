import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Candle, Timeframe } from "../src/lib/types.ts";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sl-replay-"));
process.env.LOG_LEVEL = "error";
const { getDb } = await import("../src/lib/server/db.ts");
const { store } = await import("../src/lib/data/klines.ts");
const { analyzeWith } = await import("../src/lib/analysis.ts");
const { DEFAULT_ENGINE_PARAMS } = await import("../src/lib/params.ts");
const { TF_SECONDS } = await import("../src/lib/types.ts");

const D = 86400;
const NOW = Math.floor(Date.now() / 1000 / D) * D;

/** A deterministic market: slow waves plus per-bar noise, the same price at the same moment on every timeframe. */
const noise = (t: number) => {
  const x = Math.sin(t * 12.9898) * 43758.5453;
  return (x - Math.floor(x) - 0.5) * 0.01;
};
const price = (t: number) => 100 * Math.exp(0.15 * Math.sin(t / (D * 40)) + 0.05 * Math.sin(t / (D * 3)) + noise(t));
function bars(tf: Timeframe, from: number, to: number, bump = 1): Candle[] {
  const sec = TF_SECONDS[tf];
  const out: Candle[] = [];
  for (let t = Math.ceil(from / sec) * sec; t <= to; t += sec) {
    const o = price(t) * bump, c = price(t + sec) * bump;
    out.push({ t, o, c, h: Math.max(o, c) * 1.003, l: Math.min(o, c) * 0.997, v: 1000 + 500 * Math.sin(t / 7777) });
  }
  return out;
}

// the exchange: the live window ends now
globalThis.fetch = (async (input: string) => {
  const q = new URL(input).searchParams;
  const tf = q.get("interval") as Timeframe;
  const sec = TF_SECONDS[tf];
  const limit = Number(q.get("limit"));
  const end = q.has("endTime") ? Number(q.get("endTime")) / 1000 : NOW;
  const rows = bars(tf, end - (limit - 1) * sec, end).slice(-limit).map((x) => [x.t * 1000, String(x.o), String(x.h), String(x.l), String(x.c), String(x.v)]);
  return new Response(JSON.stringify(rows), { status: 200 });
}) as typeof fetch;

// two years of stored history on every timeframe a 4h replay reads
const FROM: Record<string, number> = { "15m": NOW - 300 * D, "1h": NOW - 700 * D, "4h": NOW - 1500 * D, "1d": NOW - 3000 * D, "1w": NOW - 3000 * D };
for (const tf of ["15m", "1h", "4h", "1d"] as Timeframe[]) store("BTC", tf, "binance-futures", bars(tf, FROM[tf], NOW));

const strip = (a: Awaited<ReturnType<typeof analyzeWith>>) => {
  const { replay: _r, updatedAt: _u, ...rest } = a;
  return rest;
};

test("replay: an old moment is rebuilt from the stored history and never sees what came after it", async () => {
  // outside the live 15m and 1h windows (2000 bars ≈ 21 and 83 days)
  const asOf = NOW - 200 * D;
  const before = await analyzeWith("BTC", "4h", DEFAULT_ENGINE_PARAMS, asOf);
  assert.equal(before.lastClosedT, asOf);
  assert.ok(before.replay?.future.length, "what happened next is shown");
  assert.ok(before.levels.supports.length + before.levels.resistances.length > 0);
  assert.ok(
    [...before.levels.supports, ...before.levels.resistances].some((l) => l.timeframes.includes("15m")),
    "the 15-minute timeframe takes part in an old replay too",
  );

  // rewrite every stored bar after the replay point, on every timeframe
  const d = getDb();
  for (const tf of ["15m", "1h", "4h", "1d"] as Timeframe[]) {
    d.prepare("DELETE FROM candles WHERE coin = 'BTC' AND tf = ? AND t >= ?").run(tf, asOf + TF_SECONDS["4h"]);
    store("BTC", tf, "binance-futures", bars(tf, asOf + TF_SECONDS["4h"], NOW, 1.5));
  }
  const after = await analyzeWith("BTC", "4h", DEFAULT_ENGINE_PARAMS, asOf);
  assert.deepEqual(strip(after), strip(before));
  assert.notDeepEqual(after.replay?.future, before.replay?.future, "only the future changed");
});
