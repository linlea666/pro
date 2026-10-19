import { NextResponse } from "next/server";
import { SESSION_COOKIE, SESSION_TTL_MS, ipAllowed, login } from "@/lib/server/auth";
import { env } from "@/lib/server/env";
import { clientIp } from "@/lib/server/guard";
import { logger } from "@/lib/server/log";
import { allow } from "@/lib/server/ratelimit";
import { withRoute } from "@/lib/server/route";

export const dynamic = "force-dynamic";

export const POST = withRoute("admin.login", async (req: Request) => {
  const ip = clientIp(req.headers);
  if (!ipAllowed(ip)) {
    logger.warn("audit", "白名单外的 IP 尝试登录后台", { ip });
    return NextResponse.json({ error: "当前 IP 不允许访问后台" }, { status: 403 });
  }
  // per-IP lockout stops one guesser; this caps guessing spread over many IPs
  if (!allow("login-global", "*", 20, 60_000).ok) {
    logger.warn("audit", "登录请求过于频繁，已临时拒绝", { ip });
    return NextResponse.json({ error: "登录请求过于频繁，请一分钟后再试" }, { status: 429 });
  }
  const body = (await req.json().catch(() => ({}))) as { username?: string; password?: string };
  const username = String(body.username ?? "").trim();
  const password = String(body.password ?? "");
  if (!username || !password) return NextResponse.json({ error: "请输入用户名和密码" }, { status: 400 });

  const r = login(username, password, ip, req.headers.get("user-agent") ?? "");
  if (!r.ok) {
    logger.warn("audit", r.reason === "locked" ? "登录被锁定" : "登录失败", { username, ip });
    const msg = r.lockedUntil ? `失败次数过多，请在 ${new Date(r.lockedUntil).toLocaleTimeString("zh-CN", { hour12: false })} 之后再试` : "用户名或密码错误";
    return NextResponse.json({ error: msg }, { status: r.reason === "locked" ? 429 : 401 });
  }
  logger.info("audit", "管理员登录", { username, ip });
  const res = NextResponse.json({ ok: true, username: r.admin.username });
  res.cookies.set(SESSION_COOKIE, r.token, { httpOnly: true, sameSite: "lax", secure: env.secureCookies, path: "/", maxAge: SESSION_TTL_MS / 1000 });
  return res;
});
