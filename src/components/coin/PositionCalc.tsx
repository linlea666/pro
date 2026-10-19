"use client";

import { useEffect, useState } from "react";
import { Term } from "../Term";
import { Section } from "./shared";
import { fmtPrice } from "./format";

/** Position size from the 2% rule: how much to buy so a stop-out costs at most X% of capital. */
export function PositionCalc({ price, stopRef, coin }: { price: number; stopRef: number | null; coin: string }) {
  const [capital, setCapital] = useState(1000);
  const [riskPct, setRiskPct] = useState(2);
  const [entry, setEntry] = useState(price);
  const [stop, setStop] = useState(stopRef && stopRef < price ? stopRef : price * 0.95);

  useEffect(() => {
    setEntry(price);
    setStop(stopRef && stopRef < price ? stopRef : price * 0.95);
    // re-seed only when the coin or suggested stop changes, not on every tick
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coin, stopRef]);

  const dist = (entry - stop) / entry;
  const valid = capital > 0 && riskPct > 0 && entry > 0 && stop > 0 && stop < entry;
  const maxLoss = (capital * riskPct) / 100;
  const size = valid ? Math.min(capital, maxLoss / dist) : 0;
  const capped = valid && maxLoss / dist > capital;
  const qty = valid ? size / entry : 0;

  const field = "num w-full rounded-lg border border-line bg-panel-2 px-2.5 py-1.5 text-sm outline-none focus:border-accent";
  return (
    <Section title={<>仓位计算器 <span className="text-xs font-normal text-ink-3">（<Term k="仓位">2% 法则</Term>）</span></>}>
      <div className="grid grid-cols-2 gap-2.5 text-xs text-ink-3">
        <label className="space-y-1">
          <span>总资金 (USDT)</span>
          <input type="number" className={field} value={capital} min={0} onChange={(e) => setCapital(+e.target.value)} />
        </label>
        <label className="space-y-1">
          <span>最多愿意亏 (%)</span>
          <input type="number" className={field} value={riskPct} min={0.1} max={20} step={0.5} onChange={(e) => setRiskPct(+e.target.value)} />
        </label>
        <label className="space-y-1">
          <span>买入价</span>
          <input type="number" className={field} value={+entry.toPrecision(6)} onChange={(e) => setEntry(+e.target.value)} />
        </label>
        <label className="space-y-1">
          <span><Term k="止损">止损价</Term></span>
          <input type="number" className={field} value={+stop.toPrecision(6)} onChange={(e) => setStop(+e.target.value)} />
        </label>
      </div>
      <div className="mt-3 rounded-lg bg-panel-2 p-3 text-[13px] leading-relaxed">
        {valid ? (
          <>
            <div>
              建议最多买入 <b className="num text-base">{size.toLocaleString("en-US", { maximumFractionDigits: 0 })}</b> USDT
              <span className="text-ink-3">（约 {qty.toPrecision(4)} {coin}）</span>
            </div>
            <div className="mt-1 text-ink-2">
              止损距离 {(dist * 100).toFixed(1)}%。如果跌到 {fmtPrice(stop)} 止损，你会亏 <b className="num text-down">{maxLoss.toFixed(0)} USDT</b>，只占总资金的 {riskPct}%。
            </div>
            {capped && <div className="mt-1 text-warn">按规则算出的金额超过了你的总资金，说明止损设得很近、容易被小波动打掉。不建议满仓，单个币最好不超过总资金的三分之一。</div>}
          </>
        ) : (
          <span className="text-ink-3">止损价要低于买入价。</span>
        )}
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-ink-3">止损默认取系统给出的“认错位”。连续亏 5 次也只亏约 10%，这就是职业交易者活下来的方法。</p>
    </Section>
  );
}
