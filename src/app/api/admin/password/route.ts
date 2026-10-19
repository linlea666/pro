import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE, changePassword } from "@/lib/server/auth";
import { requireAdmin } from "@/lib/server/guard";
import { logger } from "@/lib/server/log";
import { withRoute } from "@/lib/server/route";

export const POST = withRoute("admin.password", async (req: Request) => {
  const admin = await requireAdmin();
  if (admin instanceof Response) return admin;
  const { current, next } = (await req.json().catch(() => ({}))) as { current?: string; next?: string };
  const keep = (await cookies()).get(SESSION_COOKIE)?.value;
  const err = changePassword(admin.id, String(current ?? ""), String(next ?? ""), keep);
  if (err) return NextResponse.json({ error: err }, { status: 400 });
  logger.info("audit", "管理员修改了密码，其他会话已退出", { username: admin.username });
  return NextResponse.json({ ok: true });
});
