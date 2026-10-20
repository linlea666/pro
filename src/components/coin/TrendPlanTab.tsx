"use client";

import { useEffect, useMemo, useState } from "react";
import type { Framework, PlanOutcome, TrendPlan } from "@/lib/trendplan";
import { MMR, sizePosition, type SidePlan } from "@/lib/ta/plan";
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

const ALIGN: Record<SidePlan["alignment"], { text: string; color: string }> = {
  with: { text: "顺大周期", color: "var(--up)" },
  against: { text: "逆大周期", color: "var(--warn)" },
  neutral: { text: "大周期不明", color: "var(--text-3)" },
};
const STATUS: Record<SidePlan["status"], string> = { active: "已触发", watch: "等待触发", none: "观望" };
const SWING_COLOR: Record<string, string> = { HH: "var(--up)", HL: "var(--up)", LH: "var(--down)", LL: "var(--down)" };

/** The page's own rule: of the two plans, look first at the one already triggered, then the one with the higher timeframe. */
const defaultSide = (p: TrendPlan): "long" | "short" =>
  p.short.status === "active" && p.long.status !== "active" ? "short" : p.long.status !== "active" && p.short.alignment === "with" && p.short.status !== "none" ? "short" : "long";

export function TrendPlanTab({ p, mode, fw, onFw, onPick }: { p: TrendPlan; mode: Mode; fw: Framework; onFw: (f: Framework) => void; onPick: (tf: Timeframe, t: number) => void }) {
  const [side, setSide] = useState<"long" | "short">(() => defaultSide(p));
  useEffect(() => setSide(defaultSide(p)), [p.coin, p.framework, p.lastClosedT]); // eslint-disable-line react-hooks/exhaustive-deps
  const s = p[side];

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
        <TrendMap p={p} mode={mode} />
        <PlanChart p={p} s={s} onPick={onPick} />
        <div className="grid gap-4 md:grid-cols-2">
          {(["long", "short"] as const).map((k) => (
            <PlanCard key={k} p={p} s={p[k]} selected={side === k} onSelect={() => setSide(k)} outcome={p.replay?.[k] ?? null} />
          ))}
        </div>
        <p className="px-1 text-[12px] leading-relaxed text-ink-3">
          说明：研究报告里，这几种入场规则都没有证明比同方向、同止损距离的随机入场更好。计划能帮你的是认错位放在哪、仓位多大、怎么拿住和何时离场，不是预测涨跌。所有数字已扣 {p.costPct}% 的往返成本，样本外是最近 12 个月。
        </p>
      </div>

      <div className="space-y-4">
        <PriceLadder p={p} side={side} />
        <PlanCalc p={p} s={s} />
        {!p.replay && <PositionCheck current={p} />}
        <PlanScorecardCard p={p} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- plan card

function PlanCard({ p, s, selected, onSelect, outcome }: { p: TrendPlan; s: SidePlan; selected: boolean; onSelect: () => void; outcome: PlanOutcome | null }) {
  const long = s.side === "long";
  const color = long ? "var(--up)" : "var(--down)";
  const a = ALIGN[s.alignment];
  const v = s.invalidation;
  const sec = TF_SECONDS[p.tf];
  return (
    <section className={`card flex flex-col p-4 ${selected ? "ring-1 ring-accent" : ""}`}>
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

      {v && (
        <button className="mt-auto pt-3 text-left text-xs text-accent" onClick={onSelect}>
          {selected ? "✓ 图、价格梯和仓位计算正在用这份计划" : "用这份计划看图、算仓位 →"}
        </button>
      )}
    </section>
  );
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
    </p>
  );
}

// ---------------------------------------------------------------- chart

function PlanChart({ p, s, onPick }: { p: TrendPlan; s: SidePlan; onPick: (tf: Timeframe, t: number) => void }) {
  const outer = useReplay();
  const view = p.map.find((m) => m.role === "entry")!.view;
  const markers = useMemo<MarkerSpec[]>(
    () => view.swings.map((w) => ({ t: w.t, position: w.kind === "high" ? "aboveBar" : "belowBar", color: SWING_COLOR[w.label ?? ""] ?? "#7d8896", text: w.label ?? "", shape: "circle" })),
    [view],
  );
  const segments = useMemo<Segment[]>(() => [{ points: view.swings.map((w) => ({ t: w.t, v: w.price })), color: "#3987e5", width: 1 }], [view]);
  const priceLines = useMemo<PriceLineSpec[]>(() => {
    const out: PriceLineSpec[] = [];
    const v = s.invalidation;
    if (!v || s.entry == null) return out;
    out.push({ price: v.stop, color: "#e0a400", title: "认错位", dashed: false, width: 2 });
    out.push({ price: v.zone[0], color: "#e0a400", title: "" }, { price: v.zone[1], color: "#e0a400", title: "" });
    if (s.zone) out.push({ price: s.zone[0], color: "#3987e5", title: "回调区" }, { price: s.zone[1], color: "#3987e5", title: "" });
    else out.push({ price: s.entry, color: "#3987e5", title: s.status === "active" ? "入场" : "触发" });
    return out;
  }, [s]);
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
        <span>{TF_LABEL[p.tf]} K 线 · 当前看的是{s.side === "long" ? "做多" : "做空"}计划：</span>
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
}

function PriceLadder({ p, side }: { p: TrendPlan; side: "long" | "short" }) {
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
    const s = p[side];
    const word = side === "long" ? "做多" : "做空";
    if (s.invalidation && s.entry != null) {
      out.push({ price: s.invalidation.stop, label: `${word}认错位（止损）`, color: "var(--warn)" });
      out.push({ price: s.zone ? (s.zone[0] + s.zone[1]) / 2 : s.entry, label: s.zone ? `${word}回调区中部` : s.status === "active" ? `${word}入场` : `${word}触发`, color: "var(--accent)" });
    }
    return out.sort((x, y) => y.price - x.price);
  }, [p, side]);
  return (
    <Section title="价格梯" extra={<span className="text-[11px] text-ink-3">{TF_LABEL[p.tf]} · 1 ATR ≈ {fmtPrice(p.atr)}</span>}>
      <ul className="space-y-0.5 text-[13px]">
        {rungs.map((r, k) => (
          <li key={`${r.label}${r.price}${k}`} className={`flex items-center gap-2 rounded-md px-2 py-1 ${r.now ? "bg-panel-2 font-medium" : ""}`}>
            <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: r.color }} />
            <span className="num w-20 shrink-0">{fmtPrice(r.price)}</span>
            <span className="min-w-0 flex-1 truncate text-ink-2">{r.label}</span>
            {r.state && r.state !== "none" && <BreachBadge breach={r.state} level />}
            {!r.now && <span className="num shrink-0 text-[11px] text-ink-3">{(((r.price - p.price) / p.price) * 100).toFixed(1)}%</span>}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[11px] leading-relaxed text-ink-3">
        关键位的两级状态只看收盘：越过 0.1 倍 ATR 为“被刺穿·观察”，越过 0.8 倍为“失效”（<Term k="收盘确认">为什么</Term>）。
      </p>
    </Section>
  );
}

// ---------------------------------------------------------------- sizing

function PlanCalc({ p, s }: { p: TrendPlan; s: SidePlan }) {
  const seedEntry = s.status === "active" ? p.price : (s.entry ?? p.price);
  const seedStop = s.invalidation?.stop ?? p.price * (s.side === "long" ? 0.95 : 1.05);
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
    // re-seed when the plan changes, not on every price tick
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.coin, p.framework, s.side, s.kind, s.invalidation?.stop]);

  const r = sizePosition({ capital, riskPct: riskPct * (s.size === "half" ? 0.5 : 1), entry, stop, leverage: lev });
  const long = s.side === "long";
  const valid = capital > 0 && riskPct > 0 && entry > 0 && stop > 0 && (long ? stop < entry : stop > entry);
  const loss = (capital * riskPct * (s.size === "half" ? 0.5 : 1)) / 100;
  const field = "num w-full rounded-lg border border-line bg-panel-2 px-2.5 py-1.5 text-sm outline-none focus:border-accent";
  const set = (f: (v: number) => void, key?: "capital" | "risk" | "lev") => (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = +e.target.value;
    f(v);
    if (key) writePref(key, v);
    track("use_calc", "calc");
  };
  return (
    <Section title={<>按计划算仓位 <span className="text-xs font-normal text-ink-3">（<Term k="仓位">先定亏多少，再算仓位</Term>）</span></>}>
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
              <span className="text-ink-3">（约 {r.qty.toPrecision(4)} {p.coin}{s.size === "half" ? "，已按半仓减半" : ""}）</span>
            </div>
            <div className="text-ink-2">
              打到止损亏 <b className="num text-down">{loss.toFixed(0)} USDT</b>（总资金的 {(riskPct * (s.size === "half" ? 0.5 : 1)).toFixed(1)}%），这就是 1R。
            </div>
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
