"use client";

import { useEffect, useState } from "react";
import { btnCls, btnGhost, inputCls } from "./ui";

type Effort = "low" | "medium" | "high" | "xhigh" | "max";
interface Config {
  enabled: boolean;
  baseUrl: string;
  model: string;
  effort: Effort;
  dailyLimit: number;
  perIpHourly: number;
  timeoutSec: number;
  fallback: boolean;
  prompt: string;
  revision: number;
  hasKey: boolean;
  keyHint: string | null;
  defaultPrompt: string;
  defaultModel: string;
}
interface UsageRow {
  day: string;
  calls: number;
  failures: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
}
interface State {
  config: Config;
  usage: { today: UsageRow | null; days: UsageRow[]; cachedInterpretations: number };
  canEncrypt: boolean;
}

const EFFORTS: { v: Effort; label: string; hint: string }[] = [
  { v: "low", label: "低", hint: "最快、最省，适合简单总结" },
  { v: "medium", label: "中（推荐）", hint: "Claude Opus 5.5 的默认值，质量和成本较均衡" },
  { v: "high", label: "高", hint: "思考更充分，耗时和费用更高" },
  { v: "xhigh", label: "很高", hint: "更深入，适合复杂分析" },
  { v: "max", label: "最高", hint: "最慢最贵，一般不需要" },
];

/** Official list prices (USD per million tokens) for the cost estimate. */
const PRICES: Record<string, [number, number]> = {
  "claude-opus-5-5": [4, 20],
  "claude-opus-5": [5, 25],
  "claude-opus-4-8": [5, 25],
  "claude-opus-4-7": [5, 25],
  "claude-opus-4-6": [5, 25],
  "claude-sonnet-5-5": [2, 10],
  "claude-sonnet-5": [2, 10],
  "claude-sonnet-4-6": [3, 15],
  "claude-haiku-5-5": [0.1, 0.5],
  "claude-fable-5-1": [10, 50],
};

export function AiPanel() {
  const [st, setSt] = useState<State | null>(null);
  const [f, setF] = useState<Omit<Config, "revision" | "hasKey" | "keyHint" | "defaultPrompt" | "defaultModel"> | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [test, setTest] = useState<{ ok: boolean; message: string; model?: string; durationMs: number } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = (s: State) => {
    setSt(s);
    const { enabled, baseUrl, model, effort, dailyLimit, perIpHourly, timeoutSec, fallback, prompt } = s.config;
    setF({ enabled, baseUrl, model, effort, dailyLimit, perIpHourly, timeoutSec, fallback, prompt: prompt || s.config.defaultPrompt });
    setApiKey("");
  };
  useEffect(() => {
    fetch("/api/admin/ai").then((r) => r.json()).then(load);
  }, []);
  if (!st || !f) return <div className="card h-64 animate-pulse" />;
  const c = st.config;

  const save = async (extra: Record<string, unknown> = {}) => {
    setBusy("save");
    setMsg(null);
    const body = { ...f, prompt: f.prompt.trim() === c.defaultPrompt.trim() ? "" : f.prompt, ...(apiKey ? { apiKey } : {}), ...extra };
    const r = await fetch("/api/admin/ai", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const b = await r.json();
    setBusy(null);
    if (!r.ok) return setMsg({ ok: false, text: b.error });
    load(b);
    setMsg({ ok: true, text: "已保存。之后生成的解读会使用新配置。" });
  };
  const runTest = async () => {
    setBusy("test");
    setTest(null);
    const r = await fetch("/api/admin/ai/test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ baseUrl: f.baseUrl, model: f.model, ...(apiKey ? { apiKey } : {}) }) });
    setTest(await r.json());
    setBusy(null);
  };
  const clearCache = async () => {
    if (!confirm("确定清空所有已生成的 AI 解读吗？下次访问会重新生成并计入额度。")) return;
    const r = await fetch("/api/admin/ai/cache", { method: "DELETE" });
    const b = await r.json();
    setMsg({ ok: r.ok, text: b.message ?? b.error });
    fetch("/api/admin/ai").then((r) => r.json()).then((s) => setSt(s));
  };

  const price = PRICES[f.model];
  const cost = (u: UsageRow) => (price ? (u.input_tokens * price[0] + u.output_tokens * price[1]) / 1e6 : null);
  const t = st.usage.today;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">AI 配置</h1>
        <span className={`rounded-full px-2.5 py-0.5 text-xs ${c.enabled ? "bg-up-soft text-up" : "bg-panel-2 text-ink-3"}`}>{c.enabled ? "● 已启用" : "○ 未启用"}</span>
        <span className={`rounded-full px-2.5 py-0.5 text-xs ${c.hasKey ? "bg-up-soft text-up" : "bg-warn-soft text-warn"}`}>{c.hasKey ? `API Key 已配置 ${c.keyHint ?? ""}` : "API Key 未配置"}</span>
      </div>
      {!st.canEncrypt && (
        <p className="rounded-lg bg-down-soft px-3 py-2 text-[13px] text-down">服务器没有配置 MASTER_KEY，无法加密保存 API Key。请在 /etc/signallight/signallight.env 设置后执行 sudo signallight restart。</p>
      )}
      {msg && <p className={`rounded-lg px-3 py-2 text-[13px] ${msg.ok ? "bg-up-soft text-up" : "bg-down-soft text-down"}`}>{msg.text}</p>}

      <section className="card p-4">
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl bg-panel-2 p-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-[#d97757] text-lg font-bold text-white">A\</div>
          <div>
            <div className="font-semibold">Claude AI</div>
            <div className="text-xs text-ink-3">Anthropic · {f.model || c.defaultModel}</div>
          </div>
          <a className={`${btnGhost} ml-auto`} href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">
            获取 API Key ↗
          </a>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <label className="space-y-1 md:col-span-2">
            <span className="text-sm font-medium">API Key {!c.hasKey && <span className="text-down">*</span>}</span>
            <input className={inputCls} type="password" autoComplete="off" placeholder={c.hasKey ? "已保存（加密存储）。重新输入即可替换" : "sk-ant-..."} value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
            {c.hasKey && (
              <button className="text-xs text-down" onClick={() => confirm("确定清除已保存的 API Key 吗？AI 解读会随之停用。") && save({ clearKey: true, enabled: false })}>
                清除已保存的 Key
              </button>
            )}
          </label>
          <label className="space-y-1">
            <span className="text-sm font-medium">Base URL（可选）</span>
            <input className={inputCls} placeholder="留空使用官方地址 https://api.anthropic.com" value={f.baseUrl} onChange={(e) => setF({ ...f, baseUrl: e.target.value })} />
            <span className="text-[11px] text-ink-3">只有使用第三方代理时才需要填写。</span>
          </label>
          <label className="space-y-1">
            <span className="text-sm font-medium">模型名称（可选）</span>
            <input className={inputCls} placeholder={c.defaultModel} value={f.model} onChange={(e) => setF({ ...f, model: e.target.value })} />
            <span className="text-[11px] text-ink-3">默认 {c.defaultModel}。代理服务的模型名可能不同，以代理说明为准。</span>
          </label>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button className={btnGhost} disabled={!!busy || (!c.hasKey && !apiKey)} onClick={runTest}>
            {busy === "test" ? "测试中…" : "测试连接"}
          </button>
          {test && (
            <span className={`text-[13px] ${test.ok ? "text-up" : "text-down"}`}>
              {test.ok ? "✓" : "✗"} {test.message}
              {test.model && ` · 实际模型 ${test.model}`} · {(test.durationMs / 1000).toFixed(1)} 秒
            </span>
          )}
        </div>
      </section>

      <section className="card space-y-4 p-4">
        <h2 className="text-[15px] font-semibold">生成设置</h2>
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} />
          在分析页显示 AI 解读
        </label>
        <div>
          <div className="mb-1.5 text-sm font-medium">思考强度</div>
          <div className="flex flex-wrap gap-1.5">
            {EFFORTS.map((e) => (
              <button key={e.v} className="chip !text-xs" data-active={f.effort === e.v} onClick={() => setF({ ...f, effort: e.v })} title={e.hint}>
                {e.label}
              </button>
            ))}
          </div>
          <p className="mt-1 text-[11px] text-ink-3">{EFFORTS.find((e) => e.v === f.effort)?.hint}</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="space-y-1">
            <span className="text-sm font-medium">每日生成上限</span>
            <input className={inputCls} type="number" min={0} value={f.dailyLimit} onChange={(e) => setF({ ...f, dailyLimit: Number(e.target.value) })} />
            <span className="text-[11px] text-ink-3">访客点“AI 分析”按钮才会生成；同一个币、同一周期的同一根已收盘 K 线只生成一次，其他人直接看缓存。超过上限后显示最近一次的解读。</span>
          </label>
          <label className="space-y-1">
            <span className="text-sm font-medium">每个 IP 每小时最多生成</span>
            <input className={inputCls} type="number" min={1} max={100} value={f.perIpHourly} onChange={(e) => setF({ ...f, perIpHourly: Number(e.target.value) })} />
            <span className="text-[11px] text-ink-3">防止有人反复点按钮消耗额度（1–100 次）。看已有的缓存不计数。只在 1 小时及以上周期提供。</span>
          </label>
          <label className="space-y-1">
            <span className="text-sm font-medium">单次超时（秒）</span>
            <input className={inputCls} type="number" min={10} max={600} value={f.timeoutSec} onChange={(e) => setF({ ...f, timeoutSec: Number(e.target.value) })} />
          </label>
        </div>
        <label className="flex cursor-pointer items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={f.fallback} onChange={(e) => setF({ ...f, fallback: e.target.checked })} />
          <span>
            拒答时自动切换备用模型
            <span className="block text-[11px] text-ink-3">Claude 的安全检查偶尔会拒绝请求。开启后，官方 API 会自动改用 Anthropic 推荐的备用模型重新生成。第三方代理不支持时，系统会自动关闭这个参数并重试。</span>
          </span>
        </label>
      </section>

      <section className="card p-4">
        <div className="mb-2 flex items-center gap-2">
          <h2 className="text-[15px] font-semibold">提示词</h2>
          <span className="text-xs text-ink-3">AI 只会收到系统算好的结构化数据，并按固定格式输出。</span>
          {f.prompt.trim() !== c.defaultPrompt.trim() && (
            <button className="ml-auto text-xs text-accent" onClick={() => setF({ ...f, prompt: c.defaultPrompt })}>
              恢复默认提示词
            </button>
          )}
        </div>
        <textarea className={`${inputCls} h-72 font-mono !text-[12px] leading-relaxed`} value={f.prompt} onChange={(e) => setF({ ...f, prompt: e.target.value })} />
      </section>

      <div className="flex gap-2">
        <button className={btnCls} disabled={!!busy} onClick={() => save()}>
          {busy === "save" ? "保存中…" : "保存配置"}
        </button>
      </div>

      <section className="card p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h2 className="text-[15px] font-semibold">用量</h2>
          <span className="text-xs text-ink-3">已缓存 {st.usage.cachedInterpretations} 条解读</span>
          <button className={`${btnGhost} ml-auto !text-xs`} onClick={clearCache}>清空解读缓存</button>
        </div>
        <div className="grid grid-cols-2 gap-2 text-[13px] sm:grid-cols-4">
          <Stat label="今日生成" value={`${t?.calls ?? 0} / ${f.dailyLimit}`} />
          <Stat label="今日失败" value={String(t?.failures ?? 0)} />
          <Stat label="今日 Token（输入 / 输出）" value={`${((t?.input_tokens ?? 0) / 1000).toFixed(1)}k / ${((t?.output_tokens ?? 0) / 1000).toFixed(1)}k`} />
          <Stat label="今日估算费用" value={t && cost(t) != null ? `$${cost(t)!.toFixed(3)}` : "—"} />
        </div>
        {st.usage.days.length > 0 && (
          <table className="mt-3 w-full text-xs num">
            <thead className="text-left text-ink-3">
              <tr><th className="font-normal">日期</th><th className="font-normal">生成</th><th className="font-normal">失败</th><th className="font-normal">输入</th><th className="font-normal">输出</th><th className="font-normal">缓存命中</th><th className="font-normal">估算费用</th></tr>
            </thead>
            <tbody>
              {st.usage.days.map((d) => (
                <tr key={d.day} className="border-t border-line">
                  <td className="py-1">{d.day}</td><td>{d.calls}</td><td>{d.failures}</td><td>{d.input_tokens}</td><td>{d.output_tokens}</td><td>{d.cache_read_tokens}</td>
                  <td>{cost(d) != null ? `$${cost(d)!.toFixed(3)}` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="mt-2 text-[11px] text-ink-3">费用按 Anthropic 官方价格估算{price ? `（${f.model}：输入 $${price[0]} / 输出 $${price[1]} 每百万 Token）` : ""}；使用第三方代理时以实际账单为准。每次调用的明细在「日志中心 → AI」里。</p>
      </section>

      <section className="rounded-xl border border-accent/30 bg-accent-soft p-4 text-[13px] leading-relaxed text-ink-2">
        <b className="text-ink">说明</b>
        <ul className="mt-1 list-disc pl-5">
          <li>使用官方 API 时只需填写 API Key，其他留空即可。</li>
          <li>自定义 Base URL 和模型名称只在使用第三方代理时需要填写。</li>
          <li>API Key 用服务器主密钥加密保存，页面上不会显示明文。</li>
          <li>AI 不会接触原始行情，也不会预测价格；输出里必须包含认错位和风险提醒。</li>
        </ul>
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-panel-2 p-2.5">
      <div className="text-[11px] text-ink-3">{label}</div>
      <div className="num mt-0.5 font-medium">{value}</div>
    </div>
  );
}
