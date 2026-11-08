"use client";

import { useState } from "react";
import { EXCHANGE_NAME, type ExPosition } from "@/lib/exchange";
import type { Account, Holding, HoldingView } from "@/lib/rollbook";
import { ACCOUNT_RISK_PCT } from "@/lib/rollbook";
import { lossAtStops, MARGIN_RULES, stressTest, survivableMove } from "@/lib/ta/margin";
import { field, money, severity, TONE_BG } from "./ui";
import { Term } from "./Term";

/**
 * The account at a glance: one sentence, three lights (stop orders, distance to liquidation, everything at
 * its stop), the most urgent thing to do, and for an exchange account the balances and a BTC stress test.
 * The account settings (risk per trade, budget, fee) fold away underneath.
 */
export function AccountHealth({
  acc,
  views,
  betas,
  alertOff,
  onEnableAlert,
  onChange,
  onRemove,
  now,
}: {
  acc: Account;
  views: (readonly [Holding, HoldingView])[];
  betas: Record<string, number>;
  /** the server's mail alerts are off (null: a visitor, no alerts) */
  alertOff: boolean | null;
  onEnableAlert: () => void;
  onChange: (p: Partial<Account>) => void;
  onRemove: (() => void) | null;
  now: number;
}) {
  const s = acc.snap;
  const equity = acc.total;
  const unguarded = views.filter(([, v]) => v.guard && v.guard.state !== "ok");
  const noStop = views.filter(([h, v]) => !h.ex && v.stop == null);
  const { loss, unbounded } = lossAtStops(
    views.map(([h, v]) => ({ dir: h.dir, qty: v.pos.qty, avg: v.pos.avg, stop: h.ex ? h.ex.sl : v.stop, covered: h.ex ? h.ex.covered : null, liq: v.liq, mode: h.mode, margin: h.ex ? h.ex.margin : h.mode === "isolated" ? (v.pos.avg * v.pos.qty) / Math.max(1, h.leverage) : null })),
    acc.fee,
  );
  const lossPct = equity > 0 ? (loss / equity) * 100 : null;
  const ratio = s?.mgnRatio ?? null;
  const urgent = [...views].sort(([, a], [, b]) => severity(a) - severity(b)).find(([, v]) => v.status && (v.status.tone === "bad" || v.status.tone === "warn"));

  const stopLight = unguarded.length + noStop.length > 0 ? "bad" : "good";
  const ratioLight = ratio == null ? "wait" : ratio <= MARGIN_RULES.ratioDanger ? "bad" : ratio <= MARGIN_RULES.ratioWarn ? "warn" : "good";
  const lossLight = unbounded > 0 || (lossPct != null && lossPct > ACCOUNT_RISK_PCT * 2) ? "bad" : lossPct != null && lossPct > ACCOUNT_RISK_PCT ? "warn" : "good";
  const headline = !views.length
    ? "这个账户现在没有持仓。"
    : stopLight === "bad"
      ? `${unguarded.length + noStop.length} 笔仓位没有完整的止损保护，先处理它们。`
      : ratioLight === "bad"
        ? "离爆仓很近：立刻减仓或补保证金。"
        : lossLight !== "good"
          ? `所有仓位一起打到止损要亏账户的 ${lossPct!.toFixed(1)}%，仓位偏重。`
          : "止损都挂好了，账户风险在范围内。";

  const beta = (p: ExPosition) => (p.coin === "BTC" ? 1 : (p.coin && betas[p.coin]) || MARGIN_RULES.defaultBeta);
  const stress = s && s.positions.length ? stressTest(s, beta) : null;
  const netDir = s ? Math.sign(s.positions.reduce((t, p) => t + p.dir * p.qty * p.mark * beta(p), 0)) || 1 : 1;
  const survive = s && s.positions.length ? survivableMove(s, beta, netDir > 0 ? -1 : 1) : null;
  const notional = views.reduce((t, [h, v]) => t + v.pos.qty * (h.ex?.mark ?? v.price ?? v.pos.avg), 0);
  const age = s ? Math.round((now - s.t) / 1000) : null;

  return (
    <section className="card space-y-4 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold">
          {acc.name}
          <span className="text-sm font-normal text-ink-3">
            {s ? ` · ${EXCHANGE_NAME[s.ex]} · ${s.posMode === "hedge" ? "双向持仓" : "单向持仓"}` : " · 手动填写"}
          </span>
        </h2>
        {age != null && <span className={`text-xs ${age > 90 ? "text-warn" : "text-ink-3"}`}>交易所数据 {age < 5 ? "刚刚" : `${age} 秒前`}更新{age > 90 ? "，可能已过时" : ""}</span>}
      </div>

      <p className="text-[15px] font-semibold">{headline}</p>

      {alertOff && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg bg-warn-soft px-3 py-2 text-sm">
          <span>邮件提醒还没打开：没挂止损、快到止损、离强平太近时不会通知你。</span>
          <button className="rounded-lg bg-ink px-3 py-1 text-xs text-bg" onClick={onEnableAlert}>打开提醒</button>
        </div>
      )}

      <div className="grid gap-2.5 sm:grid-cols-3">
        <Light tone={stopLight} k="止损单" v={stopLight === "good" ? (views.length ? "全部挂好" : "—") : `${unguarded.length + noStop.length} 笔有问题`} sub={unguarded.map(([h, v]) => `${h.coin}${h.dir > 0 ? "多" : "空"}：${v.guard!.title}`).concat(noStop.map(([h]) => `${h.coin}：没填止损`)).join("；") || "交易所上的止损单覆盖了每一笔仓位"} />
        <Light tone={ratioLight} k={<Term k="爆仓安全倍数" />} v={ratio != null ? `${ratio.toFixed(1)} 倍` : "—"} sub={ratio != null ? `降到 1 倍强平；${MARGIN_RULES.ratioWarn} 倍以下要小心` : s ? "没有占用维持保证金" : "接入交易所后显示"} />
        <Light tone={lossLight} k="全部打到止损" v={lossPct != null ? `亏 ${Math.round(loss).toLocaleString("en-US")}（${lossPct.toFixed(1)}%）` : "—"} sub={unbounded ? `另有 ${unbounded} 笔全仓没止损：亏损没有上限，直到账户强平` : `超过权益的 ${ACCOUNT_RISK_PCT}% 就偏重；没被止损单覆盖的部分按打到强平算`} />
      </div>

      {urgent && (
        <div className={`rounded-lg px-4 py-3 ${TONE_BG[urgent[1].status!.tone]}`}>
          <div className="font-semibold">最先处理：{urgent[0].coin} {urgent[0].dir > 0 ? "多单" : "空单"}（{urgent[0].mode === "isolated" ? "逐仓" : "全仓"}）· {urgent[1].status!.title}</div>
          <div className="text-sm text-ink-2">{urgent[1].status!.detail}</div>
        </div>
      )}

      {s && (
        <div className="grid grid-cols-2 gap-2.5 rounded-lg bg-panel-2 p-3 text-sm sm:grid-cols-5">
          <Stat k="USDT 权益" v={usd(s.equity)} />
          <Stat k="可用于开仓" v={usd(s.available)} />
          <Stat k="挂单占用" v={usd(s.frozen)} />
          <Stat k="浮动盈亏" v={<span className={s.upl >= 0 ? "text-up" : "text-down"}>{money(s.upl)}</span>} />
          <Stat k="仓位总价值 / 权益" v={equity > 0 ? `${(notional / equity).toFixed(1)} 倍` : "—"} sub="只作参考，不限制加仓" />
        </div>
      )}

      {stress && (
        <details className="text-sm">
          <summary className="cursor-pointer text-ink-2">
            压力测试：账户能扛住 BTC {netDir > 0 ? "跌" : "涨"} <b className={survive != null && survive < MARGIN_RULES.survive ? "text-down" : "text-up"}>{survive != null ? (survive >= 0.9 ? "90% 以上" : `${(survive * 100).toFixed(1)}%`) : "—"}</b> 不出现强平
            {survive != null && survive < MARGIN_RULES.survive && <span className="text-down">（不到 {MARGIN_RULES.survive * 100}%，仓位偏重）</span>}
          </summary>
          <div className="mt-2 overflow-x-auto">
            <table className="num w-full min-w-[520px] text-sm">
              <thead className="text-xs text-ink-3">
                <tr>
                  <th className="py-1 text-left font-normal">BTC 涨跌</th>
                  <th className="py-1 text-right font-normal">之后权益</th>
                  <th className="py-1 text-right font-normal">爆仓安全倍数</th>
                  <th className="py-1 text-left font-normal pl-3">被强平</th>
                </tr>
              </thead>
              <tbody>
                {stress.map((r) => (
                  <tr key={r.shock} className="border-t border-line">
                    <td className="py-1">{r.shock > 0 ? "+" : ""}{(r.shock * 100).toFixed(0)}%</td>
                    <td className={`py-1 text-right ${r.equity < s!.equity ? "text-down" : "text-up"}`}>{usd(r.equity)}</td>
                    <td className="py-1 text-right">{r.ratio != null ? `${r.ratio.toFixed(1)} 倍` : "—"}</td>
                    <td className="py-1 pl-3 text-down">{r.wiped ? "全仓全部强平" : r.liquidated.map((k) => k.split("|")[0]).join("、")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-1 text-[11px] leading-relaxed text-ink-3">
              其他币按过去 90 天日线相对 BTC 的联动倍数（β）一起动：{Object.entries(betas).filter(([c]) => c !== "BTC" && views.some(([h]) => h.coin === c)).map(([c, b]) => `${c} ${b}`).join("、") || "—"}；不在本站币种里的按 {MARGIN_RULES.defaultBeta} 倍。逐仓最多亏掉自己的保证金；全仓权益跌到维持保证金时整个全仓一起强平。只是推演，以交易所为准。
            </p>
          </div>
        </details>
      )}

      <AccountSettings acc={acc} onChange={onChange} onRemove={onRemove} />
    </section>
  );
}

function Light({ tone, k, v, sub }: { tone: "good" | "warn" | "bad" | "wait"; k: React.ReactNode; v: React.ReactNode; sub: string }) {
  const dot = tone === "good" ? "bg-up" : tone === "warn" ? "bg-warn" : tone === "bad" ? "bg-down" : "bg-ink-3";
  return (
    <div className="min-w-0 rounded-lg border border-line px-3 py-2">
      <div className="flex items-center gap-1.5 text-xs text-ink-3"><i className={`inline-block h-2 w-2 rounded-full ${dot}`} />{k}</div>
      <div className="num text-[17px] font-semibold">{v}</div>
      <div className="text-[11px] leading-snug text-ink-3">{sub}</div>
    </div>
  );
}

function Stat({ k, v, sub }: { k: string; v: React.ReactNode; sub?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-ink-3">{k}</div>
      <div className="num truncate font-semibold">{v}</div>
      {sub && <div className="text-[11px] text-ink-3">{sub}</div>}
    </div>
  );
}

const usd = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: 2 });

/** Risk per trade, the budget after an add and the fee; for a hand-entered account also its name and total. */
function AccountSettings({ acc, onChange, onRemove }: { acc: Account; onChange: (p: Partial<Account>) => void; onRemove: (() => void) | null }) {
  const [confirm, setConfirm] = useState(false);
  const manual = !acc.exchange;
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-ink-2">账户设置：每笔风险 {acc.riskPct}%{acc.budget === "even" ? " · 保本滚仓" : ""} · 手续费 {+(acc.fee * 100).toFixed(4)}%</summary>
      <div className="mt-2 grid grid-cols-2 gap-3 text-xs text-ink-3 sm:grid-cols-5">
        {manual && (
          <>
            <label className="space-y-1">
              <span>账户名</span>
              <input id="acc-name" className={field} value={acc.name} onChange={(e) => onChange({ name: e.target.value })} />
            </label>
            <label className="space-y-1">
              <span>账户总金额 (USDT)</span>
              <input id="acc-total" type="number" className={field} value={acc.total || ""} onChange={(e) => onChange({ total: +e.target.value })} />
            </label>
          </>
        )}
        <label className="space-y-1">
          <span>每笔风险（打到止损最多亏权益的）</span>
          <select id="acc-risk" className={field} value={acc.riskPct} onChange={(e) => onChange({ riskPct: +e.target.value })}>
            <option value={1}>保守 1%</option>
            <option value={2}>标准 2%</option>
            <option value={3}>积极 3%</option>
          </select>
        </label>
        <label className="space-y-1">
          <span>加仓后打到止损</span>
          <select id="acc-budget" className={field} value={acc.budget} onChange={(e) => onChange({ budget: e.target.value as Account["budget"] })}>
            <option value="keep">最多亏每笔风险</option>
            <option value="even">必须不亏（保本滚仓）</option>
          </select>
        </label>
        <label className="space-y-1">
          <span>手续费（吃单）%</span>
          <input id="acc-fee" type="number" step="0.01" className={field} value={+(acc.fee * 100).toFixed(4)} onChange={(e) => onChange({ fee: Math.max(0, +e.target.value) / 100 })} />
        </label>
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-ink-3">
        “每笔风险”决定加仓上限：加完整笔打到止损最多亏权益的这个百分比（保本滚仓则必须不亏）。{manual ? "手动账户的总金额是你填的，强平按维持保证金率 0.5% 估算。" : "权益、可用保证金、杠杆、强平价都用交易所的数字。"}
      </p>
      {onRemove && (
        <div className="mt-2 text-xs">
          {confirm ? (
            <span className="space-x-3">
              <span className="text-down">删除“{acc.name}”和下面所有持仓？</span>
              <button className="text-down underline" onClick={() => (onRemove(), setConfirm(false))}>删除</button>
              <button className="text-ink-3" onClick={() => setConfirm(false)}>取消</button>
            </span>
          ) : (
            <button className="text-ink-3" onClick={() => setConfirm(true)}>删除这个账户</button>
          )}
        </div>
      )}
    </details>
  );
}
