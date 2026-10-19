"use client";

import { useEffect } from "react";

/** Sends uncaught browser errors to /api/client-log (at most 5 per page view). */
export function ErrorReporter() {
  useEffect(() => {
    let sent = 0;
    const send = (kind: string, msg: string, stack?: string) => {
      if (sent++ >= 5) return;
      const body = JSON.stringify({ kind, msg, stack, url: location.href });
      try {
        if (!navigator.sendBeacon?.("/api/client-log", new Blob([body], { type: "application/json" }))) {
          fetch("/api/client-log", { method: "POST", body, keepalive: true }).catch(() => {});
        }
      } catch {}
    };
    const onError = (e: ErrorEvent) => send("error", e.message, e.error?.stack);
    const onRejection = (e: PromiseRejectionEvent) => {
      const r = e.reason;
      send("unhandledrejection", r?.message ?? String(r), r?.stack);
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);
  return null;
}
