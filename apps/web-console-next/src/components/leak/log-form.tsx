"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { STORAGE_PREFIX } from "@/lib/app-config";
import type { LogServiceEventRequest, ServiceEventKind } from "@saas/contracts/leak";
import { SERVICE_EVENT_KIND_LABELS, VERIFICATION_KINDS, formatOunces, toOunces } from "@saas/contracts/leak";

const TECHNICIAN_KEY = `${STORAGE_PREFIX}.technician-name`;

/** The kinds a technician picks from on site, most common first. */
const QUICK_KINDS: ServiceEventKind[] = [
  "service",
  "leak_inspection",
  "repair",
  "verification_initial",
  "verification_followup",
  "installation",
  "seasonal_adjustment",
  "retrofit",
  "mothball",
  "retirement",
];

/** Today in the device's own time zone — the technician's calendar day. */
export function localToday(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function readTechnician(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(TECHNICIAN_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeTechnician(name: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(TECHNICIAN_KEY, name);
  } catch {
    /* ignore */
  }
}

interface Quantity {
  lb: string;
  oz: string;
}

const EMPTY: Quantity = { lb: "", oz: "" };

/** "" → 0; whole pounds and 0–15 ounces → total ounces; anything else → null. */
export function quantityToOunces(q: Quantity): number | null {
  const lb = q.lb.trim() === "" ? 0 : Number(q.lb);
  const oz = q.oz.trim() === "" ? 0 : Number(q.oz);
  if (!Number.isInteger(oz) || oz > 15) return null;
  return toOunces(lb, oz);
}

function QuantityField({
  id,
  label,
  hint,
  value,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  value: Quantity;
  onChange: (q: Quantity) => void;
}) {
  const total = quantityToOunces(value);
  return (
    <div>
      <label className="mb-1 block text-sm font-medium" htmlFor={`${id}-lb`}>
        {label}
      </label>
      <div className="flex items-center gap-2">
        <Input
          id={`${id}-lb`}
          inputMode="numeric"
          pattern="[0-9]*"
          className="h-11 w-24 text-base"
          value={value.lb}
          onChange={(e) => onChange({ ...value, lb: e.target.value })}
          aria-label={`${label}, pounds`}
          placeholder="0"
        />
        <span className="text-sm text-muted-foreground">lb</span>
        <Input
          inputMode="numeric"
          pattern="[0-9]*"
          className="h-11 w-20 text-base"
          value={value.oz}
          onChange={(e) => onChange({ ...value, oz: e.target.value })}
          aria-label={`${label}, ounces`}
          placeholder="0"
        />
        <span className="text-sm text-muted-foreground">oz</span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {total === null ? <span className="text-destructive">Whole pounds, and 0–15 ounces</span> : hint}
      </p>
    </div>
  );
}

export interface LogFormResult {
  ok: boolean;
  message?: string;
  fields?: Record<string, string[]>;
}

/**
 * The one-screen service log. Used by the phone page (a scanned label) and by
 * the appliance page. Quantities are entered as pounds + ounces and sent as
 * integer ounces; the technician's name is remembered on this device.
 */
export function LogForm({
  onSubmit,
  compact = false,
}: {
  onSubmit: (body: LogServiceEventRequest) => Promise<LogFormResult>;
  compact?: boolean;
}) {
  const [kind, setKind] = React.useState<ServiceEventKind>("service");
  const [serviceDate, setServiceDate] = React.useState(localToday());
  const [technician, setTechnician] = React.useState("");
  const [added, setAdded] = React.useState<Quantity>(EMPTY);
  const [recovered, setRecovered] = React.useState<Quantity>(EMPTY);
  const [returned, setReturned] = React.useState<Quantity>(EMPTY);
  const [component, setComponent] = React.useState("");
  const [work, setWork] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [passed, setPassed] = React.useState<boolean | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [errors, setErrors] = React.useState<Record<string, string[]>>({});
  const [message, setMessage] = React.useState<string | null>(null);

  React.useEffect(() => setTechnician(readTechnician()), []);

  const isVerification = VERIFICATION_KINDS.includes(kind);
  const addedOz = quantityToOunces(added);
  const recoveredOz = quantityToOunces(recovered);
  const returnedOz = quantityToOunces(returned);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMessage(null);
    if (addedOz === null || recoveredOz === null || returnedOz === null) {
      setMessage("Check the quantities: whole pounds and 0–15 ounces.");
      return;
    }
    if (isVerification && passed === null) {
      setMessage("Did the verification test pass?");
      return;
    }
    const body: LogServiceEventRequest = {
      serviceDate,
      kind,
      technicianName: technician.trim(),
      component,
      workPerformed: work,
      notes,
      addedOz,
      recoveredOz,
      returnedOz,
      ...(isVerification && passed !== null ? { verificationPassed: passed } : {}),
    };
    setBusy(true);
    const r = await onSubmit(body);
    setBusy(false);
    if (!r.ok) {
      setErrors(r.fields ?? {});
      setMessage(r.message ?? "Could not save the visit.");
      return;
    }
    writeTechnician(technician.trim());
    setErrors({});
    setAdded(EMPTY);
    setRecovered(EMPTY);
    setReturned(EMPTY);
    setComponent("");
    setWork("");
    setNotes("");
    setPassed(null);
    setMessage(null);
  }

  const fieldError = (name: string) =>
    errors[name]?.length ? <p className="mt-1 text-xs text-destructive">{errors[name]!.join(" ")}</p> : null;

  return (
    <form onSubmit={submit} className="space-y-4">
      <fieldset>
        <legend className="mb-2 text-sm font-medium">What was done</legend>
        <div className="flex flex-wrap gap-2">
          {QUICK_KINDS.map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              aria-pressed={kind === k}
              className={`min-h-11 rounded-full border px-3 text-sm ${
                kind === k ? "border-primary bg-primary text-primary-foreground" : "bg-background hover:bg-accent"
              }`}
            >
              {SERVICE_EVENT_KIND_LABELS[k]}
            </button>
          ))}
        </div>
        {fieldError("kind")}
      </fieldset>

      {isVerification && (
        <fieldset>
          <legend className="mb-2 text-sm font-medium">Result</legend>
          <div className="flex gap-2">
            <Button type="button" variant={passed === true ? "default" : "outline"} className="h-11" onClick={() => setPassed(true)}>
              Passed
            </Button>
            <Button type="button" variant={passed === false ? "destructive" : "outline"} className="h-11" onClick={() => setPassed(false)}>
              Failed
            </Button>
          </div>
          {fieldError("verificationPassed")}
        </fieldset>
      )}

      <div className={compact ? "space-y-4" : "grid gap-4 sm:grid-cols-2"}>
        <div>
          <label className="mb-1 block text-sm font-medium" htmlFor="lf-date">
            Date of service
          </label>
          <Input id="lf-date" type="date" className="h-11 text-base" value={serviceDate} max={localToday()} onChange={(e) => setServiceDate(e.target.value)} required />
          {fieldError("serviceDate")}
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium" htmlFor="lf-tech">
            Technician
          </label>
          <Input
            id="lf-tech"
            className="h-11 text-base"
            autoComplete="name"
            value={technician}
            onChange={(e) => setTechnician(e.target.value)}
            placeholder="Who did the work"
            required
          />
          {fieldError("technicianName")}
        </div>
      </div>

      <div className={compact ? "space-y-4" : "grid gap-4 sm:grid-cols-3"}>
        <div>
          <QuantityField
            id="lf-added"
            label="Refrigerant added"
            hint={addedOz ? `${formatOunces(addedOz)} charged in` : "Charged into the system"}
            value={added}
            onChange={setAdded}
          />
          {fieldError("addedOz")}
        </div>
        <div>
          <QuantityField
            id="lf-recovered"
            label="Recovered and held"
            hint="Pulled out to go back into this unit"
            value={recovered}
            onChange={setRecovered}
          />
          {fieldError("recoveredOz")}
        </div>
        <div>
          <QuantityField
            id="lf-returned"
            label="Of the added, returned"
            hint="Refrigerant recovered from this unit earlier"
            value={returned}
            onChange={setReturned}
          />
          {fieldError("returnedOz")}
        </div>
      </div>

      <div className={compact ? "space-y-4" : "grid gap-4 sm:grid-cols-2"}>
        <div>
          <label className="mb-1 block text-sm font-medium" htmlFor="lf-component">
            Part serviced
          </label>
          <Input id="lf-component" className="h-11 text-base" value={component} onChange={(e) => setComponent(e.target.value)} placeholder="e.g. condenser coil" />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium" htmlFor="lf-work">
            Work performed
          </label>
          <Input id="lf-work" className="h-11 text-base" value={work} onChange={(e) => setWork(e.target.value)} placeholder="e.g. brazed leak, pressure tested" />
        </div>
      </div>
      {!compact && (
        <div>
          <label className="mb-1 block text-sm font-medium" htmlFor="lf-notes">
            Notes
          </label>
          <Textarea id="lf-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
      )}

      {message && (
        <p role="alert" className="text-sm text-destructive">
          {message}
        </p>
      )}
      <Button type="submit" className="h-12 w-full text-base sm:w-auto" disabled={busy}>
        {busy ? "Saving…" : "Save visit"}
      </Button>
    </form>
  );
}
