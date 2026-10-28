import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/server/guard";
import { logger } from "@/lib/server/log";
import { getMailConfig, mailReady } from "@/lib/server/mail";
import { getRollBook, saveRollBook, sendTestRollAlert } from "@/lib/server/rollalert";
import { withRoute } from "@/lib/server/route";

export const dynamic = "force-dynamic";

const body = () => ({ book: getRollBook(), mailTo: getMailConfig().to, mailReady: mailReady() });

/** The admin's 滚仓助手 accounts and alert settings (401 for visitors: the page then keeps them in the browser). */
export const GET = withRoute("admin.roll.get", async () => {
  const admin = await requireAdmin();
  if (admin instanceof Response) return admin;
  return NextResponse.json(body());
});

/** `{ action: "save", book }` stores the whole book; `{ action: "test", book }` mails a sample with its alert settings. */
export const POST = withRoute("admin.roll.post", async (req: Request) => {
  const admin = await requireAdmin();
  if (admin instanceof Response) return admin;
  const { action, book } = (await req.json().catch(() => ({}))) as { action?: string; book?: unknown };
  try {
    if (action === "save") {
      const before = getRollBook();
      const after = saveRollBook(book);
      if (before.alert.enabled !== after.alert.enabled) logger.info("audit", after.alert.enabled ? "开启滚仓提醒" : "关闭滚仓提醒", { username: admin.username });
      return NextResponse.json(body());
    }
    if (action === "test") {
      const to = await sendTestRollAlert(book);
      return NextResponse.json({ ok: true, message: `测试提醒已发送到 ${to.join("、")}，请查收（也看看垃圾邮件箱）` });
    }
    return NextResponse.json({ error: "未知操作" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
});
