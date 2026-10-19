import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import { analyze, multiTimeframe, type Analysis, type LightSummary } from "../analysis.ts";
import { TF_LABEL, type Timeframe } from "../types.ts";
import { getDb } from "./db.ts";
import { decrypt, encrypt } from "./crypto.ts";
import { logger } from "./log.ts";

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
  const lvl = (l: Analysis["levels"]["supports"][number]) => ({ price: round(l.price), distancePct: Math.round(l.distancePct * 100) / 100, methods: l.methods.slice(0, 3) });
  return {
    coin: a.coin,
    timeframe: TF_LABEL[a.tf],
    price: a.price,
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
      countdown: a.td.current.countdown ? `${a.td.current.countdown.side === "buy" ? "买入" : "卖出"} ${a.td.current.countdown.count}/${a.td.current.countdownLength}` : null,
      lastSignal: a.td.current.lastSignal
        ? {
            type: `${a.td.current.lastSignal.side === "buy" ? "买入" : "卖出"}${a.td.current.lastSignal.kind === "setup9" ? a.td.current.setupLength : a.td.current.countdownLength}`,
            barsAgo: a.td.current.lastSignal.barsAgo,
            invalidated: a.td.current.lastSignal.invalidated,
            changeSincePct: Math.round(a.td.current.lastSignal.changePct * 100) / 100,
          }
        : null,
    },
    trend: { label: a.trend.label, score: a.trend.current, explain: a.trend.explain },
    indicatorVotes: { bullish: Object.values(a.indicators.summary).reduce((s, x) => s + x.bull, 0), bearish: Object.values(a.indicators.summary).reduce((s, x) => s + x.bear, 0), total: a.indicators.total },
    supports: a.levels.supports.slice(0, 3).map(lvl),
    resistances: a.levels.resistances.slice(0, 3).map(lvl),
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

async function callClaude(c: AiConfig, system: string, user: string, opts: { json: boolean; effort?: Effort }): Promise<CallResult> {
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
      ...(opts.json ? { format: { type: "json_schema", schema: OUTPUT_SCHEMA as unknown as Record<string, unknown> } } : {}),
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

export interface Interpretation {
  content: AiContent;
  model: string;
  createdAt: number;
  barTime: number;
  cached: boolean;
  stale?: boolean;
}

const pending = new Map<string, Promise<Interpretation>>();

function latestCached(coin: string, tf: Timeframe): Interpretation | null {
  const r = getDb().prepare("SELECT * FROM ai_cache WHERE coin = ? AND tf = ? ORDER BY created_at DESC LIMIT 1").get(coin, tf) as
    | { content: string; model: string; created_at: number; bar_t: number }
    | undefined;
  return r ? { content: JSON.parse(r.content), model: r.model, createdAt: r.created_at, barTime: r.bar_t, cached: true, stale: true } : null;
}

const cacheKey = (c: AiConfig, coin: string, tf: Timeframe, barTime: number) => `${coin}|${tf}|${barTime}|${c.revision}|${promptHash(c)}`;

function cachedAt(key: string): Interpretation | null {
  const hit = getDb().prepare("SELECT content, model, created_at, bar_t FROM ai_cache WHERE key = ?").get(key) as
    | { content: string; model: string; created_at: number; bar_t: number }
    | undefined;
  return hit ? { content: JSON.parse(hit.content), model: hit.model, createdAt: hit.created_at, barTime: hit.bar_t, cached: true } : null;
}

/** The interpretation already generated for the last closed bar, if anyone asked for it. Never calls the model. */
export async function peekInterpretation(coin: string, tf: Timeframe): Promise<Interpretation | null> {
  const c = getAiConfig();
  if (!c.enabled || !c.apiKeyEnc) return null;
  const a = await analyze(coin, tf);
  return cachedAt(cacheKey(c, coin, tf, a.lastClosedT));
}

/** Get (or generate once) the interpretation for the last closed bar. */
export async function interpret(coin: string, tf: Timeframe): Promise<Interpretation> {
  const c = getAiConfig();
  if (!c.enabled || !c.apiKeyEnc) throw new AiError("AI 解读未启用", "disabled");
  const a = await analyze(coin, tf);
  const barTime = a.lastClosedT;
  const key = cacheKey(c, coin, tf, barTime);

  const hit = cachedAt(key);
  if (hit) return hit;
  const p = pending.get(key);
  if (p) return p;

  if (callsToday() >= c.dailyLimit) {
    logger.warn("ai", "今日 AI 解读额度已用完", { limit: c.dailyLimit, coin, tf });
    const old = latestCached(coin, tf);
    if (old) return old;
    throw new AiError(`今日 AI 解读额度（${c.dailyLimit} 次）已用完，明天会自动恢复`, "quota");
  }

  const job = (async (): Promise<Interpretation> => {
    const t0 = Date.now();
    const mtf = await multiTimeframe(coin);
    const snapshot = buildSnapshot(a, mtf);
    let r: CallResult;
    try {
      r = await callClaude(c, c.prompt || DEFAULT_PROMPT, `请解读下面这份行情快照：\n${JSON.stringify(snapshot)}`, { json: true });
    } catch (e) {
      recordUsage(false);
      const err = describeApiError(e);
      logger.error("ai", `AI 解读失败 ${coin} ${tf}：${err.message}`, { kind: err.kind, model: c.model, durationMs: Date.now() - t0 });
      throw err;
    }
    recordUsage(r.stopReason !== "refusal", r.usage);
    if (r.stopReason === "refusal") {
      logger.warn("ai", `AI 拒绝了解读请求 ${coin} ${tf}`, { category: r.refusalCategory, model: r.model });
      throw new AiError("AI 这次没有给出解读，请稍后再试", "refusal");
    }
    let content: AiContent;
    try {
      content = JSON.parse(r.text) as AiContent;
      if (!content.headline || !Array.isArray(content.watch)) throw new Error("字段缺失");
    } catch (e) {
      logger.error("ai", `AI 返回内容无法解析 ${coin} ${tf}`, { error: (e as Error).message, stopReason: r.stopReason, sample: r.text.slice(0, 300) });
      throw new AiError("AI 返回的内容格式不正确", "bad_output");
    }
    const ms = Date.now() - t0;
    const now = Date.now();
    getDb()
      .prepare("INSERT OR REPLACE INTO ai_cache (key, coin, tf, bar_t, created_at, model, content, input_tokens, output_tokens, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(key, coin, tf, barTime, now, r.model, JSON.stringify(content), r.usage.input_tokens, r.usage.output_tokens, ms);
    // keep the table small: only the newest 20 per coin/timeframe
    getDb()
      .prepare("DELETE FROM ai_cache WHERE coin = ? AND tf = ? AND key NOT IN (SELECT key FROM ai_cache WHERE coin = ? AND tf = ? ORDER BY created_at DESC LIMIT 20)")
      .run(coin, tf, coin, tf);
    logger.info("ai", `AI 解读生成 ${coin} ${tf}`, {
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
