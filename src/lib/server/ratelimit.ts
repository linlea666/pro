/**
 * Fixed-window rate limiter for public endpoints, keyed by bucket + client IP.
 * In memory: the app runs as a single process, and a restart simply resets the windows.
 */

interface Window {
  n: number;
  start: number;
  /** each entry expires on its own window, so a 1-minute bucket's cleanup can't reset an hourly one */
  ms: number;
}

const MAX_KEYS = 50_000;

const windows = new Map<string, Window>();
const rejected = new Map<string, number>(); // bucket -> requests turned away since the last read

export interface LimitResult {
  ok: boolean;
  /** seconds until the window resets (only meaningful when !ok) */
  retryAfter: number;
}

/** One IPv6 user typically owns a whole /64, so count it as one address. */
export function ipKey(ip: string): string {
  if (!ip.includes(":")) return ip;
  const full = ip.split("%")[0];
  const [head] = full.split("::");
  const parts = head.split(":").filter(Boolean);
  return parts.length >= 4 ? `${parts.slice(0, 4).join(":")}::/64` : full;
}

export function allow(bucket: string, ip: string, max: number, windowMs: number, now = Date.now()): LimitResult {
  const key = `${bucket}|${ipKey(ip)}`;
  const w = windows.get(key);
  if (!w || now - w.start >= windowMs) {
    windows.set(key, { n: 1, start: now, ms: windowMs });
    if (windows.size > MAX_KEYS) sweep(now);
    return { ok: true, retryAfter: 0 };
  }
  if (w.n >= max) {
    rejected.set(bucket, (rejected.get(bucket) ?? 0) + 1);
    return { ok: false, retryAfter: Math.ceil((w.start + windowMs - now) / 1000) };
  }
  w.n++;
  return { ok: true, retryAfter: 0 };
}

/** Would `allow` let this through? Doesn't count anything. */
export function wouldAllow(bucket: string, ip: string, max: number, now = Date.now()): boolean {
  const w = windows.get(`${bucket}|${ipKey(ip)}`);
  return !w || now - w.start >= w.ms || w.n < max;
}

function sweep(now: number) {
  for (const [k, w] of windows) if (now - w.start >= w.ms) windows.delete(k);
  // still too big (a flood of distinct IPs): drop the short windows first, the hourly ones last
  if (windows.size > MAX_KEYS) for (const [k, w] of windows) if (w.ms <= 60_000) windows.delete(k);
}

/** Rejections per bucket since the previous call; used for the periodic log summary. */
export function takeRejected(): Record<string, number> {
  const out = Object.fromEntries(rejected);
  rejected.clear();
  return out;
}

/** For tests. */
export function resetLimits() {
  windows.clear();
  rejected.clear();
}
