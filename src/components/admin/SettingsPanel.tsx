"use client";

import { useEffect, useState } from "react";
import { btnCls, btnGhost, inputCls } from "./ui";

type Settings = Record<string, { value: number | boolean; default: number | boolean }>;

type Field = { key: string; label: string; hint: string; unit?: string; kind: "number" | "bool" };

const FIELDS: Field[] = [
  { key: "log.retentionDays", label: "日志保留天数", hint: "超过这个天数的日志每天凌晨自动删除（7–365）", unit: "天", kind: "number" },
  { key: "log.maxDbMB", label: "数据库大小上限", hint: "超过上限时优先删除最旧的“信息 / 调试”级日志，错误日志会保留", unit: "MB", kind: "number" },
  { key: "log.archiveKeepWeeks", label: "日志归档保留周数", hint: "在“日志中心”开启周归档后，超出周数的最旧归档文件会被删除", unit: "周", kind: "number" },
  { key: "backup.keepDaily", label: "自动备份保留份数", hint: "每天自动备份一次数据库，超出份数的最旧备份会被删除", unit: "份", kind: "number" },
];

const RATE_FIELDS: Field[] = [
  { key: "rate.publicPerMin", label: "公开接口限流", hint: "同一个 IP 每分钟最多请求分析、多周期、K 线、总览接口各多少次；超出返回“请求太频繁”（10–1000）", unit: "次/分钟", kind: "number" },
  { key: "rate.replayPerMin", label: "时光机回放限流", hint: "回放需要现场计算，比普通分析耗资源，单独限流（2–300）", unit: "次/分钟", kind: "number" },
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
        <h2 className="mb-3 text-[15px] font-semibold">日志、备份与限流</h2>
        {!s ? (
          <div className="h-32 animate-pulse rounded bg-panel-2" />
        ) : (
          <div className="space-y-4">
            {FIELDS.map((f) => (
              <FieldRow key={f.key} f={f} s={s} draft={draft} setDraft={setDraft} />
            ))}
            <h3 className="border-t border-line pt-4 text-sm font-semibold">接口限流</h3>
            {RATE_FIELDS.map((f) => (
              <FieldRow key={f.key} f={f} s={s} draft={draft} setDraft={setDraft} />
            ))}
            <label className="flex cursor-pointer items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1" checked={Boolean(draft["precompute.enabled"])} onChange={(e) => setDraft({ ...draft, "precompute.enabled": e.target.checked })} />
              <span>
                后台预计算
                <span className="block text-xs text-ink-3">每分钟提前算好所有币种和周期的分析，访问时直接读取结果。服务器配置很低（单核）时可以关闭。</span>
              </span>
            </label>
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

function FieldRow({ f, s, draft, setDraft }: { f: Field; s: Settings; draft: Record<string, number | boolean>; setDraft: (d: Record<string, number | boolean>) => void }) {
  return (
    <div className="grid gap-2 sm:grid-cols-[200px_160px_1fr] sm:items-center">
      <label className="text-sm" htmlFor={f.key}>{f.label}</label>
      <div className="flex items-center gap-2">
        <input id={f.key} type="number" className={inputCls} value={Number(draft[f.key])} onChange={(e) => setDraft({ ...draft, [f.key]: Math.round(+e.target.value) })} />
        <span className="whitespace-nowrap text-xs text-ink-3">{f.unit}</span>
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
    setMsg({ ok: r.ok, text: r.ok ? "密码已修改，其他设备上的登录已退出" : b.error });
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
        <input className={inputCls} type="password" placeholder="新密码（至少 12 位，包含字母和数字）" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
        <input className={inputCls} type="password" placeholder="再次输入新密码" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
        {msg && <p className={`text-[13px] ${msg.ok ? "text-up" : "text-down"}`}>{msg.text}</p>}
        <button className={`${btnCls} w-fit`}>修改密码</button>
      </form>
      <p className="mt-3 text-xs text-ink-3">忘记密码时，在服务器上执行 <code>sudo signallight admin</code> 重置。</p>
    </section>
  );
}
