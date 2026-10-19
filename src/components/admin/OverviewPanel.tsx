"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { CATEGORY_LABEL, LevelBadge, Tile, fmtDuration, fmtTime } from "./ui";

interface Source {
  ok: number;
  fail: number;
  avgMs: number;
  successRate: number | null;
  lastOkAt: number | null;
  lastFailAt: number | null;
  lastError: string | null;
}
interface Data {
  version: string;
  schema: number;
  node: string;
  uptimeSec: number;
  memoryMB: number;
  dbMB: number;
  allowlist: boolean;
  secureCookies: boolean;
  sources: Record<string, Source>;
  logs: {
    byLevel: { level: string; n: number }[];
    byCategory: { category: string; n: number; errors: number; warns: number }[];
    recentErrors: { id: number; ts: number; level: string; category: string; msg: string; trace: string | null }[];
    hourly: { h: number; n: number; errors: number }[];
  };
  requests: { count: number; avgMs: number | null };
  precompute: { lastRunAt: number | null; lastDurationMs: number | null; runs: number; failures: number; lastError: string | null };
  storedKlines: number;
}

const SOURCE_NAME: Record<string, string> = { binance: "Binance 公共行情", okx: "OKX" };

export function OverviewPanel() {
  const [d, setD] = useState<Data | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const load = () =>
      fetch("/api/admin/overview")
        .then(async (r) => {
          const b = await r.json();
          if (!r.ok) throw new Error(b.error);
          setD(b);
          setErr(null);
        })
        .catch((e) => setErr(e.message));
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, []);

  if (err) return <div className="card p-6 text-sm text-down">{err}</div>;
  if (!d) return <div className="card h-64 animate-pulse" />;

  const lv = Object.fromEntries(d.logs.byLevel.map((x) => [x.level, x.n]));
  const sources = Object.entries(d.sources);
  const healthy = sources.some(([, s]) => s.lastOkAt && Date.now() - s.lastOkAt < 15 * 60_000);

  return (
    <div className="space-y-4">
      <div className="flex items-baseline gap-3">
        <h1 className="text-xl font-semibold">运行概览</h1>
        <span className="text-xs text-ink-3">每 30 秒刷新</span>
      </div>

      {!d.allowlist && !d.secureCookies && (
        <div className="rounded-xl border border-warn/40 bg-warn-soft p-3 text-[13px] leading-relaxed">
          <b className="text-warn">安全提示：</b>后台正通过 HTTP 访问，登录密码会以明文传输。建议在 <code>/etc/signallight/signallight.env</code> 里设置 <code>ADMIN_IP_ALLOWLIST</code>（只允许你的 IP 访问后台），或者绑定域名后启用 HTTPS。
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile label="服务状态" value={healthy || sources.length === 0 ? "● 正常" : "● 数据源异常"} tone={healthy || sources.length === 0 ? "up" : "down"} sub={`版本 ${d.version} · 数据库结构 v${d.schema}`} />
        <Tile label="已运行" value={fmtDuration(d.uptimeSec)} sub={`Node ${d.node} · 内存 ${d.memoryMB} MB`} />
        <Tile label="24 小时接口请求" value={d.requests.count.toLocaleString()} sub={d.requests.avgMs == null ? "—" : `平均耗时 ${d.requests.avgMs} ms`} />
        <Tile label="24 小时错误 / 警告" value={`${lv.error ?? 0} / ${lv.warn ?? 0}`} tone={(lv.error ?? 0) > 0 ? "down" : undefined} sub={`数据库 ${d.dbMB} MB`} />
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile
          label="后台预计算"
          value={d.precompute.lastRunAt ? `${((d.precompute.lastDurationMs ?? 0) / 1000).toFixed(1)} 秒 / 轮` : "未运行"}
          sub={d.precompute.lastRunAt ? `最近一轮 ${fmtTime(d.precompute.lastRunAt)} · 共 ${d.precompute.runs} 轮${d.precompute.failures ? ` · 失败 ${d.precompute.failures} 次` : ""}` : "可在系统设置中开启"}
          tone={d.precompute.failures ? "warn" : undefined}
        />
        <Tile label="本地 K 线" value={d.storedKlines.toLocaleString()} sub="交易所不可用时用它继续提供服务" />
      </div>

      <section className="card p-4">
        <h2 className="mb-3 text-[15px] font-semibold">数据源（近 24 小时）</h2>
        {sources.length === 0 ? (
          <p className="text-sm text-ink-3">服务刚启动，还没有请求过交易所。</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-[13px]">
              <thead className="text-left text-xs text-ink-3">
                <tr>
                  <th className="pb-2 font-normal">数据源</th>
                  <th className="pb-2 font-normal">成功率</th>
                  <th className="pb-2 font-normal">请求数</th>
                  <th className="pb-2 font-normal">平均耗时</th>
                  <th className="pb-2 font-normal">最近成功</th>
                  <th className="pb-2 font-normal">最近失败</th>
                </tr>
              </thead>
              <tbody className="num">
                {sources.map(([name, s]) => (
                  <tr key={name} className="border-t border-line align-top">
                    <td className="py-2">{SOURCE_NAME[name] ?? name}</td>
                    <td className="py-2" style={{ color: (s.successRate ?? 0) >= 95 ? "var(--up)" : (s.successRate ?? 0) >= 80 ? "var(--warn)" : "var(--down)" }}>
                      {s.successRate == null ? "—" : `${s.successRate}%`}
                    </td>
                    <td className="py-2">{s.ok + s.fail}</td>
                    <td className="py-2">{s.avgMs} ms</td>
                    <td className="py-2">{fmtTime(s.lastOkAt)}</td>
                    <td className="py-2">
                      {fmtTime(s.lastFailAt)}
                      {s.lastError && <div className="max-w-[220px] truncate text-[11px] text-down" title={s.lastError}>{s.lastError}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="card p-4">
          <h2 className="mb-3 text-[15px] font-semibold">日志量（近 24 小时，按小时）</h2>
          <HourlyBars data={d.logs.hourly} />
          <div className="mt-3 flex flex-wrap gap-2 text-xs">
            {d.logs.byCategory.map((c) => (
              <span key={c.category} className="rounded-lg bg-panel-2 px-2 py-1 text-ink-2">
                {CATEGORY_LABEL[c.category] ?? c.category} {c.n}
                {c.errors > 0 && <b className="ml-1 text-down">· {c.errors} 错误</b>}
              </span>
            ))}
          </div>
        </section>
        <section className="card p-4">
          <h2 className="mb-3 text-[15px] font-semibold">最近的错误和警告</h2>
          {d.logs.recentErrors.length === 0 ? (
            <p className="text-sm text-ink-3">没有错误，一切正常。</p>
          ) : (
            <ul className="space-y-1.5 text-[13px]">
              {d.logs.recentErrors.map((e) => (
                <li key={e.id} className="flex items-start gap-2">
                  <LevelBadge level={e.level} />
                  <span className="num shrink-0 text-xs text-ink-3">{fmtTime(e.ts)}</span>
                  <span className="min-w-0 flex-1 truncate" title={e.msg}>
                    <span className="text-ink-3">[{CATEGORY_LABEL[e.category] ?? e.category}]</span> {e.msg}
                  </span>
                  {e.trace && (
                    <Link href={`/admin/logs?trace=${e.trace}`} className="num shrink-0 text-[11px] text-accent">
                      {e.trace}
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function HourlyBars({ data }: { data: { h: number; n: number; errors: number }[] }) {
  const now = Math.floor(Date.now() / 3600_000);
  const hours = Array.from({ length: 24 }, (_, k) => now - 23 + k);
  const map = new Map(data.map((x) => [x.h, x]));
  const max = Math.max(1, ...data.map((x) => x.n));
  return (
    <div>
      <div className="flex h-24 items-end gap-0.5" role="img" aria-label="近 24 小时每小时日志条数">
        {hours.map((h) => {
          const x = map.get(h);
          const n = x?.n ?? 0;
          const label = `${new Date(h * 3600_000).getHours()}:00 · ${n} 条${x?.errors ? `，其中 ${x.errors} 条错误` : ""}`;
          return (
            <div key={h} className="group relative flex h-full flex-1 items-end" title={label}>
              <div className="w-full rounded-t-[3px]" style={{ height: `${(n / max) * 100}%`, minHeight: n ? 2 : 0, background: x?.errors ? "var(--down)" : "var(--accent)" }} />
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-ink-3">
        <span>24 小时前</span>
        <span>现在</span>
      </div>
      <p className="mt-1 text-[11px] text-ink-3">蓝色 = 正常；红色 = 这一小时内出现过错误。鼠标悬停查看数量。</p>
    </div>
  );
}
