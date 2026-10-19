import { NextResponse } from "next/server";
import { changePassword } from "@/lib/server/auth";
import { requireAdmin } from "@/lib/server/guard";
import { logger } from "@/lib/server/log";
import { withRoute } from "@/lib/server/route";

export const POST = withRoute("admin.password", async (req: Request) => {
  const admin = await requireAdmin();
  if (admin instanceof Response) return admin;
  const { current, next } = (await req.json().catch(() => ({}))) as { current?: string; next?: string };
  const err = changePassword(admin.id, String(current ?? ""), String(next ?? ""));
  if (err) return NextResponse.json({ error: err }, { status: 400 });
  logger.info("audit", "管理员修改了密码", { username: admin.username });
  return NextResponse.json({ ok: true });
});
