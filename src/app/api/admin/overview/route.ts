import { NextResponse } from "next/server";
import { getDb, SCHEMA_VERSION } from "@/lib/server/db";
import { env } from "@/lib/server/env";
import { requireAdmin } from "@/lib/server/guard";
import { sourceSummary, startedAt } from "@/lib/server/health";
import { dbSizeMB } from "@/lib/server/jobs";
import { withRoute } from "@/lib/server/route";

export const dynamic = "force-dynamic";

export const GET = withRoute("admin.overview", async () => {
  const admin = await requireAdmin();
  if (admin instanceof Response) return admin;
  const d = getDb();
  const since = Date.now() - 24 * 3600 * 1000;
  const byLevel = d.prepare("SELECT level, COUNT(*) n FROM logs WHERE ts >= ? GROUP BY level").all(since) as { level: string; n: number }[];
  const byCategory = d.prepare("SELECT category, COUNT(*) n, SUM(level = 'error') errors, SUM(level = 'warn') warns FROM logs WHERE ts >= ? GROUP BY category").all(since);
  const recentErrors = d.prepare("SELECT id, ts, level, category, msg, trace FROM logs WHERE level IN ('error','warn') ORDER BY id DESC LIMIT 12").all();
  const requests = d.prepare("SELECT COUNT(*) n, AVG(duration_ms) avg FROM logs WHERE category = 'http' AND ts >= ?").get(since) as { n: number; avg: number | null };
  const hourly = d
    .prepare("SELECT (ts / 3600000) h, COUNT(*) n, SUM(level = 'error') errors FROM logs WHERE ts >= ? GROUP BY h ORDER BY h")
    .all(since) as { h: number; n: number; errors: number }[];
  return NextResponse.json({
    version: env.version,
    schema: SCHEMA_VERSION,
    node: process.version,
    uptimeSec: Math.round((Date.now() - startedAt()) / 1000),
    memoryMB: Math.round(process.memoryUsage().rss / 1048576),
    dbMB: dbSizeMB(),
    allowlist: env.adminAllowlist.length > 0,
    secureCookies: env.secureCookies,
    sources: sourceSummary(24),
    logs: { byLevel, byCategory, recentErrors, hourly },
    requests: { count: requests.n, avgMs: requests.avg == null ? null : Math.round(requests.avg) },
  });
});
