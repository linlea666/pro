import { NextResponse } from "next/server";
import { newTrace, runWithTrace } from "./context.ts";
import { clientIp } from "./guard.ts";
import { logger } from "./log.ts";
import { allow, takeRejected } from "./ratelimit.ts";

/**
 * Wrap an API route handler: assigns a trace id (returned as `x-trace-id`),
 * logs method/path/status/duration, and turns uncaught errors into a JSON 500
 * that carries the trace id so a user report can be matched to the log.
 *
 * Successful public requests are not stored one by one (an open coin page polls
 * every minute); they are counted and written as one summary line per minute.
 */

const TRACE_RE = /^[A-Za-z0-9-]{8,32}$/;

interface Tally {
  n: number;
  ms: number;
  max: number;
}
const g = globalThis as { __slHttpTally?: Map<string, Tally>; __slHttpTimer?: ReturnType<typeof setInterval> };
const tally = (g.__slHttpTally ??= new Map());
if (!g.__slHttpTimer) {
  g.__slHttpTimer = setInterval(flushSummary, 60_000);
  g.__slHttpTimer.unref?.();
}

function count(path: string, ms: number) {
  const t = tally.get(path);
  if (t) {
    t.n++;
    t.ms += ms;
    t.max = Math.max(t.max, ms);
  } else tally.set(path, { n: 1, ms, max: ms });
}

export function flushSummary() {
  const rejected = takeRejected();
  const rej = Object.values(rejected).reduce((a, b) => a + b, 0);
  if (tally.size === 0 && rej === 0) return;
  const paths = Object.fromEntries([...tally].map(([p, t]) => [p, { n: t.n, avgMs: Math.round(t.ms / t.n), maxMs: t.max }]));
  const total = [...tally.values()].reduce((a, t) => a + t.n, 0);
  tally.clear();
  logger[rej ? "warn" : "info"]("http", `公开接口 1 分钟汇总：${total} 次成功请求${rej ? `，限流拒绝 ${rej} 次` : ""}`, { paths, rejected: rej ? rejected : undefined });
}

export function withRoute<R extends Request, C>(name: string, handler: (req: R, ctx: C) => Promise<Response> | Response) {
  return async (req: R, ctx: C): Promise<Response> => {
    const supplied = req.headers.get("x-trace-id");
    const trace = supplied && TRACE_RE.test(supplied) ? supplied : newTrace();
    const url = new URL(req.url);
    return runWithTrace({ trace, path: url.pathname }, async () => {
      const start = Date.now();
      let res: Response;
      try {
        res = await handler(req, ctx);
      } catch (e) {
        logger.error("http", `${name} 未处理的异常`, { error: e, path: url.pathname, query: url.search });
        res = NextResponse.json({ error: "服务器内部错误", trace }, { status: 500 });
      }
      const ms = Date.now() - start;
      const admin = url.pathname.startsWith("/api/admin/");
      if (res.status >= 500) logger.error("http", `${req.method} ${url.pathname} ${res.status}`, { durationMs: ms, query: url.search || undefined });
      else if (res.status === 429) {
        // counted by the rate limiter and reported in the minute summary
      } else if (res.status >= 400) logger.warn("http", `${req.method} ${url.pathname} ${res.status}`, { durationMs: ms, query: url.search || undefined });
      else if (!admin) count(url.pathname, ms);
      // the admin UI polls its own read endpoints; keep those out of the stored log
      else logger[req.method === "GET" ? "debug" : "info"]("http", `${req.method} ${url.pathname} ${res.status}`, { durationMs: ms, query: url.search || undefined });
      res.headers.set("x-trace-id", trace);
      return res;
    });
  };
}

/** Per-IP limit for a public endpoint; returns a 429 response when the caller is over it. */
export function limited(req: Request, bucket: string, max: number, windowMs = 60_000): NextResponse | null {
  const r = allow(bucket, clientIp(req.headers), max, windowMs);
  if (r.ok) return null;
  return NextResponse.json(
    { error: "请求太频繁，请稍后再试", retryAfter: r.retryAfter },
    { status: 429, headers: { "retry-after": String(r.retryAfter) } },
  );
}
