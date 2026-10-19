import fs from "node:fs";
import path from "node:path";
import { dbPath, getDb } from "./db.ts";
import { env } from "./env.ts";
import { logger } from "./log.ts";
import { getSetting, getState, setState } from "./settings.ts";
import { sourceSummary } from "./health.ts";

/**
 * In-process scheduler. Runs a tick every 10 minutes; each job records when it
 * last ran in the settings table, so restarts don't repeat or skip work.
 */

const DAY = 24 * 3600 * 1000;
const HOUR = 3600 * 1000;

function due(key: string, every: number) {
  const last = Number(getState(`job.${key}`) || 0);
  return Date.now() - last >= every;
}
const done = (key: string) => setState(`job.${key}`, String(Date.now()));

export function dbSizeMB(): number {
  let total = 0;
  for (const f of [dbPath(), `${dbPath()}-wal`]) {
    try {
      total += fs.statSync(/*turbopackIgnore: true*/ f).size;
    } catch {}
  }
  return Math.round((total / 1024 / 1024) * 10) / 10;
}

export function cleanupLogs(): { byAge: number; bySize: number } {
  const d = getDb();
  const days = getSetting("log.retentionDays");
  const cutoff = Date.now() - days * DAY;
  const byAge = d.prepare("DELETE FROM logs WHERE ts < ?").run(cutoff).changes;
  // over the size cap: drop the oldest debug/info rows in batches
  let bySize = 0;
  const cap = getSetting("log.maxDbMB");
  for (let k = 0; k < 20 && dbSizeMB() > cap; k++) {
    const n = d.prepare("DELETE FROM logs WHERE id IN (SELECT id FROM logs WHERE level IN ('debug','info') ORDER BY id LIMIT 50000)").run().changes;
    bySize += n;
    d.pragma("wal_checkpoint(TRUNCATE)");
    if (n === 0) break;
  }
  d.pragma("optimize");
  return { byAge, bySize };
}

export async function backupNow(label = "auto"): Promise<string> {
  const dir = path.join(/*turbopackIgnore: true*/ env.dataDir, "backups");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
  const file = path.join(dir, `${label}-${stamp}.db`);
  await getDb().backup(file);
  // keep the newest N automatic backups
  const keep = getSetting("backup.keepDaily");
  const autos = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(`${label}-`) && f.endsWith(".db"))
    .sort()
    .reverse();
  for (const f of autos.slice(keep)) fs.rmSync(path.join(dir, f));
  return file;
}

async function tick() {
  try {
    if (due("hourlySummary", HOUR)) {
      const s = sourceSummary(1);
      if (Object.keys(s).length) logger.info("system", "数据源小时汇总", { sources: s });
      const mem = process.memoryUsage();
      logger.info("system", "进程状态", { rssMB: Math.round(mem.rss / 1048576), heapMB: Math.round(mem.heapUsed / 1048576), uptimeMin: Math.round(process.uptime() / 60), dbMB: dbSizeMB() });
      done("hourlySummary");
    }
    if (due("cleanup", DAY)) {
      const t = Date.now();
      const r = cleanupLogs();
      logger.info("system", "日志清理完成", { ...r, retentionDays: getSetting("log.retentionDays"), durationMs: Date.now() - t });
      done("cleanup");
    }
    if (due("backup", DAY)) {
      const file = await backupNow("auto");
      logger.info("system", "数据库自动备份完成", { file: path.basename(file), dbMB: dbSizeMB() });
      done("backup");
    }
  } catch (e) {
    logger.error("system", "定时任务执行失败", { error: e });
  }
}

const g = globalThis as unknown as { __slJobs?: NodeJS.Timeout };

export function startJobs() {
  if (g.__slJobs) return;
  getDb();
  logger.info("system", "服务启动", { version: env.version, node: process.version, pid: process.pid, dataDir: env.dataDir });
  process.on("unhandledRejection", (r) => logger.error("system", "未处理的 Promise 拒绝", { error: r }));
  process.on("uncaughtException", (e) => logger.error("system", "未捕获的异常", { error: e }));
  setTimeout(tick, 15_000);
  g.__slJobs = setInterval(tick, 10 * 60 * 1000);
  g.__slJobs.unref?.();
}
