import { Suspense } from "react";
import { LogsPanel } from "@/components/admin/LogsPanel";

export const metadata = { title: "日志中心 — 信号灯后台" };

export default function LogsPage() {
  return (
    <Suspense>
      <LogsPanel />
    </Suspense>
  );
}
