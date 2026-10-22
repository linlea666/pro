"use client";

import { useMemo, useState } from "react";

import type { LightSummary } from "@/lib/analysis";
import { TF_LABEL, TF_SECONDS, type Timeframe } from "@/lib/types";
import { PriceChart, type MarkerSpec, type PriceLineSpec } from "../PriceChart";
import { Term } from "../Term";
import { fmtBjTime, fmtPct, fmtPrice, spanAgo } from "./format";
import { Explainer, Section, StatsTable } from "./shared";
import type { TabProps } from "./CoinView";
import { useReplay } from "./replay";
import { TdBriefCard } from "./TdBriefCard";

const UP = "#199e70", DOWN = "#e66767";

export function TdTab({ a, mtf, mode, onTf }: TabProps) {
  const [allNumbers, setAllNumbers] = useState(mode === "pro");
  const cur = a.td.current;

  const markers = useMemo<MarkerSpec[]>(() => {
    return a.td.markers
      .filter((m) => allNumbers || m.final)
      .map((m) => {
        const buy = m.side === "buy";
        const big = m.final;
        return {
          t: m.t,
          position: buy ? "belowBar" : "aboveBar",
          // "buy" side = a run of lower closes: drawn red and pointing down, as a description of what happened
          color: m.kind === "countdown" && !big ? "#e0a400" : buy ? DOWN : UP,
          text: `${m.n}${m.kind === "setup" && m.final && m.perfected ? "★" : ""}`,
          shape: big ? (buy ? "arrowDown" : "arrowUp") : "circle",
          size: big ? 1 : 0.1,
        } satisfies MarkerSpec;
      });
  }, [a, allNumbers]);

  const priceLines = useMemo<PriceLineSpec[]>(() => {
    const out: PriceLineSpec[] = [];
    if (cur.tdstResistance) out.push({ price: cur.tdstResistance, color: DOWN, title: "TDST 阻力" });
    if (cur.tdstSupport) out.push({ price: cur.tdstSupport, color: UP, title: "TDST 支撑" });
    if (cur.lastSignal && !cur.lastSignal.invalidated) out.push({ price: cur.lastSignal.riskLevel, color: "#e0a400", title: "风险位", dashed: false });
    return out;
  }, [cur]);

  const ls = cur.lastSignal;
  const sideText = (s: "buy" | "sell") => (s === "buy" ? "跌势" : "涨势");
  const nowText = cur.setupSide
    ? cur.setupCount >= 9
      ? `${cur.setupSide === "buy" ? "下跌" : "上涨"}计数已经走完 9（目前第 ${cur.setupCount} 根），趋势仍在延续。`
      : `${cur.setupSide === "buy" ? "连续下跌" : "连续上涨"}计数 ${cur.setupCount}/9。下一根 K 线收盘${cur.setupSide === "buy" ? "低于" : "高于"} ${fmtPrice(cur.nextCloseNeeded)} 才能继续计数，否则计数中断。`
    : "当前没有在计数。";

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
      <div className="min-w-0 space-y-4">
        <TdBriefCard a={a} mtf={mtf} mode={mode} />
        <section className="card p-3">
          <div className="mb-1 flex flex-wrap items-center gap-3 px-1 text-xs text-ink-3">
            <span>红色↓9 = 跌势 9（连跌满 9 根）· 绿色↑9 = 涨势 9（连涨满 9 根）· ★ = 完美 9 · 13 = 衰竭计数数满</span>
            <label className="ml-auto flex cursor-pointer items-center gap-1.5">
              <input type="checkbox" checked={allNumbers} onChange={(e) => setAllNumbers(e.target.checked)} />
              显示全部计数
            </label>
          </div>
          <PriceChart candles={a.candles} markers={markers} priceLines={priceLines} height={440} initialBars={140} />
        </section>
        <Explainer title="3 分钟看懂 TD 序列" defaultOpen={mode === "beginner"}>
          <p>
            <b className="text-ink">核心思想：</b>任何一段涨势或跌势都会“累”。<Term k="TD序列">TD 序列</Term>通过数 K 线来判断它什么时候可能累了。
          </p>
          <p>
            <b className="text-ink">第一步 · 数到 9：</b>如果连续 9 根 K 线的收盘价都比 4 根前低，就出现<Term k="Setup9">跌势 9</Term>，意思是“已经连跌了 9 根”；反过来连涨 9 根就是涨势 9。DeMark 原名叫“买入 Setup / 卖出 Setup”，但它描述的是已经发生的涨跌，不是叫你买或卖。
          </p>
          <p>
            <b className="text-ink">第二步 · 数到 13：</b>出现 9 之后，系统继续数“特别弱（或特别强）”的 K 线，数满 13 根就是<Term k="Countdown13">13</Term>，意思是“这一轮走得很久了”。
          </p>
          <p>
            <b className="text-ink">怎么用：</b>9 和 13 只告诉你一段涨跌走了多久，研究里它们都不能预测接下来是涨是跌。跌势信号之后收盘跌破图上的黄色<Term k="RiskLevel">风险位</Term>（涨势信号之后收盘突破），说明原来的走势还在继续。
          </p>
          <p>
            <b className="text-ink">新手最常犯的错：</b>把小周期（15 分钟）的跌势 9 当成买点去抄底，结果大周期还在下跌。先看日线和 4 小时的方向，再用小周期找时机。
          </p>
        </Explainer>
      </div>

      <div className="space-y-4">
        <TdMtfTable mtf={mtf} current={a.tf} onTf={onTf} pro={mode === "pro"} />
        <Section title={`现在的状态 · ${TF_LABEL[a.tf]}`}>
          <p className="text-[13px] leading-relaxed">{nowText}</p>
          <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
            <Stat label={<Term k="Setup9">下跌计数（买入 Setup）</Term>} value={`${cur.setupSide === "buy" ? Math.min(cur.setupCount, 9) : 0} / 9`} />
            <Stat label={<Term k="Setup9">上涨计数（卖出 Setup）</Term>} value={`${cur.setupSide === "sell" ? Math.min(cur.setupCount, 9) : 0} / 9`} />
            <Stat label={<Term k="Countdown13">13 计数进度</Term>} value={cur.countdown ? `${sideText(cur.countdown.side)} ${cur.countdown.count} / 13` : "未开始"} />
            <Stat label={<Term k="TDST">TDST</Term>} value={cur.tdstResistance ? `阻力 ${fmtPrice(cur.tdstResistance)}` : "—"} sub={cur.tdstSupport ? `支撑 ${fmtPrice(cur.tdstSupport)}` : undefined} />
          </div>
        </Section>

        <Section title="上一个信号复盘">
          {ls ? (
            <div className="text-[13px] leading-relaxed">
              <p>
                <b style={{ color: ls.side === "buy" ? "var(--down)" : "var(--up)" }}>
                  {ls.side === "buy" ? "↓" : "↑"} {sideText(ls.side)} {ls.kind === "setup9" ? "9" : "13"}
                </b>{" "}
                出现在 {ls.barsAgo} 根 K 线前，价格 {fmtPrice(ls.price)}。
              </p>
              <p className="mt-1 text-ink-2">
                之后价格 {fmtPct(ls.changePct)}（<Term k="RiskLevel">风险位</Term>是这个信号的认错线），
                {ls.invalidated
                  ? `收盘已${ls.side === "buy" ? "跌破" : "突破"}风险位 ${fmtPrice(ls.riskLevel)}，原来的${ls.side === "buy" ? "跌势" : "涨势"}还在继续，这个信号失败了。`
                  : `风险位 ${fmtPrice(ls.riskLevel)} 还没被收盘越过。`}
              </p>
            </div>
          ) : (
            <p className="text-[13px] text-ink-3">最近没有完整的 9 或 13 信号。</p>
          )}
        </Section>

        <Section title="以前灵不灵？">
          <StatsTable stats={a.stats} horizonText={a.horizonText} coin={a.coin} tf={a.tf} only={["td_buy9", "td_buy13", "td_sell9", "td_sell13"]} />
        </Section>
      </div>
    </div>
  );
}

/** One block per timeframe: the latest 9 and its countdown, the setup being counted now, and TDST. Describes only. */
function TdMtfTable({ mtf, current, onTf, pro }: { mtf: LightSummary[] | null; current: Timeframe; onTf: (t: Timeframe) => void; pro: boolean }) {
  const replay = useReplay();
  return (
    <Section title="多周期 TD 计数">
      {replay?.asOf ? (
        <p className="text-xs leading-relaxed text-ink-3">回放模式下只计算当前周期在那个时刻的状态，多周期计数暂不显示。</p>
      ) : !mtf ? (
        <div className="h-40 animate-pulse rounded-lg bg-panel-2" />
      ) : (
        <>
          <ul className="divide-y divide-line text-[13px]">
            {/* big to small: the larger timeframe is the background for the smaller ones */}
            {[...mtf].reverse().map((m) => (
              <TdRow key={m.tf} m={m} active={m.tf === current} onTf={onTf} pro={pro} />
            ))}
          </ul>
          <p className="mt-2 text-[11px] leading-relaxed text-ink-3">
            从大周期排到小周期。跌势 / 涨势只描述已经连跌或连涨了多久，不是买卖建议。每行左边是这一行所用 K 线的收盘时刻（北京时间），最小的周期一收盘就自动更新。这里只描述每个周期数到了哪里；几个周期同时数到 9 或 13 是否更灵，还没有研究数字，单个信号以前灵不灵见下方统计。点击周期可切换。
          </p>
        </>
      )}
    </Section>
  );
}

function TdRow({ m, active, onTf, pro }: { m: LightSummary; active: boolean; onTf: (t: Timeframe) => void; pro: boolean }) {
  const d = m.tdDetail;
  const sec = TF_SECONDS[m.tf];
  const n = d.nine;
  const sideColor = (s: "buy" | "sell") => (s === "buy" ? "var(--down)" : "var(--up)");
  const counting = d.setupSide && d.setupCount < d.setupLength;
  const tdst = (p: number | null) => (p == null ? null : `${fmtPrice(p)}（${fmtPct(((p - m.close) / m.close) * 100, 1)}）`);
  return (
    <li className="py-2.5">
      <div className="flex gap-3">
        <button onClick={() => onTf(m.tf)} className={`w-14 shrink-0 text-left ${active ? "font-semibold text-ink" : "text-ink-2 hover:text-ink"}`}>
          {TF_LABEL[m.tf]}
          <span className="num mt-0.5 block text-[10px] font-normal leading-tight text-ink-3" title="这一行按这一刻收盘的 K 线计算（北京时间）">
            截至 {fmtBjTime(m.closeAt).slice(6)}
            {m.tf === "1d" || m.tf === "1w" ? <span className="block">{fmtBjTime(m.closeAt).slice(0, 5)}</span> : null}
          </span>
        </button>
        <div className="min-w-0 flex-1 space-y-1">
          {n ? (
            <>
              <div>
                <b style={{ color: sideColor(n.side) }}>
                  {n.side === "buy" ? "↓ 跌势 9" : "↑ 涨势 9"}
                  {n.perfected ? "★" : ""}
                </b>
                <span className="text-ink-2">
                  {" "}
                  （{n.side === "buy" ? "连跌" : "连涨"}满 9 根）· {spanAgo(n.barsAgo * sec)}
                </span>
                {pro && <span className="text-[11px] text-ink-3"> · DeMark 原名{n.side === "buy" ? "买入" : "卖出"} Setup</span>}
              </div>
              {n.thirteen ? (
                <div className="text-xs">
                  <span style={{ color: n.thirteen.invalidated ? "var(--text-3)" : sideColor(n.side) }}>13 已出现 · {spanAgo(n.thirteen.barsAgo * sec)}</span>
                  {n.thirteen.invalidated ? (
                    <span className="text-ink-2">
                      {" "}
                      · 收盘已{n.side === "buy" ? "跌破" : "突破"}风险位 {fmtPrice(n.thirteen.riskLevel)}，这个 13 失败了
                    </span>
                  ) : (
                    <span className="text-ink-3"> · 风险位 {fmtPrice(n.thirteen.riskLevel)} 还没被收盘越过</span>
                  )}
                </div>
              ) : n.countdown != null ? (
                <CountdownBar count={n.countdown} length={d.countdownLength} color={sideColor(n.side)} />
              ) : (
                <div className="text-xs text-ink-3">13 计数已取消（收盘越过 TDST，或出现了反向的 9）</div>
              )}
            </>
          ) : (
            <div className="text-ink-3">最近没有完整的 9</div>
          )}
          {counting && (
            <div className="text-xs text-ink-2">
              {d.setupSide === "buy" ? "连跌" : "连涨"}计数 <span className="num">{d.setupCount}/{d.setupLength}</span>
              {d.nextCloseNeeded != null && (
                <>
                  {" "}
                  · 下一根收盘{d.setupSide === "buy" ? "低于" : "高于"} <span className="num">{fmtPrice(d.nextCloseNeeded)}</span> 才继续
                </>
              )}
            </div>
          )}
          {(d.tdstResistance != null || d.tdstSupport != null) && (
            <div className="num text-[11px] text-ink-3">
              {d.tdstResistance != null && <>TDST 阻力 {tdst(d.tdstResistance)}</>}
              {d.tdstResistance != null && d.tdstSupport != null && " · "}
              {d.tdstSupport != null && <>TDST 支撑 {tdst(d.tdstSupport)}</>}
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

function CountdownBar({ count, length, color }: { count: number; length: number; color: string }) {
  return (
    <div className="flex items-center gap-2 text-xs text-ink-2">
      <span className="flex gap-px">
        {Array.from({ length }, (_, i) => (
          <span key={i} className="h-2.5 w-1.5 rounded-[1px]" style={{ background: i < count ? color : "var(--panel-2)", border: "1px solid var(--border)" }} />
        ))}
      </span>
      <span className="num">13 计数 {count}/{length}</span>
    </div>
  );
}

function Stat({ label, value, sub }: { label: React.ReactNode; value: string; sub?: string }) {
  return (
    <div className="rounded-lg bg-panel-2 p-2.5">
      <div className="text-ink-3">{label}</div>
      <div className="num mt-0.5 text-sm font-medium">{value}</div>
      {sub && <div className="num text-ink-2">{sub}</div>}
    </div>
  );
}
