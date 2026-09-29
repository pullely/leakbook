import type { Env } from "./env.js";
import type { LeakClockRepository, LeakRepository } from "@saas/db/leak";
import type { SqlExecutor } from "@saas/db/d1";
import { createLeakClockRepository, createLeakRepository } from "@saas/db/leak";
import { enqueueNotification } from "@saas/notifications-client";
import { runClockSweep, type ClockDeps, type SweepReport } from "./clock.js";
import { createSqlExecutor } from "@saas/db/d1";
import { addCalendarDays } from "@saas/contracts/leak-rate";

export interface Db {
  executor: SqlExecutor;
  leak: LeakRepository;
  clocks: LeakClockRepository;
}

/** Open the request's database handle, or null when the binding is missing. */
export function openDb(env: Env): (Db & { dispose(): Promise<void> }) | null {
  if (!env.PLATFORM_DB) return null;
  const executor = createSqlExecutor(env.PLATFORM_DB);
  return {
    executor,
    leak: createLeakRepository(executor),
    clocks: createLeakClockRepository(executor),
    dispose: () => executor.dispose(),
  };
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

/** LB3: the repair clock's dependencies over this request's database and the notifications binding. */
export function clockDeps(env: Env, db: Db): ClockDeps {
  return {
    clocks: db.clocks,
    executor: db.executor,
    enqueue: env.NOTIFICATIONS_WORKER
      ? (request, requestId) =>
          enqueueNotification(
            env,
            {
              internalActor: "leak-worker",
              actorSubjectType: "system",
              actorSubjectId: "leak-worker",
              requestId,
            },
            request,
          )
      : null,
  };
}

/** The `scheduled()` entry point: one pass over every organization's running clocks. */
export async function runScheduledClockSweep(env: Env): Promise<SweepReport | null> {
  const db = openDb(env);
  if (!db) return null;
  try {
    const report = await runClockSweep(clockDeps(env, db), todayUtc(), nowIso());
    // eslint-disable-next-line no-console -- one structured line per tick for Workers Logs
    console.log(JSON.stringify({ level: "info", msg: "leak.clock.sweep", ...report }));
    return report;
  } finally {
    await db.dispose();
  }
}
