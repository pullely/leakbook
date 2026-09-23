// Refrigerant log (leak) bounded context — row shapes and repository seam.
//
// Timestamps are ISO-8601 strings and dates are YYYY-MM-DD strings end to end:
// D1 stores TEXT, the wire carries strings, and a string comparison of two
// such dates is a date comparison. Quantities are integer ounces.

export interface LeakSite {
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
  leakRateMethod: string;
  status: string;
  notes: string;
  applianceCount: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LeakSiteFields {
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
  leakRateMethod: string;
  status: string;
  notes: string;
}

export interface CreateLeakSiteInput extends LeakSiteFields {
  id: string;
  orgId: string;
  createdBy: string | null;
  now: string;
}

export interface Appliance {
  id: string;
  orgId: string;
  siteId: string;
  name: string;
  location: string;
  category: string;
  refrigerant: string;
  refrigerantClass: string;
  fullChargeOz: number;
  fullChargeMethod: string;
  fullChargeRangeLowOz: number | null;
  fullChargeRangeHighOz: number | null;
  installedOn: string | null;
  manufacturer: string;
  model: string;
  serialNumber: string;
  status: string;
  qrToken: string;
  qrTokenRotatedAt: string | null;
  lastServiceDate: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApplianceFields {
  name: string;
  location: string;
  category: string;
  refrigerant: string;
  refrigerantClass: string;
  fullChargeOz: number;
  fullChargeMethod: string;
  fullChargeRangeLowOz: number | null;
  fullChargeRangeHighOz: number | null;
  installedOn: string | null;
  manufacturer: string;
  model: string;
  serialNumber: string;
  status: string;
}

export interface CreateApplianceInput extends ApplianceFields {
  id: string;
  orgId: string;
  siteId: string;
  qrToken: string;
  createdBy: string | null;
  now: string;
}

export interface ServiceEvent {
  id: string;
  orgId: string;
  siteId: string;
  applianceId: string;
  serviceDate: string;
  kind: string;
  technicianName: string;
  component: string;
  workPerformed: string;
  addedOz: number;
  recoveredOz: number;
  returnedOz: number;
  fullChargeOz: number;
  verificationPassed: boolean | null;
  notes: string;
  loggedBy: string | null;
  loggedVia: string;
  voidedAt: string | null;
  voidReason: string | null;
  voidedBy: string | null;
  createdAt: string;
}

export interface CreateServiceEventInput {
  id: string;
  orgId: string;
  siteId: string;
  applianceId: string;
  serviceDate: string;
  kind: string;
  technicianName: string;
  component: string;
  workPerformed: string;
  addedOz: number;
  recoveredOz: number;
  returnedOz: number;
  fullChargeOz: number;
  verificationPassed: boolean | null;
  notes: string;
  loggedBy: string | null;
  loggedVia: string;
  now: string;
}

export interface ListEventsPage {
  /** Exclusive cursor: events strictly older than (serviceDate, createdAt, id). */
  before?: { serviceDate: string; createdAt: string; id: string } | null;
  limit: number;
}

export interface LeakRepository {
  createSite(input: CreateLeakSiteInput): Promise<LeakSite>;
  getSite(orgId: string, siteId: string): Promise<LeakSite | null>;
  listSites(orgId: string, status?: string): Promise<LeakSite[]>;
  updateSite(orgId: string, siteId: string, fields: LeakSiteFields, now: string): Promise<LeakSite | null>;

  createAppliance(input: CreateApplianceInput): Promise<Appliance>;
  getAppliance(orgId: string, applianceId: string): Promise<Appliance | null>;
  /** Cross-org by design: the token is the only key. The caller must authorize against the returned org. */
  findApplianceByQrToken(qrToken: string): Promise<Appliance | null>;
  listAppliancesForSite(orgId: string, siteId: string): Promise<Appliance[]>;
  updateAppliance(orgId: string, applianceId: string, fields: ApplianceFields, now: string): Promise<Appliance | null>;
  rotateQrToken(orgId: string, applianceId: string, qrToken: string, now: string): Promise<Appliance | null>;

  createServiceEvent(input: CreateServiceEventInput): Promise<ServiceEvent>;
  getServiceEvent(orgId: string, applianceId: string, eventId: string): Promise<ServiceEvent | null>;
  listServiceEvents(orgId: string, applianceId: string, page: ListEventsPage): Promise<ServiceEvent[]>;
  /** Null when the event does not exist in this org/appliance or is already voided. */
  voidServiceEvent(
    orgId: string,
    applianceId: string,
    eventId: string,
    reason: string,
    voidedBy: string | null,
    now: string,
  ): Promise<ServiceEvent | null>;
}
