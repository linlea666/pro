import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { env } from "./env.ts";
import { iterateLogs, toJsonLine } from "./logquery.ts";
import { getSetting } from "./settings.ts";

/**
 * Weekly log archives: one gzip'd JSON-lines file per ISO week (server local
 * time), written to DATA_DIR/archive. Archives outlive the retention window
 * so old logs can still be inspected after the database has been cleaned.
 */

export const archiveDir = () => path.join(/*turbopackIgnore: true*/ env.dataDir, "archive");

/** Monday 00:00 (local) of the week containing `t`. */
export function weekStart(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

export function weekLabel(start: number): string {
  // ISO week number of the Thursday in that week
  const th = new Date(start + 3 * 86400_000);
  const jan4 = new Date(th.getFullYear(), 0, 4);
  const week = 1 + Math.round(((th.getTime() - weekStart(jan4.getTime())) / 86400_000 - 3) / 7);
  return `${th.getFullYear()}-W${String(week).padStart(2, "0")}`;
}

export async function archiveWeek(start: number): Promise<{ file: string; rows: number }> {
  const dir = archiveDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `logs-${weekLabel(start)}.jsonl.gz`);
  const tmp = `${file}.tmp`;
  const gz = zlib.createGzip();
  const out = fs.createWriteStream(tmp);
  gz.pipe(out);
  let rows = 0;
  for (const batch of iterateLogs({ from: start, to: start + 7 * 86400_000 - 1 })) {
    const chunk = batch.map(toJsonLine).join("");
    rows += batch.length;
    if (!gz.write(chunk)) await new Promise((r) => gz.once("drain", r));
  }
  await new Promise<void>((resolve, reject) => {
    out.on("finish", resolve);
    out.on("error", reject);
    gz.end();
  });
  fs.renameSync(tmp, file);
  pruneArchives();
  return { file, rows };
}

export function listArchives(): { name: string; sizeKB: number; mtime: number }[] {
  const dir = archiveDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^logs-\d{4}-W\d{2}\.jsonl\.gz$/.test(f))
    .map((name) => {
      const st = fs.statSync(path.join(dir, name));
      return { name, sizeKB: Math.round(st.size / 1024), mtime: st.mtimeMs };
    })
    .sort((a, b) => b.name.localeCompare(a.name));
}

function pruneArchives() {
  const keep = getSetting("log.archiveKeepWeeks");
  for (const a of listArchives().slice(keep)) fs.rmSync(path.join(archiveDir(), a.name));
}
