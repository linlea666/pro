import fs from "node:fs";
import path from "node:path";
import { dbPath, getDb } from "./db.ts";
import { env } from "./env.ts";
import { logger } from "./log.ts";
import { getSetting, getState, setState } from "./settings.ts";
import { sourceSummary } from "./health.ts";
import { archiveWeek, weekLabel, weekStart } from "./archive.ts";
import { raiseAlert, sendDigest } from "./alert.ts";

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
      const { precomputeStats } = await import("./precompute.ts");
      const pre = precomputeStats();
      if (pre.runs) logger.info("engine", "预计算状态", { ...pre });
      const mem = process.memoryUsage();
      logger.info("system", "进程状态", { rssMB: Math.round(mem.rss / 1048576), heapMB: Math.round(mem.heapUsed / 1048576), uptimeMin: Math.round(process.uptime() / 60), dbMB: dbSizeMB() });
      const cap = getSetting("log.maxDbMB");
      if (dbSizeMB() > cap * 0.9) raiseAlert("db", "数据库接近或超过容量上限", { 当前: `${dbSizeMB()} MB`, 上限: `${cap} MB` });
      done("hourlySummary");
    }
    if (due("cleanup", DAY)) {
      const t = Date.now();
      const r = cleanupLogs();
      const { pruneStoredKlines } = await import("../data/klines.ts");
      const klines = pruneStoredKlines();
      logger.info("system", "日志清理完成", { ...r, prunedKlines: klines, retentionDays: getSetting("log.retentionDays"), durationMs: Date.now() - t });
      done("cleanup");
    }
    if (getSetting("log.weeklyArchive")) {
      // archive the last completed week once
      const lastWeek = weekStart(weekStart(Date.now()) - 1);
      const label = weekLabel(lastWeek);
      if (getState("job.archivedWeek") !== label) {
        const r = await archiveWeek(lastWeek);
        logger.info("system", `日志周归档完成 ${label}`, { rows: r.rows, file: path.basename(r.file) });
        setState("job.archivedWeek", label);
      }
    }
    // long candle history: every tick until it reaches the retention targets, then a hole check every 6 hours
    if (getState("job.historyComplete") !== "1" || due("history", 6 * HOUR)) {
      const { syncHistory } = await import("../data/history.ts");
      const r = await syncHistory();
      setState("job.historyComplete", r.complete ? "1" : "0");
      if (r.requests || r.error) logger[r.error ? "warn" : "info"]("datasource", r.complete ? "K 线历史已补齐" : "K 线历史补充中", { ...r });
      done("history");
    }
    // funding settlements and hourly open interest
    if (due("perp", HOUR - 60_000)) {
      const { syncPerpHistory } = await import("../data/perp.ts");
      const r = await syncPerpHistory();
      if (r.error) logger.warn("datasource", "资金费率 / 持仓量更新失败", r);
      else if (r.funding || r.openInterest) logger.debug("datasource", "资金费率 / 持仓量已更新", r);
      done("perp");
    }
    const busy = globalThis as { __slJobBusy?: boolean };
    // stop-loss calibration: weekly, and right away on a fresh install
    const calibEmpty = !getDb().prepare("SELECT 1 FROM risk_calib LIMIT 1").get();
    if (calibEmpty || due("riskCalib", 7 * DAY)) {
      const { runCalibration } = await import("./riskcalib.ts");
      busy.__slJobBusy = true;
      const r = await runCalibration().finally(() => (busy.__slJobBusy = false));
      logger.info("engine", "止损参考校准完成", r);
      done("riskCalib");
    }
    // the traffic light's track record, filled in small batches
    if (due("scorecard", HOUR - 60_000)) {
      const { runScorecard } = await import("./scorecard.ts");
      busy.__slJobBusy = true;
      const r = await runScorecard().finally(() => (busy.__slJobBusy = false));
      if (r.added) logger.info("engine", "信号灯成绩单更新", r);
      done("scorecard");
    }
    if (due("digest", DAY)) {
      const s = sourceSummary(24);
      const extra = [
        ...Object.entries(s).map(([name, x]) => `数据源 ${name}：成功率 ${x.successRate ?? "—"}%，平均 ${x.avgMs} 毫秒`),
        `数据库 ${dbSizeMB()} MB`,
        `K 线历史${getState("job.historyComplete") === "1" ? "已补齐" : "补充中"}`,
      ];
      await sendDigest(extra).catch((e) => logger.warn("system", "每日摘要发送失败", { error: (e as Error).message }));
      done("digest");
    }
    if (due("backup", DAY)) {
      const file = await backupNow("auto");
      logger.info("system", "数据库自动备份完成", { file: path.basename(file), dbMB: dbSizeMB() });
      done("backup");
    }
  } catch (e) {
    logger.error("system", "定时任务执行失败", { error: e });
    raiseAlert("job", "定时任务执行失败", { 错误: (e as Error).message });
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
  import("./precompute.ts").then((m) => m.startPrecompute()).catch((e) => logger.error("system", "预计算启动失败", { error: e }));
  g.__slJobs = setInterval(tick, 10 * 60 * 1000);
  g.__slJobs.unref?.();
}
