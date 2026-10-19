import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE, logout, sessionAdmin } from "@/lib/server/auth";
import { logger } from "@/lib/server/log";
import { withRoute } from "@/lib/server/route";

export const POST = withRoute("admin.logout", async () => {
  const c = await cookies();
  const token = c.get(SESSION_COOKIE)?.value;
  const admin = sessionAdmin(token);
  logout(token);
  if (admin) logger.info("audit", "管理员退出登录", { username: admin.username });
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(SESSION_COOKIE);
  return res;
});
