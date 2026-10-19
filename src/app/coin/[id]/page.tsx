import { notFound } from "next/navigation";
import { CoinView } from "@/components/coin/CoinView";
import { getCoin } from "@/lib/symbols";
import { TIMEFRAMES, type Timeframe } from "@/lib/types";

export default async function CoinPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tf?: string; tab?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const coin = getCoin(id);
  if (!coin) notFound();
  const tf = TIMEFRAMES.includes(sp.tf as Timeframe) ? (sp.tf as Timeframe) : "4h";
  return <CoinView coinId={coin.id} initialTf={tf} initialTab={sp.tab ?? "overview"} />;
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const coin = getCoin(id);
  return { title: coin ? `${coin.id} ${coin.name} 行情分析 — 信号灯` : "信号灯" };
}
