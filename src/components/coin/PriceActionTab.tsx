"use client";

import { useEffect, useMemo, useState } from "react";
import type { PaChecklist, PaLevelRow, PaNextLevel, PaResearchItem, PaSetupView, PaTf, PaView } from "@/lib/pa";
import { PA_RULES, PATTERN_NAME, TREND_NAME } from "@/lib/ta/patterns";
import { MMR, sizePosition } from "@/lib/ta/plan";
import { TF_SECONDS, type Timeframe } from "@/lib/types";
import { PriceChart, type MarkerSpec, type PriceLineSpec } from "../PriceChart";
import { Term } from "../Term";
import { track } from "../track";
import type { Mode } from "./CoinView";
import { fmtPrice } from "./format";
import { PATTERN_GUIDE, PatternSketch } from "./pa-ui";
import { fmtR, fmtWhen, readPref, writePref } from "./plan-ui";
import { ReplayContext, useReplay } from "./replay";
import { Section } from "./shared";

/**
 * 裸 K: three steps on one screen — ① the trend (structure), ② the location (support / resistance / middle),
 * ③ a confirming bar at a key level within the last three bars, with the buy point, the stop and the size.
 * Every number and research sentence comes from the server (src/lib/pa.ts). The page never says a pattern works:
 * E20 found none beats random entries with the same stop.
 */

export const PA_TF_LIST: { tf: PaTf; label: string }[] = [
  { tf: "15m", label: "15 分钟" },
  { tf: "1h", label: "1 小时" },
  { tf: "4h", label: "4 小时" },
  { tf: "1d", label: "日线" },
];
const TF_WORD: Record<PaTf, string> = { "15m": "15 分钟", "1h": "1 小时", "4h": "4 小时", "1d": "日线" };

export function PriceActionTab({ v, mode, pf, onPf, onPick }: { v: PaView; mode: Mode; pf: PaTf; onPf: (tf: PaTf) => void; onPick: (tf: Timeframe, t: number) => void }) {
  const main = v.confirm?.[0] ?? null;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-ink-3">裸 K 看哪个周期：</span>
        {PA_TF_LIST.map((x) => (
          <button key={x.tf} onClick={() => onPf(x.tf)} className="chip" data-active={x.tf === pf}>
            {x.label}
          </button>
        ))}
        {v.replay && <span className="rounded-full border border-warn px-2 py-0.5 text-xs text-warn">回放</span>}
        <span className="num ml-auto text-[12px] text-ink-3">
          {v.replay ? "回放时的价格" : "最新价"} <b className="text-[14px] text-ink">{fmtPrice(v.price)}</b> · ATR ≈ {fmtPrice(v.atr)}
        </span>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <StepCard n="①" title="趋势">
          <p className="text-[14px] font-medium leading-snug">{v.trend.sentence}</p>
          {v.trend.detail && <p className="mt-1 text-[12px] leading-relaxed text-ink-3">{v.trend.detail}</p>}
          <p className="mt-1 text-[11px] text-ink-3">
            按<Term k="结构">结构</Term>判断：只看已收盘的 K 线。
          </p>
        </StepCard>
        <StepCard n="②" title="位置">
          <p className={`text-[14px] font-medium leading-snug ${v.location.loc === "mid" ? "text-ink-2" : ""}`}>{v.location.sentence}</p>
          <NearestTwo levels={v.levels} />
        </StepCard>
        <StepCard n="③" title="K 线确认">
          <ConfirmBody v={v} />
        </StepCard>
      </div>
      <ChecklistCard v={v} />
      <p className="rounded-lg bg-panel-2 px-3 py-2 text-[13px] leading-relaxed text-ink">形态不是信号：它的价值是买点和认错位都清楚、仓位好算，不是预测涨跌。</p>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0 space-y-4">
          {main && <SizeCard v={v} x={main} />}
          <PaChart v={v} mode={mode} main={main} onPick={onPick} />
          {mode === "pro" && <RecentCard v={v} />}
        </div>
        <div className="min-w-0 space-y-4">
          <ResearchCard v={v} mode={mode} />
          <GuideCard mode={mode} />
        </div>
      </div>
      {v.replay && <p className="text-right text-[11px] text-ink-3">回放：{fmtWhen(v.end)} 那根 {TF_WORD[v.pf]} K 线收盘时</p>}
    </div>
  );
}

function StepCard({ n, title, children }: { n: string; title: string; children: React.ReactNode }) {
  return (
    <section className="card p-4">
      <div className="mb-1.5 flex items-center gap-1.5 text-xs text-ink-3">
        <span className="text-[15px] font-semibold text-ink">{n}</span>
        <span className="font-medium">{title}</span>
      </div>
      {children}
    </section>
  );
}

function NearestTwo({ levels }: { levels: PaLevelRow[] }) {
  const s = levels.filter((x) => x.side === "support").at(-1);
  const r = levels.find((x) => x.side === "resistance");
  if (!s && !r) return <p className="mt-1 text-[12px] text-ink-3">附近没有找到关键位。</p>;
  return (
    <ul className="num mt-1.5 space-y-0.5 text-[12px] text-ink-2">
      {r && (
        <li>
          上方阻力 <b className="text-ink">{fmtPrice(r.price)}</b> <span className="text-ink-3">{r.name}，{Math.abs(r.distAtr).toFixed(1)} 倍 ATR</span>
        </li>
      )}
      {s && (
        <li>
          下方支撑 <b className="text-ink">{fmtPrice(s.price)}</b> <span className="text-ink-3">{s.name}，{Math.abs(s.distAtr).toFixed(1)} 倍 ATR</span>
        </li>
      )}
    </ul>
  );
}

const dirWord = (d: 1 | -1) => (d > 0 ? "做多" : "做空");

/** The step-3 setup in words: status, buy point, stop, risk. */
function ConfirmBody({ v }: { v: PaView }) {
  const list = v.confirm;
  if (!list) return <p className="text-[14px] font-medium leading-snug text-ink-2">还没有确认 K 线，等。</p>;
  const x = list[0];
  const long = x.dir > 0;
  const sec = TF_SECONDS[v.pf];
  const clash = (v.location.loc === "support" && !long) || (v.location.loc === "resistance" && long);
  return (
    <div className="text-[13px] leading-relaxed">
      <p className="text-[14px] font-medium leading-snug">
        {x.name} · {dirWord(x.dir)}
        <span className="ml-1 text-[12px] font-normal text-ink-3">（关键位，{TREND_NAME[x.trend]}）</span>
      </p>
      {x.status === "entered" ? (
        <p className="text-ink-2">
          已确认：{fmtWhen(x.eT! + sec)} 收盘{long ? "站上" : "跌破"} <span className="num">{fmtPrice(x.trigger)}</span>，买点 <b className="num text-ink">{fmtPrice(x.entry)}</b>
          {x.barsAgo ? <span className="text-ink-3">（{x.barsAgo} 根之前）</span> : <span className="text-ink-3">（最近一根）</span>}
        </p>
      ) : (
        <p className="text-ink-2">
          等确认：收盘{long ? "高于" : "低于"} <b className="num text-ink">{fmtPrice(x.trigger)}</b> 才算{long ? "买点" : "卖点"}；没收过去就不做。
        </p>
      )}
      <p className="text-ink-2">
        止损 <b className="num text-ink">{fmtPrice(x.stop)}</b>
        <span className="text-ink-3">
          （形态{long ? "最低" : "最高"}点 {fmtPrice(x.extreme)} 之外留 {v.buf.toFixed(2)} 倍 ATR 扫损缓冲，风险 {x.riskAtr.toFixed(1)} 倍 ATR）
        </span>
      </p>
      {!x.ok && (
        <p className="text-warn">
          止损距离 {x.riskAtr.toFixed(1)} 倍 ATR，不在 {PA_RULES.minRiskAtr}–{PA_RULES.maxRiskAtr} 倍之间，按规则不做。
        </p>
      )}
      {clash && <p className="text-[12px] text-warn">注意：收盘已在{v.location.loc === "support" ? "支撑区" : "阻力区"}，{dirWord(x.dir)}离{v.location.loc === "support" ? "支撑" : "阻力"}不到 {PA_RULES.keyAtr} 倍 ATR。</p>}
      {list.length > 1 && <p className="mt-1 text-[12px] text-ink-3">另外还有 {list.length - 1} 个：{list.slice(1).map((y) => `${y.name}${dirWord(y.dir)}（${y.status === "entered" ? "已确认" : "等确认"}）`).join("、")}。</p>}
    </div>
  );
}

// ---------------------------------------------------------------- entry checklist (filled in by the server, not clickable)

function ChecklistCard({ v }: { v: PaView }) {
  const lists = v.checklists ?? [];
  if (!lists.length) return null;
  const setups = v.confirm ?? [];
  const [first, ...rest] = lists;
  return (
    <Section
      title={<>入场检查表 <span className="text-xs font-normal text-ink-3">（按页面数据自动判断）</span></>}
      extra={<span className="num text-[13px] font-semibold">{first.score}/5</span>}
    >
      {setups[0] && <p className="mb-1 text-[12px] text-ink-3">{setups[0].name} · {dirWord(setups[0].dir)}</p>}
      <ul className="space-y-1 text-[13px] leading-relaxed">
        {first.items.map((it, k) => (
          <li key={it.key} className="flex gap-2">
            <span className={`w-4 shrink-0 text-center font-semibold ${it.ok ? "text-up" : "text-down"}`}>{it.ok ? "✓" : "✗"}</span>
            <span className="min-w-0">
              <span className="text-ink-3">{"①②③④⑤"[k]} </span>
              {it.label}
              <span className="text-ink-3">：{it.detail}</span>
            </span>
          </li>
        ))}
      </ul>
      {v.nextLevels?.[0] && <NextLevelLine x={v.nextLevels[0]} />}
      {rest.length > 0 && (
        <ul className="mt-2 space-y-1 border-t border-line pt-2 text-[12px] leading-relaxed text-ink-2">
          {rest.map((cl, k) => {
            const x = setups[k + 1];
            const miss = cl.items.filter((it) => !it.ok);
            return (
              <li key={`${cl.kind}${cl.dir}${k}`}>
                <b className="num text-ink">{cl.score}/5</b> {x ? `${x.name} · ${dirWord(x.dir)}` : ""}
                {miss.length > 0 && <span className="text-ink-3">（未满足：{miss.map((it) => `${it.label}——${it.detail}`).join("；")}）</span>}
                {v.nextLevels?.[k + 1] && <span className="block text-ink-3">{v.nextLevels[k + 1].text}</span>}
              </li>
            );
          })}
        </ul>
      )}
      <p className="mt-2 text-[12px] leading-relaxed text-ink-3">{first.footer}</p>
    </Section>
  );
}

function NextLevelLine({ x }: { x: PaNextLevel }) {
  return (
    <div className="mt-2 rounded-md bg-panel-2 px-2.5 py-1.5 text-[12px] leading-relaxed">
      <div className="font-medium text-ink">离下一个关键位{x.r != null ? ` 约 ${x.r.toFixed(1)}R` : ""}（只作参考）</div>
      <p className="text-ink-2">{x.text}</p>
    </div>
  );
}

// ---------------------------------------------------------------- sizing

function SizeCard({ v, x }: { v: PaView; x: PaSetupView }) {
  const long = x.dir > 0;
  // an entered setup is sized at the latest price; a waiting one at its trigger
  const entry = x.status === "entered" ? v.price : x.trigger;
  const [capital, setCapital] = useState(1000);
  const [riskPct, setRiskPct] = useState(1);
  const [lev, setLev] = useState(5);
  useEffect(() => {
    setCapital(readPref("capital", 1000));
    setRiskPct(readPref("risk", 1));
    setLev(readPref("lev", 5));
  }, []);
  const r = sizePosition({ capital, riskPct, entry, stop: x.stop, leverage: lev });
  const valid = capital > 0 && riskPct > 0 && (long ? x.stop < entry : x.stop > entry);
  const loss = (capital * riskPct) / 100;
  const field = "num w-full rounded-lg border border-line bg-panel-2 px-2 py-1.5 text-sm outline-none focus:border-accent";
  const set = (f: (n: number) => void, key: "capital" | "risk" | "lev") => (e: React.ChangeEvent<HTMLInputElement>) => {
    const n = +e.target.value;
    f(n);
    writePref(key, n);
    track("use_calc", "calc");
    track("defense_done", "defense");
  };
  return (
    <Section title={<>按止损算仓位 <span className="text-xs font-normal text-ink-3">（<Term k="仓位">先定亏多少，再算仓位</Term>）</span></>}>
      <div className="grid grid-cols-3 gap-2 text-xs text-ink-3">
        <label className="space-y-1">
          <span>总资金 (USDT)</span>
          <input type="number" className={field} value={capital} min={0} onChange={set(setCapital, "capital")} />
        </label>
        <label className="space-y-1">
          <span>每笔最多亏 (%)</span>
          <input type="number" className={field} value={riskPct} min={0.1} max={10} step={0.5} onChange={set(setRiskPct, "risk")} />
        </label>
        <label className="space-y-1">
          <span>杠杆（逐仓）</span>
          <input type="number" className={field} value={lev} min={1} max={125} onChange={set(setLev, "lev")} />
        </label>
      </div>
      <div className="mt-2 space-y-0.5 text-[13px] leading-relaxed">
        {!valid ? (
          <span className="text-ink-3">{long ? "价格已经在止损之下，这个形态已经作废。" : "价格已经在止损之上，这个形态已经作废。"}</span>
        ) : (
          <>
            <div>
              {x.status === "entered" ? `按${v.replay ? "当时" : "最新"}价` : "按买点"} {fmtPrice(entry)} {long ? "开多" : "开空"}，止损 {fmtPrice(x.stop)}：仓位价值{" "}
              <b className="num">{r.notional.toLocaleString("en-US", { maximumFractionDigits: 0 })}</b> USDT
              <span className="text-ink-3">（约 {r.qty.toPrecision(4)} {v.coin}）</span>
            </div>
            <div className="text-ink-2">
              打到止损亏 <b className="num">{loss.toFixed(0)} USDT</b>（1R）；{lev} 倍杠杆占用保证金 <span className="num">{r.margin.toLocaleString("en-US", { maximumFractionDigits: 0 })}</span> USDT
              {r.liq != null && (
                <>
                  ，强平价约 <b className="num">{fmtPrice(r.liq)}</b>
                </>
              )}
              。
            </div>
            {!r.stopBeforeLiq && <div className="text-down">⚠ 强平价在止损之前：还没到止损就会被强平。降低杠杆。</div>}
            {r.margin > capital && <div className="text-down">⚠ 需要的保证金超过总资金：仓位做小，或者确认强平价仍在止损之外。</div>}
            {!x.ok && <div className="text-warn">这个形态的止损距离超出规则范围，按规则不做；这里只是演示怎么算。</div>}
          </>
        )}
      </div>
      <p className="mt-1.5 text-[11px] leading-relaxed text-ink-3">强平价按逐仓、维持保证金率 {MMR * 100}% 粗算，未计手续费和资金费；以交易所显示为准。</p>
    </Section>
  );
}

// ---------------------------------------------------------------- chart

const SHORT: Record<string, string> = { pin: "影线", engulf: "吞没", inside: "孕线", fake2b: "2B", retest: "回踩" };

function PaChart({ v, mode, main, onPick }: { v: PaView; mode: Mode; main: PaSetupView | null; onPick: (tf: Timeframe, t: number) => void }) {
  const outer = useReplay();
  const last = v.candles[v.candles.length - 1];
  const markers = useMemo<MarkerSpec[]>(() => {
    const times = new Set(v.candles.map((c) => c.t));
    return v.recent
      .filter((x) => mode === "pro" || x.loc === "key")
      .map((x): MarkerSpec => {
        const long = x.dir > 0;
        const t = x.eT ?? x.sT;
        const key = x.loc === "key";
        return {
          t,
          position: long ? "belowBar" : "aboveBar",
          color: x.status === "waiting" ? "#7d8896" : key ? (long ? "#16a34a" : "#dc2626") : "#a3acb8",
          text: `${SHORT[x.kind]}${x.status === "waiting" ? "?" : ""}`,
          shape: x.status === "waiting" ? "circle" : long ? "arrowUp" : "arrowDown",
          size: key ? 1 : 0.6,
        };
      })
      .filter((m) => times.has(m.t));
  }, [v, mode]);
  const priceLines = useMemo<PriceLineSpec[]>(() => {
    const out: PriceLineSpec[] = v.levels.map((l) => ({ price: l.price, color: "#7d8896", title: l.name, dashed: true }));
    if (main) {
      out.push({ price: main.stop, color: "#e0a400", title: "止损", dashed: false, width: 2 });
      out.push({ price: main.entry ?? main.trigger, color: "#3987e5", title: main.status === "entered" ? "买点" : "触发价", dashed: false });
    }
    return out;
  }, [v, main]);
  const ctx = useMemo(
    () => ({
      picking: outer?.picking ?? false,
      pick: (t: number) => onPick(v.pf, t),
      asOf: v.replay && last ? last.t : null,
      future: v.replay && last && outer?.asOf === last.t ? outer.future : null,
    }),
    [outer?.picking, outer?.asOf, outer?.future, onPick, v.replay, v.pf, last],
  );
  if (!last) return null;
  return (
    <section className="card p-3">
      <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-xs text-ink-3">
        <span>{TF_WORD[v.pf]} K 线 · {mode === "pro" ? "全部形态（浅色在中间位置）" : "只标关键位上的形态"}</span>
        <span><span className="mr-1 inline-block h-0.5 w-3 bg-ink-3 align-middle" />关键位</span>
        {main && <span><span className="mr-1 inline-block h-0.5 w-3 bg-accent align-middle" />{main.status === "entered" ? "买点" : "触发价"} / <span className="text-warn">止损</span></span>}
        <span>“?”= 还在等确认</span>
      </div>
      <ReplayContext.Provider value={ctx}>
        <PriceChart candles={v.candles} markers={markers} priceLines={priceLines} height={340} initialBars={120} />
      </ReplayContext.Provider>
      {v.replay && ctx.future && <p className="px-1 pt-1 text-[11px] text-ink-3">回放点右边颜色浅的 K 线，是这一刻之后真实发生的走势。</p>}
    </section>
  );
}

// ---------------------------------------------------------------- pro: every recent setup

function RecentCard({ v }: { v: PaView }) {
  const list = [...v.recent].reverse().slice(0, 20);
  const sec = TF_SECONDS[v.pf];
  return (
    <Section title="最近的形态（专业模式）" extra={<span className="text-[11px] text-ink-3">图上 {v.candles.length} 根内</span>}>
      {list.length === 0 ? (
        <p className="text-[13px] text-ink-3">图上这段时间没有形态。</p>
      ) : (
        <div className="-mx-1 overflow-x-auto">
          <table className="num w-full min-w-[520px] text-left text-[12px]">
            <thead className="text-ink-3">
              <tr>
                <th className="px-1 py-1 font-normal">时间</th>
                <th className="px-1 py-1 font-normal">形态</th>
                <th className="px-1 py-1 font-normal">位置</th>
                <th className="px-1 py-1 font-normal">趋势</th>
                <th className="px-1 py-1 font-normal">买点</th>
                <th className="px-1 py-1 font-normal">止损</th>
                <th className="px-1 py-1 font-normal">风险</th>
              </tr>
            </thead>
            <tbody>
              {list.map((x) => (
                <tr key={`${x.kind}${x.dir}${x.startT}`} className="border-t border-line">
                  <td className="px-1 py-1 text-ink-3">{fmtWhen((x.eT ?? x.sT) + sec)}</td>
                  <td className="px-1 py-1">
                    {x.name} · {dirWord(x.dir)}
                    {x.status === "waiting" && <span className="text-ink-3">（等确认）</span>}
                  </td>
                  <td className="px-1 py-1">{x.loc === "key" ? "关键位" : "中间"}</td>
                  <td className="px-1 py-1">{TREND_NAME[x.trend]}</td>
                  <td className="px-1 py-1">{fmtPrice(x.entry ?? x.trigger)}</td>
                  <td className="px-1 py-1">{fmtPrice(x.stop)}</td>
                  <td className={`px-1 py-1 ${x.ok ? "" : "text-warn"}`}>{x.riskAtr.toFixed(1)} ATR{x.ok ? "" : " 不做"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------- research

function ResearchCard({ v, mode }: { v: PaView; mode: Mode }) {
  const res = v.research;
  return (
    <Section title={<>历史上这些形态怎么样 <span className="text-xs font-normal text-ink-3">（{TF_WORD[v.pf]}）</span></>}>
      {!res ? (
        <p className="text-[13px] text-ink-3">{v.researchNote ?? "裸 K 的研究数字会在服务器生成研究报告后显示。"}</p>
      ) : (
        <div className="space-y-2.5">
          <p className="text-[12px] leading-relaxed text-ink-3">
            每种形态都按上面的买点、止损入场，跟着结构<Term k="移动止损">移动认错位</Term>，和同一币种、同方向、同止损距离的随机入场比较，已扣成本。
          </p>
          <ul className="space-y-2 text-[13px] leading-relaxed">
            {res.items.map((it) => (
              <ResearchItem key={it.kind} it={it} pro={mode === "pro"} />
            ))}
          </ul>
          <p className="text-[11px] text-ink-3">研究报告 {new Date(res.createdAt).toLocaleDateString("zh-CN")} 生成。</p>
        </div>
      )}
    </Section>
  );
}

function ResearchItem({ it, pro }: { it: PaResearchItem; pro: boolean }) {
  const row = (label: string, r: PaResearchItem["all"]) =>
    r && (
      <li>
        {label}：{r.n} 笔，对随机 {fmtR(r.edgeR)}；样本外 {fmtR(r.oosEdgeR)}（{r.oosN} 笔）· {r.verdict}
      </li>
    );
  return (
    <li className="rounded-md bg-panel-2 px-2.5 py-1.5">
      <div className="font-medium text-ink">{PATTERN_NAME[it.kind]}</div>
      <p className="text-ink-2">{it.sentence}</p>
      {pro && (
        <ul className="num mt-1 space-y-0.5 text-[12px] text-ink-3">
          {row("全部", it.all)}
          {row(it.textName, it.text)}
          <li>
            先到 2R {it.reach2 != null ? `${it.reach2}%` : "—"} · {6} 根内被扫 {it.quickStopPct != null ? `${it.quickStopPct}%` : "—"}
            {it.setups != null && ` · 形态 ${it.setups} 个，被确认 ${it.triggerPct ?? "—"}%`}
          </li>
        </ul>
      )}
    </li>
  );
}

// ---------------------------------------------------------------- the five patterns

function GuideCard({ mode }: { mode: Mode }) {
  return (
    <section className="card p-4">
      <details open={mode === "pro"}>
        <summary className="cursor-pointer text-[15px] font-semibold">五种形态怎么认</summary>
        <p className="mt-2 text-[12px] leading-relaxed text-ink-3">
          画的是做多的样子，做空上下颠倒。所有判断只看收盘。扫损缓冲是止损留在极点之外的一段距离（<Term k="认错区间">为什么要留</Term>）；止损距离不在 {PA_RULES.minRiskAtr}–{PA_RULES.maxRiskAtr} 倍 ATR 之间的不做。
        </p>
        <ul className="mt-3 space-y-3">
          {PATTERN_GUIDE.map((g) => (
            <li key={g.kind} className="flex gap-3">
              <PatternSketch kind={g.kind} />
              <div className="min-w-0 text-[12px] leading-relaxed">
                <div className="text-[13px] font-medium text-ink">{PATTERN_NAME[g.kind]}</div>
                <p className="text-ink-2">
                  <span className="text-ink-3">何时有效：</span>
                  {g.valid}
                </p>
                <p className="text-ink-2">
                  <span className="text-ink-3">买点：</span>
                  {g.entry}
                </p>
                <p className="text-ink-2">
                  <span className="text-ink-3">止损：</span>
                  {g.stop}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
