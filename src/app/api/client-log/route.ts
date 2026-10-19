import { NextResponse } from "next/server";
import { clientIp } from "@/lib/server/guard";
import { logger } from "@/lib/server/log";
import { allow } from "@/lib/server/ratelimit";
import { withRoute } from "@/lib/server/route";

/** Browser-side error reports. Public, so it is size- and rate-limited per IP. */

export const POST = withRoute("client-log", async (req: Request) => {
  const ip = clientIp(req.headers);
  // over the limit: accept silently so a broken page doesn't retry in a loop
  if (!allow("client-log", ip, 20, 60_000).ok) return new NextResponse(null, { status: 204 });

  const text = await req.text();
  if (text.length > 10_000) return new NextResponse(null, { status: 204 });
  let body: { msg?: string; stack?: string; url?: string; kind?: string } = {};
  try {
    body = JSON.parse(text);
  } catch {
    return new NextResponse(null, { status: 204 });
  }
  logger.error("client", `浏览器端错误：${String(body.msg ?? "未知错误").slice(0, 300)}`, {
    kind: body.kind,
    url: String(body.url ?? "").slice(0, 300),
    stack: String(body.stack ?? "").slice(0, 2000),
    ua: (req.headers.get("user-agent") ?? "").slice(0, 200),
    ip: ip.replace(/\.\d+$/, ".*"),
  });
  return new NextResponse(null, { status: 204 });
});
