import { NextResponse, type NextRequest } from "next/server";
import { getSetting } from "@/lib/server/settings";
import { limited, withRoute } from "@/lib/server/route";
import { getPerpSnapshot } from "@/lib/data/perp";
import { getCoin } from "@/lib/symbols";

export const dynamic = "force-dynamic";

/** Funding rate and open interest of one coin's perpetual contract. */
export const GET = withRoute("perp", async (req: NextRequest) => {
  const blocked = limited(req, "perp", getSetting("rate.publicPerMin"));
  if (blocked) return blocked;
  const coin = getCoin(req.nextUrl.searchParams.get("coin") || "");
  if (!coin) return NextResponse.json({ status: "unsupported" });
  try {
    return NextResponse.json({ status: "ok", perp: await getPerpSnapshot(coin.id) });
  } catch {
    return NextResponse.json({ status: "unavailable" });
  }
});
