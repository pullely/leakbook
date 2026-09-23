import {
  APPLIANCE_CATEGORIES,
  APPLIANCE_STATUSES,
  FULL_CHARGE_METHODS,
  LEAK_RATE_METHODS,
  LEAK_SITE_STATUSES,
  MAX_QUANTITY_OZ,
  REFRIGERANT_CLASSES,
  SERVICE_EVENT_KINDS,
  SERVICE_EVENT_SOURCES,
  VERIFICATION_KINDS,
  classifyRefrigerant,
  normalizeRefrigerant,
  type ServiceEventKind,
} from "@saas/contracts/leak";
import type { Appliance, ApplianceFields, LeakSite, LeakSiteFields } from "@saas/db/leak";

export type Validation<T> = { valid: true; value: T } | { valid: false; fields: Record<string, string[]> };

// No ':' anywhere: an address may become part of a notification idempotency key (LB3).
const EMAIL_RE = /^[^\s@:]+@[^\s@:]+\.[^\s@:]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const COUNTRY_RE = /^[A-Z]{2}$/;
const REFRIGERANT_RE = /^[A-Za-z0-9()\-. ]{1,40}$/;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A real calendar date in YYYY-MM-DD (rejects 2026-02-30). */
export function isCalendarDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** YYYY-MM-DD plus `days` calendar days. */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

class Collector {
  fields: Record<string, string[]> = {};
  add(field: string, message: string): void {
    (this.fields[field] ??= []).push(message);
  }
  get ok(): boolean {
    return Object.keys(this.fields).length === 0;
  }
}

/** undefined = absent; null = explicitly cleared; string = the trimmed value. */
function text(
  c: Collector,
  body: Record<string, unknown>,
  field: string,
  opts: { required: boolean; max: number },
): string | null | undefined {
  if (!(field in body) || body[field] === undefined) {
    if (opts.required) c.add(field, "Required");
    return undefined;
  }
  const v = body[field];
  if (v === null || v === "") {
    if (opts.required) c.add(field, "Required");
    return null;
  }
  if (typeof v !== "string") {
    c.add(field, "Must be a string");
    return undefined;
  }
  const trimmed = v.trim();
  if (opts.required && trimmed.length === 0) c.add(field, "Required");
  if (trimmed.length > opts.max) c.add(field, `At most ${opts.max} characters`);
  return trimmed.length === 0 ? null : trimmed;
}

function email(c: Collector, body: Record<string, unknown>, field: string): string | null | undefined {
  const v = text(c, body, field, { required: false, max: 254 });
  if (typeof v === "string" && !EMAIL_RE.test(v)) c.add(field, "Not an email address");
  return typeof v === "string" ? v.toLowerCase() : v;
}

function date(c: Collector, body: Record<string, unknown>, field: string, required: boolean): string | null | undefined {
  const v = text(c, body, field, { required, max: 10 });
  if (typeof v === "string" && !isCalendarDate(v)) c.add(field, "A date as YYYY-MM-DD");
  return v;
}

function oneOf<T extends string>(
  c: Collector,
  body: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
  required: boolean,
): T | undefined {
  if (!(field in body) || body[field] === undefined) {
    if (required) c.add(field, "Required");
    return undefined;
  }
  const v = body[field];
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) {
    c.add(field, `One of ${allowed.join(", ")}`);
    return undefined;
  }
  return v as T;
}

/** A whole number of ounces in [min, MAX_QUANTITY_OZ]; undefined when absent, null when explicitly null. */
function ounces(
  c: Collector,
  body: Record<string, unknown>,
  field: string,
  opts: { required: boolean; min: number; nullable?: boolean },
): number | null | undefined {
  if (!(field in body) || body[field] === undefined) {
    if (opts.required) c.add(field, "Required");
    return undefined;
  }
  const v = body[field];
  if (v === null && opts.nullable) return null;
  if (typeof v !== "number" || !Number.isInteger(v) || v < opts.min || v > MAX_QUANTITY_OZ) {
    c.add(field, `A whole number of ounces from ${opts.min} to ${MAX_QUANTITY_OZ}`);
    return undefined;
  }
  return v;
}

// ── Sites ──────────────────────────────────────────────────

/**
 * Validate a site body. On create every required field must be present; on
 * update the body is a patch over `current` and absent fields keep their value.
 */
export function validateSiteBody(body: unknown, current: LeakSite | null): Validation<LeakSiteFields> {
  if (!isObject(body)) return { valid: false, fields: { body: ["Must be a JSON object"] } };
  const c = new Collector();
  const creating = current === null;

  const required = (field: string, max: number): string | null | undefined => {
    const v = text(c, body, field, { required: creating, max });
    if (!creating && v === null) c.add(field, "Required");
    return v;
  };
  const name = required("name", 200);
  const customerName = required("customerName", 200);
  const addressLine1 = required("addressLine1", 200);
  const city = required("city", 120);
  const addressLine2 = text(c, body, "addressLine2", { required: false, max: 200 });
  const region = text(c, body, "region", { required: false, max: 120 });
  const postalCode = text(c, body, "postalCode", { required: false, max: 20 });
  const ownerContactName = text(c, body, "ownerContactName", { required: false, max: 200 });
  const ownerContactEmail = email(c, body, "ownerContactEmail");
  const notes = text(c, body, "notes", { required: false, max: 5000 });
  const leakRateMethod = oneOf(c, body, "leakRateMethod", LEAK_RATE_METHODS, false);
  const status = creating ? undefined : oneOf(c, body, "status", LEAK_SITE_STATUSES, false);
  if (creating && "status" in body) c.add("status", "Set on update only");

  let country: string | undefined;
  if ("country" in body && body.country !== undefined) {
    const v = body.country;
    if (typeof v !== "string" || !COUNTRY_RE.test(v)) c.add("country", "A two-letter ISO 3166 code, e.g. US");
    else country = v;
  }

  if (!c.ok) return { valid: false, fields: c.fields };
  const keep = <T>(next: T | null | undefined, prev: T | null | undefined, fallback: T): T =>
    next === undefined ? (prev ?? fallback) : (next ?? fallback);

  return {
    valid: true,
    value: {
      name: name ?? current?.name ?? "",
      customerName: customerName ?? current?.customerName ?? "",
      addressLine1: addressLine1 ?? current?.addressLine1 ?? "",
      addressLine2: addressLine2 === undefined ? (current?.addressLine2 ?? null) : addressLine2,
      city: city ?? current?.city ?? "",
      region: keep(region, current?.region, ""),
      postalCode: keep(postalCode, current?.postalCode, ""),
      country: country ?? current?.country ?? "US",
      ownerContactName: ownerContactName === undefined ? (current?.ownerContactName ?? null) : ownerContactName,
      ownerContactEmail: ownerContactEmail === undefined ? (current?.ownerContactEmail ?? null) : ownerContactEmail,
      leakRateMethod: leakRateMethod ?? current?.leakRateMethod ?? "annualizing",
      status: status ?? current?.status ?? "active",
      notes: keep(notes, current?.notes, ""),
    },
  };
}

// ── Appliances ─────────────────────────────────────────────

/** The midpoint of an established range, rounded half up (40 CFR 84.102 *Full charge* (4)). */
export function rangeMidpoint(low: number, high: number): number {
  return Math.floor((low + high + 1) / 2);
}

/**
 * Validate an appliance body; a patch over `current` on update. `today` is the
 * UTC date, for the not-in-the-future check on installedOn (one day of grace
 * for time zones ahead of UTC).
 */
export function validateApplianceBody(
  body: unknown,
  current: Appliance | null,
  today: string,
): Validation<ApplianceFields> {
  if (!isObject(body)) return { valid: false, fields: { body: ["Must be a JSON object"] } };
  const c = new Collector();
  const creating = current === null;

  const name = text(c, body, "name", { required: creating, max: 120 });
  if (!creating && name === null) c.add("name", "Required");
  const location = text(c, body, "location", { required: false, max: 200 });
  const category = oneOf(c, body, "category", APPLIANCE_CATEGORIES, creating);
  const fullChargeMethod = oneOf(c, body, "fullChargeMethod", FULL_CHARGE_METHODS, creating);
  // With method 4 the full charge is derived from the range, so it may be omitted.
  const fullChargeOz = ounces(c, body, "fullChargeOz", {
    required: creating && body.fullChargeMethod !== "range_midpoint",
    min: 1,
  });
  const rangeLow = ounces(c, body, "fullChargeRangeLowOz", { required: false, min: 1, nullable: true });
  const rangeHigh = ounces(c, body, "fullChargeRangeHighOz", { required: false, min: 1, nullable: true });
  const installedOn = date(c, body, "installedOn", false);
  if (typeof installedOn === "string" && installedOn > addDays(today, 1)) c.add("installedOn", "Must not be in the future");
  const manufacturer = text(c, body, "manufacturer", { required: false, max: 120 });
  const model = text(c, body, "model", { required: false, max: 120 });
  const serialNumber = text(c, body, "serialNumber", { required: false, max: 120 });
  const status = creating ? undefined : oneOf(c, body, "status", APPLIANCE_STATUSES, false);
  if (creating && "status" in body) c.add("status", "Set on update only");

  let refrigerant: string | undefined;
  const rawRefrigerant = text(c, body, "refrigerant", { required: creating, max: 40 });
  if (!creating && rawRefrigerant === null) c.add("refrigerant", "Required");
  if (typeof rawRefrigerant === "string") {
    if (!REFRIGERANT_RE.test(rawRefrigerant)) c.add("refrigerant", "An ASHRAE designation, e.g. R-404A");
    else refrigerant = normalizeRefrigerant(rawRefrigerant);
  }
  const suppliedClass = oneOf(c, body, "refrigerantClass", REFRIGERANT_CLASSES, false);

  if (!c.ok) return { valid: false, fields: c.fields };

  const merged: ApplianceFields = {
    name: name ?? current?.name ?? "",
    location: location === undefined ? (current?.location ?? "") : (location ?? ""),
    category: category ?? current?.category ?? "",
    refrigerant: refrigerant ?? current?.refrigerant ?? "",
    refrigerantClass: "",
    fullChargeOz: fullChargeOz ?? current?.fullChargeOz ?? 0,
    fullChargeMethod: fullChargeMethod ?? current?.fullChargeMethod ?? "",
    fullChargeRangeLowOz: rangeLow === undefined ? (current?.fullChargeRangeLowOz ?? null) : rangeLow,
    fullChargeRangeHighOz: rangeHigh === undefined ? (current?.fullChargeRangeHighOz ?? null) : rangeHigh,
    installedOn: installedOn === undefined ? (current?.installedOn ?? null) : installedOn,
    manufacturer: manufacturer === undefined ? (current?.manufacturer ?? "") : (manufacturer ?? ""),
    model: model === undefined ? (current?.model ?? "") : (model ?? ""),
    serialNumber: serialNumber === undefined ? (current?.serialNumber ?? "") : (serialNumber ?? ""),
    status: status ?? current?.status ?? "active",
  };

  // The class: the built-in table decides for a known refrigerant; otherwise it must be supplied.
  const known = classifyRefrigerant(merged.refrigerant);
  if (known) {
    if (suppliedClass && suppliedClass !== known) {
      return { valid: false, fields: { refrigerantClass: [`${merged.refrigerant} is classified as ${known}`] } };
    }
    merged.refrigerantClass = known;
  } else if (suppliedClass) {
    merged.refrigerantClass = suppliedClass;
  } else if (current && refrigerant === undefined) {
    merged.refrigerantClass = current.refrigerantClass;
  } else {
    return {
      valid: false,
      fields: { refrigerantClass: [`${merged.refrigerant} is not in the built-in table: one of ${REFRIGERANT_CLASSES.join(", ")}`] },
    };
  }

  // Full charge method 4: the range is required, and the full charge is its midpoint (84.106(l)(1)(iv)).
  if (merged.fullChargeMethod === "range_midpoint") {
    const { fullChargeRangeLowOz: low, fullChargeRangeHighOz: high } = merged;
    if (low === null || high === null) {
      return { valid: false, fields: { fullChargeRangeLowOz: ["Required for range_midpoint"], fullChargeRangeHighOz: ["Required for range_midpoint"] } };
    }
    if (high < low) return { valid: false, fields: { fullChargeRangeHighOz: ["Must not be below fullChargeRangeLowOz"] } };
    const mid = rangeMidpoint(low, high);
    if (fullChargeOz !== undefined && fullChargeOz !== mid) {
      return { valid: false, fields: { fullChargeOz: [`Must be the range midpoint, ${mid}`] } };
    }
    merged.fullChargeOz = mid;
  } else {
    merged.fullChargeRangeLowOz = null;
    merged.fullChargeRangeHighOz = null;
  }
  return { valid: true, value: merged };
}

// ── Service events ─────────────────────────────────────────

export interface ServiceEventFields {
  serviceDate: string;
  kind: ServiceEventKind;
  technicianName: string;
  component: string;
  workPerformed: string;
  addedOz: number;
  recoveredOz: number;
  returnedOz: number;
  verificationPassed: boolean | null;
  notes: string;
  loggedVia: string;
}

export function validateServiceEvent(
  body: unknown,
  appliance: Pick<Appliance, "installedOn">,
  today: string,
): Validation<ServiceEventFields> {
  if (!isObject(body)) return { valid: false, fields: { body: ["Must be a JSON object"] } };
  const c = new Collector();
  const serviceDate = date(c, body, "serviceDate", true);
  if (typeof serviceDate === "string") {
    if (serviceDate > addDays(today, 1)) c.add("serviceDate", "Must not be in the future");
    if (appliance.installedOn && serviceDate < appliance.installedOn) {
      c.add("serviceDate", `Must not be before the installation date, ${appliance.installedOn}`);
    }
  }
  const kind = oneOf(c, body, "kind", SERVICE_EVENT_KINDS, true);
  const technicianName = text(c, body, "technicianName", { required: true, max: 120 });
  const component = text(c, body, "component", { required: false, max: 200 });
  const workPerformed = text(c, body, "workPerformed", { required: false, max: 2000 });
  const notes = text(c, body, "notes", { required: false, max: 5000 });
  const addedOz = ounces(c, body, "addedOz", { required: false, min: 0 }) ?? 0;
  const recoveredOz = ounces(c, body, "recoveredOz", { required: false, min: 0 }) ?? 0;
  const returnedOz = ounces(c, body, "returnedOz", { required: false, min: 0 }) ?? 0;
  const loggedVia = oneOf(c, body, "loggedVia", SERVICE_EVENT_SOURCES, false) ?? "console";

  let verificationPassed: boolean | null = null;
  const isVerification = kind !== undefined && VERIFICATION_KINDS.includes(kind);
  if ("verificationPassed" in body && body.verificationPassed !== undefined) {
    if (typeof body.verificationPassed !== "boolean") c.add("verificationPassed", "Must be true or false");
    else if (!isVerification) c.add("verificationPassed", "Only for a verification test");
    else verificationPassed = body.verificationPassed;
  } else if (isVerification) {
    c.add("verificationPassed", "Required for a verification test");
  }
  if (returnedOz > addedOz) c.add("returnedOz", "Must not exceed addedOz — only refrigerant going in can be returned");

  if (!c.ok) return { valid: false, fields: c.fields };
  return {
    valid: true,
    value: {
      serviceDate: serviceDate!,
      kind: kind!,
      technicianName: technicianName!,
      component: component ?? "",
      workPerformed: workPerformed ?? "",
      addedOz,
      recoveredOz,
      returnedOz,
      verificationPassed,
      notes: notes ?? "",
      loggedVia,
    },
  };
}

export function validateVoid(body: unknown): Validation<{ reason: string }> {
  if (!isObject(body)) return { valid: false, fields: { body: ["Must be a JSON object"] } };
  const c = new Collector();
  const reason = text(c, body, "reason", { required: true, max: 500 });
  if (!c.ok) return { valid: false, fields: c.fields };
  return { valid: true, value: { reason: reason! } };
}

/**
 * The appliance status an event leaves behind: a mothball event mothballs it,
 * a retirement retires it, and refrigerant added to a mothballed appliance
 * brings it back into service (40 CFR 84.106(d)(3): the clock "will resume on
 * the day additional refrigerant is added").
 */
export function statusAfterEvent(current: string, kind: ServiceEventKind, addedOz: number): string {
  if (kind === "retirement") return "retired";
  if (kind === "mothball") return "mothballed";
  if (current === "mothballed" && addedOz > 0) return "active";
  return current;
}
