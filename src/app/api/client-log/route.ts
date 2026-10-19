import { NextResponse } from "next/server";
import { clientIp } from "@/lib/server/guard";
import { logger } from "@/lib/server/log";
import { withRoute } from "@/lib/server/route";

/** Browser-side error reports. Public, so it is size- and rate-limited per IP. */
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 20;
const hits = new Map<string, { n: number; start: number }>();

export const POST = withRoute("client-log", async (req: Request) => {
  const ip = clientIp(req.headers);
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || now - h.start > WINDOW_MS) hits.set(ip, { n: 1, start: now });
  else if (++h.n > MAX_PER_WINDOW) return new NextResponse(null, { status: 204 });
  if (hits.size > 5000) hits.clear();

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
