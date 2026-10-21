import { notFound } from "next/navigation";
import { CoinView } from "@/components/coin/CoinView";
import { findCoin, publicCoins } from "@/lib/server/coins";
import { TIMEFRAMES, type Timeframe } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function CoinPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tf?: string; tab?: string; asOf?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const coin = findCoin(id);
  if (!coin) notFound();
  const tf = TIMEFRAMES.includes(sp.tf as Timeframe) ? (sp.tf as Timeframe) : "4h";
  const asOf = Number(sp.asOf) > 0 ? Number(sp.asOf) : null;
  return <CoinView coinId={coin.id} coins={publicCoins()} initialTf={tf} initialTab={sp.tab ?? "overview"} initialAsOf={asOf} />;
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const coin = findCoin(id);
  return { title: coin ? `${coin.id} ${coin.name} 行情分析 — 信号灯` : "信号灯" };
}
