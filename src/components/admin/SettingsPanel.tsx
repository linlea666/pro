"use client";

import { useEffect, useState } from "react";
import { OpinionZonesForm } from "./OpinionZonesForm";
import { btnCls, btnGhost, inputCls } from "./ui";

/** number / boolean settings are edited in the form below; string ones (JSON) have their own editors */
type SettingValue = number | boolean | string;
type Settings = Record<string, { value: SettingValue; default: SettingValue }>;

/** the number / boolean settings only: the main form never re-posts a JSON setting saved by its own editor */
const scalars = (b: Settings) => Object.fromEntries(Object.entries(b).filter(([, v]) => typeof v.value !== "string").map(([k, v]) => [k, v.value as number | boolean]));

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
        setDraft(scalars(b));
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

      {s && <OpinionZonesForm value={String(s["spot.opinionZones"]?.value ?? "")} fallback={String(s["spot.opinionZones"]?.default ?? "")} onSaved={(b) => setS(b as Settings)} />}
      <MailForm />
      <PasswordForm />
    </div>
  );
}

type MailConfig = { host: string; port: number; security: "ssl" | "starttls" | "none"; user: string; to: string[]; alertsEnabled: boolean; hasPass: boolean };

const SECURITY: { value: MailConfig["security"]; label: string; port: number }[] = [
  { value: "ssl", label: "SSL/TLS（推荐，通常 465 端口）", port: 465 },
  { value: "starttls", label: "STARTTLS（通常 587 端口）", port: 587 },
  { value: "none", label: "不加密（不推荐）", port: 25 },
];

/** SMTP settings for alert mails; the password is write-only. */
function MailForm() {
  const [c, setC] = useState<MailConfig | null>(null);
  const [canEncrypt, setCanEncrypt] = useState(true);
  const [form, setForm] = useState({ host: "", port: 465, security: "ssl" as MailConfig["security"], user: "", pass: "", to: "", alertsEnabled: false });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = (b: { config: MailConfig; canEncrypt: boolean }) => {
    setC(b.config);
    setCanEncrypt(b.canEncrypt);
    setForm({ host: b.config.host, port: b.config.port, security: b.config.security, user: b.config.user, pass: "", to: b.config.to.join("\n"), alertsEnabled: b.config.alertsEnabled });
  };
  useEffect(() => {
    fetch("/api/admin/mail")
      .then((r) => r.json())
      .then(load);
  }, []);

  const post = async (action: "save" | "test") => {
    setBusy(true);
    setMsg(null);
    const r = await fetch("/api/admin/mail", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, ...form }) });
    const b = await r.json();
    setBusy(false);
    if (!r.ok) return setMsg({ ok: false, text: b.error });
    if (action === "save") load(b);
    setMsg({ ok: true, text: b.message });
  };

  const set = (k: keyof typeof form, v: string | number | boolean) => setForm({ ...form, [k]: v });
  const row = "grid gap-2 sm:grid-cols-[200px_1fr] sm:items-center";
  return (
    <section className="card p-4">
      <h2 className="mb-1 text-[15px] font-semibold">邮件与告警</h2>
      <p className="mb-3 text-xs text-ink-3">
        数据源全部失败或切换、K 线出现缺口、定时任务连续失败、AI 调用失败或额度用完、数据库接近上限时，发邮件给下面的收件人。同一类告警 30 分钟内只发一封，另外每天发一封摘要。
      </p>
      {!c ? (
        <div className="h-40 animate-pulse rounded bg-panel-2" />
      ) : (
        <div className="space-y-3">
          {!canEncrypt && <p className="rounded-lg bg-down-soft px-3 py-2 text-[13px] text-down">服务器没有配置 MASTER_KEY，无法加密保存授权码。请在配置文件中设置后重启。</p>}
          <div className={row}>
            <label className="text-sm" htmlFor="mail-host">SMTP 服务器</label>
            <input id="mail-host" className={inputCls} placeholder="例如 smtp.qq.com、smtp.163.com" value={form.host} onChange={(e) => set("host", e.target.value)} />
          </div>
          <div className={row}>
            <label className="text-sm" htmlFor="mail-security">连接方式与端口</label>
            <div className="flex gap-2">
              <select
                id="mail-security"
                className={inputCls}
                value={form.security}
                onChange={(e) => {
                  const s = SECURITY.find((x) => x.value === e.target.value)!;
                  setForm({ ...form, security: s.value, port: s.port });
                }}
              >
                {SECURITY.map((x) => (
                  <option key={x.value} value={x.value}>{x.label}</option>
                ))}
              </select>
              <input aria-label="端口" type="number" className={`${inputCls} max-w-24`} value={form.port} onChange={(e) => set("port", Math.round(+e.target.value))} />
            </div>
          </div>
          <div className={row}>
            <label className="text-sm" htmlFor="mail-user">发件邮箱 / 登录账号</label>
            <input id="mail-user" className={inputCls} autoComplete="off" placeholder="name@qq.com" value={form.user} onChange={(e) => set("user", e.target.value)} />
          </div>
          <div className={row}>
            <label className="text-sm" htmlFor="mail-pass">邮箱授权码</label>
            <div>
              <input id="mail-pass" type="password" className={inputCls} autoComplete="new-password" placeholder={c.hasPass ? "已保存（留空表示不修改）" : "在邮箱设置里开启 SMTP 后获得，不是登录密码"} value={form.pass} onChange={(e) => set("pass", e.target.value)} />
            </div>
          </div>
          <div className={row}>
            <label className="text-sm" htmlFor="mail-to">告警收件邮箱</label>
            <textarea id="mail-to" rows={2} className={inputCls} placeholder="每行一个，最多 10 个" value={form.to} onChange={(e) => set("to", e.target.value)} />
          </div>
          <label className="flex cursor-pointer items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={form.alertsEnabled} onChange={(e) => set("alertsEnabled", e.target.checked)} />
            <span>
              开启告警邮件
              <span className="block text-xs text-ink-3">建议先“发送测试邮件”确认能收到，再开启。</span>
            </span>
          </label>
          {msg && <p className={`rounded-lg px-3 py-2 text-[13px] ${msg.ok ? "bg-up-soft text-up" : "bg-down-soft text-down"}`}>{msg.text}</p>}
          <div className="flex flex-wrap gap-2 border-t border-line pt-4">
            <button className={btnCls} disabled={busy} onClick={() => post("save")}>保存邮件配置</button>
            <button className={btnGhost} disabled={busy} onClick={() => post("test")}>发送测试邮件</button>
          </div>
          <p className="text-xs text-ink-3">测试邮件使用当前表单的内容，不会保存。授权码留空时使用已保存的授权码。阿里云等云服务器通常封禁 25 端口，请用 465 或 587。</p>
        </div>
      )}
    </section>
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
          <button className="ml-2 text-accent" onClick={() => setDraft({ ...draft, [f.key]: s[f.key].default as number })}>
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
