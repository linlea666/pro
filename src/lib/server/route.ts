import { NextResponse } from "next/server";
import { newTrace, runWithTrace } from "./context.ts";
import { logger } from "./log.ts";

/**
 * Wrap an API route handler: assigns a trace id (returned as `x-trace-id`),
 * logs method/path/status/duration, and turns uncaught errors into a JSON 500
 * that carries the trace id so a user report can be matched to the log.
 */
export function withRoute<R extends Request, C>(name: string, handler: (req: R, ctx: C) => Promise<Response> | Response) {
  return async (req: R, ctx: C): Promise<Response> => {
    const trace = req.headers.get("x-trace-id")?.slice(0, 32) || newTrace();
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
      const level = res.status >= 500 ? "error" : res.status >= 400 ? "warn" : "info";
      logger[level]("http", `${req.method} ${url.pathname} ${res.status}`, { durationMs: ms, query: url.search || undefined });
      res.headers.set("x-trace-id", trace);
      return res;
    });
  };
}
