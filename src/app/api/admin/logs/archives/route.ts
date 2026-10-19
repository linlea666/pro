import { NextResponse } from "next/server";
import { archiveWeek, listArchives, weekLabel, weekStart } from "@/lib/server/archive";
import { requireAdmin } from "@/lib/server/guard";
import { logger } from "@/lib/server/log";
import { withRoute } from "@/lib/server/route";

export const dynamic = "force-dynamic";

export const GET = withRoute("admin.logs.archives", async () => {
  const admin = await requireAdmin();
  if (admin instanceof Response) return admin;
  return NextResponse.json({ archives: listArchives() });
});

/** Archive a week now. Body: { weeksAgo?: number } (0 = current week so far). */
export const POST = withRoute("admin.logs.archive", async (req: Request) => {
  const admin = await requireAdmin();
  if (admin instanceof Response) return admin;
  const { weeksAgo = 1 } = (await req.json().catch(() => ({}))) as { weeksAgo?: number };
  const n = Math.max(0, Math.min(52, Math.floor(weeksAgo)));
  let start = weekStart(Date.now());
  for (let k = 0; k < n; k++) start = weekStart(start - 1);
  const r = await archiveWeek(start);
  logger.info("audit", `手动归档日志 ${weekLabel(start)}`, { username: admin.username, rows: r.rows });
  return NextResponse.json({ ok: true, message: `已归档 ${weekLabel(start)}，共 ${r.rows} 条`, archives: listArchives() });
});
