import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { getDb } from "./db.ts";
import { env } from "./env.ts";

/**
 * Admin accounts and sessions. Passwords: scrypt with per-user salt.
 * Session tokens are random; only their SHA-256 is stored.
 */

export const SESSION_COOKIE = "sl_admin";
export const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export interface Admin {
  id: number;
  username: string;
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [alg, n, r, p, salt, hash] = stored.split("$");
  if (alg !== "scrypt") return false;
  const expected = Buffer.from(hash, "base64");
  const got = scryptSync(password, Buffer.from(salt, "base64"), expected.length, { N: +n, r: +r, p: +p });
  return got.length === expected.length && timingSafeEqual(got, expected);
}

export function validatePassword(password: string): string | null {
  if (password.length < 8) return "密码至少 8 位";
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return "密码需要同时包含字母和数字";
  return null;
}

/** Create or reset an admin. Returns the admin id. */
export function upsertAdmin(username: string, password: string): number {
  const d = getDb();
  const hash = hashPassword(password);
  const existing = d.prepare("SELECT id FROM admins WHERE username = ?").get(username) as { id: number } | undefined;
  if (existing) {
    d.prepare("UPDATE admins SET password_hash = ? WHERE id = ?").run(hash, existing.id);
    d.prepare("DELETE FROM sessions WHERE admin_id = ?").run(existing.id);
    return existing.id;
  }
  return Number(d.prepare("INSERT INTO admins (username, password_hash, created_at) VALUES (?, ?, ?)").run(username, hash, Date.now()).lastInsertRowid);
}

export function adminCount(): number {
  return (getDb().prepare("SELECT COUNT(*) n FROM admins").get() as { n: number }).n;
}

// ---------------------------------------------------------------- brute-force protection

const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;
const fails = new Map<string, { count: number; first: number; lockedUntil: number }>();

export function lockStatus(ip: string): number {
  const f = fails.get(ip);
  return f && f.lockedUntil > Date.now() ? f.lockedUntil : 0;
}

function recordFail(ip: string) {
  const now = Date.now();
  const f = fails.get(ip);
  if (!f || now - f.first > LOCK_MS) fails.set(ip, { count: 1, first: now, lockedUntil: 0 });
  else {
    f.count++;
    if (f.count >= MAX_FAILS) f.lockedUntil = now + LOCK_MS;
  }
}

// ---------------------------------------------------------------- sessions

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export type LoginResult = { ok: true; token: string; admin: Admin } | { ok: false; reason: "locked" | "invalid"; lockedUntil?: number };

export function login(username: string, password: string, ip: string, userAgent: string): LoginResult {
  const locked = lockStatus(ip);
  if (locked) return { ok: false, reason: "locked", lockedUntil: locked };
  const row = getDb().prepare("SELECT id, username, password_hash FROM admins WHERE username = ?").get(username) as
    | { id: number; username: string; password_hash: string }
    | undefined;
  // verify against a dummy hash when the user doesn't exist to keep timing similar
  const ok = row ? verifyPassword(password, row.password_hash) : (verifyPassword(password, DUMMY_HASH), false);
  if (!row || !ok) {
    recordFail(ip);
    return { ok: false, reason: "invalid", lockedUntil: lockStatus(ip) || undefined };
  }
  fails.delete(ip);
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  const d = getDb();
  d.prepare("INSERT INTO sessions (token_hash, admin_id, created_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)").run(sha256(token), row.id, now, now + SESSION_TTL_MS, ip, userAgent.slice(0, 200));
  d.prepare("UPDATE admins SET last_login_at = ? WHERE id = ?").run(now, row.id);
  d.prepare("DELETE FROM sessions WHERE expires_at < ?").run(now);
  return { ok: true, token, admin: { id: row.id, username: row.username } };
}

const DUMMY_HASH = hashPassword(randomBytes(8).toString("hex"));

export function sessionAdmin(token: string | undefined): Admin | null {
  if (!token) return null;
  const row = getDb()
    .prepare("SELECT a.id, a.username, s.expires_at FROM sessions s JOIN admins a ON a.id = s.admin_id WHERE s.token_hash = ?")
    .get(sha256(token)) as { id: number; username: string; expires_at: number } | undefined;
  if (!row || row.expires_at < Date.now()) return null;
  return { id: row.id, username: row.username };
}

export function logout(token: string | undefined) {
  if (token) getDb().prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
}

export function changePassword(adminId: number, current: string, next: string): string | null {
  const row = getDb().prepare("SELECT password_hash FROM admins WHERE id = ?").get(adminId) as { password_hash: string } | undefined;
  if (!row || !verifyPassword(current, row.password_hash)) return "当前密码不正确";
  const bad = validatePassword(next);
  if (bad) return bad;
  getDb().prepare("UPDATE admins SET password_hash = ? WHERE id = ?").run(hashPassword(next), adminId);
  return null;
}

// ---------------------------------------------------------------- IP allowlist

/** Entries are exact IPs or prefixes ending in "." / ":" (e.g. "10.0.0."). */
export function ipAllowed(ip: string): boolean {
  if (env.adminAllowlist.length === 0) return true;
  const v = ip.replace(/^::ffff:/, "");
  return env.adminAllowlist.some((e) => (e.endsWith(".") || e.endsWith(":") ? v.startsWith(e) : v === e));
}
