import { NextResponse } from "next/server";
import { clearAiCache } from "@/lib/server/ai";
import { requireAdmin } from "@/lib/server/guard";
import { logger } from "@/lib/server/log";
import { withRoute } from "@/lib/server/route";

export const DELETE = withRoute("admin.ai.cache.clear", async () => {
  const admin = await requireAdmin();
  if (admin instanceof Response) return admin;
  const n = clearAiCache();
  logger.info("audit", "清空 AI 解读缓存", { username: admin.username, removed: n });
  return NextResponse.json({ ok: true, message: `已清空 ${n} 条缓存，下次访问会重新生成` });
});
