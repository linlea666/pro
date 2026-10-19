import { NextResponse } from "next/server";
import { getDb, SCHEMA_VERSION } from "@/lib/server/db";
import { env } from "@/lib/server/env";
import { sourceSummary, startedAt } from "@/lib/server/health";

export const dynamic = "force-dynamic";

/** Liveness + readiness. Used by update.sh to decide whether to roll back. */
export async function GET() {
  let dbOk = false;
  try {
    dbOk = (getDb().prepare("SELECT 1 ok").get() as { ok: number }).ok === 1;
  } catch {}
  const sources = sourceSummary(1);
  const recentOk = Object.values(sources).some((s) => s.lastOkAt && Date.now() - s.lastOkAt < 15 * 60 * 1000);
  const anyTraffic = Object.keys(sources).length > 0;
  const status = !dbOk ? "down" : anyTraffic && !recentOk ? "degraded" : "ok";
  return NextResponse.json(
    { status, version: env.version, schema: SCHEMA_VERSION, uptimeSec: Math.round((Date.now() - startedAt()) / 1000), db: dbOk, sources, time: new Date().toISOString() },
    { status: status === "down" ? 503 : 200, headers: { "cache-control": "no-store" } },
  );
}
