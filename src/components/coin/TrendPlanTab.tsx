"use client";

import { useEffect, useMemo, useState } from "react";
import type { DefendOutcome, Framework, PlanOutcome, StopResult, TrendPlan } from "@/lib/trendplan";
import { MMR, sizePosition, type DefendPlan, type SidePlan, type StopOption } from "@/lib/ta/plan";
import { TF_LABEL, TF_SECONDS, type Timeframe } from "@/lib/types";
import { PriceChart, type MarkerSpec, type PriceLineSpec, type Segment } from "../PriceChart";
import { Term } from "../Term";
import { track } from "../track";
import type { Mode } from "./CoinView";
import { fmtPrice } from "./format";
import { closedBars, fmtR, fmtWhen, levelState, readPref, writePref } from "./plan-ui";
import { PositionCheck } from "./PositionCheck";
import { ReplayContext, useReplay } from "./replay";
import { Section } from "./shared";
import { BreachBadge, TrendMap } from "./TrendMap";
import { BigTrendCard } from "./BigTrendCard";

const ALIGN: Record<SidePlan["alignment"], { text: string; color: string }> = {
  with: { text: "顺大周期", color: "var(--up)" },
  against: { text: "逆大周期", color: "var(--warn)" },
  neutral: { text: "大周期不明", color: "var(--text-3)" },
};
const STATUS: Record<SidePlan["status"], string> = { active: "已触发", watch: "等待触发", none: "观望" };
const SWING_COLOR: Record<string, string> = { HH: "var(--up)", HL: "var(--up)", LH: "var(--down)", LL: "var(--down)" };

/** Which plan the chart, the ladder and the calculator use: a side, its plan or the defended level, and which stop. */
interface Pick {
  side: "long" | "short";
  plan: "main" | "defend";
  stop: "far" | "near";
}

/** The chosen plan reduced to what the chart, the ladder and the calculator need. */
interface Chosen {
  side: "long" | "short";
  plan: "main" | "defend";
  word: string;
  status: SidePlan["status"];
  entry: number | null;
  zone: [number, number] | null;
  far: number | null;
  /** the far stop's zone (main plans) */
  farZone: [number, number] | null;
  near: StopOption | null;
  /** the stop in use */
  stop: number | null;
  size: "full" | "half";
  /** identifies the plan, so the calculator re-seeds when it changes */
  id: string;
}

function chosenOf(p: TrendPlan, pick: Pick): Chosen {
  const s = p[pick.side];
  const word = pick.side === "long" ? "做多" : "做空";
  const d = pick.plan === "defend" ? s.defend : null;
  if (d) {
    const stop = pick.stop === "near" && d.near ? d.near.stop : d.far.stop;
    return { side: pick.side, plan: "defend", word: `守位${word}`, status: "active", entry: d.entry, zone: null, far: d.far.stop, farZone: null, near: d.near, stop, size: d.size, id: `defend:${d.entryT}` };
  }
  const far = s.invalidation?.stop ?? null;
  const stop = pick.stop === "near" && s.near ? s.near.stop : far;
  return { side: pick.side, plan: "main", word, status: s.status, entry: s.entry, zone: s.zone, far, farZone: s.invalidation?.zone ?? null, near: s.near, stop, size: s.size, id: `main:${s.kind}:${s.entryT ?? ""}:${far ?? ""}` };
}

/** The page's own rule: of the two plans, look first at the one already triggered, then the one with the higher timeframe. */
const defaultSide = (p: TrendPlan): "long" | "short" =>
  p.short.status === "active" && p.long.status !== "active" ? "short" : p.long.status !== "active" && p.short.alignment === "with" && p.short.status !== "none" ? "short" : "long";

export function TrendPlanTab({ p, mode, fw, onFw, onPick }: { p: TrendPlan; mode: Mode; fw: Framework; onFw: (f: Framework) => void; onPick: (tf: Timeframe, t: number) => void }) {
  const [pick, setPick] = useState<Pick>(() => ({ side: defaultSide(p), plan: "main", stop: "far" }));
  useEffect(() => setPick({ side: defaultSide(p), plan: "main", stop: "far" }), [p.coin, p.framework, p.lastClosedT]); // eslint-disable-line react-hooks/exhaustive-deps
  const side = pick.side;
  // a defended level can disappear on the next update: fall back to the side's plan
  const ch = chosenOf(p, pick.plan === "defend" && !p[side].defend ? { ...pick, plan: "main" } : pick);

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
      <div className="min-w-0 space-y-4">
        {mode === "pro" && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-ink-3">
            <span>交易节奏：</span>
            {(["4h", "1d"] as Framework[]).map((f) => (
              <button key={f} className="chip" data-active={fw === f} onClick={() => onFw(f)}>
                {f === "4h" ? "日线定方向 · 4 小时入场" : "周线定方向 · 日线入场"}
              </button>
            ))}
          </div>
        )}
        <BigTrendCard big={p.big} />
        <TrendMap p={p} mode={mode} />
        <PlanChart p={p} ch={ch} onPick={onPick} />
        <div className="grid gap-4 md:grid-cols-2">
          {(["long", "short"] as const).map((k) => (
            <PlanCard
              key={k}
              p={p}
              s={p[k]}
              mode={mode}
              chosen={side === k ? ch.plan : null}
              onSelect={(plan) => setPick({ side: k, plan, stop: "far" })}
              outcome={p.replay?.[k] ?? null}
              defendOutcome={p.replay?.defend[k] ?? null}
            />
          ))}
        </div>
        <p className="px-1 text-[12px] leading-relaxed text-ink-3">
          说明：研究报告里，这几种入场规则都没有证明比同方向、同止损距离的随机入场更好。计划能帮你的是认错位放在哪、仓位多大、怎么拿住和何时离场，不是预测涨跌。所有数字已扣 {p.costPct}% 的往返成本，样本外是最近 12 个月。
        </p>
      </div>

      <div className="space-y-4">
        <PriceLadder p={p} ch={ch} />
        <PlanCalc p={p} ch={ch} onStop={(stop) => setPick({ ...pick, plan: ch.plan, stop })} />
        {!p.replay && <PositionCheck current={p} />}
        <PlanScorecardCard p={p} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- plan card

function PlanCard({
  p,
  s,
  mode,
  chosen,
  onSelect,
  outcome,
  defendOutcome,
}: {
  p: TrendPlan;
  s: SidePlan;
  mode: Mode;
  /** which of this side's plans the page is using, if this side is chosen */
  chosen: "main" | "defend" | null;
  onSelect: (plan: "main" | "defend") => void;
  outcome: PlanOutcome | null;
  defendOutcome: DefendOutcome | null;
}) {
  const long = s.side === "long";
  const color = long ? "var(--up)" : "var(--down)";
  const a = ALIGN[s.alignment];
  const v = s.invalidation;
  const sec = TF_SECONDS[p.tf];
  const selected = chosen === "main";
  return (
    <section className={`card flex flex-col p-4 ${chosen ? "ring-1 ring-accent" : ""}`}>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="rounded-full px-2 py-0.5 font-medium" style={{ background: long ? "var(--up-soft)" : "var(--down-soft)", color }}>
          {long ? "↑ 做多计划" : "↓ 做空计划"}
        </span>
        <span className="rounded-full border px-2 py-0.5" style={{ color: a.color, borderColor: a.color }}>
          <Term k="顺势逆势">{a.text}</Term>
        </span>
        <span className="text-ink-3">{STATUS[s.status]}</span>
        {s.size === "half" && <span className="rounded-full bg-warn-soft px-2 py-0.5 text-warn">半仓</span>}
      </div>
      <h3 className="mt-2 text-[15px] font-semibold leading-snug">{s.headline}</h3>
      {s.trigger && (
        <p className="mt-1 text-[13px] leading-relaxed text-ink-2">
          {s.trigger}
          {s.status === "active" && s.entryT != null && <span className="text-ink-3">（{fmtWhen(s.entryT + sec)} 收盘）</span>}
        </p>
      )}

      {v && s.entry != null && (
        <dl className="mt-3 space-y-1.5 text-[13px] leading-relaxed">
          <Row k={s.status === "active" ? "入场价" : s.zone ? "等待区间" : "触发价"}>
            {s.zone ? `${fmtPrice(s.zone[0])} – ${fmtPrice(s.zone[1])}` : fmtPrice(s.entry)}
          </Row>
          <Row k={<Term k="认错区间">认错区间</Term>}>
            <span className="num">
              {fmtPrice(v.zone[0])} – {fmtPrice(v.zone[1])}
            </span>
            <span className="text-ink-3">（{long ? "低点" : "高点"} {fmtPrice(v.anchor)} 之外）</span>
            <div className="text-ink-2">
              止损放 <b className="num text-ink">{fmtPrice(v.stop)}</b>，离{s.zone ? "区间中部" : "入场"} {v.distPct}%（{v.distAtr} 倍 ATR）
              {v.noise != null && <>，正常波动 {p.noiseHorizon} 内碰到它的概率约 {v.noise}%</>}
            </div>
          </Row>
          {(s.near || s.nearNote) && (
            <Row k={<Term k="近止损">近止损</Term>}>
              {s.near ? <StopLine o={s.near} p={p} /> : <span className="text-ink-3">{s.nearNote}</span>}
              {s.nearText && <div className="text-[12px] text-ink-3">{s.nearText}</div>}
              {s.near && <div className="text-[12px] text-ink-3">{NEAR_FAR_RULE}</div>}
            </Row>
          )}
          {s.targets.length > 0 && (
            <Row k="沿途关键位">
              {s.targets.map((t) => (
                <span key={t.price} className="mr-2 inline-block">
                  <span className="num">{fmtPrice(t.price)}</span>
                  <span className="text-ink-3">（{fmtR(t.r, 1)}）</span>
                </span>
              ))}
              <div className="text-[12px] text-ink-3">可能停顿的地方，不是止盈位</div>
            </Row>
          )}
          <Row k={<Term k="移动止损">拿住盈利</Term>}>{s.trailing}</Row>
          <Row k="仓位">
            {s.size === "half" ? "半仓（按风险算出的仓位再减半）" : "按风险算出的正常仓位"}
            {s.costR != null && <span className="text-ink-3">；成本（手续费、滑点和持仓期资金费）约 {s.costR.toFixed(2)}R</span>}
          </Row>
        </dl>
      )}

      {s.warnings.length > 0 && (
        <ul className="mt-3 space-y-1 rounded-lg bg-warn-soft px-3 py-2 text-[12px] leading-relaxed text-ink">
          {s.warnings.map((w) => (
            <li key={w}>⚠ {w}</li>
          ))}
        </ul>
      )}

      {s.evidence && (
        <p className="mt-3 text-[12px] leading-relaxed text-ink-3">
          历史同类（{s.evidence.n} 笔）：平均每笔 {fmtR(s.evidence.meanR)}
          {s.evidence.meanR != null && s.evidence.edgeR != null && <>，同方向随机入场 {fmtR(s.evidence.meanR - s.evidence.edgeR)}</>}
          ；最近 12 个月比随机 {fmtR(s.evidence.oosEdgeR)}（{s.evidence.oosN} 笔）。结论：{s.evidence.verdict}
        </p>
      )}

      {outcome && <OutcomeLine o={outcome} sec={sec} />}

      {s.defend ? (
        <DefendBox p={p} d={s.defend} mode={mode} selected={chosen === "defend"} onSelect={() => onSelect("defend")} outcome={defendOutcome} />
      ) : (
        p.framework === "4h" && (
          <p className="mt-3 text-[12px] leading-relaxed text-ink-3">
            守位做法：最近 3 根 {TF_LABEL[p.tf]} K 线没有出现（价格来到之前没被收盘{long ? "跌破的低点" : "突破的高点"}、扫过后收回或留下长影线，再收盘拐{long ? "上" : "下"}时才会出现）。
          </p>
        )
      )}

      {v && (
        <button className="mt-auto pt-3 text-left text-xs text-accent" onClick={() => onSelect("main")}>
          {selected ? "✓ 图、价格梯和仓位计算正在用这份计划" : "用这份计划看图、算仓位 →"}
        </button>
      )}
    </section>
  );
}

const NEAR_FAR_RULE = "止损远近不改变每笔亏多少钱（按风险算仓位都是 1R，滑点和跳空除外），只改变仓位大小和被正常波动扫掉的概率。";

/** A stop with its distance, the chance noise touches it and what costs take from it. */
function StopLine({ o, p }: { o: StopOption; p: TrendPlan }) {
  return (
    <div className="text-ink-2">
      <b className="num text-ink">{fmtPrice(o.stop)}</b>，离入场 {o.distPct}%（{o.distAtr} 倍 ATR）
      {o.noise != null && <>，正常波动 {p.noiseHorizon} 内碰到它的概率约 {o.noise}%</>}
      <span className="text-ink-3">；成本约占风险的 {Math.round(o.costR * 100)}%</span>
    </div>
  );
}

const CHECK_LABEL: Record<"flow" | "oi" | "turn", (long: boolean) => string> = {
  flow: (long) => `主动成交：新${long ? "低" : "高"}处累计主动成交差${long ? "高" : "低"}于前一个${long ? "低" : "高"}点，或放量后收回`,
  oi: () => "持仓量：扫过前后明显下降",
  turn: (long) => `1 小时：已出现更${long ? "高的低" : "低的高"}点并收盘越过前一个反弹点`,
};

/** Defending a level, beside the side's plan: what happened, two stops, what history says. */
function DefendBox({ p, d, mode, selected, onSelect, outcome }: { p: TrendPlan; d: DefendPlan; mode: Mode; selected: boolean; onSelect: () => void; outcome: DefendOutcome | null }) {
  const long = d.side === "long";
  const sec = TF_SECONDS[p.tf];
  const e = d.evidence;
  return (
    <div className={`mt-3 rounded-lg border p-3 text-[13px] leading-relaxed ${selected ? "border-accent" : "border-line"}`}>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-medium text-ink">
          <Term k="守位">守位做法</Term>
        </span>
        <span className="text-ink-3">已触发 · 不参与上面的计划排序</span>
        {d.size === "half" && <span className="rounded-full bg-warn-soft px-2 py-0.5 text-warn">逆{TF_LABEL[p.filterTf]}，半仓</span>}
      </div>
      <p className="mt-1 text-ink-2">
        {d.text}（{fmtWhen(d.entryT + sec)} 收盘 <span className="num">{fmtPrice(d.entry)}</span>）。
      </p>
      <dl className="mt-2 space-y-1">
        <Row k="远止损">
          <StopLine o={d.far} p={p} />
        </Row>
        <Row k={<Term k="近止损">近止损</Term>}>{d.near ? <StopLine o={d.near} p={p} /> : <span className="text-ink-3">{d.nearNote}</span>}</Row>
      </dl>
      <p className="mt-2 text-[12px] text-ink-3">
        {d.verdictText}
        {e && (
          <>
            （历史同类 {e.n} 笔，平均每笔 {fmtR(e.meanR)}
            {e.meanR != null && e.edgeR != null && <>，同方向随机入场 {fmtR(e.meanR - e.edgeR)}</>}；最近 12 个月比随机 {fmtR(e.oosEdgeR)}）
          </>
        )}
        。
      </p>
      {d.statsText && <p className="text-[12px] text-ink-3">{d.statsText}</p>}
      {mode === "pro" && (
        <div className="mt-2 rounded-md bg-panel-2 px-2.5 py-2 text-[12px]">
          <div className="text-ink-3">止跌 / 止涨的三项迹象（按入场那根收盘时）：</div>
          <ul className="mt-1 space-y-0.5">
            {(["flow", "oi", "turn"] as const).map((k) => (
              <li key={k}>
                <span className="inline-block w-12 text-ink">{d.checks[k] == null ? "数据缺" : d.checks[k] ? "有" : "没有"}</span>
                <span className="text-ink-2">{CHECK_LABEL[k](long)}</span>
              </li>
            ))}
          </ul>
          {p.defendChecks && (
            <ul className="mt-1.5 space-y-0.5 text-ink-3">
              {(["flow", "oi", "turn"] as const).map((k) => (
                <li key={k}>{p.defendChecks![k]}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {outcome && (
        <p className="mt-2 rounded-md border border-line px-2.5 py-1.5 text-[12px]" style={{ color: outcome.far.r > 0 ? "var(--up)" : "var(--down)" }}>
          <b>回放结果</b>：远止损 {resultText(outcome.far)}
          {outcome.near && <>；近止损 {resultText(outcome.near)}</>}
        </p>
      )}
      <button className="mt-2 text-xs text-accent" onClick={onSelect}>
        {selected ? "✓ 图、价格梯和仓位计算正在用守位做法" : "用守位做法看图、算仓位 →"}
      </button>
    </div>
  );
}

/** A followed trade's result in words. */
function resultText(r: StopResult): string {
  return r.status === "open"
    ? `到现在还没离场，按最新收盘 ${fmtR(r.r)}`
    : `${fmtWhen(r.exitT!)} ${r.exit === "stop" ? "碰到移动后的认错位离场" : "到最长持有时间离场"}，${fmtR(r.r)}`;
}

function Row({ k, children }: { k: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-2">
      <dt className="text-ink-3">{k}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function OutcomeLine({ o, sec }: { o: PlanOutcome; sec: number }) {
  const text =
    o.status === "none"
      ? `之后 ${o.watchBars} 根 K 线内没有触发。`
      : `之后：${fmtWhen(o.entryT! + sec)} 收盘以 ${fmtPrice(o.entry)} 入场，认错位 ${fmtPrice(o.stop)}；${
          o.status === "open"
            ? `到现在还没离场，按最新收盘 ${fmtR(o.r)}。`
            : `${fmtWhen(o.exitT!)} 那根 K 线${o.exit === "stop" ? "碰到移动后的认错位离场" : "到最长持有时间离场"}，结果 ${fmtR(o.r)}（期间最多浮盈 ${fmtR(o.mfe)}）。`
        }`;
  const color = o.r == null ? "var(--text-2)" : o.r > 0 ? "var(--up)" : "var(--down)";
  return (
    <p className="mt-3 rounded-lg border border-line px-3 py-2 text-[12px] leading-relaxed" style={{ color }}>
      <b>回放结果</b>（按页面规则机械执行）：{text}
      {o.near && <>用近止损 {fmtPrice(o.near.stop)}：{resultText(o.near)}。</>}
    </p>
  );
}

// ---------------------------------------------------------------- chart

function PlanChart({ p, ch, onPick }: { p: TrendPlan; ch: Chosen; onPick: (tf: Timeframe, t: number) => void }) {
  const outer = useReplay();
  const view = p.map.find((m) => m.role === "entry")!.view;
  const markers = useMemo<MarkerSpec[]>(
    () => view.swings.map((w) => ({ t: w.t, position: w.kind === "high" ? "aboveBar" : "belowBar", color: SWING_COLOR[w.label ?? ""] ?? "#7d8896", text: w.label ?? "", shape: "circle" })),
    [view],
  );
  const segments = useMemo<Segment[]>(() => [{ points: view.swings.map((w) => ({ t: w.t, v: w.price })), color: "#3987e5", width: 1 }], [view]);
  const priceLines = useMemo<PriceLineSpec[]>(() => {
    const out: PriceLineSpec[] = [];
    if (ch.far == null || ch.entry == null) return out;
    const usingNear = ch.near != null && ch.stop === ch.near.stop;
    out.push({ price: ch.far, color: "#e0a400", title: ch.near ? "远止损" : "认错位", dashed: usingNear, width: usingNear ? 1 : 2 });
    if (ch.farZone) out.push({ price: ch.farZone[0], color: "#e0a400", title: "" }, { price: ch.farZone[1], color: "#e0a400", title: "" });
    if (ch.near) out.push({ price: ch.near.stop, color: "#e0a400", title: "近止损", dashed: !usingNear, width: usingNear ? 2 : 1 });
    if (ch.zone) out.push({ price: ch.zone[0], color: "#3987e5", title: "回调区" }, { price: ch.zone[1], color: "#3987e5", title: "" });
    else out.push({ price: ch.entry, color: "#3987e5", title: ch.status === "active" ? "入场" : "触发" });
    return out;
  }, [ch]);
  // the plan's own bars and what came after them, whichever timeframe the rest of the page shows
  const ctx = useMemo(
    () => ({
      picking: outer?.picking ?? false,
      pick: (t: number) => onPick(p.tf, t),
      asOf: p.replay ? p.candles[p.candles.length - 1].t : null,
      future: p.replay?.future ?? null,
    }),
    [outer?.picking, onPick, p],
  );
  return (
    <section className="card p-3">
      <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-xs text-ink-3">
        <span>{TF_LABEL[p.tf]} K 线 · 当前看的是{ch.word}计划：</span>
        <span><span className="mr-1 inline-block h-0.5 w-3 bg-accent align-middle" />结构折线 / 触发价</span>
        <span><span className="mr-1 inline-block h-0.5 w-3 bg-warn align-middle" />认错区间与止损</span>
        <span>
          <Term k="更高低点">HH / HL / LH / LL</Term>
        </span>
      </div>
      <ReplayContext.Provider value={ctx}>
        <PriceChart candles={p.candles} markers={markers} segments={segments} priceLines={priceLines} height={360} initialBars={120} />
      </ReplayContext.Provider>
    </section>
  );
}

// ---------------------------------------------------------------- price ladder

interface Rung {
  price: number;
  label: string;
  color: string;
  state?: "none" | "pierced" | "broken";
  now?: boolean;
  tier?: "near" | "mid" | "far";
}

function PriceLadder({ p, ch }: { p: TrendPlan; ch: Chosen }) {
  const side = ch.side;
  const rungs = useMemo(() => {
    const bars = closedBars(p);
    const out: Rung[] = [{ price: p.price, label: p.replay ? "回放时的价格" : "现价", color: "var(--text)", now: true }];
    const view = p.map.find((m) => m.role === "entry")!.view;
    if (view.lastHigh) out.push({ price: view.lastHigh.price, label: `最近摆动高点${view.lastHigh.label ? ` ${view.lastHigh.label}` : ""}`, color: "var(--text-2)" });
    if (view.lastLow) out.push({ price: view.lastLow.price, label: `最近摆动低点${view.lastLow.label ? ` ${view.lastLow.label}` : ""}`, color: "var(--text-2)" });
    for (const l of p.levels) {
      if (Math.abs(l.price - p.price) > 4 * p.atr) continue;
      out.push({ price: l.price, label: `${l.side === "support" ? "支撑" : "阻力"} · ${l.methods[0] ?? "关键位"}`, color: l.side === "support" ? "var(--up)" : "var(--down)", state: levelState(l.price, bars, p.atr) });
    }
    // lines of defence for a position on this side: described, not promised to hold
    for (const d of p.defenses[side]) out.push({ price: d.price, label: d.label, color: "var(--text-2)", tier: d.tier });
    const word = ch.word;
    if (ch.far != null && ch.entry != null) {
      out.push({ price: ch.far, label: ch.near ? `${word}远止损（结构认错位）` : `${word}认错位（止损）`, color: "var(--warn)" });
      if (ch.near) out.push({ price: ch.near.stop, label: `${word}近止损（1 小时极点外）`, color: "var(--warn)" });
      out.push({ price: ch.zone ? (ch.zone[0] + ch.zone[1]) / 2 : ch.entry, label: ch.zone ? `${word}回调区中部` : ch.status === "active" ? `${word}入场` : `${word}触发`, color: "var(--accent)" });
    }
    return out.sort((x, y) => y.price - x.price);
  }, [p, side, ch]);
  return (
    <Section title="价格梯" extra={<span className="text-[11px] text-ink-3">{TF_LABEL[p.tf]} · 1 ATR ≈ {fmtPrice(p.atr)}</span>}>
      <ul className="space-y-0.5 text-[13px]">
        {rungs.map((r, k) => (
          <li key={`${r.label}${r.price}${k}`} className={`flex items-center gap-2 rounded-md px-2 py-1 ${r.now ? "bg-panel-2 font-medium" : ""}`}>
            <span className={`inline-block h-2 w-2 shrink-0 ${r.tier ? "rotate-45" : "rounded-full"}`} style={{ background: r.color }} />
            <span className="num w-20 shrink-0">{fmtPrice(r.price)}</span>
            <span className="min-w-0 flex-1 truncate text-ink-2">{r.label}</span>
            {r.state && r.state !== "none" && <BreachBadge breach={r.state} level />}
            {!r.now && <span className="num shrink-0 text-[11px] text-ink-3">{(((r.price - p.price) / p.price) * 100).toFixed(1)}%</span>}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[11px] leading-relaxed text-ink-3">
        关键位的两级状态只看收盘：越过 0.1 倍 ATR 为“被刺穿·观察”，越过 0.8 倍为“失效”（<Term k="收盘确认">为什么</Term>）。
        {p.defenses[side].length > 0 && <> 菱形是{side === "long" ? "多单" : "空单"}的近 / 中 / 远防线：{TF_LABEL[p.tf]}最近的结构点、被测试过的结构点或上周高低、{TF_LABEL[p.filterTf]}保护位或上月高低，只是标出位置。</>}
        {p.levelReach && <> {p.levelReach.short}</>}
      </p>
    </Section>
  );
}

// ---------------------------------------------------------------- sizing

function PlanCalc({ p, ch, onStop }: { p: TrendPlan; ch: Chosen; onStop: (stop: "far" | "near") => void }) {
  const seedEntry = ch.status === "active" ? p.price : (ch.entry ?? p.price);
  const seedStop = ch.stop ?? p.price * (ch.side === "long" ? 0.95 : 1.05);
  const [capital, setCapital] = useState(1000);
  const [riskPct, setRiskPct] = useState(1);
  const [lev, setLev] = useState(5);
  const [entry, setEntry] = useState(seedEntry);
  const [stop, setStop] = useState(seedStop);
  useEffect(() => {
    setCapital(readPref("capital", 1000));
    setRiskPct(readPref("risk", 1));
    setLev(readPref("lev", 5));
  }, []);
  useEffect(() => {
    setEntry(seedEntry);
    setStop(seedStop);
    // re-seed when the plan or its stop changes, not on every price tick
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.coin, p.framework, ch.side, ch.id, ch.stop]);

  const half = ch.size === "half";
  const r = sizePosition({ capital, riskPct: riskPct * (half ? 0.5 : 1), entry, stop, leverage: lev });
  const long = ch.side === "long";
  const valid = capital > 0 && riskPct > 0 && entry > 0 && stop > 0 && (long ? stop < entry : stop > entry);
  const loss = (capital * riskPct * (half ? 0.5 : 1)) / 100;
  const field = "num w-full rounded-lg border border-line bg-panel-2 px-2.5 py-1.5 text-sm outline-none focus:border-accent";
  // sizing a position with one of the plan's own stops: the defence task of the product metrics
  const usesPlanStop = (x: number) => ch.stop != null && Math.abs(x - ch.stop) <= 1e-9 * Math.max(1, x);
  const set = (f: (v: number) => void, key?: "capital" | "risk" | "lev") => (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = +e.target.value;
    f(v);
    if (key) writePref(key, v);
    track("use_calc", "calc");
    if (usesPlanStop(f === setStop ? v : stop)) track("defense_done", "defense");
  };
  const usingNear = ch.near != null && ch.stop === ch.near.stop;
  // the near stop's size against the far stop's, for the same loss
  const ratio = ch.near && ch.far != null && ch.entry != null ? Math.abs(ch.entry - ch.far) / Math.abs(ch.entry - ch.near.stop) : null;
  return (
    <Section title={<>按计划算仓位 <span className="text-xs font-normal text-ink-3">（<Term k="仓位">先定亏多少，再算仓位</Term>）</span></>}>
      {ch.near && (
        <div className="mb-2.5 flex flex-wrap items-center gap-2 text-xs text-ink-3">
          <span>{ch.word}的止损：</span>
          {(["far", "near"] as const).map((k) => (
            <button
              key={k}
              className="chip"
              data-active={(k === "near") === usingNear}
              onClick={() => {
                onStop(k);
                track("defense_done", "defense");
              }}
            >
              {k === "far" ? `远 ${fmtPrice(ch.far!)}` : `近 ${fmtPrice(ch.near!.stop)}`}
            </button>
          ))}
        </div>
      )}
      <div className="grid grid-cols-2 gap-2.5 text-xs text-ink-3">
        <label className="space-y-1">
          <span>总资金 (USDT)</span>
          <input type="number" className={field} value={capital} min={0} onChange={set(setCapital, "capital")} />
        </label>
        <label className="space-y-1">
          <span>每笔最多亏 (%)</span>
          <input type="number" className={field} value={riskPct} min={0.1} max={10} step={0.5} onChange={set(setRiskPct, "risk")} />
        </label>
        <label className="space-y-1">
          <span>{long ? "开多价" : "开空价"}</span>
          <input type="number" className={field} value={+entry.toPrecision(6)} onChange={set(setEntry)} />
        </label>
        <label className="space-y-1">
          <span>止损价（认错位）</span>
          <input type="number" className={field} value={+stop.toPrecision(6)} onChange={set(setStop)} />
        </label>
        <label className="col-span-2 space-y-1">
          <span>杠杆（逐仓，只影响占用的保证金和强平价）</span>
          <input type="number" className={field} value={lev} min={1} max={125} onChange={set(setLev, "lev")} />
        </label>
      </div>
      <div className="mt-3 space-y-1 rounded-lg bg-panel-2 p-3 text-[13px] leading-relaxed">
        {!valid ? (
          <span className="text-ink-3">{long ? "做多时止损价要低于开多价。" : "做空时止损价要高于开空价。"}</span>
        ) : (
          <>
            <div>
              仓位价值 <b className="num text-base">{r.notional.toLocaleString("en-US", { maximumFractionDigits: 0 })}</b> USDT
              <span className="text-ink-3">（约 {r.qty.toPrecision(4)} {p.coin}{half ? "，已按半仓减半" : ""}）</span>
            </div>
            <div className="text-ink-2">
              打到止损亏 <b className="num text-down">{loss.toFixed(0)} USDT</b>（总资金的 {(riskPct * (half ? 0.5 : 1)).toFixed(1)}%），这就是 1R。
            </div>
            {ratio != null && ratio > 1 && (
              <div className="text-ink-2">
                近止损的仓位是远止损的 <b className="num">{ratio.toFixed(1)}</b> 倍，打到止损亏的钱一样；近的更容易被正常波动扫掉。
              </div>
            )}
            <div className="text-ink-2">
              {lev} 倍杠杆占用保证金 <span className="num">{r.margin.toLocaleString("en-US", { maximumFractionDigits: 0 })}</span> USDT
              {r.liq != null && (
                <>
                  ，强平价约 <b className="num">{fmtPrice(r.liq)}</b>
                </>
              )}
              。
            </div>
            {!r.stopBeforeLiq && <div className="text-down">⚠ 强平价在止损之前：还没到认错位就会被强平。降低杠杆，让强平价落在止损之外。</div>}
            {r.margin > capital && <div className="text-down">⚠ 需要的保证金超过总资金：提高杠杆前先确认强平价仍在止损之外，或者把止损放近、仓位做小。</div>}
          </>
        )}
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-ink-3">
        强平价按逐仓、维持保证金率 {MMR * 100}% 粗算，未计手续费和资金费；以交易所显示为准。<Term k="强平价">先定止损和亏损额，再选杠杆</Term>。
      </p>
    </Section>
  );
}

// ---------------------------------------------------------------- scorecard

/** What following the page's plans mechanically would have made: the honest track record of this page. */
export function PlanScorecardCard({ p }: { p: TrendPlan }) {
  const sc = p.scorecard;
  return (
    <Section title="交易计划的成绩单">
      {!sc ? (
        <p className="text-[13px] leading-relaxed text-ink-3">成绩单来自每周的研究报告，服务器补齐历史数据后自动生成。生成前，这里不显示任何历史数字。</p>
      ) : (
        <div className="space-y-2.5 text-[13px] leading-relaxed text-ink-2">
          <p className="text-xs text-ink-3">
            在保存的全部历史上，每次出现页面会给出的计划就按规则执行（入场、认错位、移动认错位、半仓），一个币同时只持有一笔，已扣成本；对照是同方向、同止损距离、同仓位的随机入场。
          </p>
          {sc.rows.map((r) => (
            <div key={r.key} className="rounded-lg bg-panel-2 p-3">
              <div className="font-medium text-ink">{r.name.replace(/（.*）$/, "")}</div>
              <div className="num mt-1">
                {r.n} 笔，胜率 {r.hit ?? "—"}%，平均每笔 <b style={{ color: (r.meanR ?? 0) >= 0 ? "var(--up)" : "var(--down)" }}>{fmtR(r.meanR)}</b>，随机 {fmtR(r.controlR)}
              </div>
              <div className="num text-ink-3">
                最近 12 个月：{r.oosN} 笔，平均 {fmtR(r.oosMeanR)}，比随机 {fmtR(r.oosEdgeR)} · {r.verdict}
              </div>
            </div>
          ))}
          {sc.warning && <p className="rounded-lg bg-warn-soft px-3 py-2 text-ink">⚠ {sc.warning}</p>}
          <p className="text-[11px] text-ink-3">
            研究报告 {new Date(sc.createdAt).toLocaleDateString("zh-CN")} 生成。胜率低于一半是这类规则的常态：靠少数大赚覆盖多数小亏。
          </p>
        </div>
      )}
    </Section>
  );
}
