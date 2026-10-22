import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import { analyze, multiTimeframe, relevel, summarize, type Analysis, type LightSummary } from "../analysis.ts";
import { forbiddenPhrase, tdBrief } from "../tdbrief.ts";
import { TF_LABEL, type Timeframe } from "../types.ts";
import { getDb } from "./db.ts";
import { decrypt, encrypt } from "./crypto.ts";
import { logger } from "./log.ts";
import { raiseAlert } from "./alert.ts";

/**
 * AI interpretation ("AI 解读"). The model only sees the structured snapshot
 * our engines computed — never raw candles — and must answer in a fixed JSON
 * shape. Visitors ask for it with a button (never automatically); one
 * interpretation per coin / timeframe / closed bar is generated and cached,
 * and a daily quota plus a per-IP hourly limit cap spend.
 */

/** Short timeframes change too fast for a paid write-up to stay useful. */
export const AI_TFS: Timeframe[] = ["1h", "4h", "1d", "1w"];

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface AiConfig {
  enabled: boolean;
  /** AES-GCM blob; never sent to the browser */
  apiKeyEnc: string | null;
  baseUrl: string;
  model: string;
  effort: Effort;
  dailyLimit: number;
  /** generations one visitor IP may trigger per hour */
  perIpHourly: number;
  timeoutSec: number;
  /** server-side refusal fallback (fallbacks: "default") */
  fallback: boolean;
  /** custom system prompt; empty = built-in default */
  prompt: string;
  /** bumped on every save so cached interpretations from an old setup aren't reused */
  revision: number;
}

export const DEFAULT_MODEL = "claude-opus-5-5";

const DEFAULT_CONFIG: AiConfig = {
  enabled: false,
  apiKeyEnc: null,
  baseUrl: "",
  model: DEFAULT_MODEL,
  effort: "medium",
  dailyLimit: 200,
  perIpHourly: 5,
  timeoutSec: 90,
  fallback: true,
  prompt: "",
  revision: 0,
};

export const DEFAULT_PROMPT = `你是「信号灯」网站的技术分析讲解员，读者是刚入门的加密货币新手。
你会收到系统已经计算好的一份结构化行情快照（JSON）。请只依据快照里的数据，用简体中文写解读。

要求：
1. 说人话。尽量不用术语；必须用到时（比如 TD 9、支撑位、中枢），顺带用半句话解释它是什么。
2. 不预测具体价格或涨跌幅，不说“一定”“必涨”“稳赚”这类绝对的话；用“偏多 / 偏空 / 观望”和“可能”来表达倾向。
3. 说清楚各个周期是否一致；不一致时，分别说明大周期和小周期的状态，以及这对新手意味着什么。
4. 必须给出认错位：价格到哪里说明当前判断错了，数字只能取自快照里的支撑、阻力或止损参考。
5. 如果快照中的历史胜率显示某个信号“历史上不利”“证据弱”或“证据不足”，要提醒读者不要过度依赖它。
6. 不给买卖指令，不建议仓位大小；可以描述“想参与的人通常会等什么条件出现”。
7. 快照之外的信息（新闻、链上数据、消息面、宏观）一律不要编造或引用。
8. 每个字段都要简短：headline 不超过 30 个字，其余每段不超过 80 个字，watch 给 2–3 条。`;

/** JSON shape the model must return. */
const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    headline: { type: "string", description: "一句话结论" },
    summary: { type: "string", description: "现在是什么情况、为什么，2–3 句" },
    timeframes: { type: "string", description: "大小周期是否一致、意味着什么" },
    levels: { type: "string", description: "关键支撑阻力怎么看" },
    watch: { type: "array", items: { type: "string" }, description: "接下来值得关注的 2–3 个条件" },
    invalidation: { type: "string", description: "认错位：价格到哪里说明判断错了" },
    caution: { type: "string", description: "风险提醒，包括证据弱或历史上不利的信号" },
  },
  required: ["headline", "summary", "timeframes", "levels", "watch", "invalidation", "caution"],
  additionalProperties: false,
} as const;

/** What the TD tab's interpretation is about; "overview" is the original card. */
export type AiKind = "overview" | "td";

export const TD_PROMPT = `你是一位做了多年合约的交易员，在「信号灯」网站上给新手讲 TD 序列（DeMark）。
你会收到系统已经算好的多周期 TD 计数（JSON），其中 template 是按规则写好的解读。请只依据这些数据，用简体中文、像交易员跟新手聊天那样重写一遍。

要求：
1. TD 在我们的研究里没有可证明的方向优势。它只描述“一段涨跌走了多久”。绝不预测涨跌、反转、目标价或幅度；不说“会冲上”“一大波”“大级别反转”“见顶”“见底”“抄底”这类话。
2. 可以说的：每个周期数到哪里、13 是否出现或失败、风险位和 TDST 在哪里、13 离风险位还有多远（roomPct，%）、下一根收盘到哪里计数继续或取消、上一个信号之后实际走了多少、历史统计（照 stats 原样引用，不要改数字）。每个周期的 timeline 是最近几个 9 / 13：status 为 counting（13 计数中）、reached13（之后数到了 13）、cancelled（13 计数被取消）、standing（风险位还没被收盘越过）、failed（收盘越过风险位，失败）；upPct / downPct 是之后到过的最高 / 最低（相对信号收盘）。复盘可以引用它们，比如“这个周期最近三个 9 有两个被取消”。
3. 数据里 side 为 buy 表示连跌（称“跌势 9 / 跌势 13”），sell 表示连涨（称“涨势 9 / 涨势 13”）。不要说“买入 9”“卖出 9”，新手会当成买卖建议。用到术语（9、13、风险位、TDST）时顺带用半句话解释。
4. 不给买卖指令和仓位建议。可以说“想用它的人通常会等什么条件”，比如等风险位被守住或被收盘越过。
5. 快照之外的信息（新闻、链上、宏观、形态如头肩底）一律不要编造。
6. 简短：conclusion 不超过 40 个字；timeframes、review 各不超过 120 个字；watch 给 2–3 条，每条不超过 40 个字。
7. 说到几个周期是否一致、小周期 13 碰上大周期（“接力”“回调”）时，只能引用 template.alignment 里的研究结论（E25：没有比单个周期更灵），不要自己推断“共振更强”。
8. 数满 13 可以叫“走完”或用 DeMark 的说法“衰竭”，但要说明它只说明这段涨跌走了很久，不说明接下来的方向。`;

const TD_SCHEMA = {
  type: "object",
  properties: {
    conclusion: { type: "string", description: "一句话结论" },
    timeframes: { type: "string", description: "多周期各自数到哪里、是否一致" },
    review: { type: "string", description: "上一个 9 / 13 之后实际怎么走的，失败与否" },
    watch: { type: "array", items: { type: "string" }, description: "接下来要盯的 2–3 个收盘价条件" },
  },
  required: ["conclusion", "timeframes", "review", "watch"],
  additionalProperties: false,
} as const;

export interface TdAiContent {
  conclusion: string;
  timeframes: string;
  review: string;
  watch: string[];
}

export interface AiContent {
  headline: string;
  summary: string;
  timeframes: string;
  levels: string;
  watch: string[];
  invalidation: string;
  caution: string;
}

// ---------------------------------------------------------------- config

const CONFIG_KEY = "ai.config";

export function getAiConfig(): AiConfig {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(CONFIG_KEY) as { value: string } | undefined;
  return { ...DEFAULT_CONFIG, ...(row ? (JSON.parse(row.value) as Partial<AiConfig>) : {}) };
}

export type AiConfigInput = Partial<Omit<AiConfig, "apiKeyEnc" | "revision">> & { apiKey?: string; clearKey?: boolean };

export function saveAiConfig(input: AiConfigInput): AiConfig {
  const cur = getAiConfig();
  const next: AiConfig = { ...cur };
  if (input.enabled !== undefined) next.enabled = Boolean(input.enabled);
  if (input.baseUrl !== undefined) next.baseUrl = String(input.baseUrl).trim().replace(/\/+$/, "");
  if (input.model !== undefined) next.model = String(input.model).trim() || DEFAULT_MODEL;
  if (input.effort !== undefined) next.effort = input.effort;
  if (input.dailyLimit !== undefined) next.dailyLimit = Math.max(0, Math.min(100_000, Math.floor(Number(input.dailyLimit))));
  if (input.perIpHourly !== undefined) next.perIpHourly = Math.max(1, Math.min(100, Math.floor(Number(input.perIpHourly))));
  if (input.timeoutSec !== undefined) next.timeoutSec = Math.max(10, Math.min(600, Math.floor(Number(input.timeoutSec))));
  if (input.fallback !== undefined) next.fallback = Boolean(input.fallback);
  if (input.prompt !== undefined) next.prompt = String(input.prompt).slice(0, 8000);
  if (input.clearKey) next.apiKeyEnc = null;
  if (input.apiKey) next.apiKeyEnc = encrypt(input.apiKey.trim());
  if (next.baseUrl && !/^https?:\/\/[^\s/]+/.test(next.baseUrl)) throw new Error("Base URL 格式不正确，应以 http:// 或 https:// 开头");
  if (next.enabled && !next.apiKeyEnc) throw new Error("启用前请先填写 API Key");
  next.revision = cur.revision + 1;
  getDb()
    .prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .run(CONFIG_KEY, JSON.stringify(next), Date.now());
  fallbackUnsupported.clear();
  return next;
}

/** What the admin page may see: never the key itself. */
export function publicConfig(c: AiConfig = getAiConfig()) {
  let keyHint: string | null = null;
  if (c.apiKeyEnc) {
    try {
      const k = decrypt(c.apiKeyEnc);
      keyHint = `${k.slice(0, 7)}…${k.slice(-4)}`;
    } catch {
      keyHint = "（无法解密，请重新填写）";
    }
  }
  const { apiKeyEnc: _omit, ...rest } = c;
  return { ...rest, hasKey: !!c.apiKeyEnc, keyHint, defaultPrompt: DEFAULT_PROMPT, defaultModel: DEFAULT_MODEL };
}

function client(c: AiConfig): Anthropic {
  if (!c.apiKeyEnc) throw new Error("没有配置 API Key");
  return new Anthropic({
    apiKey: decrypt(c.apiKeyEnc),
    baseURL: c.baseUrl || undefined,
    timeout: c.timeoutSec * 1000,
    maxRetries: 1,
  });
}

// ---------------------------------------------------------------- usage

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

function recordUsage(ok: boolean, u?: { input_tokens?: number | null; output_tokens?: number | null; cache_read_input_tokens?: number | null }) {
  getDb()
    .prepare(
      `INSERT INTO ai_usage (day, calls, failures, input_tokens, output_tokens, cache_read_tokens) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(day) DO UPDATE SET calls = calls + excluded.calls, failures = failures + excluded.failures,
         input_tokens = input_tokens + excluded.input_tokens, output_tokens = output_tokens + excluded.output_tokens,
         cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens`,
    )
    .run(today(), ok ? 1 : 0, ok ? 0 : 1, u?.input_tokens ?? 0, u?.output_tokens ?? 0, u?.cache_read_input_tokens ?? 0);
}

export function usageReport(days = 14) {
  const rows = getDb().prepare("SELECT * FROM ai_usage ORDER BY day DESC LIMIT ?").all(days) as {
    day: string;
    calls: number;
    failures: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
  }[];
  const cached = (getDb().prepare("SELECT COUNT(*) n FROM ai_cache").get() as { n: number }).n;
  return { today: rows.find((r) => r.day === today()) ?? null, days: rows, cachedInterpretations: cached };
}

const callsToday = () => (getDb().prepare("SELECT calls FROM ai_usage WHERE day = ?").get(today()) as { calls: number } | undefined)?.calls ?? 0;

// ---------------------------------------------------------------- snapshot & prompt

const round = (v: number) => (Math.abs(v) >= 100 ? Math.round(v * 10) / 10 : Math.round(v * 10000) / 10000);

/** Compact, display-ready facts for one coin/timeframe plus the other timeframes. */
export function buildSnapshot(a: Analysis, mtf: LightSummary[]) {
  const v = a.verdict;
  // the write-up is cached for the whole closed bar: describe that bar, not the live tick
  const levels = relevel([...a.levels.supports, ...a.levels.resistances], a.closedPrice);
  const lvl = (l: Analysis["levels"]["supports"][number]) => ({ price: round(l.price), distancePct: Math.round(l.distancePct * 100) / 100, methods: l.methods.slice(0, 3) });
  return {
    coin: a.coin,
    timeframe: TF_LABEL[a.tf],
    price: a.closedPrice,
    change24hPct: Math.round(a.change24h * 100) / 100,
    verdict: {
      light: v.lightText,
      score: v.score,
      partsAgreeing: `${v.agreement}/4`,
      headline: v.headline,
      parts: v.components.map((c) => ({ part: c.label, score: c.score, text: c.text })),
      stopReference: v.stopRef ? round(v.stopRef) : null,
      stopAnchor: v.stopAnchor ? round(v.stopAnchor) : null,
      stopDistanceAtr: v.stopAtr,
      stopNoiseTouchPct: v.stopNoisePct,
      avgCandleMovePct: Math.round(v.atrPct * 100) / 100,
    },
    otherTimeframes: mtf.map((m) => ({ timeframe: TF_LABEL[m.tf], light: m.lightText, trend: m.trend, td: m.td })),
    td: {
      counting: a.td.current.setupSide ? `${a.td.current.setupSide === "buy" ? "连续下跌" : "连续上涨"} ${a.td.current.setupCount}/${a.td.current.setupLength}` : "未计数",
      countdown: a.td.current.countdown ? `${a.td.current.countdown.side === "buy" ? "跌势" : "涨势"} ${a.td.current.countdown.count}/${a.td.current.countdownLength}` : null,
      lastSignal: a.td.current.lastSignal
        ? {
            type: `${a.td.current.lastSignal.side === "buy" ? "跌势" : "涨势"}${a.td.current.lastSignal.kind === "setup9" ? a.td.current.setupLength : a.td.current.countdownLength}`,
            barsAgo: a.td.current.lastSignal.barsAgo,
            invalidated: a.td.current.lastSignal.invalidated,
            changeSincePct: Math.round(a.td.current.lastSignal.changePct * 100) / 100,
          }
        : null,
    },
    trend: { label: a.trend.label, score: a.trend.current, explain: a.trend.explain },
    indicatorVotes: { bullish: Object.values(a.indicators.summary).reduce((s, x) => s + x.bull, 0), bearish: Object.values(a.indicators.summary).reduce((s, x) => s + x.bear, 0), total: a.indicators.total },
    supports: levels.supports.slice(0, 3).map(lvl),
    resistances: levels.resistances.slice(0, 3).map(lvl),
    fibonacci: a.fib ? { leg: a.fib.direction === "up" ? "上涨段" : "下跌段", retracedPct: Math.round(a.fib.currentRatio * 1000) / 10, zone: a.fib.zoneText } : null,
    chan: a.chan.explain,
    recentSignals: a.active.map((s) => ({ name: s.name, barsAgo: s.barsAgo, historicalWinRatePct: s.stats.winRate, randomWinRatePct: s.stats.baseWinRate, samples: s.stats.samples, reliability: s.stats.reliability })),
    signalTrackRecord: a.stats.filter((s) => s.samples > 0).map((s) => ({ name: s.name, winRatePct: s.winRate, randomPct: s.baseWinRate, samples: s.samples, reliability: s.reliability })),
    statsWindow: `信号出现后 ${a.horizonText}`,
  };
}

const promptHash = (c: AiConfig) => createHash("sha1").update(`${c.model}|${c.effort}|${c.prompt || DEFAULT_PROMPT}`).digest("hex").slice(0, 8);

// ---------------------------------------------------------------- generation

/** Base URLs (per config revision) that rejected the fallbacks parameter. */
const fallbackUnsupported = new Set<string>();

export type AiErrorKind = "disabled" | "quota" | "refusal" | "auth" | "rate" | "network" | "bad_output" | "api";

export class AiError extends Error {
  readonly kind: AiErrorKind;
  constructor(message: string, kind: AiErrorKind) {
    super(message);
    this.kind = kind;
  }
}

function describeApiError(e: unknown): AiError {
  if (e instanceof Anthropic.AuthenticationError) return new AiError("API Key 无效或已过期", "auth");
  if (e instanceof Anthropic.PermissionDeniedError) return new AiError("API Key 没有权限访问这个模型", "auth");
  if (e instanceof Anthropic.NotFoundError) return new AiError("模型不存在或 Base URL 不正确", "api");
  if (e instanceof Anthropic.RateLimitError) return new AiError("请求太频繁或额度不足（429），请稍后再试", "rate");
  if (e instanceof Anthropic.BadRequestError) return new AiError(`请求被拒绝（400）：${e.message.slice(0, 200)}`, "api");
  if (e instanceof Anthropic.APIConnectionTimeoutError) return new AiError("请求超时", "network");
  if (e instanceof Anthropic.APIConnectionError) return new AiError("无法连接到 AI 服务，请检查网络或 Base URL", "network");
  if (e instanceof Anthropic.APIError) return new AiError(`AI 服务出错（${e.status ?? "未知"}）：${e.message.slice(0, 200)}`, "api");
  return new AiError((e as Error).message || "未知错误", "api");
}

interface CallResult {
  text: string;
  model: string;
  usage: Anthropic.Beta.BetaUsage;
  stopReason: string | null;
  refusalCategory: string | null;
  fellBack: boolean;
}

async function callClaude(c: AiConfig, system: string, user: string, opts: { json: boolean; effort?: Effort; schema?: Record<string, unknown> }): Promise<CallResult> {
  const cl = client(c);
  const fbKey = `${c.revision}|${c.baseUrl}`;
  const useFallback = c.fallback && !fallbackUnsupported.has(fbKey);
  const params: Anthropic.Beta.MessageCreateParamsNonStreaming = {
    model: c.model,
    max_tokens: 16000,
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: user }],
    output_config: {
      effort: opts.effort ?? c.effort,
      ...(opts.json ? { format: { type: "json_schema", schema: opts.schema ?? (OUTPUT_SCHEMA as unknown as Record<string, unknown>) } } : {}),
    },
  };
  let res: Anthropic.Beta.BetaMessage;
  try {
    res = await cl.beta.messages.create(useFallback ? { ...params, fallbacks: "default", betas: ["server-side-fallback-2026-07-01"] } : params);
  } catch (e) {
    // some proxies don't know the fallbacks parameter; retry once without it and remember
    if (useFallback && e instanceof Anthropic.BadRequestError) {
      logger.warn("ai", "AI 服务不支持拒答自动切换参数，已改为不带该参数重试", { error: e.message.slice(0, 300), baseUrl: c.baseUrl || "官方" });
      fallbackUnsupported.add(fbKey);
      res = await cl.beta.messages.create(params);
    } else throw e;
  }
  const text = res.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  const fellBack = res.content.some((b) => b.type === "fallback");
  return {
    text,
    model: res.model,
    usage: res.usage,
    stopReason: res.stop_reason,
    refusalCategory: res.stop_reason === "refusal" ? (res.stop_details?.category ?? null) : null,
    fellBack,
  };
}

// Some proxies ignore the json_schema output format: the model then wraps its JSON in a code
// fence or reshapes a field. Spell the shape out in the request, and read the answer leniently.
const SHAPE_TD = '只输出一个 JSON 对象，不要代码块，不要其他文字，格式：{"conclusion":"…","timeframes":"…","review":"…","watch":["…","…"]}（timeframes、review 都是一段文字，不是数组）';
const SHAPE_OVERVIEW =
  '只输出一个 JSON 对象，不要代码块，不要其他文字，格式：{"headline":"…","summary":"…","timeframes":"…","levels":"…","watch":["…"],"invalidation":"…","caution":"…"}';

/** JSON from a model answer that may be wrapped in a ```json fence or surrounded by text. */
export function parseLooseJson(text: string): Record<string, unknown> {
  const t = text.trim();
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  let body = fenced ? fenced[1] : t;
  if (!body.trim().startsWith("{")) {
    const a = body.indexOf("{"), b = body.lastIndexOf("}");
    if (a < 0 || b <= a) throw new Error("没有找到 JSON");
    body = body.slice(a, b + 1);
  }
  const v = JSON.parse(body);
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("不是 JSON 对象");
  return v as Record<string, unknown>;
}

/** A field the model returned as a list (or a list of {tf, text}) becomes one paragraph. */
function asText(v: unknown): string {
  if (typeof v === "string") return v.trim();
  if (Array.isArray(v)) return v.map(asText).filter(Boolean).join("\n");
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.text === "string") return `${typeof o.tf === "string" ? `${o.tf}：` : ""}${o.text}`.trim();
    return Object.values(o).map(asText).filter(Boolean).join("：");
  }
  return v == null ? "" : String(v);
}

const asList = (v: unknown): string[] => (Array.isArray(v) ? v.map(asText).filter(Boolean) : asText(v) ? [asText(v)] : []);

export function normalizeTd(o: Record<string, unknown>): TdAiContent {
  const c = { conclusion: asText(o.conclusion), timeframes: asText(o.timeframes), review: asText(o.review), watch: asList(o.watch) };
  if (!c.conclusion || !c.watch.length) throw new Error("字段缺失");
  return c;
}

export function normalizeOverview(o: Record<string, unknown>): AiContent {
  const c = {
    headline: asText(o.headline),
    summary: asText(o.summary),
    timeframes: asText(o.timeframes),
    levels: asText(o.levels),
    watch: asList(o.watch),
    invalidation: asText(o.invalidation),
    caution: asText(o.caution),
  };
  if (!c.headline || !c.watch.length) throw new Error("字段缺失");
  return c;
}

export interface Interpretation<C = AiContent> {
  content: C;
  model: string;
  createdAt: number;
  barTime: number;
  cached: boolean;
  stale?: boolean;
}

const pending = new Map<string, Promise<Interpretation<AiContent | TdAiContent>>>();

/** ai_cache keys of the TD card start with "td|"; the original card's keys start with the coin. */
const kindFilter = (kind: AiKind) => (kind === "td" ? "key LIKE 'td|%'" : "key NOT LIKE 'td|%'");

function latestCached(coin: string, tf: Timeframe, kind: AiKind): Interpretation<AiContent | TdAiContent> | null {
  const r = getDb().prepare(`SELECT * FROM ai_cache WHERE coin = ? AND tf = ? AND ${kindFilter(kind)} ORDER BY created_at DESC LIMIT 1`).get(coin, tf) as
    | { content: string; model: string; created_at: number; bar_t: number }
    | undefined;
  return r ? { content: JSON.parse(r.content), model: r.model, createdAt: r.created_at, barTime: r.bar_t, cached: true, stale: true } : null;
}

const cacheKey = (c: AiConfig, coin: string, tf: Timeframe, barTime: number, kind: AiKind = "overview") =>
  kind === "td"
    ? `td|${coin}|${tf}|${barTime}|${c.revision}|${createHash("sha1").update(`${c.model}|${c.effort}|${TD_PROMPT}`).digest("hex").slice(0, 8)}`
    : `${coin}|${tf}|${barTime}|${c.revision}|${promptHash(c)}`;

function cachedAt(key: string): Interpretation<AiContent | TdAiContent> | null {
  const hit = getDb().prepare("SELECT content, model, created_at, bar_t FROM ai_cache WHERE key = ?").get(key) as
    | { content: string; model: string; created_at: number; bar_t: number }
    | undefined;
  return hit ? { content: JSON.parse(hit.content), model: hit.model, createdAt: hit.created_at, barTime: hit.bar_t, cached: true } : null;
}

/** The interpretation already generated for the last closed bar, if anyone asked for it. Never calls the model. */
export async function peekInterpretation(coin: string, tf: Timeframe, kind: AiKind = "overview"): Promise<Interpretation<AiContent | TdAiContent> | null> {
  const c = getAiConfig();
  if (!c.enabled || !c.apiKeyEnc) return null;
  const a = await analyze(coin, tf);
  return cachedAt(cacheKey(c, coin, tf, a.lastClosedT, kind));
}

/** The TD card's input: every timeframe's TD state (the focus one from this analysis) plus the rule-based write-up. */
export function buildTdSnapshot(a: Analysis, mtf: LightSummary[]) {
  const focus = summarize(a);
  const rows = [...mtf.filter((m) => m.tf !== a.tf), focus].sort((x, y) => mtf.findIndex((m) => m.tf === x.tf) - mtf.findIndex((m) => m.tf === y.tf)).map((m) => ({ tf: m.tf, d: m.tdDetail }));
  const ls = a.td.current.lastSignal;
  const last = ls ? { side: ls.side, kind: ls.kind, barsAgo: ls.barsAgo, price: ls.price, riskLevel: ls.riskLevel, invalidated: ls.invalidated, changePct: ls.changePct } : null;
  const stats = a.stats.filter((s) => s.key.startsWith("td_"));
  return {
    coin: a.coin,
    focusTimeframe: TF_LABEL[a.tf],
    close: a.closedPrice,
    template: tdBrief(rows, a.tf, last, stats),
    timeframes: rows.map((r) => ({ timeframe: TF_LABEL[r.tf], ...r.d })),
    lastSignal: last,
    stats: stats.map((s) => ({ name: s.name, samples: s.samples, winRatePct: s.winRate, randomPct: s.baseWinRate, reliability: s.reliability })),
    statsWindow: `信号出现后 ${a.horizonText}`,
  };
}

/** Get (or generate once) the interpretation for the last closed bar. */
export async function interpret(coin: string, tf: Timeframe, kind: AiKind = "overview"): Promise<Interpretation<AiContent | TdAiContent>> {
  const c = getAiConfig();
  if (!c.enabled || !c.apiKeyEnc) throw new AiError("AI 解读未启用", "disabled");
  const a = await analyze(coin, tf);
  const barTime = a.lastClosedT;
  const key = cacheKey(c, coin, tf, barTime, kind);

  const hit = cachedAt(key);
  if (hit) return hit;
  const p = pending.get(key);
  if (p) return p;

  if (callsToday() >= c.dailyLimit) {
    logger.warn("ai", "今日 AI 解读额度已用完", { limit: c.dailyLimit, coin, tf });
    raiseAlert("ai", "今日 AI 解读额度已用完", { 额度: c.dailyLimit });
    const old = latestCached(coin, tf, kind);
    if (old) return old;
    throw new AiError(`今日 AI 解读额度（${c.dailyLimit} 次）已用完，明天会自动恢复`, "quota");
  }

  const job = (async (): Promise<Interpretation<AiContent | TdAiContent>> => {
    const t0 = Date.now();
    const mtf = await multiTimeframe(coin);
    let r: CallResult;
    try {
      r =
        kind === "td"
          ? await callClaude(c, TD_PROMPT, `请解读下面这份多周期 TD 计数：\n${JSON.stringify(buildTdSnapshot(a, mtf))}\n\n${SHAPE_TD}`, { json: true, schema: TD_SCHEMA as unknown as Record<string, unknown> })
          : await callClaude(c, c.prompt || DEFAULT_PROMPT, `请解读下面这份行情快照：\n${JSON.stringify(buildSnapshot(a, mtf))}\n\n${SHAPE_OVERVIEW}`, { json: true });
    } catch (e) {
      recordUsage(false);
      const err = describeApiError(e);
      logger.error("ai", `AI 解读失败 ${coin} ${tf}：${err.message}`, { kind: err.kind, model: c.model, durationMs: Date.now() - t0 });
      raiseAlert("ai", "AI 解读调用失败", { 原因: err.message, 模型: c.model });
      throw err;
    }
    recordUsage(r.stopReason !== "refusal", r.usage);
    if (r.stopReason === "refusal") {
      logger.warn("ai", `AI 拒绝了解读请求 ${coin} ${tf}`, { category: r.refusalCategory, model: r.model });
      throw new AiError("AI 这次没有给出解读，请稍后再试", "refusal");
    }
    let content: AiContent | TdAiContent;
    try {
      content = kind === "td" ? normalizeTd(parseLooseJson(r.text)) : normalizeOverview(parseLooseJson(r.text));
    } catch (e) {
      logger.error("ai", `AI 返回内容无法解析 ${coin} ${tf}`, { error: (e as Error).message, stopReason: r.stopReason, sample: r.text.slice(0, 300) });
      throw new AiError("AI 返回的内容格式不正确", "bad_output");
    }
    // the TD card must not make price calls the research can't back; such a write-up is dropped and the page keeps the template
    const bad = kind === "td" ? forbiddenPhrase(JSON.stringify(content)) : null;
    if (bad) {
      logger.warn("ai", `TD 解读含预测性说法，已丢弃 ${coin} ${tf}`, { phrase: bad, model: r.model });
      throw new AiError("AI 这次的说法超出了研究能支撑的范围", "bad_output");
    }
    const ms = Date.now() - t0;
    const now = Date.now();
    getDb()
      .prepare("INSERT OR REPLACE INTO ai_cache (key, coin, tf, bar_t, created_at, model, content, input_tokens, output_tokens, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(key, coin, tf, barTime, now, r.model, JSON.stringify(content), r.usage.input_tokens, r.usage.output_tokens, ms);
    // keep the table small: only the newest 20 per coin/timeframe/card
    getDb()
      .prepare(`DELETE FROM ai_cache WHERE coin = ? AND tf = ? AND ${kindFilter(kind)} AND key NOT IN (SELECT key FROM ai_cache WHERE coin = ? AND tf = ? AND ${kindFilter(kind)} ORDER BY created_at DESC LIMIT 20)`)
      .run(coin, tf, coin, tf);
    logger.info("ai", `AI 解读生成 ${coin} ${tf}${kind === "td" ? "（TD）" : ""}`, {
      durationMs: ms,
      model: r.model,
      fellBack: r.fellBack || undefined,
      inputTokens: r.usage.input_tokens,
      outputTokens: r.usage.output_tokens,
      cacheReadTokens: r.usage.cache_read_input_tokens ?? 0,
    });
    return { content, model: r.model, createdAt: now, barTime, cached: false };
  })();
  pending.set(key, job);
  try {
    return await job;
  } finally {
    pending.delete(key);
  }
}

/** Minimal round trip to verify key, base URL and model. */
export async function testConnection(override?: AiConfigInput): Promise<{ ok: boolean; message: string; model?: string; durationMs: number }> {
  const base = getAiConfig();
  const c: AiConfig = {
    ...base,
    ...(override?.baseUrl !== undefined ? { baseUrl: String(override.baseUrl).trim().replace(/\/+$/, "") } : {}),
    ...(override?.model ? { model: override.model.trim() } : {}),
    ...(override?.apiKey ? { apiKeyEnc: encrypt(override.apiKey.trim()) } : {}),
  };
  const t0 = Date.now();
  try {
    const r = await callClaude(c, "你是连通性测试助手。", "请只回复两个字：正常", { json: false, effort: "low" });
    const ms = Date.now() - t0;
    if (r.stopReason === "refusal") return { ok: false, message: "请求被模型拒绝", model: r.model, durationMs: ms };
    logger.info("ai", "AI 连接测试成功", { model: r.model, durationMs: ms, baseUrl: c.baseUrl || "官方" });
    return { ok: true, message: `连接正常，模型回复：“${r.text.trim().slice(0, 40)}”`, model: r.model, durationMs: ms };
  } catch (e) {
    const err = describeApiError(e);
    logger.warn("ai", `AI 连接测试失败：${err.message}`, { model: c.model, baseUrl: c.baseUrl || "官方" });
    return { ok: false, message: err.message, durationMs: Date.now() - t0 };
  }
}

export function clearAiCache(): number {
  return getDb().prepare("DELETE FROM ai_cache").run().changes;
}
