/**
 * Fixed-window rate limiter for public endpoints, keyed by bucket + client IP.
 * In memory: the app runs as a single process, and a restart simply resets the windows.
 */

interface Window {
  n: number;
  start: number;
}

const windows = new Map<string, Window>();
const rejected = new Map<string, number>(); // bucket -> requests turned away since the last read

export interface LimitResult {
  ok: boolean;
  /** seconds until the window resets (only meaningful when !ok) */
  retryAfter: number;
}

export function allow(bucket: string, ip: string, max: number, windowMs: number, now = Date.now()): LimitResult {
  const key = `${bucket}|${ip}`;
  const w = windows.get(key);
  if (!w || now - w.start >= windowMs) {
    windows.set(key, { n: 1, start: now });
    if (windows.size > 20_000) sweep(now, windowMs);
    return { ok: true, retryAfter: 0 };
  }
  if (w.n >= max) {
    rejected.set(bucket, (rejected.get(bucket) ?? 0) + 1);
    return { ok: false, retryAfter: Math.ceil((w.start + windowMs - now) / 1000) };
  }
  w.n++;
  return { ok: true, retryAfter: 0 };
}

function sweep(now: number, windowMs: number) {
  for (const [k, w] of windows) if (now - w.start >= windowMs) windows.delete(k);
  // still too big (many active IPs): start over rather than grow without bound
  if (windows.size > 20_000) windows.clear();
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
