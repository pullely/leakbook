/**
 * The repair clock of 40 CFR 84.106(d)–(e) (and 82.157(d)–(e)), LB3.
 * Design §1.5. Pure date arithmetic on YYYY-MM-DD calendar days, like
 * leak-rate.ts: no I/O and no clock. Callers pass `today`.
 *
 * - An addition over the threshold opens a clock. Repair is due 30 days after
 *   that addition's date, or 120 when an industrial process shutdown is
 *   needed (84.106(d)(1)).
 * - A passing initial verification test sets the follow-up due 10 days later
 *   (84.106(e)(1)–(2)). A passing follow-up closes the clock.
 * - A mothballed appliance suspends the clock. The days it spends mothballed
 *   are added to its deadlines when refrigerant is added again (84.106(d)(3)).
 */

import { addCalendarDays, daysBetween } from "./leak-rate.js";

export const REPAIR_DAYS = 30;
export const SHUTDOWN_REPAIR_DAYS = 120;
export const FOLLOWUP_DAYS = 10;
/** Days before a deadline on which a reminder goes out (design §5). */
export const REMINDER_RUNGS = [14, 7, 3, 1, 0] as const;

export const REPAIR_CLOCK_STATUSES = ["open", "overdue", "suspended", "closed"] as const;
export type RepairClockStatus = (typeof REPAIR_CLOCK_STATUSES)[number];
/** The clock states that still run (or are paused) — at most one per appliance. */
export const ACTIVE_CLOCK_STATUSES: readonly RepairClockStatus[] = ["open", "overdue", "suspended"];

export type ClockDeadlineKind = "repair" | "followup";

export interface ClockDates {
  status: RepairClockStatus;
  repairDueOn: string;
  initialVerifiedOn: string | null;
  followupDueOn: string | null;
}

/** 84.106(d): opened_on + 30 days, or + 120 with an industrial process shutdown, plus any suspension. */
export function repairDueOn(openedOn: string, shutdownRequired: boolean, suspendedDays = 0): string {
  return addCalendarDays(openedOn, (shutdownRequired ? SHUTDOWN_REPAIR_DAYS : REPAIR_DAYS) + suspendedDays);
}

/** 84.106(e)(2): the follow-up verification test is due 10 days after the initial one passes. */
export function followupDueOn(initialVerifiedOn: string): string {
  return addCalendarDays(initialVerifiedOn, FOLLOWUP_DAYS);
}

/**
 * The deadline a running clock is counting down to: the repair (until a
 * passing initial verification), then the follow-up. Null for a closed or
 * suspended clock, which counts down to nothing.
 */
export function clockDeadline(c: ClockDates): { kind: ClockDeadlineKind; dueOn: string } | null {
  if (c.status === "closed" || c.status === "suspended") return null;
  if (c.initialVerifiedOn === null) return { kind: "repair", dueOn: c.repairDueOn };
  if (c.followupDueOn !== null) return { kind: "followup", dueOn: c.followupDueOn };
  return null;
}

/** Calendar days from `today` to the deadline: 0 on the day, negative once past. */
export function daysLeft(dueOn: string, today: string): number {
  return daysBetween(today, dueOn);
}

/**
 * The reminder rung due for a deadline `left` days away: the most urgent rung
 * already reached (so a clock opened late, 2 days out, sends the 3-day rung
 * once, not the 14-, 7- and 3-day rungs together). Null outside the ladder or
 * once the deadline has passed (overdue is its own rung).
 */
export function dueRung(left: number): number | null {
  if (left < 0) return null;
  for (const rung of [...REMINDER_RUNGS].reverse()) {
    if (left <= rung) return rung;
  }
  return null;
}

/** Whether a running clock has missed its deadline on `today`. */
export function isOverdue(c: ClockDates, today: string): boolean {
  const deadline = clockDeadline(c);
  return deadline !== null && daysLeft(deadline.dueOn, today) < 0;
}

/** The rung key a reminder row and its notification idempotency key carry: "repair-14", "followup-0", "overdue-repair". */
export function rungKey(kind: ClockDeadlineKind, rung: number | "overdue" | "escalation"): string {
  return typeof rung === "number" ? `${kind}-${rung}` : `${rung}-${kind}`;
}
