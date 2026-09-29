"use client";

import { Badge } from "@/components/ui/badge";
import type { PublicRepairClock } from "@saas/contracts/leak";
import { formatRateBp } from "@saas/contracts/leak-rate";

/** "due in 9 days", "due today", "3 days overdue". */
export function daysPhrase(days: number): string {
  if (days < 0) return `${Math.abs(days)} day${days === -1 ? "" : "s"} overdue`;
  if (days === 0) return "due today";
  return `due in ${days} day${days === 1 ? "" : "s"}`;
}

export function ClockStatus({ clock }: { clock: PublicRepairClock }) {
  if (clock.status === "closed") return <Badge variant="success">Closed</Badge>;
  if (clock.status === "suspended") return <Badge variant="secondary">Suspended (mothballed)</Badge>;
  if (clock.status === "overdue") return <Badge variant="destructive">Overdue</Badge>;
  return <Badge>Open</Badge>;
}

/** What the clock needs next, in one sentence. */
export function clockNextStep(clock: PublicRepairClock): string {
  if (clock.status === "closed") {
    return clock.closedReason === "retired" ? `Closed ${clock.closedOn}: the unit was retired.` : `Closed ${clock.closedOn}: the follow-up verification passed.`;
  }
  if (clock.status === "suspended") return "Suspended while the unit is mothballed; it resumes when refrigerant is added.";
  const d = clock.deadline;
  if (!d) return "";
  return d.kind === "repair"
    ? `Repair and initial verification test ${daysPhrase(d.daysLeft)} (${d.dueOn}).`
    : `Follow-up verification test ${daysPhrase(d.daysLeft)} (${d.dueOn}).`;
}

/** The appliance page's and phone page's banner for a running clock (design §4). */
export function ClockBanner({ clock }: { clock: PublicRepairClock }) {
  const urgent = clock.status === "overdue" || (clock.deadline !== null && clock.deadline.daysLeft <= 3);
  return (
    <div
      role="status"
      className={`rounded-lg border p-3 text-sm ${urgent ? "border-destructive bg-destructive/5" : "border-amber-500 bg-amber-500/5"}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">Repair clock</span>
        <ClockStatus clock={clock} />
        <span className="text-muted-foreground">
          opened {clock.openedOn} at {formatRateBp(clock.leakRateBp)} (threshold {clock.thresholdPct} %, 40 CFR {clock.regime})
        </span>
      </div>
      <p className="mt-1">{clockNextStep(clock)}</p>
    </div>
  );
}
