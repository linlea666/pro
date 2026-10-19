"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Fragment, useCallback, useEffect, useState } from "react";
import { CATEGORY_LABEL, LEVEL_STYLE, LevelBadge, btnCls, btnGhost, fmtTime, inputCls } from "./ui";

interface Row {
  id: number;
  ts: number;
  level: string;
  category: string;
  msg: string;
  trace: string | null;
  duration_ms: number | null;
  ctx: string | null;
}

const RANGES: { key: string; label: string; ms: number | null }[] = [
  { key: "1h", label: "近 1 小时", ms: 3600_000 },
  { key: "24h", label: "近 24 小时", ms: 86400_000 },
  { key: "7d", label: "近 7 天", ms: 7 * 86400_000 },
  { key: "30d", label: "近 30 天", ms: 30 * 86400_000 },
  { key: "all", label: "全部", ms: null },
  { key: "custom", label: "自定义", ms: null },
];
const LEVELS = ["error", "warn", "info", "debug"];
const CATS = Object.keys(CATEGORY_LABEL);

/** datetime-local value <-> epoch ms */
const toLocalInput = (ms: number) => {
  const d = new Date(ms - new Date().getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
};

export function LogsPanel() {
  const sp = useSearchParams();
  const router = useRouter();

  // filter state is mirrored in the URL so links (e.g. ?trace=…) and reloads work
  const [range, setRange] = useState(sp.get("range") || (sp.get("trace") ? "all" : "24h"));
  const [from, setFrom] = useState(sp.get("from") || "");
  const [to, setTo] = useState(sp.get("to") || "");
  const [levels, setLevels] = useState<string[]>(sp.get("level")?.split(",").filter(Boolean) ?? []);
  const [cats, setCats] = useState<string[]>(sp.get("category")?.split(",").filter(Boolean) ?? []);
  const [q, setQ] = useState(sp.get("q") || "");
  const [trace, setTrace] = useState(sp.get("trace") || "");
  const [live, setLive] = useState(false);

  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const [meta, setMeta] = useState<{ retentionDays: number; dbMB: number } | null>(null);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const buildQuery = useCallback(() => {
    const p = new URLSearchParams();
    const r = RANGES.find((x) => x.key === range);
    if (r?.ms) p.set("from", String(Date.now() - r.ms));
    if (range === "custom") {
      if (from) p.set("from", String(new Date(from).getTime()));
      if (to) p.set("to", String(new Date(to).getTime()));
    }
    if (levels.length) p.set("level", levels.join(","));
    if (cats.length) p.set("category", cats.join(","));
    if (q.trim()) p.set("q", q.trim());
    if (trace.trim()) p.set("trace", trace.trim());
    return p;
  }, [range, from, to, levels, cats, q, trace]);

  const load = useCallback(
    async (before?: number) => {
      setLoading(true);
      setErr(null);
      try {
        const p = buildQuery();
        p.set("limit", "100");
        if (before) p.set("before", String(before));
        const r = await fetch(`/api/admin/logs?${p}`);
        const b = await r.json();
        if (!r.ok) throw new Error(b.error);
        setRows((cur) => (before ? [...cur, ...b.rows] : b.rows));
        setNext(b.nextBefore);
        if (!before) setTotal(b.total);
        setMeta({ retentionDays: b.retentionDays, dbMB: b.dbMB });
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [buildQuery],
  );

  const apply = useCallback(() => {
    const u = new URLSearchParams();
    if (range !== "24h") u.set("range", range);
    if (range === "custom") {
      if (from) u.set("from", from);
      if (to) u.set("to", to);
    }
    if (levels.length) u.set("level", levels.join(","));
    if (cats.length) u.set("category", cats.join(","));
    if (q.trim()) u.set("q", q.trim());
    if (trace.trim()) u.set("trace", trace.trim());
    router.replace(`/admin/logs${u.size ? `?${u}` : ""}`, { scroll: false });
    load();
  }, [range, from, to, levels, cats, q, trace, router, load]);

  // run on first render and whenever chips/range change; text inputs apply on Enter
  useEffect(() => {
    apply();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, levels, cats, trace]);

  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => load(), 10_000);
    return () => clearInterval(id);
  }, [live, load]);

  const toggle = (arr: string[], v: string, set: (x: string[]) => void) => set(arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
  const reset = () => {
    setRange("24h");
    setFrom("");
    setTo("");
    setLevels([]);
    setCats([]);
    setQ("");
    setTrace("");
  };
  const exportUrl = (format: "csv" | "json") => {
    const p = buildQuery();
    p.set("format", format);
    return `/api/admin/logs/export?${p}`;
  };

  const traceMode = !!trace.trim();
  const shown = traceMode ? [...rows].sort((a, b) => a.id - b.id) : rows;
  const t0 = shown[0]?.ts ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-xl font-semibold">日志中心</h1>
        {meta && (
          <span className="text-xs text-ink-3">
            保留 {meta.retentionDays} 天 · 数据库 {meta.dbMB} MB ·{" "}
            <a href="/admin/settings" className="text-accent">修改保留策略</a>
          </span>
        )}
      </div>

      <section className="card space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="w-12 text-xs text-ink-3">时间</span>
          {RANGES.map((r) => (
            <button key={r.key} className="chip !text-xs" data-active={range === r.key} onClick={() => setRange(r.key)}>
              {r.label}
            </button>
          ))}
          {range === "custom" && (
            <span className="flex flex-wrap items-center gap-1.5">
              <input type="datetime-local" className={`${inputCls} !w-auto`} value={from} max={toLocalInput(Date.now())} onChange={(e) => setFrom(e.target.value)} />
              <span className="text-xs text-ink-3">至</span>
              <input type="datetime-local" className={`${inputCls} !w-auto`} value={to} onChange={(e) => setTo(e.target.value)} />
              <button className={btnGhost} onClick={apply}>应用</button>
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="w-12 text-xs text-ink-3">级别</span>
          {LEVELS.map((l) => (
            <button key={l} className="chip !text-xs" data-active={levels.includes(l)} onClick={() => toggle(levels, l, setLevels)} style={levels.includes(l) ? {} : { color: LEVEL_STYLE[l].color }}>
              {LEVEL_STYLE[l].label}
            </button>
          ))}
          <span className="ml-3 w-12 text-xs text-ink-3">分类</span>
          {CATS.map((c) => (
            <button key={c} className="chip !text-xs" data-active={cats.includes(c)} onClick={() => toggle(cats, c, setCats)}>
              {CATEGORY_LABEL[c]}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="w-12 text-xs text-ink-3">搜索</span>
          <input className={`${inputCls} !w-64`} placeholder="消息或上下文里的关键字，回车搜索" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && apply()} />
          <input className={`${inputCls} !w-44`} placeholder="追踪 ID" value={trace} onChange={(e) => setTrace(e.target.value)} onKeyDown={(e) => e.key === "Enter" && apply()} />
          <button className={btnCls} onClick={apply} disabled={loading}>查询</button>
          <button className={btnGhost} onClick={reset}>重置</button>
          <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-xs text-ink-2">
            <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} />
            实时刷新（每 10 秒）
          </label>
        </div>
      </section>

      <section className="card p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="text-sm">
            {traceMode ? (
              <>
                追踪 <code className="text-accent">{trace}</code> 的完整链路 · {rows.length} 条
              </>
            ) : (
              <>共 {total ?? "…"} 条{rows.length < (total ?? 0) ? `，已显示 ${rows.length} 条` : ""}</>
            )}
          </span>
          {traceMode && (
            <button className="text-xs text-accent" onClick={() => setTrace("")}>
              清除追踪筛选
            </button>
          )}
          <span className="ml-auto flex gap-2">
            <a className={btnGhost} href={exportUrl("csv")}>导出 CSV</a>
            <a className={btnGhost} href={exportUrl("json")}>导出 JSON</a>
          </span>
        </div>
        {err && <p className="mb-2 rounded-lg bg-down-soft px-3 py-2 text-[13px] text-down">{err}</p>}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-[13px]">
            <thead className="text-left text-xs text-ink-3">
              <tr>
                <th className="w-[150px] pb-2 font-normal">{traceMode ? "时间 / 相对耗时" : "时间"}</th>
                <th className="w-14 pb-2 font-normal">级别</th>
                <th className="w-20 pb-2 font-normal">分类</th>
                <th className="pb-2 font-normal">消息</th>
                <th className="w-16 pb-2 text-right font-normal">耗时</th>
                <th className="w-28 pb-2 pl-3 font-normal">追踪 ID</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const isOpen = open.has(r.id);
                return (
                  <Fragment key={r.id}>
                    <tr
                      className="cursor-pointer border-t border-line align-top hover:bg-panel-2"
                      onClick={() => setOpen((s) => {
                        const n = new Set(s);
                        if (n.has(r.id)) n.delete(r.id);
                        else n.add(r.id);
                        return n;
                      })}
                    >
                      <td className="num py-1.5 text-xs text-ink-2">
                        {fmtTime(r.ts)}
                        {traceMode && <span className="ml-1 text-ink-3">+{r.ts - t0}ms</span>}
                      </td>
                      <td className="py-1.5"><LevelBadge level={r.level} /></td>
                      <td className="py-1.5 text-xs text-ink-2">{CATEGORY_LABEL[r.category] ?? r.category}</td>
                      <td className="py-1.5">
                        <span className={isOpen ? "" : "line-clamp-1"}>{r.msg}</span>
                        {r.ctx && !isOpen && <span className="ml-1 text-[11px] text-ink-3">▸ 详情</span>}
                      </td>
                      <td className="num py-1.5 text-right text-xs text-ink-2">{r.duration_ms != null ? `${r.duration_ms}ms` : ""}</td>
                      <td className="py-1.5 pl-3">
                        {r.trace && (
                          <button
                            className="num text-[11px] text-accent hover:underline"
                            onClick={(e) => {
                              e.stopPropagation();
                              setRange("all");
                              setTrace(r.trace!);
                            }}
                            title="查看这次请求的完整链路"
                          >
                            {r.trace}
                          </button>
                        )}
                      </td>
                    </tr>
                    {isOpen && r.ctx && (
                      <tr className="bg-panel-2">
                        <td colSpan={6} className="px-3 py-2">
                          <CtxView ctx={r.ctx} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          {!loading && rows.length === 0 && <p className="py-8 text-center text-sm text-ink-3">没有符合条件的日志</p>}
        </div>
        {next && !traceMode && (
          <div className="mt-3 text-center">
            <button className={btnGhost} disabled={loading} onClick={() => load(next)}>
              {loading ? "加载中…" : "加载更多"}
            </button>
          </div>
        )}
      </section>

      <Archives />
    </div>
  );
}

function CtxView({ ctx }: { ctx: string }) {
  let pretty = ctx;
  try {
    pretty = JSON.stringify(JSON.parse(ctx), null, 2);
  } catch {}
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative">
      <button
        className="absolute right-0 top-0 text-[11px] text-accent"
        onClick={() => {
          navigator.clipboard?.writeText(pretty);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? "已复制" : "复制"}
      </button>
      <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all pr-10 text-[12px] leading-relaxed text-ink-2">{pretty}</pre>
    </div>
  );
}

function Archives() {
  const [list, setList] = useState<{ name: string; sizeKB: number; mtime: number }[] | null>(null);
  const [weekly, setWeekly] = useState<boolean | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/admin/logs/archives").then((r) => r.json()).then((b) => setList(b.archives ?? []));
    fetch("/api/admin/settings").then((r) => r.json()).then((b) => setWeekly(Boolean(b["log.weeklyArchive"]?.value)));
  }, []);

  const toggleWeekly = async () => {
    const v = !weekly;
    const r = await fetch("/api/admin/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ "log.weeklyArchive": v }) });
    if (r.ok) setWeekly(v);
  };
  const archiveNow = async (weeksAgo: number) => {
    setBusy(true);
    const r = await fetch("/api/admin/logs/archives", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ weeksAgo }) });
    const b = await r.json();
    setBusy(false);
    setMsg(b.message ?? b.error);
    if (b.archives) setList(b.archives);
  };

  return (
    <section className="card p-4">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h2 className="text-[15px] font-semibold">周归档</h2>
        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-ink-2">
          <input type="checkbox" checked={!!weekly} disabled={weekly === null} onChange={toggleWeekly} />
          每周一自动归档上一周的日志
        </label>
        <span className="ml-auto flex gap-2">
          <button className={btnGhost} disabled={busy} onClick={() => archiveNow(1)}>立即归档上周</button>
          <button className={btnGhost} disabled={busy} onClick={() => archiveNow(0)}>归档本周（截至现在）</button>
        </span>
      </div>
      <p className="mb-3 text-xs text-ink-3">归档文件是 gzip 压缩的 JSON Lines，每行一条日志，可以用任何文本工具解压查看。归档不受日志保留天数影响，按“系统设置”里的保留周数清理。</p>
      {msg && <p className="mb-2 text-[13px] text-up">{msg}</p>}
      {list === null ? (
        <div className="h-12 animate-pulse rounded bg-panel-2" />
      ) : list.length === 0 ? (
        <p className="text-sm text-ink-3">还没有归档文件。</p>
      ) : (
        <ul className="divide-y divide-line text-[13px]">
          {list.map((a) => (
            <li key={a.name} className="flex items-center gap-3 py-2">
              <span className="num">{a.name}</span>
              <span className="text-xs text-ink-3">{a.sizeKB} KB · {fmtTime(a.mtime)}</span>
              <a className="ml-auto text-xs text-accent" href={`/api/admin/logs/archives/${a.name}`}>下载</a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
