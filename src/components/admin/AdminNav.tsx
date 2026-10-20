"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS: { href: string; label: string; soon?: string }[] = [
  { href: "/admin", label: "运行概览" },
  { href: "/admin/logs", label: "日志中心" },
  { href: "/admin/metrics", label: "产品指标" },
  { href: "/admin/params", label: "参数调试" },
  { href: "/admin/ai", label: "AI 配置" },
  { href: "/admin/settings", label: "系统设置" },
];

export function AdminNav({ username, ready = ["/admin", "/admin/logs", "/admin/metrics", "/admin/params", "/admin/ai", "/admin/settings"] }: { username: string; ready?: string[] }) {
  const path = usePathname();
  const logout = async () => {
    await fetch("/api/admin/logout", { method: "POST" });
    window.location.href = "/admin/login";
  };
  return (
    <aside className="card h-fit p-3 md:sticky md:top-20">
      <div className="px-2 pb-3 text-xs text-ink-3">
        管理后台 · <span className="text-ink-2">{username}</span>
      </div>
      <nav className="flex gap-1 overflow-x-auto md:flex-col">
        {ITEMS.map((it) => {
          const active = it.href === "/admin" ? path === "/admin" : path.startsWith(it.href);
          const enabled = ready.includes(it.href);
          return enabled ? (
            <Link key={it.href} href={it.href} className={`whitespace-nowrap rounded-lg px-3 py-2 text-sm ${active ? "bg-panel-2 font-medium text-ink" : "text-ink-2 hover:text-ink"}`}>
              {it.label}
            </Link>
          ) : (
            <span key={it.href} className="flex cursor-not-allowed items-center justify-between whitespace-nowrap rounded-lg px-3 py-2 text-sm text-ink-3">
              {it.label}
              <span className="ml-2 rounded bg-panel-2 px-1.5 text-[10px]">开发中</span>
            </span>
          );
        })}
      </nav>
      <button onClick={logout} className="mt-3 w-full rounded-lg border border-line px-3 py-1.5 text-xs text-ink-2 hover:text-ink">
        退出登录
      </button>
    </aside>
  );
}
