"use client";

import { useEffect, useState } from "react";
import { Term } from "../Term";
import { Section } from "./shared";
import { fmtPrice } from "./format";

type Side = "long" | "short";

/**
 * Position size from the 2% rule: how large a position (notional) may be so a
 * stop-out costs at most X% of capital. Works for longs and shorts (contracts).
 */
export function PositionCalc({ price, stopRef, coin }: { price: number; stopRef: number | null; coin: string }) {
  // the suggested stop sits above price on a red light: that's a short
  const seedSide: Side = stopRef && stopRef > price ? "short" : "long";
  const seedStop = (sd: Side) => (stopRef && (sd === "long" ? stopRef < price : stopRef > price) ? stopRef : price * (sd === "long" ? 0.95 : 1.05));
  const [side, setSide] = useState<Side>(seedSide);
  const [capital, setCapital] = useState(1000);
  const [riskPct, setRiskPct] = useState(2);
  const [entry, setEntry] = useState(price);
  const [stop, setStop] = useState(seedStop(seedSide));

  useEffect(() => {
    setSide(seedSide);
    setEntry(price);
    setStop(seedStop(seedSide));
    // re-seed only when the coin or suggested stop changes, not on every tick
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coin, stopRef]);

  const flip = (sd: Side) => {
    setSide(sd);
    setStop(seedStop(sd));
  };

  const long = side === "long";
  const dist = long ? (entry - stop) / entry : (stop - entry) / entry;
  const valid = capital > 0 && riskPct > 0 && entry > 0 && stop > 0 && dist > 0;
  const maxLoss = (capital * riskPct) / 100;
  const size = valid ? maxLoss / dist : 0;
  const leverage = valid ? size / capital : 0;
  const qty = valid ? size / entry : 0;

  const field = "num w-full rounded-lg border border-line bg-panel-2 px-2.5 py-1.5 text-sm outline-none focus:border-accent";
  return (
    <Section title={<>仓位计算器 <span className="text-xs font-normal text-ink-3">（<Term k="仓位">2% 法则</Term>）</span></>}>
      <div className="mb-2.5 flex gap-1 rounded-lg bg-panel-2 p-1 text-xs">
        {(["long", "short"] as const).map((sd) => (
          <button
            key={sd}
            className={`flex-1 rounded-md py-1 ${side === sd ? "bg-panel font-medium text-ink shadow-sm" : "text-ink-3"}`}
            onClick={() => flip(sd)}
          >
            {sd === "long" ? "做多" : "做空"}
          </button>
        ))}
      </div>
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
          <span>{long ? "开多价" : "开空价"}</span>
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
              仓位价值最多 <b className="num text-base">{size.toLocaleString("en-US", { maximumFractionDigits: 0 })}</b> USDT
              <span className="text-ink-3">（约 {qty.toPrecision(4)} {coin}）</span>
            </div>
            <div className="mt-1 text-ink-2">
              止损距离 {(dist * 100).toFixed(1)}%。如果{long ? "跌" : "涨"}到 {fmtPrice(stop)} 止损，你会亏 <b className="num text-down">{maxLoss.toFixed(0)} USDT</b>，只占总资金的 {riskPct}%。
            </div>
            {leverage > 1 && (
              <div className="mt-1 text-ink-2">
                相当于 <b className="num">{leverage.toFixed(1)} 倍</b>杠杆。杠杆只是用来少占保证金，真正决定亏多少的是止损距离和仓位价值；强平价一定要在止损价之外。
              </div>
            )}
            {leverage > 5 && <div className="mt-1 text-warn">止损离得很近，算出来要很高的杠杆。近止损很容易被正常波动扫掉，宁可把止损放到更远的认错位、仓位做小。</div>}
          </>
        ) : (
          <span className="text-ink-3">{long ? "做多时止损价要低于开多价。" : "做空时止损价要高于开空价。"}</span>
        )}
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-ink-3">止损默认取系统给出的“认错位”（红灯时是上方的做空认错位）。手续费和资金费率另算。连续亏 5 次也只亏约 10%，这就是职业交易者活下来的方法。</p>
    </Section>
  );
}
