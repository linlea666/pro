"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { WatchSideView, WatchView } from "@/lib/watch";
import type { KeyLevelKind } from "@/lib/ta/watch";
import { MMR, sizePosition } from "@/lib/ta/plan";
import type { Timeframe } from "@/lib/types";
import { PriceChart, type MarkerSpec, type PriceLineSpec } from "../PriceChart";
import { Term } from "../Term";
import { track } from "../track";
import type { Mode } from "./CoinView";
import { ago, fmtPrice } from "./format";
import { fmtR, fmtWhen, readPref, writePref } from "./plan-ui";
import { ReplayContext, useReplay } from "./replay";
import { Section } from "./shared";
import { FamilyTag, watchLevelFamily } from "./level-tags";
import { BreachBadge } from "./TrendMap";
import { PhaseCard } from "./PhaseCard";
import { fmtAtr, ruleLine, sideName, StatePill, stateWord } from "./watch-ui";

/**
 * Watching key levels live: whether price is still falling on to a key low (别接), has stalled there (观察) or
 * the 15-minute chart has turned (已转强), with the stop beyond the newest low. Shorts at highs mirror it.
 * Every number and every research sentence comes from the server (src/lib/watch.ts).
 */

/** The side the page talks about: the server's pick, else the one with the nearer level. */
export function relevantSide(v: WatchView): WatchSideView {
  if (v.side) return v[v.side];
  const withLevel = [v.long, v.short].filter((s) => s.level && s.distAtr != null);
  withLevel.sort((x, y) => Math.abs(x.distAtr!) - Math.abs(y.distAtr!));
  return withLevel[0] ?? v.long;
}

export function WatchTab({ v, mode, onPick }: { v: WatchView; mode: Mode; onPick: (tf: Timeframe, t: number) => void }) {
  const rel = relevantSide(v);
  const notify = useWatchNotify(v, rel);
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
      <div className="min-w-0 space-y-4">
        <PhaseCard v={v} mode={mode} />
        <HeadCard v={v} s={rel} />
        <WhyWait v={v} dir={rel.dir} mode={mode} />
        <div className="grid items-start gap-4 md:grid-cols-2">
          <SideCard v={v} s={v.long} />
          <SideCard v={v} s={v.short} />
        </div>
        <WatchChart v={v} s={rel} onPick={onPick} />
      </div>
      <div className="min-w-0 space-y-4">
        {!v.replay && <NotifyCard n={notify} />}
        <LevelsCard v={v} />
        <RiskCard v={v} />
        {mode === "pro" && <SignsCard v={v} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- head

function HeadCard({ v, s }: { v: WatchView; s: WatchSideView }) {
  const turn = s.state === "turned" ? (s.event?.turn ?? null) : null;
  return (
    <section className="card overflow-hidden">
      <div className="p-5">
        <div className="flex flex-wrap items-center gap-2 text-xs text-ink-3">
          <span>实时盯盘 · 只按收盘的 15 分钟 K 线判断</span>
          {v.replay && <span className="rounded-full border border-warn px-2 py-0.5 text-warn">回放</span>}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <StatePill state={v.state} dir={s.dir} big />
          {v.side && <span className="text-xs text-ink-3">{sideName(s.dir)}</span>}
          {v.forming && s.piercing && (
            <span className="whitespace-nowrap rounded-full border border-warn px-2 py-0.5 text-[11px] text-warn">正在{s.dir > 0 ? "刺穿" : "冲过"}（以收盘为准）</span>
          )}
        </div>
        <h2 className="mt-2 text-lg font-semibold leading-snug">{v.headline}</h2>
        <div className="num mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[13px] text-ink-2">
          <span>
            {v.replay ? "回放时的价格" : "最新价"} <b className="text-base text-ink">{fmtPrice(v.price)}</b>
          </span>
          <span>1 小时 ATR ≈ {fmtPrice(v.atr1h)}</span>
          <span className="text-[12px] text-ink-3">{v.replay ? `${fmtWhen(v.end)} 那根 15 分钟收盘时` : `更新于 ${ago(v.updatedAt)}`}</span>
        </div>
      </div>
      {turn && <TurnBox v={v} s={s} />}
    </section>
  );
}

/** After the turn: where the entry and the stop are, and the size that risk allows. */
function TurnBox({ v, s }: { v: WatchView; s: WatchSideView }) {
  const turn = s.event!.turn!;
  const long = s.dir > 0;
  const dist = Math.abs(turn.entry - turn.stop);
  const entryNow = v.price;
  const [capital, setCapital] = useState(1000);
  const [riskPct, setRiskPct] = useState(1);
  const [lev, setLev] = useState(5);
  useEffect(() => {
    setCapital(readPref("capital", 1000));
    setRiskPct(readPref("risk", 1));
    setLev(readPref("lev", 5));
  }, []);
  const r = sizePosition({ capital, riskPct, entry: entryNow, stop: turn.stop, leverage: lev });
  const valid = capital > 0 && riskPct > 0 && (long ? turn.stop < entryNow : turn.stop > entryNow);
  const loss = (capital * riskPct) / 100;
  const field = "num w-full rounded-lg border border-line bg-panel-2 px-2 py-1.5 text-sm outline-none focus:border-accent";
  const set = (f: (x: number) => void, key: "capital" | "risk" | "lev") => (e: React.ChangeEvent<HTMLInputElement>) => {
    const x = +e.target.value;
    f(x);
    writePref(key, x);
    track("use_calc", "calc");
    // sizing with the page's own stop: the same defence task as the plan page's calculator
    track("defense_done", "defense");
  };
  return (
    <div className="border-t border-line bg-panel-2/50 p-5">
      <dl className="grid grid-cols-[5rem_minmax(0,1fr)] gap-x-2 gap-y-1 text-[13px] leading-relaxed">
        <dt className="text-ink-3">入场参考</dt>
        <dd>
          <b className="num">{fmtPrice(turn.entry)}</b>
          <span className="text-ink-3">（{fmtWhen(turn.t + 900)} 转{long ? "强" : "弱"}那根收盘）</span>
        </dd>
        <dt className="text-ink-3">止损</dt>
        <dd>
          <b className="num">{fmtPrice(turn.stop)}</b>
          <span className="text-ink-3">
            （最新{long ? "低" : "高"}点 {fmtPrice(turn.extreme)} 之外，留了 {v.buf.toFixed(2)} 倍 1 小时 ATR 的扫损缓冲）
          </span>
        </dd>
        <dt className="text-ink-3">距离</dt>
        <dd className="num">
          离入场参考 {((dist / turn.entry) * 100).toFixed(2)}%（{v.atr1h > 0 ? (dist / v.atr1h).toFixed(2) : "—"} 倍 1 小时 ATR）
          {!v.replay && Math.abs(entryNow - turn.entry) > 1e-9 && (
            <span className="text-ink-3">；按最新价离 {((Math.abs(entryNow - turn.stop) / entryNow) * 100).toFixed(2)}%</span>
          )}
        </dd>
      </dl>
      <div className="mt-3 rounded-lg border border-line bg-panel p-3">
        <div className="text-[13px] font-medium">
          按这个止损算仓位 <span className="text-xs font-normal text-ink-3">（<Term k="仓位">先定亏多少，再算仓位</Term>）</span>
        </div>
        <div className="mt-2 grid grid-cols-3 gap-2 text-xs text-ink-3">
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
            <span className="text-ink-3">{long ? "价格已经在止损之下，这次转强已经作废。" : "价格已经在止损之上，这次转弱已经作废。"}</span>
          ) : (
            <>
              <div>
                按{v.replay ? "当时" : "最新"}价 {fmtPrice(entryNow)} {long ? "开多" : "开空"}：仓位价值{" "}
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
            </>
          )}
        </div>
        <p className="mt-1.5 text-[11px] leading-relaxed text-ink-3">强平价按逐仓、维持保证金率 {MMR * 100}% 粗算，未计手续费和资金费；以交易所显示为准。</p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- why wait

function WhyWait({ v, dir, mode }: { v: WatchView; dir: 1 | -1; mode: Mode }) {
  const res = v.research;
  return (
    <Section title={<>为什么要等 <span className="text-xs font-normal text-ink-3">（别<Term k="接飞刀">接飞刀</Term>）</span></>}>
      <div className="space-y-2 text-[14px] leading-relaxed text-ink-2">
        {res ? <p>{res.text}</p> : <p className="text-[13px] text-ink-3">{v.researchNote ?? "研究数字会在服务器生成研究报告后显示。"}</p>}
        <p className="rounded-lg bg-panel-2 px-3 py-2 text-[13px] text-ink">
          {ruleLine(dir)}（<Term k="转强">什么叫转{dir > 0 ? "强" : "弱"}</Term>）
        </p>
        {mode === "pro" && res && res.rows.length > 0 && (
          <ul className="space-y-1 text-[12px] text-ink-3">
            {res.rows.map((r) => (
              <li key={r.key} className="num">
                <span className="text-ink-2">{r.name}</span>：{r.n} 笔，平均每笔 {fmtR(r.meanR)}，对照 {fmtR(r.controlR)}；最近 12 个月相差 {fmtR(r.oosEdgeR)}（{r.oosN} 笔）· {r.verdict}
              </li>
            ))}
            <li>研究报告 {new Date(res.createdAt).toLocaleDateString("zh-CN")} 生成，已扣成本。</li>
          </ul>
        )}
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------- the two sides

const MAX_EXTREMES = 6;

function SideCard({ v, s }: { v: WatchView; s: WatchSideView }) {
  const long = s.dir > 0;
  const ev = s.event;
  const x = long ? "低" : "高";
  const extremes = ev?.newExtremes ?? [];
  const shown = extremes.slice(-MAX_EXTREMES);
  const hidden = extremes.length - shown.length;
  // the event follows price on to deeper levels: the first touch may have been a shallower one
  const deeper = !!ev && !!s.level && extremes.length > 0 && (extremes[0].price - s.level.price) * s.dir > 0;
  return (
    <section className={`card p-4 ${v.side === (long ? "long" : "short") ? "ring-1 ring-accent" : ""}`}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-[15px] font-semibold">{sideName(s.dir)}</h3>
        <StatePill state={s.state} dir={s.dir} />
        {v.forming && s.piercing && <span className="text-[11px] text-warn">正在刺穿（以收盘为准）</span>}
      </div>
      {s.level ? (
        <p className="mt-1.5 text-[13px] text-ink-2">
          {s.level.name} <b className="num text-ink">{fmtPrice(s.level.price)}</b>
          <span className="num text-ink-3">（{fmtAtr(s.distAtr)}）</span>
        </p>
      ) : (
        <p className="mt-1.5 text-[13px] text-ink-3">附近没有要盯的关键{x}点。</p>
      )}
      {ev && (
        <ol className="mt-2 space-y-1 border-l border-line pl-3 text-[13px] leading-relaxed">
          <Step when={fmtWhen(ev.startT)}>
            {deeper || !s.level ? "碰到关键位" : `碰到${spaced(s.level.name)}`}
            <span className="text-ink-3">
              （{deeper && s.level ? `后来${long ? "跌" : "涨"}到${spaced(s.level.name)}，` : ""}已过 {ev.bars} 根 15 分钟 K 线）
            </span>
          </Step>
          {hidden > 0 && <li className="text-[12px] text-ink-3">…… 前面还有 {hidden} 次创新{x}</li>}
          {shown.map((e, k) => (
            <Step key={e.t} when={fmtWhen(e.t)}>
              {hidden === 0 && k === 0 && e.t === ev.startT ? `碰到那根的最${x}点` : `创新${x}`} <span className="num">{fmtPrice(e.price)}</span>
            </Step>
          ))}
          {ev.attempt > 1 && (
            <Step>
              第 {ev.attempt} 次等转{long ? "强" : "弱"}<span className="text-ink-3">（前面 {ev.attempt - 1} 次转{long ? "强" : "弱"}后又创新{x}，从新的{x}点重新等）</span>
            </Step>
          )}
          {ev.bounce != null && (
            <Step>
              {long ? "反弹高点" : "回落低点"} <span className="num">{fmtPrice(ev.bounce)}</span>
              {!ev.turn && <span className="text-ink-3">（收盘{long ? "站上" : "跌破"}它才算转{long ? "强" : "弱"}）</span>}
            </Step>
          )}
          {ev.reclaimed && <Step>扫过后收回（收盘回到{long ? "位上方" : "位下方"}）</Step>}
          {ev.turn ? (
            <Step when={fmtWhen(ev.turn.t + 900)} accent>
              15 分钟转{long ? "强" : "弱"}：入场 <span className="num">{fmtPrice(ev.turn.entry)}</span>，止损 <span className="num">{fmtPrice(ev.turn.stop)}</span>
              <span className="text-ink-3">（{x}点 {fmtPrice(ev.turn.extreme)} 之外）</span>
            </Step>
          ) : (
            <Step>
              <span className="text-ink-3">
                还没转{long ? "强" : "弱"}；转{long ? "强" : "弱"}时止损会放在约 <span className="num">{fmtPrice(ev.stop)}</span>（最新{x}点 {fmtPrice(ev.extreme)} 之外）
              </span>
            </Step>
          )}
          {ev.hourTurned && (
            <Step>
              <span className="text-ink-3">1 小时也已转{long ? "强" : "弱"}</span>
            </Step>
          )}
        </ol>
      )}
      {!ev && s.state === "near" && <p className="mt-2 text-[12px] text-ink-3">还没碰到。碰到以后先看它是不是还在创新{x}，别急着{long ? "接" : "空"}。</p>}
    </section>
  );
}

/** a name starting with a digit ("4 小时摆动低点") gets a space before it, as the server's headline does */
const spaced = (name: string) => (/^\d/.test(name) ? ` ${name}` : name);

function Step({ when, accent = false, children }: { when?: string; accent?: boolean; children: React.ReactNode }) {
  return (
    <li className="relative">
      <span className={`absolute -left-[15.5px] top-[9px] h-1.5 w-1.5 rounded-full ${accent ? "bg-accent" : "bg-ink-3"}`} aria-hidden="true" />
      {when && <span className="num mr-1.5 text-[12px] text-ink-3">{when}</span>}
      {children}
    </li>
  );
}

// ---------------------------------------------------------------- chart

function WatchChart({ v, s, onPick }: { v: WatchView; s: WatchSideView; onPick: (tf: Timeframe, t: number) => void }) {
  const outer = useReplay();
  const long = s.dir > 0;
  const last = v.candles[v.candles.length - 1];
  const markers = useMemo<MarkerSpec[]>(() => {
    const ev = s.event;
    if (!ev) return [];
    const times = new Set(v.candles.map((c) => c.t));
    const pos = long ? "belowBar" : "aboveBar";
    const out: MarkerSpec[] = [{ t: ev.startT, position: pos, color: "#7d8896", text: "碰到", shape: "circle" }];
    for (const e of ev.newExtremes) if (e.t !== ev.startT) out.push({ t: e.t, position: pos, color: "#e0a400", text: long ? "新低" : "新高", shape: "circle" });
    if (ev.turn) out.push({ t: ev.turn.t, position: pos, color: "#3987e5", text: long ? "转强" : "转弱", shape: long ? "arrowUp" : "arrowDown", size: 1 });
    return out.filter((m) => times.has(m.t));
  }, [v, s, long]);
  const priceLines = useMemo<PriceLineSpec[]>(() => {
    const out: PriceLineSpec[] = [];
    const ev = s.event;
    if (s.level) out.push({ price: s.level.price, color: "#7d8896", title: s.level.name, dashed: false, width: 2 });
    if (!ev) return out;
    out.push({ price: ev.extreme, color: "#e0a400", title: long ? "最新低点" : "最新高点" });
    if (ev.bounce != null) out.push({ price: ev.bounce, color: "#3987e5", title: long ? "反弹高点" : "回落低点" });
    if (ev.turn && s.state === "turned") {
      out.push({ price: ev.turn.stop, color: "#e0a400", title: "止损", dashed: false, width: 2 });
      out.push({ price: ev.turn.entry, color: "#3987e5", title: "入场", dashed: false });
    }
    return out;
  }, [s, long]);
  // the watch's own 15-minute bars: picking a bar replays the watch at its close
  const ctx = useMemo(
    () => ({
      picking: outer?.picking ?? false,
      pick: (t: number) => onPick("15m", t),
      asOf: v.replay && last ? last.t : null,
      future: v.replay && last && outer?.asOf === last.t ? outer.future : null,
    }),
    [outer?.picking, outer?.asOf, outer?.future, onPick, v.replay, last],
  );
  if (!last) return null;
  return (
    <section className="card p-3">
      <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-xs text-ink-3">
        <span>15 分钟 K 线 · {sideName(s.dir)}</span>
        <span><span className="mr-1 inline-block h-0.5 w-3 bg-ink-3 align-middle" />关键位</span>
        <span><span className="mr-1 inline-block h-0.5 w-3 bg-warn align-middle" />最新{long ? "低" : "高"}点 / 止损</span>
        <span><span className="mr-1 inline-block h-0.5 w-3 bg-accent align-middle" />{long ? "反弹高点" : "回落低点"} / 入场</span>
      </div>
      <ReplayContext.Provider value={ctx}>
        <PriceChart candles={v.candles} markers={markers} priceLines={priceLines} height={340} initialBars={120} />
      </ReplayContext.Provider>
      {v.replay && ctx.future && <p className="px-1 pt-1 text-[11px] text-ink-3">回放点右边颜色浅的 K 线，是这一刻之后真实发生的走势。</p>}
    </section>
  );
}

// ---------------------------------------------------------------- key levels

function LevelsCard({ v }: { v: WatchView }) {
  const rows = useMemo(() => {
    const out: { price: number; name: string; kind?: KeyLevelKind; dist: number | null; state: "none" | "pierced" | "broken"; now?: boolean }[] = v.levels.map((l) => ({ price: l.price, name: l.name, kind: l.kind, dist: l.distAtr, state: l.state }));
    out.push({ price: v.closedPrice, name: v.replay ? "回放时的收盘价" : "最近收盘价", dist: null, state: "none", now: true });
    return out.sort((a, b) => b.price - a.price);
  }, [v]);
  return (
    <Section title="附近的关键位" extra={<span className="text-[11px] text-ink-3">1 小时 ATR ≈ {fmtPrice(v.atr1h)}</span>}>
      {v.levels.length === 0 ? (
        <p className="text-[13px] text-ink-3">附近没有找到关键位。</p>
      ) : (
        <ul className="space-y-0.5 text-[13px]">
          {rows.map((r, k) => (
            <li key={`${r.name}${r.price}${k}`} className={`flex items-center gap-2 rounded-md px-2 py-1 ${r.now ? "bg-panel-2 font-medium" : ""}`}>
              <span className="num w-20 shrink-0">{fmtPrice(r.price)}</span>
              <span className="min-w-0 flex-1 truncate text-ink-2">{r.kind ? <FamilyTag family={watchLevelFamily(r.kind)}>{r.name}</FamilyTag> : r.name}</span>
              {r.state !== "none" && <BreachBadge breach={r.state} level />}
              {r.dist != null && <span className="num shrink-0 text-[11px] text-ink-3">{fmtAtr(r.dist).replace(" 倍 ATR", "")} ATR</span>}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-[11px] leading-relaxed text-ink-3">
        前一日、上周、上月的高低点，以及 4 小时、日线还没被收盘越过的摆动点。状态只看收盘：越过 0.1 倍 ATR 为“被刺穿·观察”，0.8 倍为“失效”（<Term k="收盘确认">为什么</Term>）。
      </p>
    </Section>
  );
}

// ---------------------------------------------------------------- 24 hours

function RiskCard({ v }: { v: WatchView }) {
  const m = v.move24;
  const utcDay = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
  return (
    <Section title="24 小时风险环境">
      {!m ? (
        <p className="text-[13px] text-ink-3">保存的历史还不够，暂时算不出来。</p>
      ) : (
        <div className="space-y-2 text-[13px] leading-relaxed text-ink-2">
          {m.changePct != null && (
            <p>
              24 小时{m.changePct >= 0 ? "涨" : "跌"} <b className="num text-ink">{Math.abs(m.changePct).toFixed(2)}%</b>
              {m.pctRank != null && (
                <>
                  ，比这个币过去 <b className="num text-ink">{m.pctRank}%</b> 的 24 小时波动都大
                </>
              )}
              。
            </p>
          )}
          {m.volRatio != null && m.changePct != null && (
            <p>
              历史上 24 小时{m.changePct < 0 ? "跌" : "涨"}得最多的那 5% 之后 3 天，波动通常是平时的 <b className="num text-ink">{m.volRatio.toFixed(1)}</b> 倍{m.dirNote ? `；${m.dirNote}` : ""}。
            </p>
          )}
          {m.topDrops.length > 0 && (
            <div>
              <div className="text-[12px] text-ink-3">{v.coin} 历史上最大的单日跌幅（UTC 日期）：</div>
              <ul className="num mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[12px]">
                {m.topDrops.map((d) => (
                  <li key={d.t}>
                    {utcDay(d.t)} <span className="text-down">{d.pct.toFixed(2)}%</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="text-[11px] text-ink-3">这些只描述现在的波动有多大，用来定止损距离和仓位，不说明接下来往哪走。
            {(v.coin === "BTC" || v.coin === "ETH") && (
              <>
                {" "}
                <Link href={`/moves?coin=${v.coin}`} className="underline">
                  看完整的涨跌统计
                </Link>
              </>
            )}
          </p>
        </div>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------- signs (pro)

function SignsCard({ v }: { v: WatchView }) {
  const sides = [v.long, v.short].filter((s) => s.signs);
  if (!sides.length) return null;
  return (
    <Section title="迹象（专业模式）">
      {sides.map((s) => (
        <div key={s.dir} className="mb-3 last:mb-0">
          <p className="text-[12px] leading-relaxed text-ink-3">
            {sideName(s.dir)} · 按这根 15 分钟收盘时；研究里这些迹象单独看都不能判断是不是{s.dir > 0 ? "底" : "顶"}（E19b）。
          </p>
          <ul className="mt-1.5 space-y-1.5 text-[13px]">
            {s.signs!.map((g) => (
              <li key={g.key} className="rounded-md bg-panel-2 px-2.5 py-1.5">
                <div className="flex items-center gap-2">
                  <span className={`inline-block w-12 shrink-0 text-[12px] ${g.value ? "font-medium text-ink" : "text-ink-3"}`}>{g.value == null ? "数据缺" : g.value ? "有" : "没有"}</span>
                  <span className="text-ink">{g.name}</span>
                </div>
                {g.text && <p className="mt-0.5 text-[12px] leading-relaxed text-ink-3">{g.text}</p>}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </Section>
  );
}

// ---------------------------------------------------------------- alerts (while the page is open)

const OPT_KEY = "sl-watch-notify";

let audio: AudioContext | null = null;

/** Create or resume the page's audio; browsers keep it silent until the viewer has clicked on the page. */
function unlockAudio(): Promise<void> {
  try {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return Promise.resolve();
    audio ??= new AC();
    return audio.state === "suspended" ? audio.resume().catch(() => {}) : Promise.resolve();
  } catch {
    return Promise.resolve();
  }
}

/** Two short tones; silent while audio is still locked. */
function beep() {
  try {
    if (!audio || audio.state !== "running") return;
    const t0 = audio.currentTime;
    for (const [k, f] of [[0, 880], [0.25, 660]]) {
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t0 + k);
      g.gain.exponentialRampToValueAtTime(0.2, t0 + k + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + k + 0.2);
      o.connect(g).connect(audio.destination);
      o.start(t0 + k);
      o.stop(t0 + k + 0.22);
    }
  } catch {}
}

let stopFlash: (() => void) | null = null;

/** Alternate the tab title with `text` until the viewer comes back to the page. */
function flashTitle(text: string) {
  stopFlash?.();
  if (document.visibilityState === "visible" && document.hasFocus()) return;
  const base = document.title;
  let on = false;
  const timer = window.setInterval(() => {
    on = !on;
    document.title = on ? text : base;
  }, 1000);
  const onVis = () => {
    if (document.visibilityState === "visible") stopFlash?.();
  };
  stopFlash = () => {
    window.clearInterval(timer);
    document.title = base;
    window.removeEventListener("focus", stopFlash!);
    document.removeEventListener("visibilitychange", onVis);
    stopFlash = null;
  };
  window.addEventListener("focus", stopFlash);
  document.addEventListener("visibilitychange", onVis);
}

interface Notify {
  /**
   * How this browser can alert: system notifications (HTTPS only), else a tone and a flashing tab title
   * (works over plain HTTP); null before mount, "none" when neither is possible.
   */
  kind: "notify" | "sound" | "none" | null;
  enabled: boolean;
  denied: boolean;
  enable: () => void;
  disable: () => void;
  test: () => void;
}

function useWatchNotify(v: WatchView, s: WatchSideView): Notify {
  const [kind, setKind] = useState<Notify["kind"]>(null);
  const [enabled, setEnabled] = useState(false);
  const [denied, setDenied] = useState(false);
  useEffect(() => {
    const canNotify = "Notification" in window && window.isSecureContext;
    const canSound = "AudioContext" in window || "webkitAudioContext" in window;
    const k = canNotify ? "notify" : canSound ? "sound" : "none";
    setKind(k);
    if (canNotify) setDenied(Notification.permission === "denied");
    try {
      setEnabled(localStorage.getItem(OPT_KEY) === "1" && (k === "sound" || (k === "notify" && Notification.permission === "granted")));
    } catch {}
    return () => stopFlash?.();
  }, []);

  // after a reload the tone needs one click on the page before it can play
  useEffect(() => {
    if (!enabled || kind !== "sound") return;
    const unlock = () => void unlockAudio();
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, [enabled, kind]);

  // the first state seen on this coin is what the viewer is looking at: only later changes alert
  const seen = useRef<string | null>(null);
  const ev = s.event;
  const key = !v.replay && ev && (s.state === "falling" || s.state === "turned") ? `${v.coin}:${ev.startT}:${s.state}:${ev.attempt}` : null;
  useEffect(() => {
    const first = seen.current !== v.coin;
    seen.current = v.coin;
    if (!key) return;
    let before = false;
    try {
      before = sessionStorage.getItem(`sl-watch-n:${key}`) === "1";
      sessionStorage.setItem(`sl-watch-n:${key}`, "1");
    } catch {}
    if (before || first || !enabled) return;
    const L = s.level ? `${s.level.name} ${fmtPrice(s.level.price)}` : "关键位";
    const through = s.distAtr != null && s.distAtr * s.dir > 0.1;
    const title =
      s.state === "turned"
        ? `${v.coin} 已转${s.dir > 0 ? "强" : "弱"}`
        : `${v.coin} ${stateWord("falling", s.dir)}：${through ? (s.dir > 0 ? "跌破" : "涨破") : "碰到"} ${L}`;
    try {
      flashTitle(`【${title}】`);
      if (kind === "sound") beep();
      else if (kind === "notify" && Notification.permission === "granted") new Notification(title, { body: v.headline, tag: key });
    } catch {}
    // a new key (or a new coin) is what matters; the headline goes with it
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, v.coin, enabled]);

  const save = () => {
    setEnabled(true);
    try {
      localStorage.setItem(OPT_KEY, "1");
    } catch {}
  };
  const enable = () => {
    if (kind === "sound") {
      void unlockAudio().then(beep);
      save();
      return;
    }
    try {
      Notification.requestPermission().then((p) => {
        setDenied(p === "denied");
        if (p === "granted") save();
      });
    } catch {}
  };
  const disable = () => {
    setEnabled(false);
    stopFlash?.();
    try {
      localStorage.removeItem(OPT_KEY);
    } catch {}
  };
  const test = () => void unlockAudio().then(beep);
  return { kind, enabled, denied, enable, disable, test };
}

function NotifyCard({ n }: { n: Notify }) {
  if (n.kind == null || n.kind === "none") return null;
  const sound = n.kind === "sound";
  return (
    <section className="card p-4 text-[13px] leading-relaxed">
      {n.enabled ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-ink">🔔 提醒已开启</span>
          <span className="text-ink-3">状态变成“已转强”或“别接”时{sound ? "响提示音、闪标签页标题" : "弹出通知"}</span>
          <span className="ml-auto flex gap-3">
            {sound && (
              <button className="text-xs text-accent" onClick={n.test}>
                试听
              </button>
            )}
            <button className="text-xs text-accent" onClick={n.disable}>
              关闭
            </button>
          </span>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <button className="chip" onClick={n.enable}>
            🔔 开启提醒（页面打开时）
          </button>
          {n.denied && <span className="text-[12px] text-warn">浏览器拒绝了通知，可以在地址栏左边的网站设置里打开。</span>}
        </div>
      )}
      <p className="mt-1.5 text-[12px] text-ink-3">
        只在这个页面开着时提醒，关掉就收不到；不是 App 推送。
        {sound && "本站用 HTTP 访问，浏览器不允许弹系统通知，所以改用提示音和标签页标题闪烁；刷新页面后要先在页面上点一下，提示音才能响。"}
      </p>
    </section>
  );
}
