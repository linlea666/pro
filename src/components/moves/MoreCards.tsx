"use client";

import { Fragment, useState } from "react";
import type { MovesView as View } from "@/lib/moves";
import { REBOUND_DAYS, REBOUND_MIN_N, type LadderRow, type ReboundRow } from "@/lib/ta/moves";
import { Card, day, every, price, signed, type Mode } from "./moves-ui";

/** Three steps for a beginner: how big, where the prices are, how much leverage. */
export function HowTo() {
  const steps = [
    ["看现在算不算大", "同样跌 3%，有时候很平常，有时候一年才几次。先看下面的标签：平常、偏大、大、很大、极端。"],
    ["看价格梯", "再跌（涨）几个百分点是什么价格，历史上一天之内走到那里的日子有多少。"],
    ["看杠杆表再下单", "按历史波动，你开的杠杆多久会被一根影线打爆。止损和仓位要按这个来定。"],
  ];
  return (
    <section className="card p-4">
      <h2 className="text-[15px] font-semibold">这一页怎么用</h2>
      <ol className="mt-2 grid gap-2 sm:grid-cols-3">
        {steps.map(([t, d], i) => (
          <li key={t} className="rounded-lg bg-panel-2 p-3 text-[13px] leading-relaxed">
            <div className="font-medium">
              {i + 1}. {t}
            </div>
            <p className="mt-0.5 text-[12px] text-ink-3">{d}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Which period the numbers use; when it is not all history, the extreme it leaves out. */
export function PeriodNote({ v }: { v: View }) {
  const w = v.allWorstDay;
  return (
    <p className="rounded-lg bg-panel-2 px-3 py-2 text-[12px] leading-relaxed text-ink-2">
      下面的统计都按「{v.periodName}」算（{day(v.periodFrom)} 起，{v.buckets.days.toLocaleString("en-US")} 天）。
      {v.period === "main" && v.coin === "BTC" && " 美国比特币现货 ETF 2024-01-11 开始交易，之后单日涨跌明显变小；不过 2023 年本来也一样平稳，波动是一阵大一阵小，不全是 ETF 的原因。"}
      {v.period === "main" && v.coin === "ETH" && " 以太坊的现货 ETF 2024-07 开始交易，之后波动没有明显变小，所以按最近 2 年算。"}
      {v.period !== "all" && w && (
        <b className="font-medium text-ink">
          {" "}
          平稳期会低估极端情况：全部历史里最大的单日跌幅是 <span className="num text-down">{signed(w.pct, 1)}</span>（{day(w.t)}），这段时间的数据里看不到。
        </b>
      )}
    </p>
  );
}

// ---------------------------------------------------------------- price ladder

function LadderSide({ v, dir, mode }: { v: View; dir: 1 | -1; mode: Mode }) {
  const L = v.ladder!;
  const rows = dir < 0 ? L.down : L.up;
  const sofar = dir < 0 ? L.sofarDn : L.sofarUp;
  const given = dir < 0 ? L.givenDn : L.givenUp;
  const now = v.price != null ? (v.price / L.ref - 1) * 100 : null;
  // the live price sits between the steps it has passed and the next one
  const at = now == null ? -1 : rows.findIndex((r) => r.pct > now * dir);
  const word = dir < 0 ? "跌" : "涨";
  const Row = ({ r }: { r: LadderRow }) => (
    <tr className={`border-t border-line align-top ${r.reached ? "text-ink-3" : ""}`}>
      <td className={`num py-1.5 pr-2 font-medium ${dir < 0 ? "text-down" : "text-up"}`}>
        {dir < 0 ? "−" : "+"}
        {r.pct}%
      </td>
      <td className="num py-1.5 pr-2 text-ink">{price(r.price)}</td>
      <td className="py-1.5 pr-2">
        <span className="num">{r.share}%</span>
        <span className="ml-1 text-[11px] text-ink-3">{every(r.everySec).replace("一次", "")}</span>
      </td>
      {mode === "pro" && <td className="num py-1.5 pr-2">{r.given == null ? "" : `${r.given}%`}</td>}
      <td className="py-1.5 text-[11px]">{r.reached ? "24 小时内已到过" : ""}</td>
    </tr>
  );
  return (
    <div className="min-w-0">
      <h3 className={`mb-1 text-[13px] font-medium ${dir < 0 ? "text-down" : "text-up"}`}>
        {dir < 0 ? "往下跌到哪" : "往上涨到哪"}
      </h3>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[300px] text-[13px]">
          <thead>
            <tr className="text-left text-[11px] text-ink-3">
              <th className="pb-1.5 font-normal">{word}</th>
              <th className="pb-1.5 font-normal">价格</th>
              <th className="pb-1.5 font-normal">一天内到过的日子</th>
              {mode === "pro" && <th className="pb-1.5 font-normal">已{word} {sofar.toFixed(1)}% 的日子里</th>}
              <th className="pb-1.5 font-normal" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <Fragment key={r.pct}>
                {i === at && now != null && now * dir > 0 && (
                  <tr className="border-t border-line bg-panel-2">
                    <td className="num py-1 pr-2 text-[12px] font-medium">现价</td>
                    <td className="num py-1 pr-2 font-medium">{price(v.price)}</td>
                    <td colSpan={mode === "pro" ? 3 : 2} className="py-1 text-[11px] text-ink-3">
                      {signed(now)}
                    </td>
                  </tr>
                )}
                <Row r={r} />
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      {mode === "pro" && given > 0 && (
        <p className="mt-1 text-[11px] leading-relaxed text-ink-3">
          “已{word} {sofar.toFixed(1)}% 的日子里”：历史上一天之内{word}到过 {sofar.toFixed(1)}% 的 {given} 天里，还{word}到过这一档的比例。只是过去的比例，不是预测。
        </p>
      )}
    </div>
  );
}

export function LadderCard({ v, mode }: { v: View; mode: Mode }) {
  if (!v.ladder) return null;
  const L = v.ladder;
  return (
    <Card title="价格梯：再跌（涨）几个点是什么价格" extra={`从 24 小时前的 ${price(L.ref)} 算起`}>
      <p className="mb-3 text-[13px] leading-relaxed text-ink-2">
        24 小时前是 <b className="num text-ink">{price(L.ref)}</b>，这 24 小时里最多跌了 <b className="num text-down">{L.sofarDn.toFixed(2)}%</b>、最多涨了{" "}
        <b className="num text-up">{L.sofarUp.toFixed(2)}%</b>。下面每一档写出对应价格，以及「{v.periodName}」里一天之内走到过那里的日子占多少。
      </p>
      <div className="grid gap-4 lg:grid-cols-2">
        <LadderSide v={v} dir={-1} mode={mode} />
        <LadderSide v={v} dir={1} mode={mode} />
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-ink-3">
        “一天内到过”按 UTC 日线算：从前一天收盘到当天最低（最高）价走了多远，和“24 小时前的价格”是同一个意思。这些是价格的刻度，不是支撑阻力；想看关键位，去实时盯盘。
      </p>
    </Card>
  );
}

// ---------------------------------------------------------------- after big days

export function AfterBig({ v, mode }: { v: View; mode: Mode }) {
  const [dir, setDir] = useState<1 | -1>(-1);
  const rows = dir < 0 ? v.afterDrops : v.afterRises;
  const base = rows[rows.length - 1];
  const word = dir < 0 ? "跌" : "涨";
  const backWord = dir < 0 ? "收盘更高" : "收盘更低";
  const onWord = dir < 0 ? "继续跌" : "继续涨";
  const i1 = REBOUND_DAYS.indexOf(1), i3 = REBOUND_DAYS.indexOf(3);
  const pick = rows.find((r) => r.min === 5 && r.n >= REBOUND_MIN_N) ?? rows.find((r) => r.min === 3 && r.n >= REBOUND_MIN_N);
  const pctCell = (x: number | null) => (x == null ? "—" : `${x.toFixed(0)}%`);
  const label = (r: ReboundRow) => (r.min == null ? "所有日子（对照）" : `单日${word} ${r.min}% 以上`);
  return (
    <Card
      title={dir < 0 ? "大跌之后：反弹了多少" : "大涨之后：回落了多少"}
      extra={
        <div className="flex items-center gap-1 rounded-full border border-line p-0.5 text-[12px]">
          {([-1, 1] as const).map((k) => (
            <button key={k} onClick={() => setDir(k)} className={`rounded-full px-2.5 py-0.5 ${dir === k ? "bg-ink text-bg" : "text-ink-2"}`}>
              {k < 0 ? "跌后反弹" : "涨后回落"}
            </button>
          ))}
        </div>
      }
    >
      {pick && (
        <p className="mb-3 text-[13px] leading-relaxed text-ink-2">
          「{v.periodName}」里单日{word} {pick.min}% 以上 {pick.n} 次：第二天{backWord}的占 <b className="num text-ink">{pctCell(pick.back[i1])}</b>、{onWord}的占{" "}
          <b className="num text-ink">{pctCell(pick.on[i1])}</b>（随便哪一天之后是 {pctCell(base.back[i1])} / {pctCell(base.on[i1])}）；3 天后{backWord}的占{" "}
          <b className="num text-ink">{pctCell(pick.back[i3])}</b>（平时 {pctCell(base.back[i3])}）。之后 3 天里从当天{dir < 0 ? "最低点最多反弹" : "最高点最多回落"}一半的时候有 {pick.bounce?.toFixed(1)}%，平时也有 {base.bounce?.toFixed(1)}%。
        </p>
      )}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-[13px]">
          <thead>
            <tr className="text-left text-[11px] text-ink-3">
              <th className="pb-1.5 font-normal">那一天</th>
              <th className="pb-1.5 font-normal">次数</th>
              <th className="pb-1.5 font-normal">3 天内{dir < 0 ? "从最低点反弹" : "从最高点回落"}（中位）</th>
              {REBOUND_DAYS.map((k) => (
                <Fragment key={k}>
                  <th className="pb-1.5 font-normal">
                    {k === 1 ? "第二天" : `${k} 天后`}
                    {backWord}
                  </th>
                  {k === 1 && <th className="pb-1.5 font-normal">第二天{onWord}</th>}
                </Fragment>
              ))}
              {mode === "pro" &&
                REBOUND_DAYS.map((k) => (
                  <th key={`m${k}`} className="pb-1.5 font-normal">
                    {k === 1 ? "第二天" : `${k} 天后`}涨跌（中位）
                  </th>
                ))}
            </tr>
          </thead>
          <tbody className="num">
            {rows.map((r) => {
              const few = r.min != null && r.n < REBOUND_MIN_N;
              return (
                <tr key={r.min ?? "base"} className={`border-t border-line ${r.min == null ? "bg-panel-2" : ""} ${few ? "text-ink-3" : ""}`}>
                  <td className="py-1.5 pr-2">{label(r)}</td>
                  <td className="py-1.5 pr-2">
                    {r.n}
                    {few && <span className="ml-1 text-[10px]">样本太少</span>}
                  </td>
                  <td className="py-1.5 pr-2">{r.bounce == null ? "—" : `${r.bounce.toFixed(1)}%`}</td>
                  {r.back.map((x, k) => (
                    <Fragment key={k}>
                      <td className="py-1.5 pr-2">{pctCell(x)}</td>
                      {REBOUND_DAYS[k] === 1 && <td className="py-1.5 pr-2">{pctCell(r.on[k])}</td>}
                    </Fragment>
                  ))}
                  {mode === "pro" &&
                    r.med.map((x, k) => (
                      <td key={`m${k}`} className="py-1.5 pr-2">
                        {signed(x, 1)}
                      </td>
                    ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="mt-2 space-y-1 text-[11px] leading-relaxed text-ink-3">
        <p>
          怎么看：拿每一行和最后一行“所有日子”比。{dir < 0 ? "反弹" : "回落"}几乎每次都会有，平常的日子也一样；真正要看的是之后{backWord}的比例比平时高多少。“第二天”是那一天收盘之后的下一根日线（UTC 0 点到 0 点），收盘不变的天两边都不算。差不到 10 个百分点，就当作和平时一样。
        </p>
        <p>
          大{word}之后{dir < 0 ? "反弹" : "回落"}的幅度往往更大，是因为大{word}之后波动本来就更大，往两个方向都走得更远。每次至少隔 7 天，同一轮行情只算一次；次数少于 {REBOUND_MIN_N} 的行灰色显示，没有做显著性检验。
        </p>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- volatility and streaks (pro)

export function VolStreak({ v }: { v: View }) {
  const s = v.vol.series;
  const W = 600, H = 120;
  const max = Math.max(1, ...s.map((x) => x.pct));
  const x0 = s.length ? s[0].t : 0, x1 = s.length ? s[s.length - 1].t : 1;
  const X = (t: number) => ((t - x0) / Math.max(1, x1 - x0)) * W;
  const Y = (p: number) => H - (p / max) * (H - 8) - 2;
  const st = v.streak;
  const run = (k: typeof st.current) =>
    k ? (
      <>
        <span className="num">{k.n}</span> 天（{day(k.from)} 至 {day(k.to)}，累计 <span className={`num ${k.dir < 0 ? "text-down" : "text-up"}`}>{signed(k.pct, 1)}</span>）
      </>
    ) : (
      "—"
    );
  return (
    <Card title="波动率和连涨连跌（专业模式）">
      <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <div className="min-w-0">
          <p className="mb-1 text-[12px] text-ink-3">
            最近 30 天的已实现波动率（年化）：<b className="num text-ink">{v.vol.now?.toFixed(0) ?? "—"}%</b>，在「{v.periodName}」里比{" "}
            <span className="num">{v.vol.rank ?? "—"}%</span> 的时候高；中位数 {v.vol.p50?.toFixed(0) ?? "—"}%。
          </p>
          {s.length > 1 && (
            <svg viewBox={`0 0 ${W} ${H}`} className="h-28 w-full" preserveAspectRatio="none" role="img" aria-label="30 天波动率走势">
              {v.vol.p50 != null && <line x1={0} x2={W} y1={Y(v.vol.p50)} y2={Y(v.vol.p50)} stroke="currentColor" className="text-ink-3" strokeDasharray="4 4" strokeWidth={1} vectorEffect="non-scaling-stroke" />}
              <polyline fill="none" stroke="currentColor" className="text-ink-2" strokeWidth={1.5} vectorEffect="non-scaling-stroke" points={s.map((p) => `${X(p.t).toFixed(1)},${Y(p.pct).toFixed(1)}`).join(" ")} />
            </svg>
          )}
          <div className="flex justify-between text-[10px] text-ink-3">
            <span>{day(s[0]?.t)}</span>
            <span>虚线：中位数</span>
            <span>{day(s[s.length - 1]?.t)}</span>
          </div>
        </div>
        <div className="space-y-1.5 text-[13px] leading-relaxed text-ink-2">
          <p>
            现在：{st.current ? `连续 ${st.current.dir < 0 ? "下跌" : "上涨"} ` : ""}
            {st.current ? run(st.current) : "—"}
          </p>
          <p>最长连跌：{run(st.longestDown)}</p>
          <p>最长连涨：{run(st.longestUp)}</p>
          <p className="text-[11px] text-ink-3">按日线收盘一天比一天低（高）算。波动有“扎堆”的特点：大波动后面常跟着大波动，这只说幅度，不说方向。</p>
        </div>
      </div>
    </Card>
  );
}
