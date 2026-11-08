import { createHmac } from "node:crypto";
import { binanceReadOnly, EXCHANGE_NAME, okxContractValues, okxReadOnly, parseBinance, parseOkx, type ExchangeId, type ExSnapshot, type OkxInstrument } from "../exchange.ts";
import { coinIds } from "./coins.ts";
import { decrypt, encrypt } from "./crypto.ts";
import { getDb } from "./db.ts";
import { recordSource } from "./health.ts";
import { logger } from "./log.ts";

/**
 * Read-only exchange accounts for 滚仓助手: the keys (encrypted with MASTER_KEY, in settings), signed
 * GET requests to OKX and Binance USDT-M futures, and the latest snapshot of each account in memory.
 * Only read-only keys are accepted: a key that can trade or withdraw is refused when saved.
 * Logs never carry a query string, a signature or a key: only the exchange, the path and the status.
 */

const KEY = "exchange.accounts";
const OKX = "https://www.okx.com";
const FAPI = "https://fapi.binance.com";
const SAPI = "https://api.binance.com";
const TIMEOUT_MS = 10_000;
const MAX_ACCOUNTS = 5;

export interface ExAccount {
  id: string;
  name: string;
  ex: ExchangeId;
  keyEnc: string;
  secretEnc: string;
  passEnc: string | null;
  keyHint: string;
  /** Binance: the key is bound to IP addresses */
  ipRestrict?: boolean;
  addedAt: number;
}

interface Creds {
  key: string;
  secret: string;
  pass: string | null;
}

export function getExAccounts(): ExAccount[] {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(KEY) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as ExAccount[]) : [];
}

function putExAccounts(list: ExAccount[]) {
  getDb()
    .prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .run(KEY, JSON.stringify(list), Date.now());
}

/** What the page may see: never the key, the secret or the passphrase. */
export const publicExAccounts = () => getExAccounts().map(({ id, name, ex, keyHint, ipRestrict, addedAt }) => ({ id, name, ex, keyHint, ipRestrict: ipRestrict ?? null, addedAt }));

const credsOf = (a: ExAccount): Creds => ({ key: decrypt(a.keyEnc), secret: decrypt(a.secretEnc), pass: a.passEnc ? decrypt(a.passEnc) : null });
const hint = (k: string) => `${k.slice(0, 4)}…${k.slice(-4)}`;

// ---------------------------------------------------------------- signed requests

class ExchangeError extends Error {}

async function signedGet(source: string, url: string, headers: Record<string, string>): Promise<unknown> {
  const path = new URL(url).pathname;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const res = await fetch(url, { headers, signal: ctl.signal, cache: "no-store" });
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    // OKX answers 200 with a non-zero code on errors; Binance answers 4xx with { code, msg }
    const okxErr = body && typeof body.code === "string" && body.code !== "0";
    if (!res.ok || okxErr) {
      const msg = body?.msg ? `${body.msg}${body.code != null ? `（错误码 ${body.code}）` : ""}` : `HTTP ${res.status}`;
      recordSource(source, false, Date.now() - t0, `${path}: ${msg}`);
      throw new ExchangeError(msg);
    }
    recordSource(source, true, Date.now() - t0);
    return body;
  } catch (e) {
    if (e instanceof ExchangeError) throw e;
    const msg = (e as Error).name === "AbortError" ? `超时 ${TIMEOUT_MS} 毫秒` : (e as Error).message;
    recordSource(source, false, Date.now() - t0, `${path}: ${msg}`);
    throw new ExchangeError(`${path} 请求失败：${msg}`);
  } finally {
    clearTimeout(timer);
  }
}

/** OKX: Base64(HMAC-SHA256(timestamp + "GET" + path with query, secret)). */
export const okxSign = (ts: string, method: string, pathWithQuery: string, body: string, secret: string) =>
  createHmac("sha256", secret).update(ts + method + pathWithQuery + body).digest("base64");

async function okxGet(c: Creds, pathWithQuery: string): Promise<Record<string, unknown>[]> {
  const ts = new Date().toISOString();
  const body = (await signedGet("okx-private", OKX + pathWithQuery, {
    "OK-ACCESS-KEY": c.key,
    "OK-ACCESS-SIGN": okxSign(ts, "GET", pathWithQuery, "", c.secret),
    "OK-ACCESS-TIMESTAMP": ts,
    "OK-ACCESS-PASSPHRASE": c.pass ?? "",
  })) as { data?: Record<string, unknown>[] };
  return body.data ?? [];
}

/** Binance: hex HMAC-SHA256 of the query string, appended as `signature`. */
export const binanceSign = (query: string, secret: string) => createHmac("sha256", secret).update(query).digest("hex");

async function binanceGet(c: Creds, host: string, path: string, params: Record<string, string> = {}): Promise<unknown> {
  const q = new URLSearchParams({ ...params, recvWindow: "10000", timestamp: String(Date.now()) }).toString();
  return signedGet("binance-private", `${host}${path}?${q}&signature=${binanceSign(q, c.secret)}`, { "X-MBX-APIKEY": c.key });
}

// ---------------------------------------------------------------- snapshots

const g = globalThis as unknown as {
  __slOkxCt?: { at: number; map: Record<string, number> };
  __slExSnap?: Record<string, { snap: ExSnapshot | null; error: string | null; t: number }>;
  __slExSync?: Promise<void> | null;
  __slBnAlgo?: number;
};
const snaps = (g.__slExSnap ??= {});

async function okxContracts(): Promise<Record<string, number>> {
  if (g.__slOkxCt && Date.now() - g.__slOkxCt.at < 24 * 3600_000) return g.__slOkxCt.map;
  const res = await fetch(`${OKX}/api/v5/public/instruments?instType=SWAP`, { cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
  const body = (await res.json()) as { data?: OkxInstrument[] };
  const map = okxContractValues(body.data ?? []);
  if (!Object.keys(map).length) throw new ExchangeError("OKX 合约列表为空");
  g.__slOkxCt = { at: Date.now(), map };
  return map;
}

/** OKX: refuses a key that can trade or withdraw. */
async function okxSnapshot(id: string, name: string, c: Creds): Promise<{ snap: ExSnapshot; readOnly: boolean; perm: string }> {
  const [config] = await okxGet(c, "/api/v5/account/config");
  const perm = String(config?.perm ?? "");
  const [ctVal, balance, positions, ...algos] = await Promise.all([
    okxContracts(),
    okxGet(c, "/api/v5/account/balance").then((d) => d[0] ?? {}),
    okxGet(c, "/api/v5/account/positions?instType=SWAP"),
    okxGet(c, "/api/v5/trade/orders-algo-pending?ordType=conditional&instType=SWAP"),
    okxGet(c, "/api/v5/trade/orders-algo-pending?ordType=oco&instType=SWAP"),
    okxGet(c, "/api/v5/trade/orders-algo-pending?ordType=move_order_stop&instType=SWAP"),
  ]);
  const snap = parseOkx({ id, name, t: Date.now(), config: config ?? {}, balance, positions, algos: algos.flat(), ctVal, coins: coinIds() });
  return { snap, readOnly: okxReadOnly(perm), perm };
}

/** Binance USDT-M futures. Conditional orders moved to the algo service; both lists are read. */
async function binanceSnapshot(id: string, name: string, c: Creds): Promise<{ snap: ExSnapshot; readOnly: boolean; ipRestrict: boolean }> {
  const restrictions = (await binanceGet(c, SAPI, "/sapi/v1/account/apiRestrictions")) as Record<string, unknown>;
  const [account, risks, orders, dual] = await Promise.all([
    binanceGet(c, FAPI, "/fapi/v2/account") as Promise<Record<string, unknown>>,
    binanceGet(c, FAPI, "/fapi/v2/positionRisk") as Promise<Record<string, unknown>[]>,
    binanceGet(c, FAPI, "/fapi/v1/openOrders") as Promise<Record<string, unknown>[]>,
    binanceGet(c, FAPI, "/fapi/v1/positionSide/dual") as Promise<{ dualSidePosition?: boolean }>,
  ]);
  // not every account or region has the algo endpoint: stop asking for a day after it fails
  let algo: Record<string, unknown>[] = [];
  if (!g.__slBnAlgo || Date.now() - g.__slBnAlgo > 24 * 3600_000) {
    algo = await (binanceGet(c, FAPI, "/fapi/v1/openAlgoOrders") as Promise<Record<string, unknown>[] | { orders?: Record<string, unknown>[] }>)
      .then((r) => (Array.isArray(r) ? r : (r.orders ?? [])))
      .catch(() => ((g.__slBnAlgo = Date.now()), []));
  }
  const snap = parseBinance({ id, name, t: Date.now(), account, risks, orders: [...orders, ...algo], dual: dual.dualSidePosition === true, coins: coinIds() });
  const ro = binanceReadOnly(restrictions);
  return { snap, readOnly: ro.ok, ipRestrict: ro.ipRestrict };
}

const fetchSnapshot = (a: Pick<ExAccount, "id" | "name" | "ex">, c: Creds) => (a.ex === "okx" ? okxSnapshot(a.id, a.name, c) : binanceSnapshot(a.id, a.name, c));

/** The latest snapshot (or error) of every configured account. */
export function exSnapshots() {
  const ids = new Set(getExAccounts().map((a) => a.id));
  return Object.fromEntries(Object.entries(snaps).filter(([id]) => ids.has(id)));
}

/**
 * Fetch every account once (one at a time) and mirror the positions into the 滚仓助手 book.
 * Concurrent calls share the run in progress.
 */
export function syncExchanges(): Promise<void> {
  if (g.__slExSync) return g.__slExSync;
  g.__slExSync = (async () => {
    const list = getExAccounts();
    if (!list.length) return;
    const fresh: ExSnapshot[] = [];
    for (const a of list) {
      try {
        const { snap, readOnly } = await fetchSnapshot(a, credsOf(a));
        if (!readOnly) {
          // permissions were widened after saving: stop using the key
          snaps[a.id] = { snap: null, error: "这个 API Key 现在有交易或提币权限，已停止读取。请在交易所改回只读后，在这里重新保存。", t: Date.now() };
          logger.warn("audit", "交易所 API Key 不再是只读，已停止读取", { account: a.name, ex: a.ex });
          continue;
        }
        if (snaps[a.id]?.error) logger.info("datasource", `交易所账户 ${a.name} 恢复读取`);
        snaps[a.id] = { snap, error: null, t: snap.t };
        fresh.push(snap);
      } catch (e) {
        const msg = (e as Error).message;
        if (snaps[a.id]?.error !== msg) logger.warn("datasource", `交易所账户 ${a.name} 读取失败`, { ex: a.ex, error: msg });
        snaps[a.id] = { snap: snaps[a.id]?.snap ?? null, error: msg, t: Date.now() };
      }
    }
    if (fresh.length) {
      const { mirrorSnapshots } = await import("./rollalert.ts");
      mirrorSnapshots(fresh);
    }
  })().finally(() => (g.__slExSync = null));
  return g.__slExSync;
}

// ---------------------------------------------------------------- saving keys

export interface ExAccountInput {
  id?: string;
  name?: string;
  ex?: string;
  key?: string;
  secret?: string;
  passphrase?: string;
}

/**
 * Add an account, or rename it / replace its key. A new or replaced key is tried first: it must read the
 * account and be read-only, otherwise nothing is saved.
 */
export async function saveExAccount(input: ExAccountInput): Promise<{ account: ReturnType<typeof publicExAccounts>[number]; snap: ExSnapshot }> {
  const list = getExAccounts();
  const cur = input.id ? list.find((a) => a.id === input.id) : undefined;
  if (input.id && !cur) throw new Error("没有找到这个交易所账户");
  const ex = (cur?.ex ?? input.ex) as ExchangeId;
  if (ex !== "okx" && ex !== "binance") throw new Error("请选择交易所");
  if (!cur && list.length >= MAX_ACCOUNTS) throw new Error(`最多添加 ${MAX_ACCOUNTS} 个交易所账户`);
  const name = (input.name ?? cur?.name ?? "").trim().slice(0, 30) || EXCHANGE_NAME[ex];
  const key = input.key?.trim(), secret = input.secret?.trim(), pass = input.passphrase?.trim();
  const replacing = !!(key || secret || pass);
  if (!cur && !(key && secret)) throw new Error("请填写 API Key 和 Secret");
  if (replacing && !(key && secret)) throw new Error("更新密钥时 API Key 和 Secret 都要填");
  if (ex === "okx" && replacing && !pass) throw new Error("OKX 需要填写创建 API Key 时设置的 Passphrase");
  const creds: Creds = replacing ? { key: key!, secret: secret!, pass: pass ?? null } : credsOf(cur!);
  const id = cur?.id ?? Math.random().toString(36).slice(2, 10);
  const r = await fetchSnapshot({ id, name, ex }, creds).catch((e: Error) => {
    throw new Error(`连接失败：${e.message}`);
  });
  if (!r.readOnly)
    throw new Error(
      "perm" in r
        ? `这个 API Key 的权限是“${r.perm}”。为了安全只接受只读 Key：请在 OKX 新建一个只勾“读取”的 API Key（建议绑定服务器 IP）。`
        : "这个 API Key 开了交易、划转或提币权限。为了安全只接受只读 Key：请在币安 API 管理里只保留“允许读取”（建议限制 IP 为服务器地址）。",
    );
  const snap = r.snap;
  const ipRestrict = "ipRestrict" in r ? r.ipRestrict : undefined;
  const next: ExAccount = {
    id,
    name,
    ex,
    keyEnc: replacing ? encrypt(creds.key) : cur!.keyEnc,
    secretEnc: replacing ? encrypt(creds.secret) : cur!.secretEnc,
    passEnc: replacing ? (creds.pass ? encrypt(creds.pass) : null) : cur!.passEnc,
    keyHint: replacing ? hint(creds.key) : cur!.keyHint,
    ...(ipRestrict !== undefined ? { ipRestrict } : cur?.ipRestrict !== undefined ? { ipRestrict: cur.ipRestrict } : {}),
    addedAt: cur?.addedAt ?? Date.now(),
  };
  putExAccounts(cur ? list.map((a) => (a.id === id ? next : a)) : [...list, next]);
  snaps[id] = { snap: { ...snap, name }, error: null, t: snap.t };
  const { mirrorSnapshots } = await import("./rollalert.ts");
  mirrorSnapshots([{ ...snap, name }]);
  return { account: publicExAccounts().find((a) => a.id === id)!, snap };
}

/** Read the account once with the stored key. */
export async function testExAccount(id: string): Promise<ExSnapshot> {
  const a = getExAccounts().find((x) => x.id === id);
  if (!a) throw new Error("没有找到这个交易所账户");
  const r = await fetchSnapshot(a, credsOf(a));
  if (!r.readOnly) throw new Error("这个 API Key 现在有交易或提币权限，请在交易所改回只读后重新保存。");
  snaps[id] = { snap: r.snap, error: null, t: r.snap.t };
  return r.snap;
}

/** Forget the key and the snapshot; the mirrored 滚仓 account goes too. */
export async function removeExAccount(id: string) {
  const list = getExAccounts();
  if (!list.some((a) => a.id === id)) throw new Error("没有找到这个交易所账户");
  putExAccounts(list.filter((a) => a.id !== id));
  delete snaps[id];
  const { dropMirror } = await import("./rollalert.ts");
  dropMirror(id);
}
