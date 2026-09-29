import {
  APPLIANCE_CATEGORY_LABELS,
  FULL_CHARGE_METHOD_LABELS,
  LEAK_RATE_METHOD_LABELS,
  REFRIGERANT_CLASS_LABELS,
  SERVICE_EVENT_KIND_LABELS,
  formatOunces,
  type ApplianceCategory,
  type FullChargeMethod,
  type LeakRateMethod,
  type RefrigerantClass,
  type ServiceEventKind,
} from "@saas/contracts/leak";
import { applicability, chronicLeak, formatRateBp } from "@saas/contracts/leak-rate";
import type { Appliance, LeakSite, RepairClock, ServiceEvent } from "@saas/db/leak";
import { renderPdf, type PdfBlock } from "./pdf.js";
import { toRateEvent } from "./present.js";

// LB3 — the site's inspection record (design §1.6): what 84.106(l) asks an
// owner to keep, per appliance, in one document an inspector can read.

export interface SiteRecord {
  site: LeakSite;
  appliances: { appliance: Appliance; events: ServiceEvent[]; clocks: RepairClock[] }[];
}

function kindLabel(kind: string): string {
  return SERVICE_EVENT_KIND_LABELS[kind as ServiceEventKind] ?? kind;
}

function eventLine(e: ServiceEvent): string {
  const parts = [e.serviceDate, kindLabel(e.kind), e.technicianName];
  const q: string[] = [];
  if (e.addedOz > 0) q.push(`+${formatOunces(e.addedOz)} added`);
  if (e.returnedOz > 0) q.push(`${formatOunces(e.returnedOz)} of it returned`);
  if (e.recoveredOz > 0) q.push(`${formatOunces(e.recoveredOz)} recovered`);
  if (q.length) parts.push(q.join(", "));
  if (e.verificationPassed !== null) parts.push(e.verificationPassed ? "passed" : "FAILED");
  if (e.leakRateBp !== null) {
    const verdict =
      e.exceedsThreshold === null ? "" : e.exceedsThreshold ? ` — OVER ${e.thresholdPct} %` : ` — under ${e.thresholdPct} %`;
    parts.push(`leak rate ${formatRateBp(e.leakRateBp)}${verdict}`);
  }
  let line = parts.join(" · ");
  if (e.component || e.workPerformed) line += `\n    ${[e.component, e.workPerformed].filter(Boolean).join(" — ")}`;
  if (e.voidedAt) line = `VOID (${e.voidReason ?? ""}) — ${line}`;
  return line;
}

function clockLine(c: RepairClock): string {
  const parts = [
    `Opened ${c.openedOn} at ${formatRateBp(c.leakRateBp)} (threshold ${c.thresholdPct} %, 40 CFR ${c.regime})`,
    `repair due ${c.repairDueOn}${c.shutdownRequired ? " (industrial process shutdown)" : ""}`,
  ];
  if (c.initialVerifiedOn) parts.push(`initial verification passed ${c.initialVerifiedOn}, follow-up due ${c.followupDueOn}`);
  if (c.suspendedDays > 0) parts.push(`${c.suspendedDays} days mothballed`);
  if (c.closedOn) parts.push(`closed ${c.closedOn}${c.closedReason === "retired" ? " (retired)" : " (verified)"}`);
  else parts.push(c.status.toUpperCase());
  return parts.join(" · ");
}

/** The PDF, as blocks (exported for tests). */
export function siteRecordBlocks(record: SiteRecord, generatedOn: string): PdfBlock[] {
  const { site } = record;
  const year = Number(generatedOn.slice(0, 4));
  const blocks: PdfBlock[] = [
    { text: "Refrigerant leak-repair record", size: 18, bold: true, after: 4 },
    { text: site.name, size: 13, bold: true, after: 2 },
    {
      text: [
        `Owner or operator: ${site.customerName}`,
        `Location: ${[site.addressLine1, site.addressLine2, site.city, site.region, site.postalCode, site.country]
          .filter((p) => p && p.length > 0)
          .join(", ")}`,
        `Leak-rate method for this facility: ${LEAK_RATE_METHOD_LABELS[site.leakRateMethod as LeakRateMethod] ?? site.leakRateMethod}`,
        `Generated ${generatedOn} by Leakbook. Rates are calculated per 40 CFR 84.102 and 84.106(b) (82.152 / 82.157(b) for ODS-only appliances); quantities in pounds and ounces.`,
      ].join("\n"),
      size: 9,
      after: 6,
    },
    { text: "", rule: true },
  ];

  if (record.appliances.length === 0) blocks.push({ text: "No appliances are registered at this site.", size: 10 });

  for (const { appliance: a, events, clocks } of record.appliances) {
    const app = applicability({
      refrigerantClass: a.refrigerantClass as RefrigerantClass,
      category: a.category as ApplianceCategory,
      fullChargeOz: a.fullChargeOz,
    });
    const rateEvents = events.map(toRateEvent);
    const chronic = [year, year - 1].map((y) => chronicLeak(rateEvents, y, a.fullChargeOz)).filter((c) => c.leakOz > 0);
    blocks.push({ text: `${a.name}${a.location ? ` — ${a.location}` : ""}${a.status !== "active" ? ` (${a.status})` : ""}`, size: 12, bold: true, after: 2 });
    blocks.push({
      text: [
        `${a.refrigerant} (${REFRIGERANT_CLASS_LABELS[a.refrigerantClass as RefrigerantClass] ?? a.refrigerantClass}) · ${
          APPLIANCE_CATEGORY_LABELS[a.category as ApplianceCategory] ?? a.category
        }`,
        `Full charge ${formatOunces(a.fullChargeOz)} — ${FULL_CHARGE_METHOD_LABELS[a.fullChargeMethod as FullChargeMethod] ?? a.fullChargeMethod}${
          a.installedOn ? ` · installed ${a.installedOn}` : ""
        }`,
        [a.manufacturer, a.model, a.serialNumber ? `serial ${a.serialNumber}` : ""].filter(Boolean).join(" · ") || "Manufacturer, model and serial not recorded",
        app.thresholdPct !== null ? `Subject to 40 CFR ${app.regime}; threshold ${app.thresholdPct} %` : app.reason,
        ...chronic.map((c) => `${c.year}: ${formatOunces(c.leakOz)} leaked, ${formatRateBp(c.percentBp)} of full charge${c.chronic ? " — CHRONIC LEAKER (84.106(j))" : ""}`),
      ].join("\n"),
      size: 9,
      after: 4,
    });
    if (clocks.length) {
      blocks.push({ text: "Repair clocks", size: 10, bold: true, after: 1 });
      for (const c of clocks) blocks.push({ text: clockLine(c), size: 9, after: 2 });
    }
    blocks.push({ text: "Service log (oldest first)", size: 10, bold: true, after: 1 });
    if (events.length === 0) blocks.push({ text: "No visits logged.", size: 9 });
    for (const e of events) blocks.push({ text: eventLine(e), size: 9, after: 2 });
    blocks.push({ text: "", rule: true, after: 8 });
  }
  return blocks;
}

export function renderSiteRecordPdf(record: SiteRecord, generatedOn: string): Uint8Array {
  return renderPdf(siteRecordBlocks(record, generatedOn), { title: `Refrigerant leak-repair record — ${record.site.name}` });
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ── CSV ─────────────────────────────────────────────────────

export const CSV_HEADER = [
  "site",
  "appliance",
  "refrigerant",
  "full_charge_oz",
  "service_date",
  "kind",
  "technician",
  "component",
  "work_performed",
  "added_oz",
  "recovered_oz",
  "returned_oz",
  "leak_oz",
  "rate_method",
  "rate_days",
  "leak_rate_pct",
  "threshold_pct",
  "exceeds_threshold",
  "regime",
  "verification_passed",
  "logged_via",
  "voided",
  "void_reason",
  "created_at",
];

/** RFC 4180 quoting, and a leading quote on anything a spreadsheet would run as a formula. */
export function csvCell(value: string | number | boolean | null): string {
  if (value === null) return "";
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s) && typeof value === "string") s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvRows(site: LeakSite, appliance: Appliance, events: ServiceEvent[]): string {
  return events
    .map((e) =>
      [
        site.name,
        appliance.name,
        appliance.refrigerant,
        e.fullChargeOz,
        e.serviceDate,
        e.kind,
        e.technicianName,
        e.component,
        e.workPerformed,
        e.addedOz,
        e.recoveredOz,
        e.returnedOz,
        e.leakOz,
        e.rateMethod,
        e.rateDays,
        e.leakRateBp === null ? null : (e.leakRateBp / 100).toFixed(2),
        e.thresholdPct,
        e.exceedsThreshold,
        e.regime,
        e.verificationPassed,
        e.loggedVia,
        e.voidedAt !== null,
        e.voidReason,
        e.createdAt,
      ]
        .map(csvCell)
        .join(","),
    )
    .map((line) => `${line}\r\n`)
    .join("");
}
