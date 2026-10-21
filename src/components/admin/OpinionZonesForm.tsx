"use client";

import { useState } from "react";
import { OPINION_LIMITS, parseOpinionZones } from "@/lib/spot/opinion";
import { btnCls, btnGhost, inputCls } from "./ui";

/**
 * Editor for `spot.opinionZones`: someone's market-cap zones shown on the 现货囤币 page as "观点".
 * Market caps are typed in 万亿美元 and stored in USD; the settings API validates (validateOpinionZones).
 */

interface Row {
  label: string;
  /** 万亿美元, as typed */
  from: string;
  to: string;
}

const T = 1e12;
const toRows = (json: string) => {
  const o = parseOpinionZones(json).value;
  return { source: o.source, date: o.date, rows: o.zones.map((z) => ({ label: z.label, from: String(+(z.from / T).toFixed(4)), to: String(+(z.to / T).toFixed(4)) })) };
};

export function OpinionZonesForm({ value, fallback, onSaved }: { value: string; fallback: string; onSaved: (all: unknown) => void }) {
  const [f, setF] = useState(() => toRows(value));
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const setRow = (k: number, patch: Partial<Row>) => setF({ ...f, rows: f.rows.map((r, i) => (i === k ? { ...r, ...patch } : r)) });

  const save = async () => {
    setMsg(null);
    const zones = f.rows.map((r) => ({ label: r.label.trim(), from: Math.round(parseFloat(r.from) * T), to: Math.round(parseFloat(r.to) * T) }));
    const bad = zones.find((z) => !Number.isFinite(z.from) || !Number.isFinite(z.to));
    if (bad) return setMsg({ ok: false, text: `“${bad.label || "未命名"}”的市值要填数字（万亿美元，比如 1.2）` });
    setBusy(true);
    const r = await fetch("/api/admin/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ "spot.opinionZones": JSON.stringify({ source: f.source.trim(), date: f.date.trim(), zones }) }),
    });
    const b = await r.json().catch(() => ({ error: "保存失败" }));
    setBusy(false);
    if (!r.ok) return setMsg({ ok: false, text: b.error ?? "保存失败" });
    onSaved(b);
    setF(toRows(String(b["spot.opinionZones"]?.value ?? "")));
    setMsg({ ok: true, text: "已保存，现货囤币页下次读取时生效" });
  };

  return (
    <section className="card p-4">
      <h2 className="mb-1 text-[15px] font-semibold">现货囤币 · 观点市值分区</h2>
      <p className="mb-3 text-xs leading-relaxed text-ink-3">
        别人公开说过的市值区间，现货囤币页按当天流通量换算成价格，永远标“观点，不是研究结论”和来源。市值单位是万亿美元；上下沿相同表示一个价位，下沿填 0 表示“以下”。最多 {OPINION_LIMITS.maxZones} 个。
      </p>
      <div className="space-y-3">
        <div className="grid gap-2 sm:grid-cols-[1fr_160px]">
          <label className="space-y-1 text-xs text-ink-3">
            <span>来源（最多 {OPINION_LIMITS.maxSource} 字）</span>
            <input id="op-source" className={inputCls} value={f.source} maxLength={OPINION_LIMITS.maxSource} onChange={(e) => setF({ ...f, source: e.target.value })} />
          </label>
          <label className="space-y-1 text-xs text-ink-3">
            <span>日期</span>
            <input id="op-date" className={inputCls} placeholder="2026-10" value={f.date} maxLength={OPINION_LIMITS.maxDate} onChange={(e) => setF({ ...f, date: e.target.value })} />
          </label>
        </div>
        <div className="space-y-2">
          <div className="hidden grid-cols-[1fr_110px_110px_48px] gap-2 text-xs text-ink-3 sm:grid">
            <span>名称（最多 {OPINION_LIMITS.maxLabel} 字）</span>
            <span>下沿（万亿美元）</span>
            <span>上沿（万亿美元）</span>
            <span />
          </div>
          {f.rows.map((r, k) => (
            <div key={k} className="grid grid-cols-[1fr_1fr_auto] gap-2 sm:grid-cols-[1fr_110px_110px_48px]">
              <input aria-label="名称" className={`${inputCls} col-span-3 sm:col-span-1`} value={r.label} maxLength={OPINION_LIMITS.maxLabel} onChange={(e) => setRow(k, { label: e.target.value })} />
              <input aria-label="下沿（万亿美元）" type="number" step="0.1" min="0" className={inputCls} value={r.from} onChange={(e) => setRow(k, { from: e.target.value })} />
              <input aria-label="上沿（万亿美元）" type="number" step="0.1" min="0" className={inputCls} value={r.to} onChange={(e) => setRow(k, { to: e.target.value })} />
              <button className="text-xs text-ink-3 hover:text-down disabled:opacity-40" disabled={f.rows.length <= 1} onClick={() => setF({ ...f, rows: f.rows.filter((_, i) => i !== k) })}>
                删除
              </button>
            </div>
          ))}
          {f.rows.length < OPINION_LIMITS.maxZones && (
            <button className="text-xs text-accent" onClick={() => setF({ ...f, rows: [...f.rows, { label: "", from: "", to: "" }] })}>
              + 添加一个区间
            </button>
          )}
        </div>
        {msg && <p className={`rounded-lg px-3 py-2 text-[13px] ${msg.ok ? "bg-up-soft text-up" : "bg-down-soft text-down"}`}>{msg.text}</p>}
        <div className="flex flex-wrap gap-2 border-t border-line pt-4">
          <button className={btnCls} disabled={busy} onClick={save}>
            保存观点分区
          </button>
          <button className={btnGhost} disabled={busy} onClick={() => setF(toRows(fallback))}>
            填入默认值
          </button>
        </div>
      </div>
    </section>
  );
}
