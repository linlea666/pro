"use client";

import { useEffect, useState } from "react";
import type { PerpSnapshot } from "@/lib/data/perp";
import { Term } from "../Term";
import { Section } from "./shared";

const pct = (x: number, digits = 4) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(digits)}%`;
const hm = (sec: number) => new Date(sec * 1000).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });

function amount(x: number) {
  if (x >= 1e8) return `${(x / 1e8).toFixed(2)} 亿`;
  if (x >= 1e4) return `${(x / 1e4).toFixed(1)} 万`;
  return x.toFixed(0);
}

/** Funding rate and open interest: what the contract market looks like right now, not a forecast. */
export function PerpCard({ coin, beginner }: { coin: string; beginner: boolean }) {
  const [p, setP] = useState<PerpSnapshot | null>(null);
  useEffect(() => {
    let alive = true;
    setP(null);
    const load = () =>
      fetch(`/api/perp?coin=${coin}`)
        .then((r) => r.json())
        .then((b) => alive && b.status === "ok" && setP(b.perp))
        .catch(() => {});
    load();
    const timer = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [coin]);

  if (!p) return null;
  const payer = p.fundingRate > 0 ? "做多的人付给做空的人" : p.fundingRate < 0 ? "做空的人付给做多的人" : "双方都不用付";
  const every = p.intervalHours ? `每 ${p.intervalHours} 小时` : "每期";
  return (
    <Section title="合约市场">
      <div className="space-y-2 text-[13px] leading-relaxed text-ink-2">
        <p>
          <b className="text-ink"><Term k="资金费率">资金费率</Term></b> <b className="num text-ink">{pct(p.fundingRate)}</b>
          <span className="text-ink-3"> / {every}</span>：{payer}，{hm(p.nextFundingTime)} 结算。
          {p.avgRate7d != null && <span className="text-ink-3"> 近 7 天平均 {pct(p.avgRate7d)}。</span>}
        </p>
        {p.openInterest != null && (
          <p>
            <b className="text-ink"><Term k="持仓量">持仓量</Term></b> <b className="num text-ink">{amount(p.openInterest)} {coin}</b>
            {p.oiChange24hPct != null && (
              <span className="text-ink-3">，24 小时{p.oiChange24hPct >= 0 ? "增加" : "减少"} {Math.abs(p.oiChange24hPct)}%</span>
            )}
            。
          </p>
        )}
        {beginner && (
          <p className="text-[11px] text-ink-3">
            这两项描述的是合约市场现在的状态：谁更拥挤、杠杆有没有在堆积。它们不预测涨跌。持仓过夜要付的资金费 = 仓位价值 × 费率 × 结算次数。
          </p>
        )}
        <p className="text-[11px] text-ink-3">来源 {p.source === "binance-futures" ? "Binance" : "OKX"} 永续合约{p.markPrice != null && `，标记价格 ${p.markPrice}`}</p>
      </div>
    </Section>
  );
}
