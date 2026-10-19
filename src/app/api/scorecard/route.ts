import { NextResponse, type NextRequest } from "next/server";
import { getSetting } from "@/lib/server/settings";
import { limited, withRoute } from "@/lib/server/route";
import { SCORECARD_TFS, getScorecard } from "@/lib/server/scorecard";
import { getCoin } from "@/lib/symbols";
import type { Timeframe } from "@/lib/types";

export const dynamic = "force-dynamic";

/** The traffic light's own track record, for one coin (or all coins with no `coin`). */
export const GET = withRoute("scorecard", async (req: NextRequest) => {
  const blocked = limited(req, "scorecard", getSetting("rate.publicPerMin"));
  if (blocked) return blocked;
  const raw = req.nextUrl.searchParams.get("coin");
  const coin = raw ? getCoin(raw) : null;
  const tf = req.nextUrl.searchParams.get("tf") as Timeframe;
  if ((raw && !coin) || !SCORECARD_TFS.includes(tf)) return NextResponse.json({ status: "unsupported" });
  return NextResponse.json({ status: "ok", mine: coin ? getScorecard(coin.id, tf) : null, all: getScorecard(null, tf) });
});
