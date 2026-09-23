/**
 * Refrigerant log (`leak`) bounded context — a contractor's customer sites,
 * the refrigerant-containing appliances at each (one row per independent
 * circuit, 40 CFR 84.102), and the immutable log of service events against
 * them. The organization IS the contractor; its technicians and office staff
 * are its members.
 *
 * Quantities are integer ounces everywhere (16 oz = 1 lb). No floating point
 * decides anything in this context.
 */

export const LEAK_SITE_STATUSES = ["active", "archived"] as const;
export type LeakSiteStatus = (typeof LEAK_SITE_STATUSES)[number];

/** 40 CFR 84.102, *Leak rate*: one method for every appliance at an operating facility (a site). */
export const LEAK_RATE_METHODS = ["annualizing", "rolling_average"] as const;
export type LeakRateMethod = (typeof LEAK_RATE_METHODS)[number];

export const LEAK_RATE_METHOD_LABELS: Record<LeakRateMethod, string> = {
  annualizing: "Annualizing method",
  rolling_average: "Rolling average method",
};

/** 40 CFR 84.106(c)(2) and (a)(3)(ii). */
export const APPLIANCE_CATEGORIES = [
  "commercial_refrigeration",
  "industrial_process_refrigeration",
  "comfort_cooling",
  "refrigerated_transport",
  "residential_light_commercial_ac",
  "other",
] as const;
export type ApplianceCategory = (typeof APPLIANCE_CATEGORIES)[number];

export const APPLIANCE_CATEGORY_LABELS: Record<ApplianceCategory, string> = {
  commercial_refrigeration: "Commercial refrigeration",
  industrial_process_refrigeration: "Industrial process refrigeration",
  comfort_cooling: "Comfort cooling",
  refrigerated_transport: "Refrigerated transport",
  residential_light_commercial_ac: "Residential / light commercial AC",
  other: "Other",
};

/**
 * hfc — contains a regulated substance (HFC) or is a substitute with GWP > 53 (84.106(a)(1)–(2));
 * ods_hfc_blend — an ODS blend that also contains an HFC (not "solely" ODS);
 * ods — solely class I/II (82.157; excluded from 84.106 by (a)(3)(i));
 * low_gwp — neither.
 */
export const REFRIGERANT_CLASSES = ["hfc", "ods_hfc_blend", "ods", "low_gwp"] as const;
export type RefrigerantClass = (typeof REFRIGERANT_CLASSES)[number];

export const REFRIGERANT_CLASS_LABELS: Record<RefrigerantClass, string> = {
  hfc: "HFC (or GWP > 53)",
  ods_hfc_blend: "ODS blend containing an HFC",
  ods: "Ozone-depleting (CFC/HCFC)",
  low_gwp: "Low-GWP (≤ 53)",
};

/**
 * The built-in classification for common ASHRAE designations. Anything not
 * here must be classified by the office when the appliance is created.
 */
export const KNOWN_REFRIGERANTS: Readonly<Record<string, RefrigerantClass>> = {
  "R-404A": "hfc",
  "R-507A": "hfc",
  "R-410A": "hfc",
  "R-134a": "hfc",
  "R-407A": "hfc",
  "R-407C": "hfc",
  "R-407F": "hfc",
  "R-422D": "hfc",
  "R-438A": "hfc",
  "R-448A": "hfc",
  "R-449A": "hfc",
  "R-513A": "hfc",
  "R-32": "hfc",
  "R-454B": "hfc",
  "R-454C": "hfc",
  "R-455A": "hfc",
  "R-401A": "ods_hfc_blend",
  "R-402A": "ods_hfc_blend",
  "R-22": "ods",
  "R-12": "ods",
  "R-502": "ods",
  "R-409A": "ods",
  "R-290": "low_gwp",
  "R-600a": "low_gwp",
  "R-744": "low_gwp",
  "R-717": "low_gwp",
  "R-1234yf": "low_gwp",
  "R-1234ze(E)": "low_gwp",
};

/** Case- and spacing-insensitive lookup: "r404a", "R 404A" and "R-404A" are one refrigerant. */
export function normalizeRefrigerant(raw: string): string {
  const compact = raw.trim().replace(/\s+/g, "").toUpperCase();
  const m = compact.match(/^R-?(.+)$/);
  const body = m ? m[1]! : compact;
  for (const known of Object.keys(KNOWN_REFRIGERANTS)) {
    if (known.slice(2).toUpperCase() === body) return known;
  }
  return m ? `R-${body}` : raw.trim();
}

export function classifyRefrigerant(designation: string): RefrigerantClass | null {
  return KNOWN_REFRIGERANTS[normalizeRefrigerant(designation)] ?? null;
}

/** The four methods of determining full charge, 40 CFR 84.102 *Full charge* (1)–(4). */
export const FULL_CHARGE_METHODS = ["manufacturer", "calculation", "measurement", "range_midpoint"] as const;
export type FullChargeMethod = (typeof FULL_CHARGE_METHODS)[number];

export const FULL_CHARGE_METHOD_LABELS: Record<FullChargeMethod, string> = {
  manufacturer: "Manufacturer's determination",
  calculation: "Calculation (component sizes, piping)",
  measurement: "Measured (added or evacuated)",
  range_midpoint: "Midpoint of an established range",
};

export const APPLIANCE_STATUSES = ["active", "mothballed", "retired"] as const;
export type ApplianceStatus = (typeof APPLIANCE_STATUSES)[number];

export const SERVICE_EVENT_KINDS = [
  "installation",
  "service",
  "leak_inspection",
  "repair",
  "verification_initial",
  "verification_followup",
  "seasonal_adjustment",
  "retrofit",
  "mothball",
  "retirement",
] as const;
export type ServiceEventKind = (typeof SERVICE_EVENT_KINDS)[number];

export const SERVICE_EVENT_KIND_LABELS: Record<ServiceEventKind, string> = {
  installation: "Installation",
  service: "Service / top-up",
  leak_inspection: "Leak inspection",
  repair: "Repair",
  verification_initial: "Initial verification test",
  verification_followup: "Follow-up verification test",
  seasonal_adjustment: "Seasonal adjustment",
  retrofit: "Retrofit",
  mothball: "Mothball",
  retirement: "Retirement / disposal",
};

export const VERIFICATION_KINDS: readonly ServiceEventKind[] = ["verification_initial", "verification_followup"];

export const SERVICE_EVENT_SOURCES = ["console", "qr"] as const;
export type ServiceEventSource = (typeof SERVICE_EVENT_SOURCES)[number];

/** Per-event ceiling on any quantity: 1 000 000 oz = 62 500 lb. */
export const MAX_QUANTITY_OZ = 1_000_000;

export const LEAK_EVENT_TYPES = [
  "leak.site.created",
  "leak.site.updated",
  "leak.appliance.created",
  "leak.appliance.updated",
  "leak.appliance.qr_rotated",
  "leak.event.logged",
  "leak.event.voided",
] as const;
export type LeakEventType = (typeof LEAK_EVENT_TYPES)[number];

/** 1 lb = 16 oz. Split an ounce quantity for display: 646 → { lb: 40, oz: 6 }. */
export function splitOunces(totalOz: number): { lb: number; oz: number } {
  const whole = Math.max(0, Math.trunc(totalOz));
  return { lb: Math.floor(whole / 16), oz: whole % 16 };
}

/** "40 lb 6 oz", "40 lb", "6 oz", "0 oz". */
export function formatOunces(totalOz: number): string {
  const { lb, oz } = splitOunces(totalOz);
  if (lb === 0) return `${oz} oz`;
  return oz === 0 ? `${lb} lb` : `${lb} lb ${oz} oz`;
}

/** Pounds and ounces entered on a form → integer ounces; null unless both are whole and non-negative. */
export function toOunces(lb: number, oz: number): number | null {
  if (!Number.isInteger(lb) || !Number.isInteger(oz) || lb < 0 || oz < 0) return null;
  return lb * 16 + oz;
}

// ── Wire shapes ─────────────────────────────────────────────

export interface PublicLeakSite {
  id: string;
  orgId: string;
  name: string;
  customerName: string;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  region: string;
  postalCode: string;
  country: string;
  ownerContactName: string | null;
  ownerContactEmail: string | null;
  leakRateMethod: LeakRateMethod;
  status: LeakSiteStatus;
  notes: string;
  /** Number of appliances at the site that are not retired. */
  applianceCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface PublicAppliance {
  id: string;
  orgId: string;
  siteId: string;
  name: string;
  location: string;
  category: ApplianceCategory;
  refrigerant: string;
  refrigerantClass: RefrigerantClass;
  fullChargeOz: number;
  fullChargeMethod: FullChargeMethod;
  fullChargeRangeLowOz: number | null;
  fullChargeRangeHighOz: number | null;
  installedOn: string | null;
  manufacturer: string;
  model: string;
  serialNumber: string;
  status: ApplianceStatus;
  /** The QR label's token. The console builds `<origin>/q/<token>` from it. */
  qrToken: string;
  qrTokenRotatedAt: string | null;
  /** The latest non-voided service date, if any. */
  lastServiceDate: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PublicServiceEvent {
  id: string;
  orgId: string;
  siteId: string;
  applianceId: string;
  /** YYYY-MM-DD — the day the work was done. */
  serviceDate: string;
  kind: ServiceEventKind;
  technicianName: string;
  component: string;
  workPerformed: string;
  addedOz: number;
  recoveredOz: number;
  returnedOz: number;
  /** addedOz − returnedOz: refrigerant actually lost and replaced. */
  leakOz: number;
  fullChargeOz: number;
  verificationPassed: boolean | null;
  notes: string;
  loggedVia: ServiceEventSource;
  voided: boolean;
  voidedAt: string | null;
  voidReason: string | null;
  createdAt: string;
}

// ── Requests ───────────────────────────────────────────────

export interface CreateLeakSiteRequest {
  name: string;
  customerName: string;
  addressLine1: string;
  addressLine2?: string | null;
  city: string;
  region: string;
  postalCode: string;
  country?: string;
  ownerContactName?: string | null;
  ownerContactEmail?: string | null;
  leakRateMethod?: LeakRateMethod;
  notes?: string;
}

export type UpdateLeakSiteRequest = Partial<CreateLeakSiteRequest> & { status?: LeakSiteStatus };

export interface CreateApplianceRequest {
  name: string;
  location?: string;
  category: ApplianceCategory;
  refrigerant: string;
  /** Required when the refrigerant is not in KNOWN_REFRIGERANTS; must agree with it when it is. */
  refrigerantClass?: RefrigerantClass;
  /** Required unless the method is range_midpoint, where it is derived from the range. */
  fullChargeOz?: number;
  fullChargeMethod: FullChargeMethod;
  fullChargeRangeLowOz?: number | null;
  fullChargeRangeHighOz?: number | null;
  installedOn?: string | null;
  manufacturer?: string;
  model?: string;
  serialNumber?: string;
}

export type UpdateApplianceRequest = Partial<CreateApplianceRequest> & { status?: ApplianceStatus };

export interface LogServiceEventRequest {
  serviceDate: string;
  kind: ServiceEventKind;
  technicianName: string;
  component?: string;
  workPerformed?: string;
  addedOz?: number;
  recoveredOz?: number;
  returnedOz?: number;
  /** Required for the two verification kinds, forbidden otherwise. */
  verificationPassed?: boolean;
  notes?: string;
  loggedVia?: ServiceEventSource;
}

export interface VoidServiceEventRequest {
  reason: string;
}

// ── Responses ──────────────────────────────────────────────

export interface ListLeakSitesResponse {
  sites: PublicLeakSite[];
}
export interface LeakSiteResponse {
  site: PublicLeakSite;
}
export interface GetLeakSiteResponse {
  site: PublicLeakSite;
  appliances: PublicAppliance[];
}
export interface ApplianceResponse {
  appliance: PublicAppliance;
}
export interface GetApplianceResponse {
  appliance: PublicAppliance;
  site: PublicLeakSite;
  events: PublicServiceEvent[];
}
export interface ListServiceEventsResponse {
  events: PublicServiceEvent[];
}
export interface ServiceEventResponse {
  event: PublicServiceEvent;
}
/** GET /v1/qr/{token} — what a scanned label opens. */
export interface ResolveQrResponse {
  organization: { id: string };
  site: PublicLeakSite;
  appliance: PublicAppliance;
  events: PublicServiceEvent[];
}
