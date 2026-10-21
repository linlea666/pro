import { NextResponse } from "next/server";
import { historyCoverage } from "@/lib/data/history";
import { addCoin, allCoins, MAX_ACTIVE_COINS, setCoinEnabled, updateCoin, type CoinResult } from "@/lib/server/coins";
import { requireAdmin } from "@/lib/server/guard";
import { logger } from "@/lib/server/log";
import { withRoute } from "@/lib/server/route";
import { getState } from "@/lib/server/settings";

export const dynamic = "force-dynamic";

/** The coin list; coins outside the built-in ten also get their history backfill progress. */
function list() {
  const nowSec = Date.now() / 1000;
  return {
    max: MAX_ACTIVE_COINS,
    historyComplete: getState("job.historyComplete") === "1",
    coins: allCoins().map((c) => ({
      ...c,
      history: c.enabled && !c.builtin ? historyCoverage(nowSec, [c.id]).map((s) => ({ tf: s.tf, bars: s.bars, first: s.first, complete: s.complete })) : null,
    })),
  };
}

export const GET = withRoute("admin.coins.get", async () => {
  const admin = await requireAdmin();
  if (admin instanceof Response) return admin;
  return NextResponse.json(list());
});

export const POST = withRoute("admin.coins.set", async (req: Request) => {
  const admin = await requireAdmin();
  if (admin instanceof Response) return admin;
  const b = (await req.json().catch(() => ({}))) as { action?: string; id?: string; name?: string; intro?: string; dir?: number };
  const id = String(b.id ?? "");
  let r: CoinResult;
  let what: string;
  switch (b.action) {
    case "add":
      r = await addCoin({ id, name: b.name, intro: b.intro });
      what = "添加币种";
      break;
    case "hide":
    case "show":
      r = await setCoinEnabled(id, b.action === "show");
      what = b.action === "show" ? "重新显示币种" : "隐藏币种";
      break;
    case "update":
      r = updateCoin(id, { name: b.name, intro: b.intro });
      what = "修改币种名称";
      break;
    case "move":
      r = updateCoin(id, { move: b.dir === -1 ? -1 : 1 });
      what = "调整币种顺序";
      break;
    default:
      return NextResponse.json({ error: "未知操作" }, { status: 400 });
  }
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
  if (b.action !== "move") logger.info("audit", `${what} ${r.coin.id}`, { username: admin.username, listedAt: r.coin.listedAt });
  return NextResponse.json({ ...list(), message: `${what} ${r.coin.id}${r.check ? `（${r.check.message}）` : ""}` });
});
