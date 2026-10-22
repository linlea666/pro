import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/server/guard";
import { logger } from "@/lib/server/log";
import { getMailConfig } from "@/lib/server/mail";
import { coinIds } from "@/lib/server/coins";
import { getWatchAlertConfig, saveWatchAlertConfig, sendTestAlert, type WatchAlertInput } from "@/lib/server/watchalert";
import { withRoute } from "@/lib/server/route";

export const dynamic = "force-dynamic";

const body = () => ({ config: getWatchAlertConfig(), coins: coinIds(), mailTo: getMailConfig().to });

export const GET = withRoute("admin.watchAlert.get", async () => {
  const admin = await requireAdmin();
  if (admin instanceof Response) return admin;
  return NextResponse.json(body());
});

/** `{ action: "save", ...form }` stores the form; `{ action: "test", ...form }` sends a sample with it, without saving. */
export const POST = withRoute("admin.watchAlert.post", async (req: Request) => {
  const admin = await requireAdmin();
  if (admin instanceof Response) return admin;
  const { action, ...form } = (await req.json().catch(() => ({}))) as WatchAlertInput & { action?: string };
  try {
    if (action === "test") {
      const to = await sendTestAlert(form);
      logger.info("audit", "发送测试盯盘提醒", { username: admin.username, to: to.length });
      return NextResponse.json({ ok: true, message: `测试提醒已发送到 ${to.join("、")}，请查收（也看看垃圾邮件箱）` });
    }
    if (action === "save") {
      const before = getWatchAlertConfig();
      const after = saveWatchAlertConfig(form);
      logger.info("audit", "修改盯盘提醒", { username: admin.username, from: { ...before, to: before.to.length }, to: { ...after, to: after.to.length } });
      return NextResponse.json({ ...body(), message: "盯盘提醒设置已保存" });
    }
    return NextResponse.json({ error: "未知操作" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
});
