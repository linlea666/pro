"use client";

import { useEffect, useState } from "react";
import { STACK_FEE, type Ladder, type StackInput } from "@/lib/spot/stack";
import { track } from "../track";
import { daysBetween, fmtBtc, fmtUsd } from "./spot-ui";

/**
 * The visitor's own record of the plan: saved in this browser only (localStorage `sl-stack-v1`), never uploaded.
 * It keeps the saved plan (the form and the ladder it gave) and every fill the visitor enters.
 */

export interface StackForm {
  budget: number;
  head: number;
  floor: number;
  levels: number;
  shape: "equal" | "pyramid";
  dcaPct: number;
  reservePct: number;
  horizon: number;
  fomo: boolean;
  snap: boolean;
}

interface SavedPlan {
  form: StackForm;
  /** YYYY-MM-DD, this browser's date */
  savedAt: string;
  budget: number;
  prices: number[];
  usd: number[];
  dcaPerWeek: number;
  dcaWeeks: number;
  reserveUsd: number;
}

type FillKind = "dca" | "level" | "reserve";

interface Fill {
  id: string;
  date: string;
  price: number;
  /** USDT spent */
  usd: number;
  kind: FillKind;
  /** ladder level index (kind "level") */
  level?: number;
}

interface Stored {
  plan: SavedPlan | null;
  fills: Fill[];
}

const KEY = "sl-stack-v1";
const KIND: Record<FillKind, string> = { dca: "定投", level: "限价档", reserve: "预备金" };

const okNum = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v > 0;

export function loadStack(): Stored | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (!v || typeof v !== "object") return null;
    const p = v.plan;
    const plan: SavedPlan | null = p && p.form && okNum(p.budget) && Array.isArray(p.prices) && Array.isArray(p.usd) && typeof p.savedAt === "string" ? p : null;
    const fills: Fill[] = Array.isArray(v.fills) ? v.fills.filter((f: Fill) => f && okNum(f.price) && okNum(f.usd) && typeof f.date === "string" && f.kind in KIND) : [];
    return { plan, fills };
  } catch {
    return null;
  }
}

function saveStack(s: Stored) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {}
}

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
const newId = () => Math.random().toString(36).slice(2, 10);

export function StackLog({ form, x, ladder, live, reservePrice }: { form: StackForm; x: StackInput | null; ladder: Ladder | null; live: number; reservePrice: number | null }) {
  const [s, setS] = useState<Stored>({ plan: null, fills: [] });
  const [adding, setAdding] = useState<FillKind | null>(null);
  useEffect(() => {
    const v = loadStack();
    if (v) setS(v);
  }, []);
  const update = (next: Stored) => {
    setS(next);
    saveStack(next);
    track("use_stack", "stack");
  };

  const savePlan = () => {
    if (!x || !ladder) return;
    const plan: SavedPlan = {
      form,
      savedAt: today(),
      budget: x.budget,
      prices: ladder.rows.map((r) => r.price),
      usd: ladder.rows.map((r) => r.usd),
      dcaPerWeek: ladder.dcaPerWeek,
      dcaWeeks: ladder.dcaWeeks,
      reserveUsd: ladder.reserveUsd,
    };
    update({ ...s, plan });
  };
  const clear = () => {
    if (!window.confirm("清除保存的计划和全部成交记录？清除后无法恢复。")) return;
    update({ plan: null, fills: [] });
  };

  const p = s.plan;
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-[14px] font-semibold">执行记录</h3>
        <span className="text-[11px] text-ink-3">只存在这个浏览器里，不上传。</span>
      </div>
      {!p ? (
        <div className="mt-2 text-[13px] leading-relaxed text-ink-2">
          <p>把上面的计划存下来，之后每成交一笔就在这里记一下：页面会算出已买的币、均价、剩下的钱和下一档。</p>
          <button className="mt-2 rounded-lg bg-ink px-3 py-1.5 text-sm font-medium text-bg disabled:opacity-50" disabled={!x} onClick={savePlan}>
            保存这个计划
          </button>
        </div>
      ) : (
        <Saved p={p} fills={s.fills} live={live} reservePrice={reservePrice} adding={adding} setAdding={setAdding} onFills={(fills) => update({ ...s, fills })} onOverwrite={x ? savePlan : undefined} onClear={clear} />
      )}
    </div>
  );
}

function Saved({
  p,
  fills,
  live,
  reservePrice,
  adding,
  setAdding,
  onFills,
  onOverwrite,
  onClear,
}: {
  p: SavedPlan;
  fills: Fill[];
  live: number;
  reservePrice: number | null;
  adding: FillKind | null;
  setAdding: (k: FillKind | null) => void;
  onFills: (f: Fill[]) => void;
  onOverwrite?: () => void;
  onClear: () => void;
}) {
  const spent = fills.reduce((a, f) => a + f.usd, 0);
  const btc = fills.reduce((a, f) => a + (f.usd * (1 - STACK_FEE)) / f.price, 0);
  const filled = new Set(fills.filter((f) => f.kind === "level" && f.level != null).map((f) => f.level!));
  const next = p.prices.findIndex((_, k) => !filled.has(k));
  const dcaDone = fills.filter((f) => f.kind === "dca").length;
  const reserveDone = fills.some((f) => f.kind === "reserve");
  const t = today();
  const due = addDays(p.savedAt, p.form.horizon);
  const left = daysBetween(t, due);
  const waited = Math.max(0, daysBetween(p.savedAt, t));

  const toggleLevel = (k: number) =>
    onFills(filled.has(k) ? fills.filter((f) => !(f.kind === "level" && f.level === k)) : [...fills, { id: newId(), date: t, price: p.prices[k], usd: p.usd[k], kind: "level", level: k }]);

  const stat = (label: string, value: React.ReactNode, sub?: React.ReactNode) => (
    <div className="min-w-0 rounded-lg bg-panel-2 px-3 py-2">
      <div className="text-[11px] text-ink-3">{label}</div>
      <div className="num text-[15px] font-semibold">{value}</div>
      {sub && <div className="num text-[11px] leading-relaxed text-ink-3">{sub}</div>}
    </div>
  );

  return (
    <div className="mt-2 space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-[12px] text-ink-3">
        <span>
          {p.savedAt} 保存 · 资金 {fmtUsd(p.budget)} U · 期限 {p.form.horizon} 天
        </span>
        <span className="ml-auto flex gap-3">
          {onOverwrite && (
            <button className="text-accent" onClick={() => window.confirm("用上面现在的设置覆盖保存的计划？已记的成交会保留。") && onOverwrite()}>
              用上面的设置覆盖
            </button>
          )}
          <button className="hover:text-down" onClick={onClear}>
            清除
          </button>
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {stat("已买币数", `${fmtBtc(btc)} BTC`, btc > 0 ? `按现价约 ${fmtUsd(btc * live)} U` : "还没有成交")}
        {stat("均价", btc > 0 ? fmtUsd(spent / btc) : "—", btc > 0 ? `含 0.1% 手续费` : undefined)}
        {stat("剩余资金", `${fmtUsd(p.budget - spent)} U`, `已花 ${fmtUsd(spent)} U`)}
        {stat("下一档", next < 0 ? "全部成交" : fmtUsd(p.prices[next]), next < 0 ? undefined : `第 ${next + 1} 档 · ${fmtUsd(p.usd[next])} U`)}
        {stat("定投", `${dcaDone} / ${p.dcaWeeks} 周`, `每周 ${fmtUsd(p.dcaPerWeek)} U`)}
        {stat("期限", left >= 0 ? `还剩 ${left} 天` : "已到期", left >= 0 ? `${due} 到期；没成交的钱到时照样买进去` : `${due} 到期：没成交的钱按计划买进去`)}
        {stat(
          "预备金",
          reserveDone ? "已买入" : `已经等了 ${waited} 天`,
          reserveDone ? undefined : <>等跌破 200 周均线或 MVRV &lt; 1（现在约 {fmtUsd(reservePrice)}）；历史上两次之间最长隔了 4 年</>,
        )}
      </div>

      <div>
        <div className="mb-1 text-[12px] text-ink-3">限价档：成交了就勾上（按档位价格和金额记一笔，日期是今天，可以删掉重记）</div>
        <ul className="num grid gap-1.5 sm:grid-cols-2">
          {p.prices.map((price, k) => (
            <li key={k}>
              <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-line px-3 py-1.5 text-[13px]">
                <input type="checkbox" checked={filled.has(k)} onChange={() => toggleLevel(k)} />
                <span className="text-ink-3">第 {k + 1} 档</span>
                <b>{fmtUsd(price)}</b>
                <span className="ml-auto text-ink-3">{fmtUsd(p.usd[k])} U</span>
              </label>
            </li>
          ))}
        </ul>
      </div>

      {adding ? (
        <AddFill
          kind={adding}
          defaults={{ price: Math.round(live), usd: adding === "dca" ? Math.round(p.dcaPerWeek) : adding === "reserve" ? Math.round(p.reserveUsd) : 0 }}
          onCancel={() => setAdding(null)}
          onAdd={(f) => {
            onFills([...fills, f]);
            setAdding(null);
          }}
        />
      ) : (
        <div className="flex flex-wrap gap-3 text-xs">
          <button className="text-accent" onClick={() => setAdding("dca")}>
            + 记一笔定投
          </button>
          <button className="text-accent" onClick={() => setAdding("reserve")}>
            + 记预备金买入
          </button>
          <button className="text-accent" onClick={() => setAdding("level")}>
            + 记一笔别的成交
          </button>
        </div>
      )}

      {fills.length > 0 && (
        <div className="-mx-1 overflow-x-auto px-1">
          <table className="num w-full text-[12px]">
            <thead>
              <tr className="border-b border-line text-left text-ink-3">
                <th className="py-1 pr-2 font-normal">日期</th>
                <th className="py-1 pr-2 font-normal">类型</th>
                <th className="py-1 pr-2 text-right font-normal">价格</th>
                <th className="py-1 pr-2 text-right font-normal">金额</th>
                <th className="hidden py-1 pr-2 text-right font-normal sm:table-cell">币数</th>
                <th className="py-1" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {[...fills]
                .sort((a, b) => (a.date < b.date ? 1 : -1))
                .map((f) => (
                  <tr key={f.id}>
                    <td className="py-1 pr-2">{f.date}</td>
                    <td className="py-1 pr-2">
                      {KIND[f.kind]}
                      {f.level != null && ` ${f.level + 1}`}
                    </td>
                    <td className="py-1 pr-2 text-right">{fmtUsd(f.price)}</td>
                    <td className="py-1 pr-2 text-right">{fmtUsd(f.usd)}</td>
                    <td className="hidden py-1 pr-2 text-right sm:table-cell">{fmtBtc((f.usd * (1 - STACK_FEE)) / f.price)}</td>
                    <td className="py-1 text-right">
                      <button className="text-[11px] text-ink-3 hover:text-down" onClick={() => onFills(fills.filter((y) => y.id !== f.id))}>
                        删除
                      </button>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-[11px] leading-relaxed text-ink-3">记录只存在这个浏览器里，不上传；换设备或清除浏览器数据会丢失。币数按 0.1% 手续费估算。</p>
    </div>
  );
}

function AddFill({ kind: k0, defaults, onAdd, onCancel }: { kind: FillKind; defaults: { price: number; usd: number }; onAdd: (f: Fill) => void; onCancel: () => void }) {
  const [kind, setKind] = useState<FillKind>(k0);
  const [date, setDate] = useState(today());
  const [price, setPrice] = useState(defaults.price);
  const [usd, setUsd] = useState(defaults.usd);
  const field = "num w-full rounded-lg border border-line bg-panel-2 px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent";
  const ok = price > 0 && usd > 0 && /^\d{4}-\d{2}-\d{2}$/.test(date);
  return (
    <div className="space-y-2.5 rounded-lg border border-line p-3 text-xs text-ink-3">
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <label className="space-y-1">
          <span>类型</span>
          <select className={field} value={kind} onChange={(e) => setKind(e.target.value as FillKind)}>
            {(Object.keys(KIND) as FillKind[]).map((x) => (
              <option key={x} value={x}>
                {KIND[x]}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1">
          <span>日期</span>
          <input type="date" className={field} value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label className="space-y-1">
          <span>成交价</span>
          <input type="number" className={field} value={price || ""} onChange={(e) => setPrice(+e.target.value)} />
        </label>
        <label className="space-y-1">
          <span>金额（USDT）</span>
          <input type="number" className={field} value={usd || ""} onChange={(e) => setUsd(+e.target.value)} />
        </label>
      </div>
      <div className="flex gap-2">
        <button className="rounded-lg bg-ink px-3 py-1.5 text-sm font-medium text-bg disabled:opacity-50" disabled={!ok} onClick={() => onAdd({ id: newId(), date, price, usd, kind })}>
          记下
        </button>
        <button className="rounded-lg border border-line px-3 py-1.5 text-sm text-ink-2" onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  );
}
