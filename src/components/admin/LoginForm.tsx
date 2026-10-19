"use client";

import { useState } from "react";

export function LoginForm() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/admin/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password }) });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || "登录失败");
      window.location.href = "/admin";
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const field = "w-full rounded-lg border border-line bg-panel-2 px-3 py-2 text-sm outline-none focus:border-accent";
  return (
    <form onSubmit={submit} className="mt-5 space-y-3">
      <label className="block space-y-1 text-xs text-ink-3">
        <span>用户名</span>
        <input className={field} value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus />
      </label>
      <label className="block space-y-1 text-xs text-ink-3">
        <span>密码</span>
        <input className={field} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
      </label>
      {error && <p className="rounded-lg bg-down-soft px-3 py-2 text-[13px] text-down">{error}</p>}
      <button disabled={busy} className="w-full rounded-lg bg-ink py-2 text-sm font-medium text-bg disabled:opacity-60">
        {busy ? "登录中…" : "登录"}
      </button>
    </form>
  );
}
