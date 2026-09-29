"use client";

import { Badge } from "@/components/ui/badge";
import type { LeakRateMethod, PublicAppliance, PublicServiceEvent, RateHistoryEvent, ServiceEventKind } from "@saas/contracts/leak";
import { LEAK_RATE_METHOD_LABELS } from "@saas/contracts/leak";
import {
  applicability,
  calculateLeakRate,
  formatRateBp,
  heldBalanceOz,
  type LeakRateResult,
  type RateAppliance,
} from "@saas/contracts/leak-rate";

export function rateAppliance(a: PublicAppliance): RateAppliance {
  return { refrigerantClass: a.refrigerantClass, category: a.category, fullChargeOz: a.fullChargeOz };
}

/** The rate stored on one logged addition (design §2.6), as a compact badge line. */
export function EventRate({ e }: { e: PublicServiceEvent }) {
  if (e.leakRateBp === null) return null;
  const basis = e.rateMethod === "annualizing" && e.rateDays !== null ? ` · annualized over ${e.rateDays} d` : " · rolling 365 d";
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="font-medium tabular-nums">Leak rate {formatRateBp(e.leakRateBp)}</span>
      {e.exceedsThreshold === true && <Badge variant="destructive">Over {e.thresholdPct} %</Badge>}
      {e.exceedsThreshold === false && <Badge variant="success">Under {e.thresholdPct} %</Badge>}
      <span className="text-xs text-muted-foreground">
        {basis}
        {e.regime ? ` · 40 CFR ${e.regime}` : " · not subject"}
      </span>
    </div>
  );
}

/** The appliance's regime and threshold today (design §2.1). */
export function ThresholdLine({ appliance, method }: { appliance: PublicAppliance; method: LeakRateMethod }) {
  const a = applicability(rateAppliance(appliance));
  return (
    <p className="text-sm">
      {a.thresholdPct !== null ? (
        <>
          <span className="font-medium">Threshold {a.thresholdPct} %</span>
          <span className="text-muted-foreground"> — {a.reason}. </span>
        </>
      ) : (
        <span className="text-muted-foreground">{a.reason}; the rate is tracked as a trend. </span>
      )}
      <span className="text-muted-foreground">{LEAK_RATE_METHOD_LABELS[method]} (set on the site).</span>
    </p>
  );
}

export interface RatePreviewInput {
  appliance: PublicAppliance;
  method: LeakRateMethod;
  history: RateHistoryEvent[];
}

/**
 * The live preview under the log form: the same module the server runs, over
 * the history the page loaded. The server's answer on save is the record.
 */
export function previewRate(
  p: RatePreviewInput,
  event: { serviceDate: string; kind: ServiceEventKind; addedOz: number; recoveredOz: number; returnedOz: number },
): { rate: LeakRateResult; heldOz: number } {
  const prior = p.history;
  const rate = calculateLeakRate({
    appliance: rateAppliance(p.appliance),
    method: p.method,
    prior,
    event: { ...event, verificationPassed: null },
  });
  return { rate, heldOz: heldBalanceOz(prior, event.serviceDate, event.recoveredOz) };
}

export function RateVerdict({ rate, prefix }: { rate: LeakRateResult; prefix: string }) {
  if (!rate.calculated || rate.leakRateBp === null) {
    return <p className="text-sm text-muted-foreground">{prefix}: no leak rate — nothing lost, or a charge the rule exempts.</p>;
  }
  const over = rate.exceedsThreshold === true;
  return (
    <p className={`text-sm ${over ? "font-medium text-destructive" : ""}`}>
      {prefix}: <span className="tabular-nums">{formatRateBp(rate.leakRateBp)}</span> a year
      {rate.thresholdPct !== null
        ? over
          ? ` — over the ${rate.thresholdPct} % threshold. The repair is due within 30 days.`
          : ` — under the ${rate.thresholdPct} % threshold.`
        : " (not subject to a threshold)."}
    </p>
  );
}
