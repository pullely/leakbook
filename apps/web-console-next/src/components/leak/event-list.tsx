"use client";

import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { PublicServiceEvent } from "@saas/contracts/leak";
import { SERVICE_EVENT_KIND_LABELS, formatOunces } from "@saas/contracts/leak";
import type { ApiResult } from "@/lib/api";

/** Adapt a `wrap` result into the log form's result shape. */
export function toFormResult(r: ApiResult<unknown>): { ok: boolean; message?: string; fields?: Record<string, string[]> } {
  if (r.ok) return { ok: true };
  const details = (r.error as { details?: { fields?: Record<string, string[]> } }).details;
  return { ok: false, message: r.error.message, fields: details?.fields ?? {} };
}

function Quantities({ e }: { e: PublicServiceEvent }) {
  const parts: string[] = [];
  if (e.addedOz > 0) parts.push(`+${formatOunces(e.addedOz)} added`);
  if (e.returnedOz > 0) parts.push(`${formatOunces(e.returnedOz)} of it returned`);
  if (e.recoveredOz > 0) parts.push(`${formatOunces(e.recoveredOz)} recovered`);
  if (parts.length === 0) return null;
  return <div className="text-sm">{parts.join(" · ")}</div>;
}

/**
 * The service log as a list of cards — readable on a phone, dense enough on a
 * desk. A voided event stays in the list, struck through, with its reason.
 */
export function EventList({
  events,
  onVoid,
}: {
  events: PublicServiceEvent[];
  onVoid?: ((event: PublicServiceEvent, reason: string) => Promise<boolean>) | undefined;
}) {
  if (events.length === 0) {
    return <p className="text-sm text-muted-foreground">No visits logged yet.</p>;
  }
  return (
    <ul className="divide-y rounded-md border">
      {events.map((e) => (
        <EventRow key={e.id} e={e} onVoid={onVoid} />
      ))}
    </ul>
  );
}

function EventRow({
  e,
  onVoid,
}: {
  e: PublicServiceEvent;
  onVoid?: ((event: PublicServiceEvent, reason: string) => Promise<boolean>) | undefined;
}) {
  const [voiding, setVoiding] = React.useState(false);
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  return (
    <li className={`space-y-1 p-3 ${e.voided ? "opacity-60" : ""}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={`font-medium ${e.voided ? "line-through" : ""}`}>{e.serviceDate}</span>
        <Badge variant="secondary">{SERVICE_EVENT_KIND_LABELS[e.kind] ?? e.kind}</Badge>
        {e.verificationPassed === true && <Badge variant="success">Passed</Badge>}
        {e.verificationPassed === false && <Badge variant="destructive">Failed</Badge>}
        {e.loggedVia === "qr" && <Badge variant="outline">via label</Badge>}
        {e.voided && <Badge variant="destructive">Voided</Badge>}
        <span className="text-xs text-muted-foreground">{e.technicianName}</span>
      </div>
      <Quantities e={e} />
      {(e.component || e.workPerformed) && (
        <div className="text-xs text-muted-foreground">{[e.component, e.workPerformed].filter(Boolean).join(" — ")}</div>
      )}
      {e.notes && <div className="text-xs text-muted-foreground">{e.notes}</div>}
      {e.voided && e.voidReason && <div className="text-xs">Void reason: {e.voidReason}</div>}
      {onVoid && !e.voided && !voiding && (
        <Button variant="ghost" size="sm" onClick={() => setVoiding(true)}>
          Void…
        </Button>
      )}
      {onVoid && voiding && (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={async (ev) => {
            ev.preventDefault();
            setBusy(true);
            const ok = await onVoid(e, reason);
            setBusy(false);
            if (ok) setVoiding(false);
          }}
        >
          <input
            className="h-8 min-w-56 flex-1 rounded-md border bg-background px-2 text-sm"
            placeholder="Why is this entry wrong?"
            value={reason}
            onChange={(ev) => setReason(ev.target.value)}
            required
          />
          <Button type="submit" size="sm" variant="destructive" disabled={busy || reason.trim() === ""}>
            Void entry
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setVoiding(false)}>
            Cancel
          </Button>
        </form>
      )}
    </li>
  );
}
