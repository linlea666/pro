"use client";

import { useState } from "react";
import type { SpotPage } from "@/lib/spot/page";
import { FNG_BANDS, type LowLine, type ZoneLabel } from "@/lib/spot/valuation";
import { WEEK_LINE_FACTS, weekLineText } from "@/lib/ta/weekline";
import { Term } from "../Term";
import { Card, fmtBj, fmtCap, fmtMult, fmtSigned, fmtSpan, fmtUsd, LIVE_SOURCE, OpinionTag, ZoneChip, type Mode } from "./spot-ui";

const pct = (p: number | null | undefined) => (p == null ? "—" : `${Math.round(p * 100)}%`);

const MOOD: Record<string, string> = { 极度恐惧: "情绪极度恐惧", 恐惧: "情绪偏恐惧", 中性: "情绪中性", 贪婪: "情绪偏贪婪", 极度贪婪: "情绪极度贪婪" };

/** ① One sentence: how many of the main rulers sit in their low / high zone, and the mood. */
export function Headline({ d, mode }: { d: SpotPage; mode: Mode }) {
  const n = d.now;
  const main: ZoneLabel[] = [n.mvrv.zone, n.wma.zone, ...(mode === "pro" ? [n.mayer.zone] : [])].filter((z): z is ZoneLabel => !!z);
  const low = main.filter((z) => z === "历史低位").length;
  const high = main.filter((z) => z === "历史高位").length;
  const rulers = low === 0 && high === 0 ? `${main.length} 把长期尺子都在中间` : `${main.length} 把长期尺子里 ${low} 把在历史低位、${high} 把在历史高位`;
  const mood = d.fng ? `，${MOOD[d.fng.label] ?? `情绪${d.fng.label}`}` : "";
  const under = n.lowLines.filter((l) => l.inZone && l.key !== "mayer08");
  const hi = d.episodes.find((e) => e.zone.key === "mvrvHigh")?.summary.find((s) => s.days === 730);
  const showHigh = n.mvrv.pct != null && n.mvrv.pct >= d.rules.mvrvHighPct && hi && hi.n > 0;
  return (
    <div className="space-y-1.5">
      <p className="text-[17px] font-semibold leading-snug sm:text-lg">
        比特币现在：{rulers}
        {mood}
        {under.length > 0 && `；价格已经${under.map((l) => (l.key === "wma" ? "跌破 200 周均线" : "跌破全网平均成本（MVRV < 1）")).join("、")}`}。
      </p>
      {showHigh && (
        <p className="rounded-lg bg-down-soft px-3 py-2 text-[13px] leading-relaxed text-ink">
          <Term k="MVRV">MVRV</Term> 在历史高分位：历史上这时候买入，2 年后
          {hi.better === 0 ? ` ${hi.n} 段都不如同期定投` : ` ${hi.n} 段里只有 ${hi.better} 段好于同期定投`}（样本不足，只作参考）。
        </p>
      )}
      <p className="text-[13px] leading-relaxed text-ink-3">这些尺子描述现在贵不贵，不预测下个月涨跌；比特币只有 4–5 轮完整周期，历史数字只作参考。</p>
    </div>
  );
}

function Tile({ label, value, chip, children }: { label: React.ReactNode; value: React.ReactNode; chip?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="min-w-0 rounded-xl border border-line bg-panel p-3">
      <div className="flex items-start gap-1.5">
        <span className="min-w-0 text-[12px] text-ink-3">{label}</span>
        {chip && <span className="ml-auto shrink-0">{chip}</span>}
      </div>
      <div className="num mt-1 text-[19px] font-semibold leading-tight">{value}</div>
      {children && <div className="num mt-1 space-y-0.5 text-[11px] leading-relaxed text-ink-3">{children}</div>}
    </div>
  );
}

/** "跌破 200 周均线 ≈ 66,957（离现价 −19%），上次 2026-06-05 至 08-16" */
function lowLineText(l: LowLine, live: number) {
  if (l.price == null) return `${l.label}：数据不够`;
  const dist = (l.price / live - 1) * 100;
  const last = l.inZone ? `现在就在这里（这一段从 ${l.lastStart} 开始）` : l.lastStart && l.lastDay ? `上次 ${fmtSpan(l.lastStart, l.lastDay)}` : "历史上没有出现过";
  return (
    <>
      {l.label} ≈ <b className="text-ink">{fmtUsd(l.price)}</b>
      <span className="text-ink-3">（离现价 {fmtSigned(dist)}），{last}</span>
    </>
  );
}

/** ② The current values, each with its date and source. */
export function NowTiles({ d, mode }: { d: SpotPage; mode: Mode }) {
  const n = d.now;
  const day = `${d.asOfDay} 日线`;
  const lines = n.lowLines.filter((l) => mode === "pro" || l.key !== "mayer08");
  return (
    <Card title="当前数值" extra={`日线指标截至 ${d.asOfDay}（UTC）`}>
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Tile label="现价" value={fmtUsd(d.live.price)}>
          <div>
            {LIVE_SOURCE[d.live.source] ?? d.live.source} · {fmtBj(d.live.at)}（北京时间）
          </div>
        </Tile>
        <Tile label={<Term k="200周均线">200 周均线</Term>} value={fmtUsd(n.wma.wma200)} chip={<ZoneChip zone={n.wma.zone} />}>
          <div>价格是它的 {fmtMult(n.wma.value)}</div>
          <div>倍数的历史分位 {pct(n.wma.pct)} · {day}</div>
        </Tile>
        <Tile label={<Term k="MVRV">MVRV</Term>} value={n.mvrv.value?.toFixed(2) ?? "—"} chip={<ZoneChip zone={n.mvrv.zone} />}>
          <div>历史分位 {pct(n.mvrv.pct)}</div>
          <div>
            <Term k="已实现价格">已实现价格</Term>（全网平均成本）{fmtUsd(n.mvrv.realizedPrice)}
          </div>
          <div>{day} · Coin Metrics</div>
        </Tile>
        <Tile label={<Term k="Mayer倍数">Mayer 倍数</Term>} value={n.mayer.value?.toFixed(2) ?? "—"} chip={mode === "pro" ? <ZoneChip zone={n.mayer.zone} /> : undefined}>
          <div>200 日均线 {fmtUsd(n.mayer.ma200)}</div>
          {mode === "pro" ? <div>历史分位 {pct(n.mayer.pct)} · {day}</div> : <div>{day}</div>}
        </Tile>
        <Tile label="总市值" value={fmtCap(n.marketCap)}>
          <div>流通 {n.supply ? Math.round(n.supply).toLocaleString("en-US") : "—"} 枚</div>
          <div>{day} · Coin Metrics</div>
        </Tile>
        <Tile label={<Term k="恐惧贪婪指数">恐惧贪婪</Term>} value={d.fng ? <>{d.fng.value} <span className="text-[14px] font-medium">{d.fng.label}</span></> : "数据缺"}>
          {d.fng && <div>{d.fng.day} · alternative.me</div>}
        </Tile>
        <Tile label="距 52 周高点" value={fmtSigned(n.high52w.distPct)}>
          <div>
            最高收盘 {fmtUsd(n.high52w.price)}（{n.high52w.day}）
          </div>
          <div>纯描述，不分区</div>
        </Tile>
        <Tile label="攒币计划的预备金" value={n.reserve ? "已触发" : "没触发"}>
          <div>跌破 200 周均线或 MVRV &lt; 1</div>
          <div>现在约 {fmtUsd(d.reservePrice)} 以下</div>
        </Tile>
      </div>
      <div className="mt-3 rounded-lg bg-panel-2 px-3 py-2">
        <div className="mb-1 text-[12px] font-medium text-ink-2">进入历史低位大约对应的价格（按 {d.asOfDay} 的数值）</div>
        <ul className="num space-y-1 text-[12px] leading-relaxed text-ink-2">
          {lines.map((l) => (
            <li key={l.key}>{lowLineText(l, d.live.price)}</li>
          ))}
        </ul>
      </div>
      {n.week50 && (
        <div className="mt-2 rounded-lg bg-panel-2 px-3 py-2 text-[12px] leading-relaxed text-ink-2">
          <div className="num">
            <span className="font-medium text-ink">长期趋势：</span>
            {weekLineText(n.week50)}，50 周均线 ≈ <b className="text-ink">{fmtUsd(n.week50.sma)}</b>
            <span className="text-ink-3">（离现价 {fmtSigned((n.week50.sma / d.live.price - 1) * 100)}）</span>
          </div>
          <p className="mt-0.5 text-ink-3">
            {WEEK_LINE_FACTS.general}
            {WEEK_LINE_FACTS.spot}
            {mode === "pro" && WEEK_LINE_FACTS.risk}
          </p>
        </div>
      )}
    </Card>
  );
}

interface BarRow {
  key: string;
  name: React.ReactNode;
  value: string;
  pct: number | null;
  zone: ZoneLabel | null;
  method: string;
  low?: LowLine;
}

/** ③ One bar per ruler: where today sits in its own history (0–100%), the 20% / 80% bands shaded. */
export function RulerBars({ d, mode }: { d: SpotPage; mode: Mode }) {
  const n = d.now;
  const R = d.rules;
  const line = (k: LowLine["key"]) => n.lowLines.find((l) => l.key === k);
  const rows: BarRow[] = [
    { key: "mvrv", name: <Term k="MVRV">MVRV</Term>, value: n.mvrv.value?.toFixed(2) ?? "—", pct: n.mvrv.pct, zone: n.mvrv.zone, method: `市值 ÷ 已实现市值（Coin Metrics）；低于 ${R.mvrvLow} 表示价格低于全网平均成本。`, low: line("mvrv1") },
    { key: "wma", name: <Term k="200周均线">200 周均线倍数</Term>, value: n.wma.value ? `×${n.wma.value.toFixed(2)}` : "—", pct: n.wma.pct, zone: n.wma.zone, method: `价格 ÷ 最近 ${R.wmaWeeks} 周每周收盘价的平均；低于 ${R.wmaLow} 就是跌破 200 周均线。`, low: line("wma") },
    ...(mode === "pro"
      ? [{ key: "mayer", name: <Term k="Mayer倍数">Mayer 倍数</Term>, value: n.mayer.value?.toFixed(2) ?? "—", pct: n.mayer.pct, zone: n.mayer.zone, method: `价格 ÷ ${R.mayerLen} 日均线；低于 ${R.mayerLow} 偏冷，高于 ${R.mayerHigh} 过热。它常在下跌途中就进入低位。`, low: line("mayer08") }]
      : []),
    { key: "fng", name: <Term k="恐惧贪婪指数">恐惧贪婪</Term>, value: d.fng ? String(d.fng.value) : "—", pct: d.fng?.pct ?? null, zone: d.fng?.zone ?? null, method: `alternative.me 每天的情绪分数（0–100）；≤ ${R.fngFear} 极度恐惧，≥ ${R.fngGreed} 极度贪婪。它一半由价格涨跌算出，只描述情绪。` },
  ];
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Card title="尺子：现在在自己历史里的什么位置" extra="点一行看算法">
      <ul className="space-y-3">
        {rows.map((r) => (
          <li key={r.key}>
            <button className="block w-full text-left" onClick={() => setOpen(open === r.key ? null : r.key)} aria-expanded={open === r.key}>
              <div className="flex items-center gap-2 text-[13px]">
                <span className="font-medium">{r.name}</span>
                <span className="num text-ink-2">{r.value}</span>
                <span className="num ml-auto text-[12px] text-ink-3">分位 {pct(r.pct)}</span>
                <ZoneChip zone={r.zone} />
              </div>
              <PctBar p={r.pct} />
            </button>
            {open === r.key && (
              <div className="mt-1.5 space-y-0.5 rounded-lg bg-panel-2 px-3 py-2 text-[12px] leading-relaxed text-ink-2">
                <p>{r.method}</p>
                {r.low && <p className="num">{lowLineText(r.low, d.live.price)}</p>}
              </div>
            )}
          </li>
        ))}
      </ul>
      <p className="mt-3 text-[11px] leading-relaxed text-ink-3">
        分位 = 今天的值在之前所有日子里排在第几（只用当天之前的数据，至少要有 2 年历史）。最低 {Math.round(R.pctLow * 100)}% 叫历史低位，最高 {Math.round((1 - R.pctHigh) * 100)}% 叫历史高位，阈值在看研究结果之前就定好了。
      </p>
    </Card>
  );
}

function PctBar({ p }: { p: number | null }) {
  return (
    <div className="relative mt-1.5 h-3 overflow-visible rounded-full bg-panel-2" aria-hidden="true">
      <div className="absolute inset-y-0 left-0 rounded-l-full" style={{ width: "20%", background: "var(--up-soft)" }} />
      <div className="absolute inset-y-0 right-0 rounded-r-full" style={{ width: "20%", background: "var(--down-soft)" }} />
      {p != null && <div className="absolute -inset-y-1 w-1 -translate-x-1/2 rounded bg-ink" style={{ left: `${Math.min(100, Math.max(0, p * 100))}%` }} />}
    </div>
  );
}

/** ⑤ Someone's market-cap zones, converted at today's supply. Always labeled as an opinion. */
export function OpinionCard({ d }: { d: SpotPage }) {
  const o = d.opinion;
  if (!o.zones.length) return null;
  const capText = (from: number, to: number) => (from === to ? fmtCap(from) : from === 0 ? `${fmtCap(to)}以下` : `${fmtCap(from).replace(" 万亿美元", "")}–${fmtCap(to)}`);
  const priceText = (from: number, to: number) => (from === to ? fmtUsd(from) : from === 0 ? `${fmtUsd(to)} 以下` : `${fmtUsd(from)}–${fmtUsd(to)}`);
  return (
    <Card
      title={
        <span className="flex items-center gap-1.5">
          <OpinionTag /> 市值分区
        </span>
      }
    >
      <p className="mb-2 text-[12px] text-accent">
        观点，不是研究结论 · 来源 {o.source}（{o.date}）
      </p>
      <ul className="space-y-1.5 text-[13px] leading-relaxed">
        {o.zones.map((z) => (
          <li key={z.label} className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-ink">“{z.label}”</span>
            <span className="num text-ink-3">市值 {capText(z.from, z.to)}</span>
            <span className="num ml-auto font-medium">≈ {priceText(z.priceFrom, z.priceTo)}</span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[11px] leading-relaxed text-ink-3">
        按 {d.asOfDay} 的流通量 {d.now.supply ? Math.round(d.now.supply).toLocaleString("en-US") : "—"} 枚换算成价格。流通量每年增加约 0.8%，同一个市值对应的价格会慢慢下移。这些区间是别人的判断，没有经过本站的研究检验。
      </p>
    </Card>
  );
}

/** ⑥ Fear & Greed today, a week and a month ago; description only. */
export function FngCard({ d }: { d: SpotPage }) {
  const f = d.fng;
  return (
    <Card title={<Term k="恐惧贪婪指数">恐惧贪婪指数</Term>} extra={f ? `${f.day} · alternative.me` : undefined}>
      {!f ? (
        <p className="text-[13px] text-ink-3">数据缺：恐惧贪婪指数还没下载到。</p>
      ) : (
        <>
          <div className="flex items-end gap-3">
            <span className="num text-[32px] font-semibold leading-none">{f.value}</span>
            <span className="pb-0.5 text-[15px] font-medium">{f.label}</span>
            <span className="ml-auto pb-0.5">
              <ZoneChip zone={f.zone} />
            </span>
          </div>
          <div className="num mt-2 grid grid-cols-3 gap-2 text-[12px] text-ink-2">
            <div className="rounded-lg bg-panel-2 px-2 py-1.5">
              <div className="text-ink-3">7 天前</div>
              <b className="text-ink">{f.ago7 ?? "—"}</b>
            </div>
            <div className="rounded-lg bg-panel-2 px-2 py-1.5">
              <div className="text-ink-3">30 天前</div>
              <b className="text-ink">{f.ago30 ?? "—"}</b>
            </div>
            <div className="rounded-lg bg-panel-2 px-2 py-1.5">
              <div className="text-ink-3">历史分位</div>
              <b className="text-ink">{pct(f.pct)}</b>
            </div>
          </div>
          <p className="mt-3 text-[13px] leading-relaxed text-ink-2">
            历史上（2018 年起）极度恐惧之后 1–6 个月，比特币平均反而比同期略差；极度贪婪之后略好。都不显著，所以这里只描述情绪，不作买卖依据。
          </p>
          <p className="mt-1 text-[11px] text-ink-3">
            {FNG_BANDS.map((b, i) => `${i ? FNG_BANDS[i - 1].max + 1 : 0}–${b.max} ${b.label}`).join(" · ")}（alternative.me 的分档）。
          </p>
        </>
      )}
    </Card>
  );
}
