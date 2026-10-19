import { redirect } from "next/navigation";
import { adminCount } from "@/lib/server/auth";
import { currentAdmin } from "@/lib/server/guard";
import { LoginForm } from "@/components/admin/LoginForm";
import { Forbidden } from "@/components/admin/Forbidden";

export const dynamic = "force-dynamic";
export const metadata = { title: "后台登录 — 信号灯" };

export default async function LoginPage() {
  const { admin, ipOk } = await currentAdmin();
  if (!ipOk) return <Forbidden />;
  if (admin) redirect("/admin");
  const hasAdmin = adminCount() > 0;
  return (
    <div className="mx-auto mt-16 max-w-sm">
      <div className="card p-6">
        <h1 className="text-xl font-semibold">管理后台</h1>
        <p className="mt-1 text-sm text-ink-3">登录后可查看运行状态、日志和修改系统设置。</p>
        {hasAdmin ? (
          <LoginForm />
        ) : (
          <div className="mt-4 rounded-lg bg-warn-soft p-3 text-[13px] leading-relaxed">
            还没有创建管理员账号。请在服务器上执行：
            <code className="mt-2 block rounded bg-panel-2 px-2 py-1.5 text-xs">sudo signallight admin</code>
          </div>
        )}
      </div>
    </div>
  );
}
