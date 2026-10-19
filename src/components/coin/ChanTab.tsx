"use client";

import { useMemo, useState } from "react";
import { PriceChart, type MarkerSpec, type Segment } from "../PriceChart";
import { Term } from "../Term";
import { fmtPrice } from "./format";
import { Explainer, Section } from "./shared";
import type { TabProps } from "./CoinView";
import { MtfStrip } from "./MtfStrip";
import { Explain } from "../Explain";

const POINT_TEXT: Record<string, string> = {
  "1买": "下跌末端力度衰竭，可能见底（风险最大、位置最低）",
  "2买": "一买之后回调没有创新低，底部得到确认",
  "3买": "向上突破中枢后回调不回中枢，上涨延续",
  "1卖": "上涨末端力度衰竭，可能见顶",
  "2卖": "一卖之后反弹没有创新高，顶部得到确认",
  "3卖": "向下跌破中枢后反弹不回中枢，下跌延续",
};

export function ChanTab({ a, mtf, mode, onTf }: TabProps) {
  const ch = a.chan;
  const [showZs, setShowZs] = useState(true);

  const segments = useMemo<Segment[]>(() => {
    const out: Segment[] = [];
    if (ch.bis.length) out.push({ points: [ch.bis[0].from, ...ch.bis.map((b) => b.to)].map((p) => ({ t: p.t, v: p.price })), color: "#3987e5", width: 2 });
    if (showZs)
      for (const z of ch.zhongshus) {
        out.push({ points: [{ t: z.tStart, v: z.zg }, { t: z.tEnd, v: z.zg }], color: "#e0a400", width: 2 });
        out.push({ points: [{ t: z.tStart, v: z.zd }, { t: z.tEnd, v: z.zd }], color: "#e0a400", width: 2 });
      }
    return out;
  }, [ch, showZs]);

  const markers = useMemo<MarkerSpec[]>(
    () =>
      ch.points.map((p) => {
        const buy = p.type.endsWith("买");
        return { t: p.t, position: buy ? "belowBar" : "aboveBar", color: buy ? "#199e70" : "#e66767", text: p.type, shape: buy ? "arrowUp" : "arrowDown", size: 1 };
      }),
    [ch],
  );

  const lastZ = ch.zhongshus[ch.zhongshus.length - 1];
  const recent = [...ch.points].reverse().slice(0, 6);

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
      <div className="min-w-0 space-y-4">
        <section className="card p-3">
          <div className="mb-1 flex items-center gap-3 px-1 text-xs text-ink-3">
            <span><span className="mr-1 inline-block h-0.5 w-3 bg-accent align-middle" />蓝色折线 = 笔</span>
            <span><span className="mr-1 inline-block h-0.5 w-3 bg-warn align-middle" />黄色上下线 = 中枢</span>
            <label className="ml-auto flex cursor-pointer items-center gap-1.5">
              <input type="checkbox" checked={showZs} onChange={(e) => setShowZs(e.target.checked)} />
              显示中枢
            </label>
          </div>
          <PriceChart candles={a.candles} segments={segments} markers={markers} height={460} initialBars={260} showVolume={mode === "pro"} />
        </section>
        <Explainer title="3 分钟看懂缠论（简化版）" defaultOpen={mode === "beginner"}>
          <p>
            <b className="text-ink">笔：</b>把走势简化成“一波涨、一波跌”的折线，过滤掉小波动。（<Term k="笔">什么是笔</Term>）
          </p>
          <p>
            <b className="text-ink">中枢：</b>连续三笔重叠的区域，是多空反复争夺的地方。价格在中枢上方偏强，下方偏弱。（<Term k="中枢">什么是中枢</Term>）
          </p>
          <p>
            <b className="text-ink">买卖点：</b>围绕中枢定义了三类买点和三类卖点（<Term k="三买">详细解释</Term>）。本站为简化实现，便于对照学习，严格的缠论还涉及线段和多级别联立。
          </p>
        </Explainer>
      </div>
      <div className="space-y-4">
        <MtfStrip kind="chan" mtf={mtf} current={a.tf} onTf={onTf} />
        <Section title="结构概况">
          <p className="text-[13px] leading-relaxed text-ink-2">{ch.explain}</p>
          <div className="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
            <div className="rounded-lg bg-panel-2 p-2"><div className="text-ink-3">笔</div><div className="num text-base font-medium">{ch.bis.length}</div></div>
            <div className="rounded-lg bg-panel-2 p-2"><div className="text-ink-3">中枢</div><div className="num text-base font-medium">{ch.zhongshus.length}</div></div>
            <div className="rounded-lg bg-panel-2 p-2"><div className="text-ink-3">买卖点</div><div className="num text-base font-medium">{ch.points.length}</div></div>
          </div>
          {lastZ && (
            <p className="mt-3 text-xs text-ink-3 num">
              最近中枢：{fmtPrice(lastZ.zd)} – {fmtPrice(lastZ.zg)}
            </p>
          )}
        </Section>
        <Section title="最近的买卖点">
          {recent.length === 0 ? (
            <p className="text-[13px] text-ink-3">图表范围内没有识别到买卖点。</p>
          ) : (
            <ul className="space-y-2">
              {recent.map((p) => {
                const buy = p.type.endsWith("买");
                return (
                  <li key={`${p.t}${p.type}`} className="rounded-lg bg-panel-2 p-2.5">
                    <div className="flex items-center gap-2 text-sm">
                      <Explain k="三买" variant="plain" now={POINT_TEXT[p.type]}>
                        <b style={{ color: buy ? "var(--up)" : "var(--down)" }}>{buy ? "↑" : "↓"} {p.type}</b>
                      </Explain>
                      <span className="num text-xs text-ink-3">{fmtPrice(p.price)}</span>
                      <span className="ml-auto text-[11px] text-ink-3">{new Date(p.t * 1000).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
                    </div>
                    <p className="mt-0.5 text-xs text-ink-2">{POINT_TEXT[p.type]}</p>
                  </li>
                );
              })}
            </ul>
          )}
        </Section>
      </div>
    </div>
  );
}
