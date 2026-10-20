"use client";

import type { EventName } from "@/lib/event-names";

/**
 * Anonymous product events. The visitor ID is random and lives only in this
 * browser; nothing personal is sent. Silently does nothing when storage or
 * the network is unavailable.
 */

const KEY = "sl-vid";
const once = new Set<string>();

function visitorId(): string | null {
  try {
    let id = localStorage.getItem(KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(KEY, id);
      send(id, "first_visit");
    }
    return id;
  } catch {
    return null;
  }
}

function send(vid: string, name: EventName) {
  const body = JSON.stringify({ vid, name, path: location.pathname });
  try {
    if (!navigator.sendBeacon?.("/api/event", new Blob([body], { type: "application/json" }))) {
      fetch("/api/event", { method: "POST", body, keepalive: true }).catch(() => {});
    }
  } catch {}
}

/** Record an event; with `onceKey`, at most once per page load for that key. */
export function track(name: EventName, onceKey?: string) {
  if (typeof window === "undefined") return;
  if (onceKey) {
    if (once.has(onceKey)) return;
    once.add(onceKey);
  }
  const vid = visitorId();
  if (vid) send(vid, name);
}
