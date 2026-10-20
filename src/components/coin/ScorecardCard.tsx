"use client";

import { useEffect, useState } from "react";
import type { Scorecard, LightRecord } from "@/lib/server/scorecard";
import { TF_LABEL, type Timeframe } from "@/lib/types";
import { Section } from "./shared";

const SCORECARD_TFS: Timeframe[] = ["1h", "4h", "1d"];

/** The traffic light's own replayed track record, so visitors can judge it instead of trusting it. */
export function ScorecardCard({ coin, tf, horizonText }: { coin: string; tf: Timeframe; horizonText: string }) {
  const [d, setD] = useState<{ mine: Scorecard | null; all: Scorecard } | null>(null);
  const supported = SCORECARD_TFS.includes(tf);
  useEffect(() => {
    let alive = true;
    setD(null);
    if (!supported) return;
    fetch(`/api/scorecard?coin=${coin}&tf=${tf}`)
      .then((r) => r.json())
      .then((b) => alive && b.status === "ok" && setD(b))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [coin, tf, supported]);

  if (!supported || !d) return null;
  const s = d.mine && d.mine.points >= 30 ? d.mine : d.all;
  const scope = s === d.mine ? `${coin} ${TF_LABEL[tf]}` : `全部币种 ${TF_LABEL[tf]}`;
  return (
    <Section title="信号灯自己的成绩单">
      {s.points < 30 ? (
        <p className="text-[13px] leading-relaxed text-ink-3">成绩单正在后台累计（目前 {s.points} 个样本），够 30 个后显示。引擎参数一改就会重新累计。</p>
      ) : (
        <div className="space-y-2.5 text-[13px] leading-relaxed text-ink-2">
          <p className="text-xs text-ink-3">
            {scope}：用时光机回放过去每隔 {horizonText}的结论，看 {horizonText}后价格怎么走（已扣 {s.costPct}% 成本，共 {s.points} 个时点）。
          </p>
          <Row r={s.green} label="绿灯（偏多）" up />
          <Row r={s.red} label="红灯（偏空）" />
          <p>
            <b className="text-ink">黄灯（观望）</b> {s.yellow.samples} 次：之后平均波动 {s.yellow.avgAbsMove ?? "—"}%，所有时点平均 {s.yellow.allAvgAbsMove ?? "—"}%。黄灯只说“方向不明”，不算对错。
          </p>
          <p className="text-[11px] text-ink-3">区间是 95% 置信区间：样本少时区间很宽，说明还看不出好坏。命中率的“随机”是同期任意时点做同方向的结果。较早的时点本站没有保存 15 分钟等小周期的完整历史，回放时少了这些周期的关键位，所以和当时实际显示的结论可能略有出入。</p>
        </div>
      )}
    </Section>
  );
}

function Row({ r, label, up = false }: { r: LightRecord; label: string; up?: boolean }) {
  if (!r.samples) return <p><b className="text-ink">{label}</b> 暂无样本</p>;
  const better = r.hitLo != null && r.baseRate != null && r.hitLo > r.baseRate;
  const worse = r.hitHi != null && r.baseRate != null && r.hitHi < r.baseRate;
  return (
    <p>
      <b className="text-ink">{label}</b> {r.samples} 次：{up ? "之后上涨" : "之后下跌"}的比例 <b className="num text-ink">{r.hitRate}%</b>
      <span className="text-ink-3">（{r.hitLo}–{r.hitHi}%）</span>，随机 {r.baseRate}%，平均{(r.avgReturn ?? 0) >= 0 ? "赚" : "亏"} {Math.abs(r.avgReturn ?? 0).toFixed(2)}%。
      <span style={{ color: better ? "var(--up)" : worse ? "var(--down)" : "var(--text-3)" }}>{better ? "明显好于随机" : worse ? "明显差于随机" : "和随机分不开"}</span>
    </p>
  );
}
