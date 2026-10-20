import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Candle, Timeframe } from "../src/lib/types.ts";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sl-levels-"));
process.env.LOG_LEVEL = "error";
const { store } = await import("../src/lib/data/klines.ts");
const { levelsReport } = await import("../src/lib/research/levels.ts");
const { DEFAULT_ENGINE_PARAMS } = await import("../src/lib/params.ts");
const { TF_SECONDS } = await import("../src/lib/types.ts");

function walk(tf: Timeframe, n: number, seed: number, end: number): Candle[] {
  let s = seed >>> 0;
  const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const sec = TF_SECONDS[tf];
  let p = 100;
  return Array.from({ length: n }, (_, i) => {
    const o = p;
    p *= 1 + (r() - 0.5) * 0.03;
    return { t: end - (n - 1 - i) * sec, o, h: Math.max(o, p) * (1 + r() * 0.005), l: Math.min(o, p) * (1 - r() * 0.005), c: p, v: 100 + r() * 100 };
  });
}

test("levels report: every method is measured against random lines on the same coin and dates", async () => {
  const end = Math.floor(Date.now() / 1000 / 86400) * 86400 - 86400;
  store("BTC", "1d", "binance-futures", walk("1d", 1500, 1, end));
  store("ETH", "1d", "binance-futures", walk("1d", 1500, 2, end));
  const r = await levelsReport(DEFAULT_ENGINE_PARAMS, { paramsVersion: 0, tfs: ["1d"] });
  const placebo = r.rows.find((x) => x.key === "level:random")!;
  assert.ok(placebo.cells.is.n > 100);
  assert.equal(placebo.cells.is.edgeR, 0, "random lines against themselves");
  assert.equal(placebo.q, null, "the control itself is not tested");
  for (const x of r.rows.filter((x) => x.family === "level")) {
    assert.ok(x.extra!.brokenPct! <= x.extra!.piercedPct!, "a level invalidated was pierced first");
    assert.ok(x.cells.is.meanR! >= -1.1 && x.cells.is.meanR! <= 2, "results are in R");
  }
  // E16: the same touches held until the stop; the further the target, the fewer reach it
  const mfe = r.rows.filter((x) => x.family === "level_mfe");
  assert.equal(mfe.length, r.rows.filter((x) => x.family === "level").length);
  assert.equal(mfe.find((x) => x.key === "level_mfe:random")!.cells.is.edgeR, 0);
  for (const x of mfe) {
    const e = x.extra!;
    assert.ok(e.reach1! >= e.reach2! && e.reach2! >= e.reach3! && e.reach3! >= e.reach5!, x.key);
    assert.ok(x.cells.is.meanR! >= -1.1, "never worse than the stop plus costs");
  }
  // a random walk has no levels worth trading
  assert.equal(r.rows.filter((x) => x.verdict === "有优势").length, 0);
});
