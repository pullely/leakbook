import type { Env } from "./env.js";
import type { LeakRepository } from "@saas/db/leak";
import type { SqlExecutor } from "@saas/db/d1";
import { createLeakRepository } from "@saas/db/leak";
import { createSqlExecutor } from "@saas/db/d1";

export interface Db {
  executor: SqlExecutor;
  leak: LeakRepository;
}

/** Open the request's database handle, or null when the binding is missing. */
export function openDb(env: Env): (Db & { dispose(): Promise<void> }) | null {
  if (!env.PLATFORM_DB) return null;
  const executor = createSqlExecutor(env.PLATFORM_DB);
  return { executor, leak: createLeakRepository(executor), dispose: () => executor.dispose() };
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Today's calendar date in UTC, YYYY-MM-DD. */
export function todayUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}
