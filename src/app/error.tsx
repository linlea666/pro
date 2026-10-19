"use client";

import { useEffect } from "react";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    const body = JSON.stringify({ kind: "render", msg: `${error.message}${error.digest ? ` (digest ${error.digest})` : ""}`, stack: error.stack, url: location.href });
    fetch("/api/client-log", { method: "POST", body, keepalive: true }).catch(() => {});
  }, [error]);
  return (
    <div className="card mx-auto mt-16 max-w-md p-6 text-center">
      <h1 className="text-lg font-semibold">页面出了点问题</h1>
      <p className="mt-2 text-sm text-ink-2">错误已自动记录。可以先刷新重试；如果一直出现，请把下面的编号告诉管理员。</p>
      {error.digest && <code className="mt-3 block rounded bg-panel-2 px-2 py-1 text-xs text-ink-3">{error.digest}</code>}
      <button onClick={reset} className="mt-4 rounded-lg bg-ink px-4 py-2 text-sm font-medium text-bg">重试</button>
    </div>
  );
}
