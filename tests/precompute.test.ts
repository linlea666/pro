import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sl-pre-"));
process.env.LOG_LEVEL = "error";
const { withTimeout, precomputeStats } = await import("../src/lib/server/precompute.ts");

test("precompute: a step that never settles is given up on instead of hanging the pass", async () => {
  const never = new Promise<number>(() => {});
  const t0 = Date.now();
  await assert.rejects(withTimeout(never, 30, "卡住"), (e: Error & { timeout?: boolean }) => e.message === "卡住" && e.timeout === true);
  assert.ok(Date.now() - t0 < 1000);
  // a step that finishes in time passes its value (or its own error) through
  assert.equal(await withTimeout(Promise.resolve(7), 1000, "x"), 7);
  await assert.rejects(withTimeout(Promise.reject(new Error("坏了")), 1000, "x"), (e: Error & { timeout?: boolean }) => e.message === "坏了" && !e.timeout);
  const s = precomputeStats();
  assert.equal(s.current, null);
  assert.equal(s.timeouts, 0);
});
