"use client";

import { useState } from "react";
import { EXCHANGE_NAME, type ExchangeId, type ExSnapshot } from "@/lib/exchange";
import type { ExAccountPrefs, HoldingPrefs } from "@/lib/rollbook";

/**
 * 交易所连接 (read-only keys): add an OKX / Binance key, test it, rename it, replace it, remove it, and see
 * whether each account reads. The balances and positions themselves show in the account card and the
 * position table above; the data is loaded once by the page (`ExData`).
 */

export interface PublicAccount {
  id: string;
  name: string;
  ex: ExchangeId;
  keyHint: string;
  ipRestrict: boolean | null;
  prefs: ExAccountPrefs;
}
export interface ExData {
  accounts: PublicAccount[];
  snapshots: Record<string, { snap: ExSnapshot | null; error: string | null; t: number }>;
  prefs: Record<string, HoldingPrefs>;
  betas: Record<string, number>;
  canEncrypt: boolean;
  allowlist: boolean;
  secure: boolean;
}

const field = "num w-full rounded-lg border border-line bg-panel-2 px-2.5 py-1.5 text-sm outline-none focus:border-accent";

export function ExchangePanel({ data, onPost }: { data: ExData; onPost: (body: Record<string, unknown>) => Promise<{ ok: boolean; message: string | null }> }) {
  const [pick, setPick] = useState<string | null>(null);
  const [form, setForm] = useState<null | "add" | "key" | "rename">(data.accounts.length ? null : "add");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const acc = data.accounts.find((a) => a.id === pick) ?? data.accounts[0] ?? null;
  const entry = acc ? data.snapshots[acc.id] : undefined;
  const http = typeof location !== "undefined" && location.protocol === "http:";
  const post = async (body: Record<string, unknown>) => {
    setBusy(true);
    setMsg(null);
    const r = await onPost(body);
    setBusy(false);
    if (r.ok) setForm(null);
    if (r.message) setMsg({ ok: r.ok, text: r.message });
  };

  return (
    <details className="card p-4" open={!data.accounts.length}>
      <summary className="cursor-pointer text-[15px] font-semibold">
        交易所连接 <span className="text-sm font-normal text-ink-3">· 只读，不下单{data.accounts.length ? ` · ${data.accounts.length} 个账户` : ""}</span>
      </summary>
      <div className="mt-3 space-y-3">
        {!data.canEncrypt && <p className="text-sm text-down">服务器没有配置 MASTER_KEY，无法加密保存 API Key。</p>}
        <div className="flex flex-wrap items-center gap-2">
          {data.accounts.length > 0 && (
            <select id="ex-pick" className={`${field} w-auto`} value={acc?.id ?? ""} onChange={(e) => setPick(e.target.value)}>
              {data.accounts.map((a) => (
                <option key={a.id} value={a.id}>{a.name} · {EXCHANGE_NAME[a.ex]}</option>
              ))}
            </select>
          )}
          {acc && (
            <>
              <button disabled={busy} className="chip" onClick={() => post({ action: "test", id: acc.id })}>测试连接</button>
              <button disabled={busy} className="chip" onClick={() => setForm("rename")}>改名</button>
              <button disabled={busy} className="chip" onClick={() => setForm("key")}>更新密钥</button>
              <RemoveButton disabled={busy} name={acc.name} onRemove={() => post({ action: "remove", id: acc.id })} />
            </>
          )}
          <button className="rounded-lg bg-ink px-3 py-1.5 text-sm text-bg" onClick={() => (setForm("add"), setMsg(null))}>添加账户</button>
        </div>
        {acc && (
          <p className="text-xs text-ink-3">
            Key {acc.keyHint}
            {entry?.snap && ` · 最近读取 ${new Date(entry.snap.t).toLocaleTimeString("zh-CN", { hour12: false })}`}
            {acc.ipRestrict === false && <span className="text-warn"> · 这个 Key 没有绑定 IP，建议在交易所绑定服务器地址</span>}
          </p>
        )}
        {acc && entry?.error && <p className="rounded-lg bg-down-soft px-3 py-2 text-sm">读取失败：{entry.error}</p>}
        {entry?.snap?.warnings.map((w) => <p key={w} className="text-xs text-warn">⚠ {w}</p>)}
        {msg && <p className={`text-sm ${msg.ok ? "text-up" : "text-down"}`}>{msg.text}</p>}
        {form && <KeyForm mode={form} acc={form === "add" ? null : acc} busy={busy} http={http} data={data} onCancel={() => setForm(null)} onSubmit={(b) => post({ action: "save", ...b })} />}
        {!data.accounts.length && !form && <p className="text-sm text-ink-3">添加一个交易所的只读 API Key 后，余额、持仓、强平价和止损挂单直接从交易所读取，不用再手填。</p>}
      </div>
    </details>
  );
}

function RemoveButton({ name, disabled, onRemove }: { name: string; disabled: boolean; onRemove: () => void }) {
  const [confirm, setConfirm] = useState(false);
  return confirm ? (
    <span className="space-x-2 text-sm">
      <span className="text-down">移除“{name}”并删除保存的密钥？</span>
      <button className="text-down underline" onClick={() => (onRemove(), setConfirm(false))}>移除</button>
      <button className="text-ink-3" onClick={() => setConfirm(false)}>取消</button>
    </span>
  ) : (
    <button disabled={disabled} className="chip" onClick={() => setConfirm(true)}>移除</button>
  );
}

function KeyForm({ mode, acc, busy, http, data, onCancel, onSubmit }: { mode: "add" | "key" | "rename"; acc: PublicAccount | null; busy: boolean; http: boolean; data: ExData; onCancel: () => void; onSubmit: (b: Record<string, unknown>) => void }) {
  const [ex, setEx] = useState<ExchangeId>(acc?.ex ?? "okx");
  const [name, setName] = useState(mode === "add" ? "" : (acc?.name ?? ""));
  const [key, setKey] = useState("");
  const [secret, setSecret] = useState("");
  const [pass, setPass] = useState("");
  const host = typeof location !== "undefined" ? location.hostname : "服务器 IP";
  const theEx = mode === "add" ? ex : acc!.ex;
  return (
    <div className="space-y-3 rounded-lg border border-line p-3">
      {mode !== "rename" && (
        <div className="space-y-1.5 rounded-lg bg-warn-soft px-3 py-2 text-xs leading-relaxed text-ink-2">
          <p><b>只接受只读 Key。</b>{theEx === "okx" ? "在 OKX「API 管理」新建 API Key，权限只勾“读取”，" : "在币安「API 管理」创建 API Key，只保留“允许读取”，"}IP 白名单填服务器地址 <b className="num">{host}</b>。有交易或提币权限的 Key 会被拒绝。</p>
          {http && !data.secure && <p>⚠ 当前是 HTTP 明文连接，提交的密钥在网络上可能被截获。只读 Key 加上 IP 白名单后，即使泄露也不能交易、不能提币，也不能从别的 IP 使用。</p>}
          {!data.allowlist && <p>⚠ 后台还没有设置 ADMIN_IP_ALLOWLIST，建议只允许你自己的 IP 进后台（服务器上 sudo signallight config）。</p>}
          <p>密钥用服务器的主密钥加密保存，页面上只显示前后 4 位。</p>
        </div>
      )}
      <div className="grid grid-cols-1 gap-2.5 text-xs text-ink-3 sm:grid-cols-2">
        {mode === "add" && (
          <label className="space-y-1">
            <span>交易所</span>
            <select id="ex-ex" className={field} value={ex} onChange={(e) => setEx(e.target.value as ExchangeId)}>
              <option value="okx">{EXCHANGE_NAME.okx}</option>
              <option value="binance">{EXCHANGE_NAME.binance}（U 本位合约）</option>
            </select>
          </label>
        )}
        {mode !== "key" && (
          <label className="space-y-1">
            <span>名称</span>
            <input id="ex-name" className={field} value={name} placeholder={EXCHANGE_NAME[theEx]} onChange={(e) => setName(e.target.value)} />
          </label>
        )}
        {mode !== "rename" && (
          <>
            <label className="space-y-1">
              <span>API Key{mode === "key" && acc ? `（现在 ${acc.keyHint}）` : ""}</span>
              <input id="ex-key" className={field} autoComplete="off" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)} />
            </label>
            <label className="space-y-1">
              <span>Secret Key</span>
              <input id="ex-secret" type="password" className={field} autoComplete="new-password" value={secret} onChange={(e) => setSecret(e.target.value)} />
            </label>
            {theEx === "okx" && (
              <label className="space-y-1">
                <span>Passphrase（创建 Key 时设的密码）</span>
                <input id="ex-pass" type="password" className={field} autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)} />
              </label>
            )}
          </>
        )}
      </div>
      <div className="flex gap-3">
        <button disabled={busy} className="rounded-lg bg-ink px-3 py-1.5 text-sm text-bg disabled:opacity-40" onClick={() => onSubmit({ ...(acc && mode !== "add" ? { id: acc.id } : { ex }), ...(mode !== "key" ? { name } : {}), ...(mode !== "rename" ? { key, secret, passphrase: pass } : {}) })}>
          {busy ? "连接中…" : mode === "rename" ? "保存" : "连接并保存"}
        </button>
        <button className="text-sm text-ink-3" onClick={onCancel}>取消</button>
      </div>
    </div>
  );
}
