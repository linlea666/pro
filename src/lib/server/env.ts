import path from "node:path";

/** Runtime configuration, all from environment variables (see .env.example). */
export const env = {
  dataDir: path.resolve(/*turbopackIgnore: true*/ process.env.DATA_DIR || path.join(/*turbopackIgnore: true*/ process.cwd(), "data")),
  logLevel: (process.env.LOG_LEVEL || "info") as "debug" | "info" | "warn" | "error",
  /** comma-separated IPs/prefixes allowed to reach /admin; empty = everyone */
  adminAllowlist: (process.env.ADMIN_IP_ALLOWLIST || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  /** 32-byte hex key for encrypting secrets at rest (AI keys) */
  masterKey: process.env.MASTER_KEY || "",
  version: process.env.APP_VERSION || "dev",
  /** set when served over HTTPS so cookies get the Secure flag */
  secureCookies: process.env.SECURE_COOKIES === "1",
};
