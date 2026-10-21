"use client";

import { useEffect, useState } from "react";
import type { CoinRow } from "@/lib/server/coins";
import { btnCls, btnGhost, inputCls } from "./ui";

type Row = CoinRow & { history: { tf: string; bars: number; first: number | null; complete: boolean }[] | null };
type Data = { max: number; historyComplete: boolean; coins: Row[] };

const day = (sec: number | null) => (sec ? new Date(sec * 1000).toISOString().slice(0, 10) : "—");

/** Add, hide, rename and reorder the coins shown on the site. */
export function CoinsPanel() {
  const [d, setD] = useState<Data | null>(null);
  const [form, setForm] = useState({ id: "", name: "", intro: "" });
  const [edit, setEdit] = useState<{ id: string; name: string; intro: string } | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () =>
    fetch("/api/admin/coins")
      .then((r) => r.json())
      .then(setD);
  useEffect(() => {
    load();
  }, []);

  const post = async (body: Record<string, unknown>, after?: () => void) => {
    setBusy(true);
    setMsg(null);
    const r = await fetch("/api/admin/coins", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const b = await r.json();
    setBusy(false);
    if (!r.ok) return setMsg({ ok: false, text: b.error });
    setD(b);
    if (body.action !== "move") setMsg({ ok: true, text: b.message });
    after?.();
  };

  const active = d?.coins.filter((c) => c.enabled).length ?? 0;
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">币种</h1>
      {msg && <p className={`rounded-lg px-3 py-2 text-[13px] ${msg.ok ? "bg-up-soft text-up" : "bg-down-soft text-down"}`}>{msg.text}</p>}

      <section className="card p-4">
        <h2 className="mb-1 text-[15px] font-semibold">添加币种</h2>
        <p className="mb-3 text-xs leading-relaxed text-ink-3">
          只能添加 Binance 有 USDT 永续合约的币（行情、资金费率、持仓量都从 Binance 来）。添加时会先核对合约还在交易。加上后页面马上能看，长历史在后台补，约 1–2 小时补完；补完之前回放、成绩单和 24 小时风险环境的数字会偏少。上线不到一年的币，日线、周线的指标会不完整。
        </p>
        <div className="grid gap-2 sm:grid-cols-[140px_160px_1fr_auto]">
          <input className={inputCls} placeholder="代码，如 SUI" value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value.toUpperCase() })} />
          <input className={inputCls} placeholder="中文名（可空）" maxLength={20} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input className={inputCls} placeholder="一句话简介（可空）" maxLength={80} value={form.intro} onChange={(e) => setForm({ ...form, intro: e.target.value })} />
          <button className={btnCls} disabled={busy || !form.id || active >= (d?.max ?? 0)} onClick={() => post({ action: "add", ...form }, () => setForm({ id: "", name: "", intro: "" }))}>
            {busy ? "核对中…" : "核对并添加"}
          </button>
        </div>
        {d && active >= d.max && <p className="mt-2 text-xs text-warn">已经显示 {d.max} 个币（这台服务器的上限），先隐藏一个再添加。</p>}
      </section>

      <section className="card p-4">
        <h2 className="mb-1 text-[15px] font-semibold">
          当前币种 {d && <span className="text-sm font-normal text-ink-3">（显示 {active} / 上限 {d.max}）</span>}
        </h2>
        <p className="mb-3 text-xs leading-relaxed text-ink-3">
          隐藏只是不再显示和计算，已存的 K 线留着，重新显示不用再补。研究报告固定用最早的 10 个币（标“研究”），加减币种不会改变研究口径；信号灯成绩单的“全部币种”也只算这 10 个。
        </p>
        {!d ? (
          <div className="h-40 animate-pulse rounded bg-panel-2" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-ink-3">
                <tr>
                  <th className="py-2 pr-2">顺序</th>
                  <th className="py-2 pr-2">代码</th>
                  <th className="py-2 pr-2">名称与简介</th>
                  <th className="py-2 pr-2">上线</th>
                  <th className="py-2 pr-2">状态</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {d.coins.map((c, i) => (
                  <tr key={c.id} className={`border-t border-line align-top ${c.enabled ? "" : "text-ink-3"}`}>
                    <td className="whitespace-nowrap py-2 pr-2">
                      <button className="px-1 text-ink-3 hover:text-ink disabled:opacity-30" disabled={busy || i === 0} onClick={() => post({ action: "move", id: c.id, dir: -1 })} aria-label="上移">↑</button>
                      <button className="px-1 text-ink-3 hover:text-ink disabled:opacity-30" disabled={busy || i === d.coins.length - 1} onClick={() => post({ action: "move", id: c.id, dir: 1 })} aria-label="下移">↓</button>
                    </td>
                    <td className="py-2 pr-2 font-medium">
                      {c.id}
                      {c.research && <span className="ml-1.5 rounded bg-panel-2 px-1.5 text-[10px] font-normal text-ink-3">研究</span>}
                    </td>
                    <td className="py-2 pr-2">
                      {edit?.id === c.id ? (
                        <div className="space-y-1.5">
                          <input className={inputCls} maxLength={20} value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
                          <input className={inputCls} maxLength={80} value={edit.intro} onChange={(e) => setEdit({ ...edit, intro: e.target.value })} />
                          <div className="flex gap-2">
                            <button className={btnCls} disabled={busy} onClick={() => post({ action: "update", ...edit }, () => setEdit(null))}>保存</button>
                            <button className={btnGhost} onClick={() => setEdit(null)}>取消</button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <div>{c.name}</div>
                          <div className="text-xs text-ink-3">{c.intro || "（没有简介）"}</div>
                          {c.history && <History rows={c.history} />}
                        </>
                      )}
                    </td>
                    <td className="num whitespace-nowrap py-2 pr-2 text-xs text-ink-3">{day(c.listedAt)}</td>
                    <td className="whitespace-nowrap py-2 pr-2 text-xs">{c.enabled ? <span className="text-up">显示中</span> : "已隐藏"}</td>
                    <td className="whitespace-nowrap py-2 text-right">
                      {edit?.id !== c.id && (
                        <button className="mr-3 text-xs text-ink-3 hover:text-ink" onClick={() => setEdit({ id: c.id, name: c.name, intro: c.intro })}>编辑</button>
                      )}
                      <button className={btnGhost} disabled={busy || (!c.enabled && active >= d.max)} onClick={() => post({ action: c.enabled ? "hide" : "show", id: c.id })}>
                        {c.enabled ? "隐藏" : "重新显示"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

/** Backfill progress of an added coin, one chip per timeframe. */
function History({ rows }: { rows: NonNullable<Row["history"]> }) {
  const done = rows.every((r) => r.complete);
  return (
    <div className="mt-1.5 text-[11px] text-ink-3">
      {done ? "历史已补齐" : "历史补充中："}
      {!done && (
        <span className="ml-1 inline-flex flex-wrap gap-1">
          {rows.map((r) => (
            <span key={r.tf} className={`rounded px-1.5 ${r.complete ? "bg-up-soft text-up" : "bg-panel-2"}`}>
              {r.tf} {r.bars.toLocaleString()} 根{r.first ? ` · 从 ${day(r.first)}` : ""}
            </span>
          ))}
        </span>
      )}
    </div>
  );
}
