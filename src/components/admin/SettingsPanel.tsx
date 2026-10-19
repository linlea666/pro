"use client";

import { useEffect, useState } from "react";
import { btnCls, btnGhost, inputCls } from "./ui";

type Settings = Record<string, { value: number | boolean; default: number | boolean }>;

const FIELDS: { key: string; label: string; hint: string; unit?: string; kind: "number" | "bool" }[] = [
  { key: "log.retentionDays", label: "日志保留天数", hint: "超过这个天数的日志每天凌晨自动删除（7–365）", unit: "天", kind: "number" },
  { key: "log.maxDbMB", label: "数据库大小上限", hint: "超过上限时优先删除最旧的“信息 / 调试”级日志，错误日志会保留", unit: "MB", kind: "number" },
  { key: "backup.keepDaily", label: "自动备份保留份数", hint: "每天自动备份一次数据库，超出份数的最旧备份会被删除", unit: "份", kind: "number" },
];

export function SettingsPanel() {
  const [s, setS] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Record<string, number | boolean>>({});
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/admin/settings")
      .then((r) => r.json())
      .then((b: Settings) => {
        setS(b);
        setDraft(Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v.value])));
      });
  }, []);

  const save = async () => {
    setBusy(true);
    setMsg(null);
    const r = await fetch("/api/admin/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(draft) });
    const b = await r.json();
    setBusy(false);
    if (!r.ok) return setMsg({ ok: false, text: b.error });
    setS(b);
    setMsg({ ok: true, text: "已保存" });
  };

  const maintenance = async (action: "backup" | "cleanup") => {
    setBusy(true);
    setMsg(null);
    const r = await fetch("/api/admin/maintenance", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }) });
    const b = await r.json();
    setBusy(false);
    setMsg({ ok: r.ok, text: b.message ?? b.error });
  };

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">系统设置</h1>
      {msg && <p className={`rounded-lg px-3 py-2 text-[13px] ${msg.ok ? "bg-up-soft text-up" : "bg-down-soft text-down"}`}>{msg.text}</p>}

      <section className="card p-4">
        <h2 className="mb-3 text-[15px] font-semibold">日志与备份</h2>
        {!s ? (
          <div className="h-32 animate-pulse rounded bg-panel-2" />
        ) : (
          <div className="space-y-4">
            {FIELDS.map((f) => (
              <div key={f.key} className="grid gap-2 sm:grid-cols-[200px_160px_1fr] sm:items-center">
                <label className="text-sm" htmlFor={f.key}>{f.label}</label>
                <div className="flex items-center gap-2">
                  <input id={f.key} type="number" className={inputCls} value={Number(draft[f.key])} onChange={(e) => setDraft({ ...draft, [f.key]: Math.round(+e.target.value) })} />
                  <span className="text-xs text-ink-3">{f.unit}</span>
                </div>
                <div className="text-xs text-ink-3">
                  {f.hint} · 默认 {String(s[f.key].default)}
                  {draft[f.key] !== s[f.key].default && (
                    <button className="ml-2 text-accent" onClick={() => setDraft({ ...draft, [f.key]: s[f.key].default })}>
                      恢复默认
                    </button>
                  )}
                </div>
              </div>
            ))}
            <div className="flex flex-wrap gap-2 border-t border-line pt-4">
              <button className={btnCls} disabled={busy} onClick={save}>保存设置</button>
              <button className={btnGhost} disabled={busy} onClick={() => maintenance("backup")}>立即备份数据库</button>
              <button className={btnGhost} disabled={busy} onClick={() => maintenance("cleanup")}>立即清理过期日志</button>
            </div>
          </div>
        )}
      </section>

      <PasswordForm />
    </div>
  );
}

function PasswordForm() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (next !== confirm) return setMsg({ ok: false, text: "两次输入的新密码不一致" });
    const r = await fetch("/api/admin/password", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ current, next }) });
    const b = await r.json();
    setMsg({ ok: r.ok, text: r.ok ? "密码已修改" : b.error });
    if (r.ok) {
      setCurrent("");
      setNext("");
      setConfirm("");
    }
  };

  return (
    <section className="card p-4">
      <h2 className="mb-3 text-[15px] font-semibold">修改管理员密码</h2>
      <form onSubmit={submit} className="grid max-w-md gap-3">
        <input className={inputCls} type="password" placeholder="当前密码" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
        <input className={inputCls} type="password" placeholder="新密码（至少 8 位，包含字母和数字）" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
        <input className={inputCls} type="password" placeholder="再次输入新密码" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
        {msg && <p className={`text-[13px] ${msg.ok ? "text-up" : "text-down"}`}>{msg.text}</p>}
        <button className={`${btnCls} w-fit`}>修改密码</button>
      </form>
      <p className="mt-3 text-xs text-ink-3">忘记密码时，在服务器上执行 <code>sudo signallight admin</code> 重置。</p>
    </section>
  );
}
