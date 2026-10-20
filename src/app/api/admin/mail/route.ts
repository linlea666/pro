import { NextResponse } from "next/server";
import { canEncrypt } from "@/lib/server/crypto";
import { requireAdmin } from "@/lib/server/guard";
import { logger } from "@/lib/server/log";
import { getMailConfig, mergeMailConfig, publicMailConfig, saveMailConfig, sendMail, type MailConfigInput } from "@/lib/server/mail";
import { withRoute } from "@/lib/server/route";

export const dynamic = "force-dynamic";

export const GET = withRoute("admin.mail.get", async () => {
  const admin = await requireAdmin();
  if (admin instanceof Response) return admin;
  return NextResponse.json({ config: publicMailConfig(), canEncrypt: canEncrypt() });
});

/** `{ action: "save", ...form }` stores the form; `{ action: "test", ...form }` sends a test mail with it, without saving. */
export const POST = withRoute("admin.mail.post", async (req: Request) => {
  const admin = await requireAdmin();
  if (admin instanceof Response) return admin;
  const { action, ...form } = (await req.json().catch(() => ({}))) as MailConfigInput & { action?: string };
  try {
    if (action === "test") {
      const c = mergeMailConfig({ ...form, alertsEnabled: false });
      await sendMail(
        "测试邮件",
        `这是一封测试邮件，说明信号灯的邮件配置可以正常发信。\n\n发件邮箱：${c.user}\nSMTP：${c.host}:${c.port}（${c.security}）\n发送人：管理员 ${admin.username}`,
        c,
      );
      logger.info("audit", "发送测试邮件", { username: admin.username, to: c.to.length });
      return NextResponse.json({ ok: true, message: `测试邮件已发送到 ${c.to.join("、")}，请查收（也看看垃圾邮件箱）` });
    }
    if (action === "save") {
      const before = publicMailConfig(getMailConfig());
      const after = publicMailConfig(saveMailConfig(form));
      const changed = (["host", "port", "security", "user", "alertsEnabled"] as const).filter((k) => before[k] !== after[k]);
      logger.info("audit", "修改邮件配置", {
        username: admin.username,
        changed: Object.fromEntries(changed.map((k) => [k, { from: before[k], to: after[k] }])),
        recipients: before.to.join(",") !== after.to.join(",") ? after.to.length : undefined,
        passChanged: form.pass ? true : form.clearPass ? "cleared" : undefined,
      });
      return NextResponse.json({ config: after, canEncrypt: canEncrypt(), message: "邮件配置已保存" });
    }
    return NextResponse.json({ error: "未知操作" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
});
