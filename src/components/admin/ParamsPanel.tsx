"use client";

import { useEffect, useMemo, useState } from "react";
import type { ParamDef, ParamModule, ParamValues } from "@/lib/params";
import { btnCls, btnGhost, fmtTime, inputCls } from "./ui";

interface Version {
  id: number;
  createdAt: number;
  author: string;
  note: string | null;
  values: ParamValues;
}
interface State {
  modules: ParamModule[];
  defaults: ParamValues;
  version: number;
  overrides: ParamValues;
  history: Version[];
}
interface StatRow {
  key: string;
  name: string;
  samples: number;
  winRate: number | null;
  baseWinRate: number;
  avgReturn: number | null;
}
interface Digest {
  lightText: string;
  score: number;
  trend: string;
  supports: number[];
  resistances: number[];
  stats: StatRow[];
}
type ResearchSplit = { is: { samples: number; edgeR: number | null }; oos: { samples: number; edgeR: number | null }; better: number; worse: number };
interface Preview {
  rows: { coin: string; tf: string; before: Digest; after: Digest }[];
  summary: { before: { samples: number; edge: number }; after: { samples: number; edge: number } };
  research: { before: ResearchSplit; after: ResearchSplit; holdoutFrom: number } | null;
  warnings: string[];
  durationMs: number;
}

const post = async (url: string, body: unknown) => {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const b = await r.json();
  if (!r.ok) throw new Error(b.error || "请求失败");
  return b;
};

export function ParamsPanel() {
  const [st, setSt] = useState<State | null>(null);
  const [draft, setDraft] = useState<ParamValues>({});
  const [mod, setMod] = useState<ParamModule["id"]>("levels");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [note, setNote] = useState("");
  const [showSave, setShowSave] = useState(false);

  const load = (s: State) => {
    setSt(s);
    setDraft({ ...s.defaults, ...s.overrides });
    setPreview(null);
  };
  useEffect(() => {
    fetch("/api/admin/params").then((r) => r.json()).then(load);
  }, []);

  const saved = useMemo(() => (st ? { ...st.defaults, ...st.overrides } : {}), [st]);
  const dirty = useMemo(() => Object.keys(draft).filter((k) => draft[k] !== saved[k]), [draft, saved]);
  const nonDefault = useMemo(() => (st ? Object.keys(draft).filter((k) => draft[k] !== st.defaults[k]) : []), [draft, st]);

  if (!st) return <div className="card h-64 animate-pulse" />;
  const module = st.modules.find((m) => m.id === mod)!;
  const moduleKeys = module.groups.flatMap((g) => g.params.map((p) => p.key));

  const set = (k: string, v: number | boolean) => {
    setDraft((d) => ({ ...d, [k]: v }));
    setPreview(null);
  };
  const resetKeys = (keys: string[]) => {
    setDraft((d) => ({ ...d, ...Object.fromEntries(keys.map((k) => [k, st.defaults[k]])) }));
    setPreview(null);
  };

  const runPreview = async () => {
    setBusy("preview");
    setMsg(null);
    try {
      setPreview(await post("/api/admin/params/preview", { values: draft }));
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
    setBusy(null);
  };
  const save = async () => {
    setBusy("save");
    try {
      load(await post("/api/admin/params", { values: draft, note }));
      setMsg({ ok: true, text: "已保存为新版本，前台结果已按新参数重新计算" });
      setShowSave(false);
      setNote("");
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
    setBusy(null);
  };
  const rollback = async (id: number) => {
    if (!confirm(id === 0 ? "确定把全部参数恢复为默认值吗？" : `确定回滚到版本 #${id} 吗？`)) return;
    setBusy("rollback");
    try {
      load(await post("/api/admin/params/rollback", { id }));
      setMsg({ ok: true, text: id === 0 ? "已恢复全部默认值" : `已回滚到版本 #${id}` });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
    setBusy(null);
  };

  const current = st.history[0];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">参数调试</h1>
        <span className="text-xs text-ink-3">
          {st.version === 0 ? "当前使用全部默认值" : `当前版本 #${st.version} · ${current?.author} · ${fmtTime(current?.createdAt)}`}
          {nonDefault.length > 0 && ` · ${nonDefault.length} 项与默认不同`}
        </span>
        <span className="ml-auto flex flex-wrap gap-2">
          <button className={btnGhost} disabled={!!busy} onClick={runPreview}>
            {busy === "preview" ? "试算中…" : "试算对比"}
          </button>
          <button className={btnCls} disabled={!!busy || dirty.length === 0} onClick={() => setShowSave(true)}>
            保存为新版本{dirty.length ? `（${dirty.length} 项修改）` : ""}
          </button>
        </span>
      </div>

      <p className="text-xs leading-relaxed text-ink-3">修改后先点「试算对比」，看看 BTC、ETH 在 4 小时和日线上的结论、关键位和信号胜率怎么变化，再决定是否保存。保存后前台立即按新参数计算；每次保存都会生成一个版本，可以随时回滚。</p>

      {msg && <p className={`rounded-lg px-3 py-2 text-[13px] ${msg.ok ? "bg-up-soft text-up" : "bg-down-soft text-down"}`}>{msg.text}</p>}

      {showSave && (
        <section className="card border-accent/40 p-4">
          <h2 className="text-[15px] font-semibold">保存 {dirty.length} 项修改</h2>
          <ul className="mt-2 space-y-0.5 text-[13px] text-ink-2">
            {dirty.map((k) => (
              <li key={k}>
                {labelOf(st, k)}：<span className="num">{String(saved[k])}</span> → <b className="num text-ink">{String(draft[k])}</b>
              </li>
            ))}
          </ul>
          <input className={`${inputCls} mt-3`} placeholder="备注（可选），例如：提高日线权重，减少小周期噪音" value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="mt-3 flex gap-2">
            <button className={btnCls} disabled={!!busy} onClick={save}>确认保存</button>
            <button className={btnGhost} onClick={() => setShowSave(false)}>取消</button>
          </div>
        </section>
      )}

      {preview && <PreviewView p={preview} />}

      <div className="-mx-1 flex gap-1 overflow-x-auto px-1">
        {st.modules.map((m) => {
          const keys = m.groups.flatMap((g) => g.params.map((p) => p.key));
          const changed = keys.filter((k) => draft[k] !== st.defaults[k]).length;
          return (
            <button key={m.id} className="chip whitespace-nowrap" data-active={mod === m.id} onClick={() => setMod(m.id)}>
              {m.title}
              {changed > 0 && <span className="ml-1 rounded bg-accent px-1 text-[10px] text-white">{changed}</span>}
            </button>
          );
        })}
      </div>

      <section className="card p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h2 className="text-[15px] font-semibold">{module.title}</h2>
          <span className="text-xs text-ink-3">{module.hint}</span>
          <button className={`${btnGhost} ml-auto !text-xs`} onClick={() => resetKeys(moduleKeys)} disabled={!moduleKeys.some((k) => draft[k] !== st.defaults[k])}>
            本模块恢复默认
          </button>
        </div>
        <div className="space-y-5">
          {module.groups.map((g) => {
            const bools = g.params.every((p) => p.type === "bool");
            return (
              <div key={g.title}>
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <h3 className="text-sm font-medium">{g.title}</h3>
                  {g.hint && <span className="text-xs text-ink-3">{g.hint}</span>}
                  {bools && (
                    <span className="ml-auto flex gap-1">
                      <button className={`${btnGhost} !px-2 !py-0.5 !text-xs`} onClick={() => setDraft((d) => ({ ...d, ...Object.fromEntries(g.params.map((p) => [p.key, true])) }))}>全选</button>
                      <button className={`${btnGhost} !px-2 !py-0.5 !text-xs`} onClick={() => setDraft((d) => ({ ...d, ...Object.fromEntries(g.params.map((p) => [p.key, false])) }))}>全不选</button>
                    </span>
                  )}
                </div>
                <div className={`grid gap-2 ${bools ? "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4" : "md:grid-cols-2"}`}>
                  {g.params.map((p) => (
                    <ParamField key={p.key} p={p} value={draft[p.key]} saved={saved[p.key]} onChange={(v) => set(p.key, v)} onReset={() => resetKeys([p.key])} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="card p-4">
        <div className="mb-3 flex items-center gap-2">
          <h2 className="text-[15px] font-semibold">版本历史</h2>
          <button className={`${btnGhost} ml-auto !text-xs`} disabled={!!busy || st.version === 0 && nonDefault.length === 0} onClick={() => rollback(0)}>
            全部恢复默认
          </button>
        </div>
        {st.history.length === 0 ? (
          <p className="text-sm text-ink-3">还没有保存过参数，当前全部使用默认值。</p>
        ) : (
          <ul className="divide-y divide-line text-[13px]">
            {st.history.map((v) => (
              <VersionRow key={v.id} v={v} st={st} current={v.id === st.version} onRollback={() => rollback(v.id)} busy={!!busy} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function labelOf(st: State, key: string) {
  for (const m of st.modules) for (const g of m.groups) for (const p of g.params) if (p.key === key) return `${m.title} · ${p.label}`;
  return key;
}

function ParamField({ p, value, saved, onChange, onReset }: { p: ParamDef; value: number | boolean; saved: number | boolean; onChange: (v: number | boolean) => void; onReset: () => void }) {
  const changed = value !== p.default;
  const unsaved = value !== saved;
  if (p.type === "bool")
    return (
      <label className="flex cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-2 text-[13px]" style={{ borderColor: unsaved ? "var(--accent)" : "var(--border)" }} title={p.hint}>
        <input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
        <span className={value ? "" : "text-ink-3 line-through"}>{p.label}</span>
      </label>
    );
  return (
    <div className="rounded-lg border p-2.5" style={{ borderColor: unsaved ? "var(--accent)" : "var(--border)" }}>
      <div className="flex items-baseline gap-2">
        <span className="text-[13px] font-medium">{p.label}</span>
        {p.unit && <span className="text-[11px] text-ink-3">{p.unit}</span>}
        {changed && (
          <button className="ml-auto text-[11px] text-accent" onClick={onReset}>
            恢复默认
          </button>
        )}
      </div>
      <div className="mt-1.5 flex items-center gap-2">
        <input type="range" className="min-w-0 flex-1 accent-[var(--accent)]" min={p.min} max={p.max} step={p.step} value={Number(value)} onChange={(e) => onChange(Number(e.target.value))} aria-label={p.label} />
        <input
          type="number"
          className={`${inputCls} !w-20 !px-2 !py-1`}
          min={p.min}
          max={p.max}
          step={p.step}
          value={Number(value)}
          onChange={(e) => e.target.value !== "" && onChange(Number(e.target.value))}
        />
      </div>
      <div className="mt-1 text-[11px] leading-relaxed text-ink-3">
        默认 {String(p.default)} · 范围 {p.min}–{p.max}
        <br />
        {p.hint}
      </div>
    </div>
  );
}

function VersionRow({ v, st, current, onRollback, busy }: { v: Version; st: State; current: boolean; onRollback: () => void; busy: boolean }) {
  const [open, setOpen] = useState(false);
  const keys = Object.keys(v.values);
  return (
    <li className="py-2">
      <div className="flex flex-wrap items-center gap-2">
        <b className="num">#{v.id}</b>
        {current && <span className="rounded bg-up-soft px-1.5 text-[11px] text-up">当前</span>}
        <span className="num text-xs text-ink-3">{fmtTime(v.createdAt)}</span>
        <span className="text-xs text-ink-2">{v.author}</span>
        <span className="text-xs text-ink-2">{v.note || "（无备注）"}</span>
        <span className="text-xs text-ink-3">{keys.length ? `${keys.length} 项非默认` : "全部默认"}</span>
        <span className="ml-auto flex gap-2">
          {keys.length > 0 && (
            <button className="text-xs text-accent" onClick={() => setOpen((o) => !o)}>
              {open ? "收起" : "查看"}
            </button>
          )}
          {!current && (
            <button className="text-xs text-accent" disabled={busy} onClick={onRollback}>
              回滚到此版本
            </button>
          )}
        </span>
      </div>
      {open && (
        <ul className="mt-1.5 grid gap-x-4 text-xs text-ink-2 sm:grid-cols-2">
          {keys.map((k) => (
            <li key={k}>
              {labelOf(st, k)}：<span className="num text-ink-3">{String(st.defaults[k])}</span> → <b className="num">{String(v.values[k])}</b>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function Delta({ a, b, unit = "", digits = 1 }: { a: number | null; b: number | null; unit?: string; digits?: number }) {
  if (a == null || b == null) return <span className="text-ink-3">—</span>;
  const d = Math.round((b - a) * 10 ** digits) / 10 ** digits;
  return (
    <span className="num">
      {a}
      {unit} → <b>{b}{unit}</b>
      {d !== 0 && <span style={{ color: d > 0 ? "var(--up)" : "var(--down)" }}> ({d > 0 ? "+" : ""}{d})</span>}
    </span>
  );
}

function PreviewView({ p }: { p: Preview }) {
  const [all, setAll] = useState(false);
  const { before: eb, after: ea } = p.summary;
  return (
    <section className="card space-y-3 p-4">
      <div className="flex flex-wrap items-baseline gap-3">
        <h2 className="text-[15px] font-semibold">试算对比</h2>
        <span className="text-xs text-ink-3">当前参数 → 草稿参数 · 用时 {(p.durationMs / 1000).toFixed(1)} 秒</span>
        <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-xs text-ink-2">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
          显示没有变化的信号
        </label>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="rounded-lg bg-panel-2 p-3 text-[13px]">
          <div className="text-xs text-ink-3">所有信号的平均胜率优势（相对随机，按样本数加权）</div>
          <div className="mt-1 text-base"><Delta a={eb.edge} b={ea.edge} unit=" 分" /></div>
        </div>
        <div className="rounded-lg bg-panel-2 p-3 text-[13px]">
          <div className="text-xs text-ink-3">统计样本总数</div>
          <div className="mt-1 text-base"><Delta a={eb.samples} b={ea.samples} /></div>
        </div>
      </div>
      {p.research ? (
        <div className="rounded-lg bg-panel-2 p-3 text-[13px]">
          <div className="text-xs text-ink-3">
            本地全部历史上的信号优势（R，相对随机，按样本数加权）：{new Date(p.research.holdoutFrom * 1000).toISOString().slice(0, 10)} 之前为样本内，之后的 12 个月为样本外
          </div>
          <div className="mt-1 grid gap-1 sm:grid-cols-2">
            <div>样本内 <Delta a={p.research.before.is.edgeR} b={p.research.after.is.edgeR} unit="R" digits={3} /> <span className="text-xs text-ink-3">（{p.research.after.is.samples} 笔）</span></div>
            <div>样本外 <Delta a={p.research.before.oos.edgeR} b={p.research.after.oos.edgeR} unit="R" digits={3} /> <span className="text-xs text-ink-3">（{p.research.after.oos.samples} 笔）</span></div>
          </div>
          <div className="mt-1 text-xs text-ink-3">
            达到“有优势”标准的信号 {p.research.before.better} → {p.research.after.better} 个；“比随机差” {p.research.before.worse} → {p.research.after.worse} 个。样本内和样本外差距越大，越可能是调出来的。
          </div>
        </div>
      ) : (
        <p className="text-xs text-ink-3">本地长历史还没补齐，暂时没有样本内 / 样本外对比。</p>
      )}
      {p.warnings.length > 0 ? (
        <div className="rounded-lg border border-warn/40 bg-warn-soft p-3 text-[13px] leading-relaxed">
          <b className="text-warn">⚠ 过拟合提醒</b>
          <ul className="mt-1 list-disc pl-5">
            {p.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-xs text-ink-3">没有发现明显的过拟合迹象。但历史表现不代表未来，建议保存后观察一段时间。</p>
      )}
      <div className="grid gap-3 lg:grid-cols-2">
        {p.rows.map((r) => {
          const changedStats = r.after.stats.map((s, k) => ({ s, b: r.before.stats[k] })).filter(({ s, b }) => all || s.winRate !== b.winRate || s.samples !== b.samples);
          return (
            <div key={`${r.coin}${r.tf}`} className="rounded-lg border border-line p-3 text-[13px]">
              <div className="mb-1.5 font-medium">
                {r.coin} · {r.tf}
              </div>
              <table className="w-full text-xs">
                <tbody>
                  <tr><td className="py-0.5 text-ink-3">结论</td><td className="py-0.5">{r.before.lightText} {r.before.score} → <b>{r.after.lightText} {r.after.score}</b></td></tr>
                  <tr><td className="py-0.5 text-ink-3">趋势</td><td className="py-0.5">{r.before.trend} → <b>{r.after.trend}</b></td></tr>
                  <tr><td className="py-0.5 text-ink-3">阻力</td><td className="num py-0.5">{r.before.resistances.join(" / ")} → <b>{r.after.resistances.join(" / ")}</b></td></tr>
                  <tr><td className="py-0.5 text-ink-3">支撑</td><td className="num py-0.5">{r.before.supports.join(" / ")} → <b>{r.after.supports.join(" / ")}</b></td></tr>
                </tbody>
              </table>
              {changedStats.length > 0 ? (
                <table className="mt-2 w-full text-xs">
                  <thead className="text-left text-ink-3">
                    <tr><th className="font-normal">信号</th><th className="font-normal">胜率</th><th className="font-normal">样本</th></tr>
                  </thead>
                  <tbody>
                    {changedStats.map(({ s, b }) => (
                      <tr key={s.key} className="border-t border-line">
                        <td className="py-0.5">{s.name}</td>
                        <td className="py-0.5"><Delta a={b.winRate} b={s.winRate} unit="%" /></td>
                        <td className="py-0.5"><Delta a={b.samples} b={s.samples} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="mt-2 text-xs text-ink-3">信号胜率没有变化</p>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
