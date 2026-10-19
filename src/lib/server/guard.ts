import { cookies, headers } from "next/headers";
import { NextResponse } from "next/server";
import { SESSION_COOKIE, ipAllowed, sessionAdmin, type Admin } from "./auth.ts";

/** Next.js-specific helpers for protecting admin pages and APIs. */

export function clientIp(h: Headers): string {
  // server.mjs overwrites x-sl-client-ip with the socket address, so it can be trusted;
  // forwarded headers are only honoured in development (next dev / next start).
  if (process.env.SL_CUSTOM_SERVER === "1") return h.get("x-sl-client-ip") || "unknown";
  const fwd = h.get("x-forwarded-for");
  return (fwd ? fwd.split(",")[0] : h.get("x-real-ip") || "unknown").trim().replace(/^::ffff:/, "");
}

/** For server components / layouts. */
export async function currentAdmin(): Promise<{ admin: Admin | null; ipOk: boolean; ip: string }> {
  const h = await headers();
  const ip = clientIp(h);
  if (!ipAllowed(ip)) return { admin: null, ipOk: false, ip };
  const c = await cookies();
  return { admin: sessionAdmin(c.get(SESSION_COOKIE)?.value), ipOk: true, ip };
}

/** For admin API routes: returns the admin, or a ready-made error response. */
export async function requireAdmin(): Promise<Admin | NextResponse> {
  const { admin, ipOk } = await currentAdmin();
  if (!ipOk) return NextResponse.json({ error: "当前 IP 不允许访问后台" }, { status: 403 });
  if (!admin) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  return admin;
}
