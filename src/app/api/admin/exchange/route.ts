import { NextResponse } from "next/server";
import { canEncrypt } from "@/lib/server/crypto";
import { env } from "@/lib/server/env";
import { exSnapshots, publicExAccounts, removeExAccount, saveExAccount, syncExchanges, testExAccount, type ExAccountInput } from "@/lib/server/exchange";
import { requireAdmin } from "@/lib/server/guard";
import { logger } from "@/lib/server/log";
import { withRoute } from "@/lib/server/route";

export const dynamic = "force-dynamic";

const body = () => ({
  accounts: publicExAccounts(),
  snapshots: exSnapshots(),
  canEncrypt: canEncrypt(),
  allowlist: env.adminAllowlist.length > 0,
  secure: env.secureCookies,
});

/** The read-only exchange accounts and their latest snapshots; `?refresh=1` reads them now. */
export const GET = withRoute("admin.exchange.get", async (req: Request) => {
  const admin = await requireAdmin();
  if (admin instanceof Response) return admin;
  if (new URL(req.url).searchParams.get("refresh") === "1") await syncExchanges();
  return NextResponse.json(body());
});

/**
 * `{ action: "save", id?, ex, name, key, secret, passphrase }` adds an account or renames it / replaces its key
 * (the key must read the account and be read-only); `{ action: "test", id }`; `{ action: "remove", id }`.
 */
export const POST = withRoute("admin.exchange.post", async (req: Request) => {
  const admin = await requireAdmin();
  if (admin instanceof Response) return admin;
  const { action, ...input } = (await req.json().catch(() => ({}))) as ExAccountInput & { action?: string };
  try {
    if (action === "save") {
      const r = await saveExAccount(input);
      logger.info("audit", input.id ? (input.key ? "更新交易所 API Key" : "修改交易所账户名") : "添加交易所账户", { username: admin.username, account: r.account.name, ex: r.account.ex, key: r.account.keyHint });
      return NextResponse.json({ ...body(), message: `已连接：权益 ${r.snap.equity.toFixed(2)} USDT，${r.snap.positions.length} 个持仓` });
    }
    if (action === "test" && input.id) {
      const s = await testExAccount(input.id);
      return NextResponse.json({ ...body(), message: `连接正常：权益 ${s.equity.toFixed(2)} USDT，${s.positions.length} 个持仓` });
    }
    if (action === "remove" && input.id) {
      const a = publicExAccounts().find((x) => x.id === input.id);
      await removeExAccount(input.id);
      logger.info("audit", "移除交易所账户", { username: admin.username, account: a?.name, ex: a?.ex });
      return NextResponse.json(body());
    }
    return NextResponse.json({ error: "未知操作" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
});
