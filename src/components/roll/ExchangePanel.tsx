"use client";

import { useCallback, useEffect, useState } from "react";
import { EXCHANGE_NAME, stopOf, type ExchangeId, type ExSnapshot } from "@/lib/exchange";
import { trimQty } from "@/lib/ta/roll";
import { fmtPrice } from "../coin/format";

/**
 * 交易所账户（只读）: add an OKX / Binance read-only API key, see the account snapshot (equity, available,
 * margin ratio, positions with the exchange's liquidation price and stop orders). Positions on the site's
 * coins are mirrored into a 滚仓 account; `onSynced` reloads the book after each read.
 */

interface PublicAccount {
  id: string;
  name: string;
  ex: ExchangeId;
  keyHint: string;
  ipRestrict: boolean | null;
  addedAt: number;
}
interface Data {
  accounts: PublicAccount[];
  snapshots: Record<string, { snap: ExSnapshot | null; error: string | null; t: number }>;
  canEncrypt: boolean;
  allowlist: boolean;
  secure: boolean;
}

const field = "num w-full rounded-lg border border-line bg-panel-2 px-2.5 py-1.5 text-sm outline-none focus:border-accent";
const usdt = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: 2 });
const STALE_MS = 30_000;
const POLL_MS = 30_000;

export function ExchangePanel({ onSynced }: { onSynced: () => void }) {
  const [data, setData] = useState<Data | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const [form, setForm] = useState<null | "add" | "key" | "rename">(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(
    (refresh: boolean) =>
      fetch(`/api/admin/exchange${refresh ? "?refresh=1" : ""}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((b: Data | null) => {
          if (!b) return;
          setData(b);
          setPick((p) => (p && b.accounts.some((a) => a.id === p) ? p : (b.accounts[0]?.id ?? null)));
          if (refresh && b.accounts.length) onSynced();
        })
        .catch(() => {}),
    [onSynced],
  );
  useEffect(() => {
    load(true);
    const id = setInterval(() => !document.hidden && load(true), POLL_MS);
    const tick = setInterval(() => setNow(Date.now()), 5_000);
    return () => (clearInterval(id), clearInterval(tick));
  }, [load]);

  const post = async (body: Record<string, unknown>) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch("/api/admin/exchange", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const b = await r.json().catch(() => null);
      if (!r.ok) throw new Error(b?.error || "操作失败");
      setData(b);
      setMsg(b.message ? { ok: true, text: b.message } : null);
      setForm(null);
      onSynced();
      return b as Data;
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
      return null;
    } finally {
      setBusy(false);
    }
  };

  if (!data) return null;
  const acc = data.accounts.find((a) => a.id === pick) ?? null;
  const entry = acc ? data.snapshots[acc.id] : undefined;
  const snap = entry?.snap ?? null;
  const http = typeof location !== "undefined" && location.protocol === "http:";

  return (
    <section className="card space-y-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">交易所账户 <span className="text-sm font-normal text-ink-3">· 只读，不下单</span></h2>
        <button className="rounded-lg bg-ink px-3 py-1.5 text-sm text-bg" onClick={() => (setForm("add"), setMsg(null))}>添加账户</button>
      </div>

      {!data.canEncrypt && <p className="text-sm text-down">服务器没有配置 MASTER_KEY，无法加密保存 API Key。</p>}

      {data.accounts.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <select id="ex-pick" className={`${field} w-auto`} value={pick ?? ""} onChange={(e) => setPick(e.target.value)}>
            {data.accounts.map((a) => (
              <option key={a.id} value={a.id}>{a.name} · {EXCHANGE_NAME[a.ex]}</option>
            ))}
          </select>
          {acc && (
            <>
              <button disabled={busy} className="chip" onClick={() => post({ action: "test", id: acc.id })}>测试连接</button>
              <button disabled={busy} className="chip" onClick={() => setForm("rename")}>改名</button>
              <button disabled={busy} className="chip" onClick={() => setForm("key")}>更新密钥</button>
              <RemoveButton disabled={busy} name={acc.name} onRemove={() => post({ action: "remove", id: acc.id })} />
            </>
          )}
        </div>
      )}

      {msg && <p className={`text-sm ${msg.ok ? "text-up" : "text-down"}`}>{msg.text}</p>}

      {form && <KeyForm mode={form} acc={acc} busy={busy} http={http} data={data} onCancel={() => setForm(null)} onSubmit={(b) => post({ action: "save", ...b })} />}

      {acc && entry?.error && <p className="rounded-lg bg-down-soft px-3 py-2 text-sm">读取失败：{entry.error}</p>}
      {acc && snap && <Snapshot snap={snap} stale={now - snap.t > STALE_MS} onRefresh={() => load(true)} keyHint={acc.keyHint} ipRestrict={acc.ipRestrict} />}

      {!data.accounts.length && !form && (
        <p className="text-sm text-ink-3">添加一个交易所的只读 API Key 后，这里直接读取余额、持仓、强平价和止损挂单，持仓会自动出现在下面的滚仓账户里，不用再手填。</p>
      )}
    </section>
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

function KeyForm({ mode, acc, busy, http, data, onCancel, onSubmit }: { mode: "add" | "key" | "rename"; acc: PublicAccount | null; busy: boolean; http: boolean; data: Data; onCancel: () => void; onSubmit: (b: Record<string, unknown>) => void }) {
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

/** Equity, available, margin ratio and every position with its liquidation price and stop orders. */
function Snapshot({ snap, stale, onRefresh, keyHint, ipRestrict }: { snap: ExSnapshot; stale: boolean; onRefresh: () => void; keyHint: string; ipRestrict: boolean | null }) {
  const time = new Date(snap.t).toLocaleTimeString("zh-CN", { hour12: false });
  const ratioTone = snap.mgnRatio == null ? "" : snap.mgnRatio <= 1.5 ? "text-down" : snap.mgnRatio <= 3 ? "text-warn" : "text-up";
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-ink-3">
        <span>
          {EXCHANGE_NAME[snap.ex]} · 账户快照 {time}
          {stale ? <span className="text-warn"> · 快照已超过 30 秒，请刷新后再参考</span> : ""} · Key {keyHint}
          {ipRestrict === false && <span className="text-warn"> · 这个 Key 没有绑定 IP</span>}
        </span>
        <button className="chip" onClick={onRefresh}>刷新快照</button>
      </div>
      <div className="grid grid-cols-2 gap-2.5 rounded-lg bg-panel-2 p-3 sm:grid-cols-4">
        <Stat k="USDT 总权益" v={usdt(snap.equity)} />
        <Stat k="当前可用于开仓" v={usdt(snap.available)} />
        <Stat k="挂单占用" v={usdt(snap.frozen)} />
        <Stat
          k="维持保证金倍数"
          v={<span className={ratioTone}>{snap.mgnRatio != null ? `${snap.mgnRatio.toFixed(1)} 倍` : "—"}</span>}
          sub={snap.mmr != null ? `维持保证金 ${usdt(snap.mmr)}；1 倍即强平` : "没有全仓占用"}
        />
      </div>
      {snap.warnings.map((w) => <p key={w} className="text-xs text-warn">⚠ {w}</p>)}
      {snap.positions.length ? (
        <div className="grid gap-2 sm:grid-cols-2">
          {snap.positions.map((p) => {
            const st = stopOf(snap, p);
            const liqPct = p.liq != null && p.mark > 0 ? Math.abs(p.mark - p.liq) / p.mark * 100 : null;
            const naked = st.sl == null;
            const beyond = st.sl != null && p.liq != null && p.dir * (st.sl - p.liq) <= 0;
            return (
              <div key={p.key} className="space-y-1 rounded-lg border border-line px-3 py-2 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <b>{p.instId}</b>
                  <span className={p.upl >= 0 ? "num text-up" : "num text-down"}>{p.upl >= 0 ? "+" : ""}{usdt(p.upl)}</span>
                </div>
                <div className="text-ink-2">{p.dir > 0 ? "多" : "空"} · {p.mode === "isolated" ? "逐仓" : "全仓"} · {p.lever}×</div>
                <div className="num text-xs text-ink-3">数量 {trimQty(p.qty)} {p.base} · 均价 {fmtPrice(p.avg)} · 标记价 {fmtPrice(p.mark)}</div>
                <div className="num text-xs">
                  强平 {p.liq != null ? `${fmtPrice(p.liq)}（${liqPct!.toFixed(1)}%）` : "—"} ·{" "}
                  {naked ? <b className="text-down">没有止损单</b> : beyond ? <b className="text-down">止损 {fmtPrice(st.sl)} 在强平后面</b> : <span className="text-up">止损 {fmtPrice(st.sl)}{st.covered != null && st.covered < p.qty * 0.99 ? `（只覆盖 ${trimQty(st.covered)}）` : ""}</span>}
                </div>
                {!p.coin && <div className="text-xs text-ink-3">{p.base} 不在本站币种里：只显示交易所数字，加入币种后才有关键位和滚仓计算。</div>}
              </div>
            );
          })}
        </div>
      ) : (
        <p className="text-sm text-ink-3">这个账户现在没有 U 本位合约持仓。</p>
      )}
    </div>
  );
}

function Stat({ k, v, sub }: { k: string; v: React.ReactNode; sub?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-ink-3">{k}</div>
      <div className="num truncate text-[17px] font-semibold">{v}</div>
      {sub && <div className="num truncate text-[11px] text-ink-3">{sub}</div>}
    </div>
  );
}
