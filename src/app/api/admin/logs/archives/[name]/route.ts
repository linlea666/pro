import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { archiveDir } from "@/lib/server/archive";
import { requireAdmin } from "@/lib/server/guard";
import { withRoute } from "@/lib/server/route";

export const dynamic = "force-dynamic";

export const GET = withRoute("admin.logs.archive.download", async (_req: Request, ctx: { params: Promise<{ name: string }> }) => {
  const admin = await requireAdmin();
  if (admin instanceof Response) return admin;
  const { name } = await ctx.params;
  if (!/^logs-\d{4}-W\d{2}\.jsonl\.gz$/.test(name)) return NextResponse.json({ error: "文件名不合法" }, { status: 400 });
  const file = path.join(archiveDir(), name);
  if (!fs.existsSync(file)) return NextResponse.json({ error: "归档不存在" }, { status: 404 });
  const buf = fs.readFileSync(file);
  return new Response(buf, { headers: { "content-type": "application/gzip", "content-disposition": `attachment; filename="${name}"`, "content-length": String(buf.length) } });
});
