import { RollView } from "@/components/roll/RollView";
import { publicCoins } from "@/lib/server/coins";

export const dynamic = "force-dynamic";
export const metadata = { title: "滚仓助手 — 信号灯" };

export default function RollPage() {
  return <RollView coins={publicCoins()} />;
}
