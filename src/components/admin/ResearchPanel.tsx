"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Group } from "@/lib/research/engine";
import type { ResearchReport, ResearchRow } from "@/lib/research/run";
import { TF_LABEL } from "@/lib/types";
import { btnCls, fmtTime } from "./ui";

type Kind = "signals" | "light" | "levels" | "plans" | "defend";
type ListItem = { id: number; createdAt: number; kind: Kind; paramsVersion: number };
const KIND_LABEL: Record<Kind, string> = { light: "信号灯", signals: "信号与指标", levels: "关键位", plans: "交易计划依据", defend: "守位依据" };
/** the questions inside a report, for its filter */
const FAMILIES: Partial<Record<Kind, Record<string, string>>> = {
  plans: { plan: "计划成绩单", anchor: "E10 价格锚定", exit: "E11 离场方式", entry: "E12 入场类型", stop: "E13 认错位", behavior: "E14 新手习惯" },
  levels: { level: "E6 触位反向（2R 止盈）", level_mfe: "E16 守住之前能走多远" },
  defend: { defend: "E17 守位计划与止跌 / 止涨证据", stop2: "E18 近止损与远止损" },
};

/** The numbers a row carries besides the edge, in a few words. */
function detail(x: ResearchRow): string {
  const e = x.extra ?? {};
  const v = (k: string, unit = "%") => (e[k] == null ? "—" : `${e[k]}${unit}`);
  if (x.family === "level") return `均值 ${x.cells.is.meanR ?? "—"}R · 刺穿 ${v("piercedPct")} / 失效 ${v("brokenPct")}`;
  if (x.family === "level_mfe") return `止损前先到 2R ${v("reach2")}（随机 ${v("reach2Ctl")}）· 最远中位 ${v("mfeMedR", "R")} · 2R 平半 ${v("scaleR", "R")}`;
  const parts: string[] = [];
  if (e.stopPct != null) parts.push(`被扫 ${v("stopPct")}（6 根内 ${v("quickStopPct")}）· 先到 2R ${v("reach2")}`);
  if (e.far_stopPct != null) parts.push(`远止损：被扫 ${v("far_stopPct")}（6 根内 ${v("far_quickStopPct")}）· 先到 2R ${v("far_reach2")}`);
  if (e.last_stopPct != null) parts.push(`按最新价：被扫 ${v("last_stopPct")}`);
  if (e.turnedPct != null) parts.push(`${v("turnedPct")} 的事件等到了 1 小时转强`);
  if (e.slipCostNearR != null) parts.push(`滑点让近止损少 ${v("slipCostNearR", "R")}、远止损少 ${v("slipCostFarR", "R")}`);
  if (e.crowdedPct != null) parts.push(`${v("crowdedPct")} 的近止损在拥挤处`);
  if (e.pct != null) parts.push(`占 ${v("pct")}`);
  if (e.unknown != null && e.unknown > 0) parts.push(`${e.unknown} 笔数据缺失未计`);
  return parts.join(" · ") || "—";
}
/** a row compared with something other than chance gets plainer words */
const verdictText = (v: string, control?: string) =>
  !control || control.includes("随机") ? v : v === "有优势" ? "明显更好" : v === "比随机差" ? "明显更差" : v === "无可证明的优势" ? "差别不能确定" : v;

const VERDICT_COLOR: Record<string, string> = {
  有优势: "var(--up)",
  比随机差: "var(--down)",
  无可证明的优势: "var(--text-3)",
  样本不足: "var(--text-3)",
};
const day = (sec: number | null) => (sec ? new Date(sec * 1000).toISOString().slice(0, 10) : "—");

function Edge({ g, strong = false }: { g: Group; strong?: boolean }) {
  if (g.edgeR == null) return <span className="text-ink-3">—</span>;
  const color = g.edgeR > 0 ? "var(--up)" : g.edgeR < 0 ? "var(--down)" : undefined;
  return (
    <span style={{ color }} className={strong ? "font-semibold" : ""} title={`${g.n} 笔，命中 ${g.hit}%（随机 ${g.baseHit}%），平均 ${g.meanR}R`}>
      {g.edgeR > 0 ? "+" : ""}
      {g.edgeR.toFixed(2)}
    </span>
  );
}

/** Research reports: every signal against a random control, in-sample and on the held-out last 12 months. */
export function ResearchPanel() {
  const [kind, setKind] = useState<Kind>("light");
  const [id, setId] = useState<number | null>(null);
  const [list, setList] = useState<ListItem[]>([]);
  const [r, setR] = useState<(ResearchReport & { id: number }) | null | undefined>(undefined);
  const [tf, setTf] = useState("all");
  const [family, setFamily] = useState("signal");
  const [onlyFindings, setOnlyFindings] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    fetch(`/api/admin/research?kind=${kind}${id ? `&id=${id}` : ""}`)
      .then((x) => x.json())
      .then((b) => {
        setList(b.list);
        setR(b.report);
      });
  }, [kind, id]);
  useEffect(load, [load]);

  const run = async () => {
    setBusy(true);
    setMsg(null);
    const x = await fetch("/api/admin/research", { method: "POST" });
    const b = await x.json();
    setBusy(false);
    setMsg({ ok: x.ok, text: x.ok ? `已生成，用时 ${Math.round(b.durationMs / 1000)} 秒` : b.error });
    setId(null);
    load();
  };

  const rows = useMemo(() => {
    if (!r) return [];
    return r.rows.filter(
      (x) =>
        (tf === "all" || x.tf === tf) &&
        (r.kind === "signals" ? x.family === family : FAMILIES[r.kind] ? !(family in FAMILIES[r.kind]!) || x.family === family : true) &&
        (!onlyFindings || x.verdict === "有优势" || x.verdict === "比随机差"),
    );
  }, [r, tf, family, onlyFindings]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">研究报告</h1>
        <button className={`${btnCls} ml-auto`} disabled={busy} onClick={run}>
          {busy ? "生成中…" : "立即生成"}
        </button>
      </div>
      <p className="text-xs leading-relaxed text-ink-3">
        每周自动生成一次（本地历史补齐后）。表里的“优势”是平均收益比随机对照多出多少，单位 R（1R = 入场时的 1 倍 ATR），已扣成本。按工作约定，只有优势至少 0.1R、多重检验校正后仍显著、并且 BTC / ETH、前后两半和最近 12 个月样本外方向一致，才算“有优势”，才可以考虑改进引擎。
      </p>
      {msg && <p className={`rounded-lg px-3 py-2 text-[13px] ${msg.ok ? "bg-up-soft text-up" : "bg-down-soft text-down"}`}>{msg.text}</p>}

      <div className="flex flex-wrap gap-2 text-sm">
        {(["light", "plans", "defend", "signals", "levels"] as const).map((k) => (
          <button
            key={k}
            className={`rounded-lg px-3 py-1.5 ${kind === k ? "bg-ink text-bg" : "border border-line text-ink-2"}`}
            onClick={() => {
              setKind(k);
              setId(null);
              setFamily(k === "signals" ? "signal" : "all");
            }}
          >
            {KIND_LABEL[k]}
          </button>
        ))}
        <select className="rounded-lg border border-line bg-panel-2 px-2 py-1.5" value={id ?? ""} onChange={(e) => setId(Number(e.target.value) || null)}>
          <option value="">最新一份</option>
          {list
            .filter((x) => x.kind === kind)
            .map((x) => (
              <option key={x.id} value={x.id}>
                {fmtTime(x.createdAt)} · 参数 v{x.paramsVersion}
              </option>
            ))}
        </select>
      </div>

      {r === undefined ? (
        <div className="h-48 animate-pulse rounded-xl bg-panel-2" />
      ) : r === null ? (
        <p className="card p-4 text-sm text-ink-3">还没有这类报告。本地 K 线历史补齐后每周自动生成，也可以点“立即生成”（关键位报告较慢，约需几分钟）。信号灯报告依赖成绩单，成绩单在后台逐步回放补齐。</p>
      ) : (
        <>
          <section className="card p-4 text-[13px]">
            <h2 className="text-[15px] font-semibold">{r.title}</h2>
            <p className="mt-1 text-xs text-ink-3">
              生成于 {fmtTime(r.createdAt)}，用时 {Math.round(r.durationMs / 1000)} 秒 · 数据 {r.source} · 参数 v{r.paramsVersion} · 成本 {r.costPct}% · 样本外从 {day(r.holdoutFrom)} 起
            </p>
            <table className="mt-3 text-xs">
              <thead className="text-left text-ink-3">
                <tr>
                  <th className="pr-4 font-normal">周期</th>
                  <th className="pr-4 font-normal">币种</th>
                  <th className="pr-4 font-normal">{r.kind === "light" ? "时点" : "每币 K 线"}</th>
                  <th className="pr-4 font-normal">覆盖</th>
                </tr>
              </thead>
              <tbody className="num">
                {r.coverage.map((c) => (
                  <tr key={c.tf}>
                    <td className="pr-4">{TF_LABEL[c.tf]}</td>
                    <td className="pr-4">{c.coins}</td>
                    <td className="pr-4">{c.bars}</td>
                    <td className="pr-4">
                      {day(c.from)} – {day(c.to)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <div className="flex flex-wrap items-center gap-2 text-sm">
            <select className="rounded-lg border border-line bg-panel-2 px-2 py-1.5" value={tf} onChange={(e) => setTf(e.target.value)}>
              <option value="all">全部周期</option>
              {r.coverage.map((c) => (
                <option key={c.tf} value={c.tf}>{TF_LABEL[c.tf]}</option>
              ))}
            </select>
            {FAMILIES[r.kind] && (
              <select className="rounded-lg border border-line bg-panel-2 px-2 py-1.5" value={family in FAMILIES[r.kind]! ? family : "all"} onChange={(e) => setFamily(e.target.value)}>
                <option value="all">全部问题</option>
                {Object.entries(FAMILIES[r.kind]!).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
            )}
            {r.kind === "signals" && (
              <select className="rounded-lg border border-line bg-panel-2 px-2 py-1.5" value={family} onChange={(e) => setFamily(e.target.value)}>
                <option value="signal">页面上的信号</option>
                <option value="indicator">每个指标的翻转</option>
              </select>
            )}
            <label className="flex items-center gap-1.5 text-xs text-ink-2">
              <input type="checkbox" checked={onlyFindings} onChange={(e) => setOnlyFindings(e.target.checked)} /> 只看有结论的
            </label>
          </div>

          <section className="card overflow-x-auto p-4">
            <table className="w-full min-w-[860px] text-[13px]">
              <thead className="text-left text-xs text-ink-3">
                <tr>
                  <th className="py-1.5 pr-3 font-normal">信号</th>
                  <th className="py-1.5 pr-3 font-normal">周期</th>
                  <th className="py-1.5 pr-3 font-normal">样本内笔数</th>
                  <th className="py-1.5 pr-3 font-normal">{r.kind === "plans" || r.kind === "defend" ? "命中 vs 对照" : "命中 vs 随机"}</th>
                  <th className="py-1.5 pr-3 font-normal">优势（样本内）</th>
                  <th className="py-1.5 pr-3 font-normal">样本外</th>
                  <th className="py-1.5 pr-3 font-normal">BTC</th>
                  <th className="py-1.5 pr-3 font-normal">ETH</th>
                  <th className="py-1.5 pr-3 font-normal">前半</th>
                  <th className="py-1.5 pr-3 font-normal">后半</th>
                  {(r.kind === "levels" || r.kind === "defend") && <th className="py-1.5 pr-3 font-normal">细节</th>}
                  <th className="py-1.5 pr-3 font-normal">q 值</th>
                  <th className="py-1.5 pr-3 font-normal">结论</th>
                  {(r.kind === "plans" || r.kind === "defend") && <th className="py-1.5 font-normal">对照</th>}
                </tr>
              </thead>
              <tbody className="num">
                {rows.map((x: ResearchRow) => (
                  <tr key={`${x.tf}:${x.key}`} className="border-t border-line">
                    <td className="py-1.5 pr-3">
                      {(x.family === "signal" || x.family === "indicator" || x.family === "light") && <span style={{ color: x.side === "bull" ? "var(--up)" : "var(--down)" }}>{x.side === "bull" ? "↑" : "↓"} </span>}
                      {x.name}
                    </td>
                    <td className="py-1.5 pr-3">{TF_LABEL[x.tf]}</td>
                    <td className="py-1.5 pr-3">{x.cells.is.n}</td>
                    <td className="py-1.5 pr-3">
                      {x.cells.is.hit ?? "—"}% <span className="text-ink-3">/ {x.cells.is.baseHit ?? "—"}%</span>
                    </td>
                    <td className="py-1.5 pr-3"><Edge g={x.cells.is} strong /></td>
                    <td className="py-1.5 pr-3"><Edge g={x.cells.oos} /> <span className="text-[11px] text-ink-3">({x.cells.oos.n})</span></td>
                    <td className="py-1.5 pr-3"><Edge g={x.cells.btc} /></td>
                    <td className="py-1.5 pr-3"><Edge g={x.cells.eth} /></td>
                    <td className="py-1.5 pr-3"><Edge g={x.cells.firstHalf} /></td>
                    <td className="py-1.5 pr-3"><Edge g={x.cells.secondHalf} /></td>
                    {(r.kind === "levels" || r.kind === "defend") && <td className="py-1.5 pr-3 text-xs text-ink-2">{detail(x)}</td>}
                    <td className="py-1.5 pr-3">{x.q ?? "—"}</td>
                    <td className="py-1.5 pr-3" style={{ color: VERDICT_COLOR[x.verdict] }}>{verdictText(x.verdict, x.control)}</td>
                    {(r.kind === "plans" || r.kind === "defend") && <td className="py-1.5 text-xs text-ink-3">{x.control}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length === 0 && <p className="py-6 text-center text-sm text-ink-3">没有符合条件的行</p>}
          </section>

          <ul className="list-disc space-y-1 pl-5 text-xs leading-relaxed text-ink-3">
            {r.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
