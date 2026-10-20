import { NextResponse, type NextRequest } from "next/server";
import { requireAdmin } from "@/lib/server/guard";
import { logger } from "@/lib/server/log";
import { withRoute } from "@/lib/server/route";
import { runResearch } from "@/lib/research/jobs";
import { getReport, listReports, type ReportKind } from "@/lib/research/run";

export const dynamic = "force-dynamic";

/** Reports list plus one report: `?id=` or the latest of `?kind=` (signals | light). */
export const GET = withRoute("admin.research.get", async (req: NextRequest) => {
  const admin = await requireAdmin();
  if (admin instanceof Response) return admin;
  const id = Number(req.nextUrl.searchParams.get("id")) || undefined;
  const kind = (req.nextUrl.searchParams.get("kind") === "light" ? "light" : "signals") as ReportKind;
  return NextResponse.json({ list: listReports(), report: getReport(id, kind) });
});

let running = false;

/** Generate both reports now. */
export const POST = withRoute("admin.research.run", async () => {
  const admin = await requireAdmin();
  if (admin instanceof Response) return admin;
  if (running) return NextResponse.json({ error: "研究报告正在生成，请稍候" }, { status: 409 });
  running = true;
  try {
    const r = await runResearch();
    logger.info("audit", "手动生成研究报告", { username: admin.username, ...r });
    return NextResponse.json({ ok: true, ...r });
  } finally {
    running = false;
  }
});
