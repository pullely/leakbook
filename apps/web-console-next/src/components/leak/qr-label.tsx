"use client";

import * as React from "react";
import type { PublicAppliance, PublicLeakSite } from "@saas/contracts/leak";
import { formatOunces } from "@saas/contracts/leak";
import { QrCode } from "./qr-code";

/** The URL a label encodes: this console's own origin, so a stage label opens stage. */
export function labelUrl(token: string): string {
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  return `${origin}/q/${token}`;
}

/**
 * A 3 × 2 in label: the QR code on the left, the facts a technician checks
 * against the nameplate on the right. Prints black on white at any zoom.
 */
export function QrLabel({ appliance, site }: { appliance: PublicAppliance; site: Pick<PublicLeakSite, "name"> }) {
  const url = labelUrl(appliance.qrToken);
  return (
    <div
      className="flex h-[2in] w-[3in] items-center gap-3 rounded-md border border-black bg-white p-2 text-black break-inside-avoid"
      data-testid="qr-label"
    >
      <QrCode value={url} size={150} title={`Log a service visit for ${appliance.name}`} />
      <div className="min-w-0 space-y-1 text-[11px] leading-tight">
        <div className="text-[13px] font-bold leading-snug">{appliance.name}</div>
        <div className="truncate">{site.name}</div>
        {appliance.location && <div className="truncate">{appliance.location}</div>}
        <div>
          <span className="font-semibold">{appliance.refrigerant}</span> · {formatOunces(appliance.fullChargeOz)}
        </div>
        {appliance.serialNumber && <div className="truncate">S/N {appliance.serialNumber}</div>}
        <div className="pt-1 text-[10px]">Scan to log service · Leakbook</div>
      </div>
    </div>
  );
}
