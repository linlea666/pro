import { type NextRequest } from "next/server";
import { requireAdmin } from "@/lib/server/guard";
import { logger } from "@/lib/server/log";
import { CSV_HEADER, iterateLogs, parseFilter, toCsvLine, toJsonLine } from "@/lib/server/logquery";
import { withRoute } from "@/lib/server/route";

export const dynamic = "force-dynamic";

const MAX_ROWS = 500_000;

/** Streams matching logs as CSV (Excel-friendly, with BOM) or JSON lines. */
export const GET = withRoute("admin.logs.export", async (req: NextRequest) => {
  const admin = await requireAdmin();
  if (admin instanceof Response) return admin;
  const sp = req.nextUrl.searchParams;
  const format = sp.get("format") === "json" ? "json" : "csv";
  const f = { ...parseFilter(sp), beforeId: undefined, limit: undefined };
  logger.info("audit", "导出日志", { username: admin.username, format, filter: Object.fromEntries(sp) });

  const enc = new TextEncoder();
  const it = iterateLogs(f);
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      if (format === "csv") c.enqueue(enc.encode("﻿" + CSV_HEADER));
    },
    pull(c) {
      const next = it.next();
      if (next.done || sent >= MAX_ROWS) return c.close();
      sent += next.value.length;
      c.enqueue(enc.encode(next.value.map(format === "csv" ? toCsvLine : toJsonLine).join("")));
    },
  });
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
  return new Response(stream, {
    headers: {
      "content-type": format === "csv" ? "text/csv; charset=utf-8" : "application/x-ndjson; charset=utf-8",
      "content-disposition": `attachment; filename="signallight-logs-${stamp}.${format === "csv" ? "csv" : "jsonl"}"`,
      "cache-control": "no-store",
    },
  });
});
