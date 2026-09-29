import type {
  ApplianceCategory,
  ApplianceStatus,
  FullChargeMethod,
  LeakRateMethod,
  LeakSiteStatus,
  PublicAppliance,
  PublicLeakSite,
  PublicServiceEvent,
  RateHistoryEvent,
  RefrigerantClass,
  ServiceEventKind,
  ServiceEventSource,
} from "@saas/contracts/leak";
import type { RateEvent } from "@saas/contracts/leak-rate";
import type { Appliance, LeakSite, ServiceEvent } from "@saas/db/leak";
import { appliancePublicId, eventPublicId, orgPublicId, sitePublicId } from "./ids.js";

export function toPublicSite(s: LeakSite): PublicLeakSite {
  return {
    id: sitePublicId(s.id),
    orgId: orgPublicId(s.orgId),
    name: s.name,
    customerName: s.customerName,
    addressLine1: s.addressLine1,
    addressLine2: s.addressLine2,
    city: s.city,
    region: s.region,
    postalCode: s.postalCode,
    country: s.country,
    ownerContactName: s.ownerContactName,
    ownerContactEmail: s.ownerContactEmail,
    leakRateMethod: s.leakRateMethod as LeakRateMethod,
    status: s.status as LeakSiteStatus,
    notes: s.notes,
    applianceCount: s.applianceCount,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

export function toPublicAppliance(a: Appliance): PublicAppliance {
  return {
    id: appliancePublicId(a.id),
    orgId: orgPublicId(a.orgId),
    siteId: sitePublicId(a.siteId),
    name: a.name,
    location: a.location,
    category: a.category as ApplianceCategory,
    refrigerant: a.refrigerant,
    refrigerantClass: a.refrigerantClass as RefrigerantClass,
    fullChargeOz: a.fullChargeOz,
    fullChargeMethod: a.fullChargeMethod as FullChargeMethod,
    fullChargeRangeLowOz: a.fullChargeRangeLowOz,
    fullChargeRangeHighOz: a.fullChargeRangeHighOz,
    installedOn: a.installedOn,
    manufacturer: a.manufacturer,
    model: a.model,
    serialNumber: a.serialNumber,
    status: a.status as ApplianceStatus,
    qrToken: a.qrToken,
    qrTokenRotatedAt: a.qrTokenRotatedAt,
    lastServiceDate: a.lastServiceDate,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

export function toPublicEvent(e: ServiceEvent): PublicServiceEvent {
  return {
    id: eventPublicId(e.id),
    orgId: orgPublicId(e.orgId),
    siteId: sitePublicId(e.siteId),
    applianceId: appliancePublicId(e.applianceId),
    serviceDate: e.serviceDate,
    kind: e.kind as ServiceEventKind,
    technicianName: e.technicianName,
    component: e.component,
    workPerformed: e.workPerformed,
    addedOz: e.addedOz,
    recoveredOz: e.recoveredOz,
    returnedOz: e.returnedOz,
    leakOz: e.leakOz,
    fullChargeOz: e.fullChargeOz,
    verificationPassed: e.verificationPassed,
    notes: e.notes,
    loggedVia: e.loggedVia as ServiceEventSource,
    voided: e.voidedAt !== null,
    voidedAt: e.voidedAt,
    voidReason: e.voidReason,
    createdAt: e.createdAt,
    rateMethod: e.rateMethod as LeakRateMethod | null,
    rateDays: e.rateDays,
    leakRateBp: e.leakRateBp,
    regime: e.regime as PublicServiceEvent["regime"],
    thresholdPct: e.thresholdPct,
    exceedsThreshold: e.exceedsThreshold,
  };
}

/** The leak-rate module's view of a stored event (voided ones flagged, so it skips them). */
export function toRateEvent(e: ServiceEvent): RateEvent {
  return {
    serviceDate: e.serviceDate,
    kind: e.kind as ServiceEventKind,
    addedOz: e.addedOz,
    recoveredOz: e.recoveredOz,
    returnedOz: e.returnedOz,
    verificationPassed: e.verificationPassed,
    voided: e.voidedAt !== null,
  };
}

/** The live preview's history: non-voided events, log order. */
export function toRateHistory(events: ServiceEvent[]): RateHistoryEvent[] {
  return events
    .filter((e) => e.voidedAt === null)
    .map((e) => ({
      serviceDate: e.serviceDate,
      kind: e.kind as ServiceEventKind,
      addedOz: e.addedOz,
      recoveredOz: e.recoveredOz,
      returnedOz: e.returnedOz,
      verificationPassed: e.verificationPassed,
    }));
}
