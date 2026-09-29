import type { Env } from "./env.js";
import type { LeakRepository } from "@saas/db/leak";
import type { SqlExecutor } from "@saas/db/d1";
import { createLeakRepository } from "@saas/db/leak";
import { createSqlExecutor } from "@saas/db/d1";
import { addCalendarDays } from "@saas/contracts/leak-rate";

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

/**
 * LB2: how far back the live preview's history reaches. The arithmetic never
 * looks further than 365 days (annualizing caps d at 365, the rolling window
 * and the held balance are 365 days), so 400 covers a back-dated entry too.
 */
export const PREVIEW_HISTORY_DAYS = 400;

export function previewHistorySince(today: string = todayUtc()): string {
  return addCalendarDays(today, -PREVIEW_HISTORY_DAYS);
}
