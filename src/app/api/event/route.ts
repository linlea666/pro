import { NextResponse } from "next/server";
import { clientIp } from "@/lib/server/guard";
import { isEventName, recordEvent } from "@/lib/server/events";
import { allow } from "@/lib/server/ratelimit";
import { withRoute } from "@/lib/server/route";

/** Anonymous product events. Public, so it is size- and rate-limited per IP; the IP itself is not stored. */

const VID = /^[A-Za-z0-9-]{16,40}$/;

export const POST = withRoute("event", async (req: Request) => {
  // over the limit or malformed: accept silently so the page never retries
  const none = new NextResponse(null, { status: 204 });
  if (!allow("event", clientIp(req.headers), 60, 60_000).ok) return none;
  const text = await req.text();
  if (text.length > 1000) return none;
  let body: { vid?: unknown; name?: unknown; path?: unknown } = {};
  try {
    body = JSON.parse(text);
  } catch {
    return none;
  }
  if (typeof body.vid !== "string" || !VID.test(body.vid) || !isEventName(body.name)) return none;
  // the page only, without query or hash
  const path = typeof body.path === "string" && body.path.startsWith("/") ? body.path.split(/[?#]/)[0].slice(0, 120) : "/";
  recordEvent(body.vid, body.name, path);
  return none;
});
