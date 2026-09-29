import {
  addCalendarDays,
  daysBetween,
  formatRateBp,
} from "@saas/contracts/leak-rate";
import {
  clockDeadline,
  daysLeft,
  dueRung,
  followupDueOn,
  repairDueOn,
  rungKey,
  type RepairClockStatus,
} from "@saas/contracts/leak-clock";
import type { SqlExecutor } from "@saas/db/d1";
import type { Appliance, ServiceEvent } from "@saas/db/leak";
import type { LeakClockRepository, RepairClock } from "@saas/db/leak";
import { buildIdempotencyKey, type EnqueueNotificationResult } from "@saas/notifications-client";
import type { EnqueueNotificationRequest } from "@saas/contracts/notifications";
import { recordAudit, type AuditActor } from "./audit.js";
import { appliancePublicId, clockPublicId, eventPublicId, sitePublicId } from "./ids.js";

/** Clocks handled per tick; the cron is daily, and a backlog drains over ticks. */
export const SWEEP_CLOCK_LIMIT = 500;

export type Enqueue = (request: EnqueueNotificationRequest, requestId: string) => Promise<EnqueueNotificationResult>;

export interface ClockDeps {
  clocks: LeakClockRepository;
  executor: SqlExecutor;
  /** Absent when the worker has no NOTIFICATIONS_WORKER binding: rungs stay unclaimed and are retried. */
  enqueue: Enqueue | null;
}

const SYSTEM: AuditActor = { type: "system", id: "leak-worker" };

function clockAudit(
  deps: ClockDeps,
  type: string,
  clock: RepairClock,
  description: string,
  actor: AuditActor,
  requestId: string,
  occurredAt: string,
  extra: Record<string, unknown> = {},
): Promise<boolean> {
  return recordAudit(deps.executor, {
    type,
    orgId: clock.orgId,
    actor,
    requestId,
    subjectKind: "leak_repair_clock",
    subjectId: clock.id,
    subjectName: `${clock.applianceName} — opened ${clock.openedOn}`,
    description,
    payload: {
      clockId: clockPublicId(clock.id),
      applianceId: appliancePublicId(clock.applianceId),
      siteId: sitePublicId(clock.siteId),
      status: clock.status,
      openedOn: clock.openedOn,
      repairDueOn: clock.repairDueOn,
      followupDueOn: clock.followupDueOn,
      ...extra,
    },
    occurredAt,
  });
}

// ── The log moves the clock ─────────────────────────────────

/**
 * Apply a just-logged event to the appliance's repair clock (design §1.5):
 * an exceedance opens one (or joins the running one), a passing initial
 * verification sets the follow-up deadline, a passing follow-up closes it, a
 * mothball suspends it, refrigerant added to a mothballed unit resumes it, and
 * a retirement closes it. Returns the clock the event opened, if any.
 */
export async function applyEventToClock(
  deps: ClockDeps,
  appliance: Appliance,
  event: ServiceEvent,
  actor: AuditActor,
  requestId: string,
  now: string,
): Promise<{ opened: RepairClock | null; clock: RepairClock | null }> {
  const orgId = appliance.orgId;
  let clock = await deps.clocks.getRunningClock(orgId, appliance.id);

  // A mothballed unit's clock resumes the day refrigerant is added (84.106(d)(3)).
  if (clock && clock.status === "suspended" && clock.suspendedOn && event.addedOz > 0) {
    const days = Math.max(0, daysBetween(clock.suspendedOn, event.serviceDate));
    const resumed = await deps.clocks.resumeClock(
      orgId,
      clock.id,
      days,
      addCalendarDays(clock.repairDueOn, days),
      clock.followupDueOn ? addCalendarDays(clock.followupDueOn, days) : null,
      now,
    );
    if (resumed) {
      clock = resumed;
      await clockAudit(deps, "leak.clock.resumed", resumed, `Resumed the repair clock on "${resumed.applianceName}" after ${days} days mothballed`, actor, requestId, now, { suspendedDays: days });
    }
  }

  if (!clock) {
    if (event.exceedsThreshold !== true || event.leakRateBp === null || event.thresholdPct === null || !event.regime) {
      return { opened: null, clock: null };
    }
    const opened = await deps.clocks.openClock({
      id: crypto.randomUUID(),
      orgId,
      siteId: appliance.siteId,
      applianceId: appliance.id,
      openedByEventId: event.id,
      openedOn: event.serviceDate,
      leakRateBp: event.leakRateBp,
      thresholdPct: event.thresholdPct,
      regime: event.regime,
      repairDueOn: repairDueOn(event.serviceDate, false),
      now,
    });
    if (!opened) return { opened: null, clock: await deps.clocks.getRunningClock(orgId, appliance.id) };
    await clockAudit(
      deps,
      "leak.clock.opened",
      opened,
      `"${opened.applianceName}" leaked at ${formatRateBp(opened.leakRateBp)} (over ${opened.thresholdPct} %): repair due ${opened.repairDueOn}`,
      actor,
      requestId,
      now,
      { eventId: eventPublicId(event.id), leakRateBp: opened.leakRateBp, thresholdPct: opened.thresholdPct },
    );
    return { opened, clock: opened };
  }

  // A running clock: an exceedance joins it (the 30 days run from the first).
  if (event.kind === "verification_initial" && event.verificationPassed === true && clock.initialVerifiedOn === null) {
    if (clock.status === "suspended") return { opened: null, clock };
    const verified = await deps.clocks.recordInitialVerification(
      orgId,
      clock.id,
      event.serviceDate,
      event.id,
      followupDueOn(event.serviceDate),
      now,
    );
    if (verified) {
      clock = verified;
      await clockAudit(deps, "leak.clock.verified", verified, `Initial verification passed on "${verified.applianceName}"; follow-up due ${verified.followupDueOn}`, actor, requestId, now, { eventId: eventPublicId(event.id) });
    }
    return { opened: null, clock };
  }

  if (
    event.kind === "verification_followup" &&
    event.verificationPassed === true &&
    clock.initialVerifiedOn !== null &&
    event.serviceDate >= clock.initialVerifiedOn
  ) {
    const closed = await deps.clocks.closeClock(orgId, clock.id, event.serviceDate, event.id, "verified", now);
    if (closed) {
      await clockAudit(deps, "leak.clock.closed", closed, `Follow-up verification passed on "${closed.applianceName}"; the repair clock is closed`, actor, requestId, now, { eventId: eventPublicId(event.id), reason: "verified" });
      return { opened: null, clock: closed };
    }
    return { opened: null, clock };
  }

  if (event.kind === "retirement") {
    const closed = await deps.clocks.closeClock(orgId, clock.id, event.serviceDate, event.id, "retired", now);
    if (closed) {
      await clockAudit(deps, "leak.clock.closed", closed, `"${closed.applianceName}" was retired; the repair clock is closed`, actor, requestId, now, { eventId: eventPublicId(event.id), reason: "retired" });
      return { opened: null, clock: closed };
    }
    return { opened: null, clock };
  }

  if (event.kind === "mothball") {
    const suspended = await deps.clocks.suspendClock(orgId, clock.id, event.serviceDate, now);
    if (suspended) {
      await clockAudit(deps, "leak.clock.suspended", suspended, `"${suspended.applianceName}" was mothballed; the repair clock is suspended`, actor, requestId, now, { eventId: eventPublicId(event.id) });
      return { opened: null, clock: suspended };
    }
  }
  return { opened: null, clock };
}

// ── Reminders ───────────────────────────────────────────────

/** The deadline an open or overdue clock counts down to (an overdue clock still has one). */
export function runningDeadline(clock: RepairClock): ReturnType<typeof clockDeadline> {
  return clockDeadline({
    status: clock.status === "overdue" ? "open" : (clock.status as RepairClockStatus),
    repairDueOn: clock.repairDueOn,
    initialVerifiedOn: clock.initialVerifiedOn,
    followupDueOn: clock.followupDueOn,
  });
}

export type RungOutcome = "sent" | "already_sent" | "deferred";

const TEMPLATE_OPENED = "leak.clock.opened";
const TEMPLATE_REMINDER = "leak.clock.reminder";
const TEMPLATE_OVERDUE = "leak.clock.overdue";
const TEMPLATE_ESCALATION = "leak.clock.escalation";

function templateData(clock: RepairClock, today: string): Record<string, string | number | boolean | null> {
  const deadline = runningDeadline(clock);
  return {
    applianceName: clock.applianceName,
    siteName: clock.siteName,
    leakRate: formatRateBp(clock.leakRateBp),
    thresholdPct: clock.thresholdPct,
    regime: clock.regime,
    openedOn: clock.openedOn,
    deadlineKind: deadline?.kind ?? "repair",
    dueOn: deadline?.dueOn ?? clock.repairDueOn,
    daysLeft: deadline ? daysLeft(deadline.dueOn, today) : 0,
  };
}

/**
 * Send one rung to one recipient exactly once: claim the (clock, rung,
 * recipient) row with INSERT … ON CONFLICT DO NOTHING RETURNING, then send. A
 * send that does not land gives the claim back so the next tick retries it;
 * the notification's idempotency key makes that retry safe.
 */
export async function sendRung(
  deps: ClockDeps,
  clock: RepairClock,
  rung: string,
  templateKey: string,
  recipient: string,
  today: string,
  now: string,
  requestId: string,
): Promise<RungOutcome> {
  if (!deps.enqueue) return "deferred";
  const claim = await deps.clocks.claimReminder({
    id: crypto.randomUUID(),
    orgId: clock.orgId,
    clockId: clock.id,
    rung,
    sentTo: recipient,
    now,
  });
  if (!claim) return "already_sent";
  let result: EnqueueNotificationResult;
  try {
    result = await deps.enqueue(
      {
        orgId: clock.orgId,
        category: "product",
        templateKey,
        templateData: templateData(clock, today),
        recipient: { channel: "email", address: recipient },
        idempotencyKey: buildIdempotencyKey("leak.clock", clockPublicId(clock.id), rung, recipient),
        correlationId: clockPublicId(clock.id),
      },
      requestId,
    );
  } catch {
    result = { ok: false, reason: "network_error" } as EnqueueNotificationResult;
  }
  if (!result.ok) {
    await deps.clocks.releaseReminder(claim);
    return "deferred";
  }
  await deps.clocks.recordReminderNotification(claim, result.notificationId);
  return "sent";
}

export interface SweepReport {
  today: string;
  clocks: number;
  sent: number;
  alreadySent: number;
  deferred: number;
  overdue: number;
}

/**
 * One tick of the daily clock. For every open or overdue clock: the "opened"
 * email to the admins if it never went out, the reminder rung due today
 * (14 / 7 / 3 / 1 / 0 days before the deadline), and once the deadline has
 * passed, the overdue email to the admins and the escalation to the site's
 * owner contact. Every rung is claimed before it is sent, so any number of
 * ticks on one day send each rung once.
 */
export async function runClockSweep(
  deps: ClockDeps,
  today: string,
  now: string,
  opts: { orgId?: string; requestId?: string } = {},
): Promise<SweepReport> {
  const requestId = opts.requestId ?? `sweep_${today}`;
  const report: SweepReport = { today, clocks: 0, sent: 0, alreadySent: 0, deferred: 0, overdue: 0 };
  const clocks = await deps.clocks.listRunningClocks(SWEEP_CLOCK_LIMIT, opts.orgId);
  report.clocks = clocks.length;
  const admins = new Map<string, string[]>();

  const count = (o: RungOutcome): void => {
    if (o === "sent") report.sent += 1;
    else if (o === "already_sent") report.alreadySent += 1;
    else report.deferred += 1;
  };

  for (let clock of clocks) {
    try {
      let recipients = admins.get(clock.orgId);
      if (!recipients) {
        recipients = await deps.clocks.listAdminEmails(clock.orgId);
        admins.set(clock.orgId, recipients);
      }
      const deadline = runningDeadline(clock);
      if (!deadline) continue;
      const left = daysLeft(deadline.dueOn, today);

      if (left < 0 && clock.status === "open") {
        const marked = await deps.clocks.markOverdue(clock.id, now);
        if (marked) {
          clock = marked;
          report.overdue += 1;
          await clockAudit(deps, "leak.clock.overdue", marked, `The ${deadline.kind} deadline on "${marked.applianceName}" (${deadline.dueOn}) has passed`, SYSTEM, requestId, now, { deadlineKind: deadline.kind, dueOn: deadline.dueOn });
        }
      }

      for (const to of recipients) {
        count(await sendRung(deps, clock, "opened", TEMPLATE_OPENED, to, today, now, requestId));
      }
      if (left < 0) {
        for (const to of recipients) {
          count(await sendRung(deps, clock, rungKey(deadline.kind, "overdue"), TEMPLATE_OVERDUE, to, today, now, requestId));
        }
        if (clock.ownerContactEmail) {
          count(
            await sendRung(deps, clock, rungKey(deadline.kind, "escalation"), TEMPLATE_ESCALATION, clock.ownerContactEmail, today, now, requestId),
          );
        }
      } else {
        const rung = dueRung(left);
        if (rung !== null) {
          for (const to of recipients) {
            count(await sendRung(deps, clock, rungKey(deadline.kind, rung), TEMPLATE_REMINDER, to, today, now, requestId));
          }
        }
      }
    } catch {
      report.deferred += 1;
    }
  }
  return report;
}

/** The "opened" email right after the logging request opened a clock; the sweep retries it if this fails. */
export async function notifyOpened(
  deps: ClockDeps,
  clock: RepairClock,
  today: string,
  now: string,
  requestId: string,
): Promise<void> {
  try {
    const recipients = await deps.clocks.listAdminEmails(clock.orgId);
    for (const to of recipients) await sendRung(deps, clock, "opened", TEMPLATE_OPENED, to, today, now, requestId);
  } catch {
    // Advisory (risk LB-G): the record is the row; the next tick retries.
  }
}
