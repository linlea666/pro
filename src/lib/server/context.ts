import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

/** Per-request context so every log line of one request shares a trace id. */
export interface RequestContext {
  trace: string;
  path?: string;
}

export const als = new AsyncLocalStorage<RequestContext>();

export const newTrace = () => randomBytes(6).toString("hex");

export function currentTrace(): string | undefined {
  return als.getStore()?.trace;
}

export function runWithTrace<T>(ctx: RequestContext, fn: () => T): T {
  return als.run(ctx, fn);
}
