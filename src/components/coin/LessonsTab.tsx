"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { ScoreRow, TrendPlan } from "@/lib/trendplan";
import type { WatchView } from "@/lib/watch";
import { TF_LABEL, type Timeframe } from "@/lib/types";
import { Term } from "../Term";
import { fmtPrice } from "./format";
import { fmtR, lossStreakProb, noiseAt, returnCorrelation } from "./plan-ui";
import { Section } from "./shared";

/**
 * Lessons built on real numbers: the visitor's own kind of mistakes, each with what the
 * research measured on this site's history and a replay of a real moment to look at.
 */

interface Case {
  title: string;
  /** open time of the bar to replay (of `tf`, 4 hours unless given), Unix seconds (UTC) */
  at: number;
  tf?: Timeframe;
  /** the tab the replay opens on (the plan unless given) */
  tab?: "plan" | "watch";
  story: string;
  lesson: string;
}

const H4 = (iso: string) => Date.parse(iso) / 1000;

/** BTC moments from 2026 (UTC open times: 4-hour bars on the plan, 15-minute bars on the watch). */
const CASES: Case[] = [
  {
    title: "9/23 在 87,000 附近做空，止损贴着前高",
    at: H4("2026-09-23T00:00:00Z"),
    story: "9/21 冲到约 87,400 后回落，很多人在 87,000、86,500 开空，止损放在 87,400 一带，只比前高多几个点。",
    lesson: "回放这一刻：4 小时还是上升结构，日线在向上脱离区间，做空是逆大周期，而且离结构保护位太远。页面要等收盘跌破最近的更高低点（约 85,100）才给做空计划，认错位放在更低的高点之外再加一段扫损缓冲。",
  },
  {
    title: "9/23 收盘跌破 85,080：上升结构被打破",
    at: H4("2026-09-23T12:00:00Z"),
    story: "先出现更低的高点（约 87,250），再收盘跌破最近的更高低点（约 85,080）。",
    lesson: "这是上升结构被打破的样子，页面给出逆大周期的半仓做空。不过这一次按规则移动认错位，在 10 月初冲回 87,000 附近的反弹里被扫、小亏离场；止损一直不动的人反而拿到了后面的下跌。规则不保证每次都更好，回放会照实显示结果。",
  },
  {
    title: "7/1 在 57,800 附近抄底做多",
    at: H4("2026-07-01T00:00:00Z"),
    story: "价格刚刚刺到约 57,800，日线还在下降趋势里，很多人觉得“跌太多了”。",
    lesson: "回放这一刻：日线下降、4 小时区间，做多是逆大周期，计划要求等 4 小时收盘站上前高再进，只用半仓，认错位放在这个新低之下。",
  },
  {
    title: "8/19 放量突破，觉得“太高”不敢追",
    at: H4("2026-08-19T12:00:00Z"),
    story: "一根 4 小时 K 线从约 64,500 拉到 68,500，成交量是平时的好几倍。",
    lesson: "回放这一刻：页面给出“已触发：突破跟随做多”，认错位在突破前的低点之下，之后按移动认错位拿着。价格高不是理由，结构才是。",
  },
  {
    title: "10/15 扫过 80,345 后收回",
    at: H4("2026-10-15T04:00:00Z"),
    story: "价格跌破之前没被收盘跌破的 4 小时低点 80,345，最低到约 80,190 后收回，随后一根 4 小时 K 线收盘拐上。",
    lesson: "回放这一刻：做多计划卡下面会多出一栏“守位做法”，给出远、近两档止损（按风险算仓位，两档亏的钱一样），并标出这种做法在历史上的表现。之后怎么走，看回放结果。",
  },
  {
    title: "10/8 碰到上周低点 82,500：等到了转强",
    at: H4("2026-10-08T07:15:00Z"),
    tf: "15m",
    tab: "watch",
    story: "价格碰到上周低点 82,500 后几次创新低，最低 82,150。",
    lesson: "回放这一刻：15 分钟走出更高的低点、收盘站上反弹高点，页面显示“已转强”，止损在 82,150 之外。之后怎么走，看回放结果；转强以后再创新低，页面会回到“别接”，并记为第几次尝试。",
  },
  {
    title: "10/15 跌破 80,345：一直在创新低",
    at: H4("2026-10-15T13:45:00Z"),
    tf: "15m",
    tab: "watch",
    story: "价格先后碰到前一日低点、上周低点 80,345 和 4 小时摆动低点 80,096，最低 79,732。",
    lesson: "回放这一刻：页面一直是“别接”。等转强的代价是有时会错过一段——回放会显示之后发生了什么。",
  },
];

export function LessonsTab({ p, coin, onReplay }: { p: TrendPlan | null; coin: string; onReplay: (tf: Timeframe, at: number, coin: string, tab?: "plan" | "watch") => void }) {
  const row = (k: string) => p?.lessons.find((r) => r.key === k) ?? null;
  const dRow = (k: string) => p?.defendLessons.find((r) => r.key === k) ?? null;
  const nf = p?.nearFar.plans ?? null;
  const tf = p?.tf ?? "4h";
  const hit = p?.scorecard?.rows[0]?.hit ?? null;
  const [peer, setPeer] = useState<TrendPlan | null>(null);
  const peerCoin = coin === "BTC" ? "ETH" : "BTC";
  useEffect(() => {
    let alive = true;
    fetch(`/api/plan?coin=${peerCoin}&fw=4h`)
      .then((r) => r.json())
      .then((b) => alive && !b.error && setPeer(b))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [peerCoin]);
  const corr = p && peer ? returnCorrelation(p.daily, peer.daily) : null;
  // what the research says about waiting at key levels (the live watch carries it)
  const [watchText, setWatchText] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    fetch(`/api/watch?coin=${coin}`)
      .then((r) => r.json())
      .then((b: WatchView & { error?: string }) => alive && !b.error && setWatchText(b.research?.text ?? null))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [coin]);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Section title="1. 止损贴着前高 / 前低，为什么总被扫" className="lg:col-span-2">
        <div className="space-y-2 text-[14px] leading-relaxed text-ink-2">
          <p>
            守住的关键位也常被影线刺穿：在 BTC / ETH 的历史里，价格最后没有突破的高低点，一半的情况下影线还会多走 0.35–0.48 倍 ATR 以上，2 成的情况会多走 0.67–0.84 倍以上。止损放在前高上面几个点，等于把它放进了噪音里。
          </p>
          {p && (
            <p>
              {coin} {TF_LABEL[tf]}现在 1 倍 ATR ≈ <b className="num text-ink">{fmtPrice(p.atr)}</b>。{p.calibrated ? "按这个币自己的历史" : "这个币还没校准，暂按 BTC / ETH 的历史"}，认错位放在结构点外{" "}
              <b className="num text-ink">{p.buffers.p50.toFixed(2)}–{p.buffers.p90.toFixed(2)}</b> 倍 ATR（约 {fmtPrice(p.buffers.p50 * p.atr)}–{fmtPrice(p.buffers.p90 * p.atr)}），默认取 {p.buffers.p80.toFixed(2)} 倍。
              {p.noise && (
                <>
                  {" "}
                  从任意时点算，{p.noiseHorizon}内正常波动碰到 0.5 倍 ATR 外止损的概率约 {noiseAt(p, 0.5)}%，1.5 倍约 {noiseAt(p, 1.5)}%，3 倍约 {noiseAt(p, 3)}%。
                </>
              )}
            </p>
          )}
          <p>
            正确做法：先找<Term k="认错区间">认错区间</Term>，再按止损距离算仓位，止损远就把仓位做小，亏损额不变。
          </p>
          <Evidence r={row("behavior:tight")} what="止损贴着入场价（0.3 倍 ATR）" vs="按计划放认错位" />
        </div>
      </Section>

      <Section title="2. 价格高低不是理由，结构才是">
        <div className="space-y-2 text-[14px] leading-relaxed text-ink-2">
          <p>“涨太多了不敢追、跌太多了不敢空”，是把价格当成了理由。下面是 20 根 K 线涨跌幅最大的那 20% 时点之后的表现：</p>
          <Evidence r={row("anchor:after_rally")} what="大涨之后继续做多" vs="任意时点做多" />
          <Evidence r={row("anchor:after_drop")} what="大跌之后继续做空" vs="任意时点做空" />
          <Evidence r={row("behavior:fade")} what="觉得太高 / 太低，反着突破做" vs="跟随突破" />
          <p className="text-[12px] leading-relaxed text-ink-3">{anchorSummary(row("anchor:after_rally"), row("anchor:after_drop"), row("behavior:fade"))}</p>
        </div>
      </Section>

      <Section title="3. 拿住盈利靠移动认错位">
        <div className="space-y-2 text-[14px] leading-relaxed text-ink-2">
          <p>
            很多人方向做对了却没赚到：赚一点就跑，或者被一次回调洗出去。计划里的做法是<Term k="移动止损">每确认一个新的更高低点，就把认错位移到它下面</Term>，不设固定止盈。
          </p>
          <Evidence r={row("exit:structure")} what="跟着结构移动认错位" vs="固定 2R 止盈" />
          <Evidence r={row("behavior:early")} what="赚 0.5R 就走" vs="按计划移动认错位" />
          <Evidence r={row("behavior:against")} what="逆着大周期做" vs="顺着大周期做" />
        </div>
      </Section>

      <Section title="4. 连续止损很正常，要提前准备">
        <div className="space-y-2 text-[14px] leading-relaxed text-ink-2">
          {hit != null ? (
            <p>
              按页面计划机械执行，历史胜率约 <b className="num text-ink">{hit}%</b>。这样的胜率下，20 笔里出现连续 5 笔止损的概率约 <b className="num text-ink">{Math.round(lossStreakProb(hit / 100) * 100)}%</b>，连续 3 笔约 {Math.round(lossStreakProb(hit / 100, 20, 3) * 100)}%。
            </p>
          ) : (
            <p>这类顺势规则的胜率通常不到一半，靠少数大赚覆盖多数小亏，所以连续止损是常事。</p>
          )}
          <p>
            规矩先定好：<b className="text-ink">连亏 3 笔就停一停</b>，复盘是不是按计划做的，而不是加大仓位想一把赢回来。每笔按 1% 风险算，连亏 5 笔也只亏约 5%。
          </p>
        </div>
      </Section>

      <Section title="5. 同时做几个币，不等于分散">
        <div className="space-y-2 text-[14px] leading-relaxed text-ink-2">
          {corr != null ? (
            <p>
              最近 90 天，{coin} 和 {peerCoin} 日涨跌的相关系数是 <b className="num text-ink">{corr.toFixed(2)}</b>（1 表示完全同步）。同时做空 BTC、ETH、SOL，差不多就是一笔更大的空单。
            </p>
          ) : (
            <p>主流币之间走势高度相关，同方向开几个币，差不多就是一笔更大的单子。</p>
          )}
          <p>“趋势与计划”页的持仓体检会把同方向的风险加在一起提醒你。</p>
        </div>
      </Section>

      <Section title="6. 一个位值不值，看它失效前走了多远" className="lg:col-span-2">
        <div className="space-y-2 text-[14px] leading-relaxed text-ink-2">
          <p>
            任何关键位迟早都会被突破。一个位值不值得守，要看守着它做，在打到止损之前价格能走多远。用 <Term k="R">R</Term>（止损距离）来量，BTC 的几千点和 ETH 的一百点才能放在一起比。
          </p>
          <p className="rounded-lg border border-line px-3 py-2 text-[13px]">
            <b className="text-ink">个例</b>：BTC 冲到约 87,400 后回落，9/22 晚到 9/23 白天几次回到 86,500–87,000 一带。在这里做空、止损放在位外 0.85 倍 ATR，止损前最远走了 6.4–7.6R（约 6,700–7,200 点）。但按“跟着结构移动认错位”，这几笔都在 10/2 冲回约 87,200 的反弹里离场，最后只拿到 +0.4R 到 +1.0R。好例子总能找到，要看的是所有同类时刻的平均。
          </p>
          {p?.levelReach ? (
            <p>{p.levelReach.text}</p>
          ) : (
            <p className="text-[12px] text-ink-3">（关键位“守到止损能走多远”的研究数字会在服务器生成研究报告后显示。）</p>
          )}
          <Evidence r={dRow("defend:all")} what="守位做法（扫过后收回或长影线拒绝，再收盘拐回就入场）" vs="同方向、同止损距离的随机入场" />
          <p>
            止损放近一点（1 小时极点之外）呢？按风险算仓位，近止损每笔亏的钱和远止损一样，只是仓位更大
            {nf && nf.near.quickPct != null && nf.far.quickPct != null && (
              <>
                ，也更容易被扫：历史上近止损 24 小时内被扫 <b className="num text-ink">{nf.near.quickPct}%</b>，远止损 {nf.far.quickPct}%
              </>
            )}
            。
          </p>
          <Evidence r={dRow("stop2:near:plans")} what="近止损（1 小时极点之外）" vs="同一批入场用远止损" />
          <p>所以计划不靠“这个位一定守得住”：先定认错位，按风险算仓位，跟着结构拿住。</p>
        </div>
      </Section>

      <Section title="7. 碰到关键位别急着接" className="lg:col-span-2">
        <div className="space-y-2 text-[14px] leading-relaxed text-ink-2">
          <p>
            价格跌到上周低点、前一日低点这类关键位时，很多人会想“到支撑了，接一下”。可下跌途中的每一个低点都可能只是半山腰，这就是<Term k="接飞刀">接飞刀</Term>。“实时盯盘”页用三个词描述碰到关键位之后的样子：
          </p>
          <ul className="space-y-1.5 rounded-lg bg-panel-2 px-3 py-2 text-[13px]">
            <li>
              <b className="text-ink">⛔ 别接</b>：碰到以后还在创新低，或者收盘已经落到位的下方。这时买进去，就是在下跌途中猜底。
            </li>
            <li>
              <b className="text-ink">👀 观察</b>：停下来了，暂时没有再创新低（有时是扫过后收回），但 15 分钟还没转强。
            </li>
            <li>
              <b className="text-ink">↗ 已转强</b>：在最新的低点之后，15 分钟先走出更高的低点、再收盘站上最近的反弹高点（<Term k="转强">15 分钟转强</Term>）。转强以后又创新低，页面回到“别接”，并记为第几次尝试。
            </li>
            <li className="text-ink-3">做空反过来：碰到关键高点后“别急着空”，等 15 分钟转弱。</li>
          </ul>
          <p>
            止损为什么放在<b className="text-ink">最新的</b>低点之外？“这里跌不下去了”这个判断，被推翻的地方就是最新的那个低点：再跌破它，说明这次转强作废。止损放在它之外再留一段扫损缓冲（和计划页的认错位一样，来自影线刺穿深度的统计），然后按止损距离算仓位，每笔亏的钱不变。
          </p>
          {watchText ? (
            <p className="rounded-lg border border-line px-3 py-2 text-[13px]">
              <b className="text-ink">研究怎么说</b>：{watchText}
            </p>
          ) : (
            <p className="text-[12px] text-ink-3">研究数字会在服务器生成研究报告后显示。</p>
          )}
          <p className="text-[13px] text-ink-3">转强不是“跌够了”的信号，只是一条纪律：等它出现再进，止损放在最新的低点之外。下面最后两个案例可以回放到“实时盯盘”页看。</p>
        </div>
      </Section>

      <Section title="8. 回放真实案例：当时页面会怎么说" className="lg:col-span-2">
        <p className="mb-3 text-[13px] leading-relaxed text-ink-3">点“回放”会把 BTC 的页面倒回那一刻（那根 K 线收盘时），只用当时已经有的数据给出趋势地图和计划（最后两个案例打开“实时盯盘”，看 15 分钟 K 线），并显示之后真实发生了什么。</p>
        <div className="grid gap-3 md:grid-cols-2">
          {CASES.map((c) => (
            <article key={c.title} className="rounded-lg bg-panel-2 p-3 text-[13px] leading-relaxed">
              <h3 className="font-semibold">{c.title}</h3>
              <p className="mt-1 text-ink-2">{c.story}</p>
              <p className="mt-1 text-ink-2">{c.lesson}</p>
              <button className="mt-2 text-xs text-accent" onClick={() => onReplay(c.tf ?? "4h", c.at, "BTC", c.tab ?? "plan")}>
                {c.tab === "watch" ? "在实时盯盘页回放这一刻 →" : "回放这一刻 →"}
              </button>
            </article>
          ))}
        </div>
        <p className="mt-3 text-[11px] text-ink-3">
          更多概念见 <Link className="text-accent" href="/learn#结构与计划">新手学堂 · 结构与计划</Link>。
        </p>
      </Section>
    </div>
  );
}

/** What the anchoring rows add up to, worded from the numbers (they differ by coin set and over time). */
function anchorSummary(rally: ScoreRow | null, drop: ScoreRow | null, fade: ScoreRow | null): string {
  if (!rally || !drop || !fade) return "看结构是否被打破，比看价格高低更有用。";
  const holds = (rally.edgeR ?? 0) >= 0 && (drop.edgeR ?? 0) >= 0 && (fade.edgeR ?? 0) <= 0;
  const flipped = [rally, drop, fade].some((r) => r.edgeR != null && r.oosEdgeR != null && Math.sign(r.edgeR) !== Math.sign(r.oosEdgeR) && Math.abs(r.oosEdgeR) >= 0.1);
  const head = holds
    ? "在全部历史里，大涨大跌之后继续同方向并不比随机差，反着突破做反而更差：价格高低本身不是反向操作的理由。"
    : "这几项的差别时正时负：价格高低本身说明不了接下来往哪走。";
  return head + (flipped ? "不过最近 12 个月有几项是反过来的：来回拉扯的行情里追突破会吃亏。规则会有失效的阶段，所以仓位要小，并留意计划成绩单。" : "看结构是否被打破，比看价格高低更有用。");
}

/** One research row in plain words: this way of doing it against the other, all history and the last 12 months. */
function Evidence({ r, what, vs }: { r: ScoreRow | null; what: string; vs: string }) {
  if (!r) return <p className="text-[12px] text-ink-3">（“{what}”的研究数字会在服务器生成研究报告后显示。）</p>;
  const e = r.edgeR ?? 0;
  const better = e >= 0;
  return (
    <p className="rounded-lg border border-line px-3 py-2 text-[13px]">
      <b className="text-ink">{what}</b>：{r.n} 笔，平均每笔 <span className="num">{fmtR(r.meanR)}</span>；{vs} <span className="num">{fmtR(r.controlR)}</span>，
      {Math.abs(e) < 0.005 ? (
        "几乎一样"
      ) : (
        <>
          {better ? "多" : "少"} <b className="num" style={{ color: better ? "var(--up)" : "var(--down)" }}>{Math.abs(e).toFixed(2)}R</b>
        </>
      )}
      。最近 12 个月相差 {fmtR(r.oosEdgeR)}（{r.oosN} 笔）。
      <span className="text-ink-3"> {r.verdict === "有优势" || r.verdict === "比随机差" ? "差别在统计上站得住。" : r.verdict === "样本不足" ? "样本还不够。" : "差别在统计上还不能确认。"}</span>
    </p>
  );
}
