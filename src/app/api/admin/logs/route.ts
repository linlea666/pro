import { NextResponse, type NextRequest } from "next/server";
import { requireAdmin } from "@/lib/server/guard";
import { countLogs, parseFilter, queryLogs } from "@/lib/server/logquery";
import { withRoute } from "@/lib/server/route";
import { getSetting } from "@/lib/server/settings";
import { dbSizeMB } from "@/lib/server/jobs";

export const dynamic = "force-dynamic";

export const GET = withRoute("admin.logs", async (req: NextRequest) => {
  const admin = await requireAdmin();
  if (admin instanceof Response) return admin;
  const f = parseFilter(req.nextUrl.searchParams);
  const page = queryLogs(f);
  // total only on the first page; it is the expensive part
  const total = f.beforeId ? null : countLogs({ ...f, beforeId: undefined });
  return NextResponse.json({ ...page, total, retentionDays: getSetting("log.retentionDays"), dbMB: dbSizeMB() });
});
