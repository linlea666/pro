import path from "node:path";
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/server/guard";
import { backupNow, cleanupLogs, dbSizeMB } from "@/lib/server/jobs";
import { logger } from "@/lib/server/log";
import { withRoute } from "@/lib/server/route";

/** Manual maintenance actions: { action: "backup" | "cleanup" } */
export const POST = withRoute("admin.maintenance", async (req: Request) => {
  const admin = await requireAdmin();
  if (admin instanceof Response) return admin;
  const { action } = (await req.json().catch(() => ({}))) as { action?: string };
  if (action === "backup") {
    const file = await backupNow("manual");
    logger.info("audit", "手动备份数据库", { username: admin.username, file: path.basename(file) });
    return NextResponse.json({ ok: true, message: `已备份到 ${path.basename(file)}` });
  }
  if (action === "cleanup") {
    const r = cleanupLogs();
    logger.info("audit", "手动清理日志", { username: admin.username, ...r });
    return NextResponse.json({ ok: true, message: `已清理 ${r.byAge + r.bySize} 条日志，当前数据库 ${dbSizeMB()} MB` });
  }
  return NextResponse.json({ error: "未知操作" }, { status: 400 });
});
