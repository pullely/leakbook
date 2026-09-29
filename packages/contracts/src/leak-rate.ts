/**
 * The leak-rate arithmetic of 40 CFR 84.102 (*Leak rate*) and 84.106(b), and
 * the same definition in 82.152 / duty in 82.157(b) for appliances that hold
 * only an ozone-depleting refrigerant. Design §2.
 *
 * Pure: no I/O, no clock. The worker, the console's live preview and the
 * tests run this one module.
 *
 * Exactness: quantities are integer ounces and days are integer calendar days.
 * The threshold verdict is decided by integer cross-multiplication (BigInt),
 * never by a rounded or floating-point rate. The displayed rate, in hundredths
 * of a percent (`bp`), is the exact rational rounded half up.
 *
 * Every interpretive choice (risk LB-C) is one named function below with a
 * worked-example test in tests/contracts/src/leak-rate.test.ts.
 */

import type { ApplianceCategory, LeakRateMethod, RefrigerantClass, ServiceEventKind } from "./leak.js";

// ── Applicability (§2.1) ─────────────────────────────────────

export const LEAK_REGIMES = ["84.106", "82.157"] as const;
export type LeakRegime = (typeof LEAK_REGIMES)[number];

/** 84.106(a): "15 or more pounds" — 240 oz, inclusive. */
export const HFC_SUBJECT_MIN_OZ = 240;
/** 82.157(a): 50 or more pounds — 800 oz, inclusive. */
export const ODS_SUBJECT_MIN_OZ = 800;
/** 84.106(b)(1)–(2): the substitutions apply to the first calculations after this date. */
export const HFC_RULE_START = "2026-01-01";
/** 84.106(j): chronically leaking — 125 percent or more of the full charge in a calendar year. */
export const CHRONIC_LEAK_PCT = 125;

export interface RateAppliance {
  refrigerantClass: RefrigerantClass;
  category: ApplianceCategory;
  fullChargeOz: number;
}

export interface Applicability {
  /** Which rule the appliance is subject to, or null when it is subject to none. */
  regime: LeakRegime | null;
  /** The applicable leak rate in whole percent (84.106(c)(2) / 82.157(c)(2)); null when not subject. */
  thresholdPct: number | null;
  /** Why the appliance is or is not subject, for display. */
  reason: string;
}

/** 84.106(c)(2), identically 82.157(c)(2). */
export function thresholdForCategory(category: ApplianceCategory): number {
  switch (category) {
    case "commercial_refrigeration":
      return 20;
    case "industrial_process_refrigeration":
      return 30;
    default:
      return 10;
  }
}

export function applicability(a: RateAppliance): Applicability {
  switch (a.refrigerantClass) {
    case "low_gwp":
      return { regime: null, thresholdPct: null, reason: "Low-GWP refrigerant: not subject to the leak-repair rules" };
    case "hfc":
    case "ods_hfc_blend":
      if (a.category === "residential_light_commercial_ac") {
        return {
          regime: null,
          thresholdPct: null,
          reason: "Residential / light commercial AC is excluded from 40 CFR 84.106 (84.106(a)(3)(ii))",
        };
      }
      if (a.fullChargeOz >= HFC_SUBJECT_MIN_OZ) {
        return {
          regime: "84.106",
          thresholdPct: thresholdForCategory(a.category),
          reason: "HFC appliance with 15 lb or more: 40 CFR 84.106",
        };
      }
      return { regime: null, thresholdPct: null, reason: "Under 15 lb of HFC: not subject to 40 CFR 84.106" };
    case "ods":
      if (a.fullChargeOz >= ODS_SUBJECT_MIN_OZ) {
        return {
          regime: "82.157",
          thresholdPct: thresholdForCategory(a.category),
          reason: "Ozone-depleting refrigerant, 50 lb or more: 40 CFR 82.157",
        };
      }
      return { regime: null, thresholdPct: null, reason: "Under 50 lb of ODS refrigerant: not subject to 40 CFR 82.157" };
    default:
      return { regime: null, thresholdPct: null, reason: "Unclassified refrigerant" };
  }
}

// ── Calendar days ───────────────────────────────────────────

const DAY_MS = 86_400_000;

function dayNumber(date: string): number {
  return Math.round(Date.parse(`${date}T00:00:00Z`) / DAY_MS);
}

/** Calendar days from `from` to `to` (YYYY-MM-DD); negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return dayNumber(to) - dayNumber(from);
}

/** YYYY-MM-DD plus `days` calendar days. */
export function addCalendarDays(date: string, days: number): string {
  return new Date((dayNumber(date) + days) * DAY_MS).toISOString().slice(0, 10);
}

// ── The log, as the arithmetic sees it ──────────────────────

/**
 * One service event. `prior` lists are in LOG ORDER — service date ascending,
 * then creation ascending — and hold only events the calculation may see
 * (voided events are ignored by every calculation: callers may pass them with
 * `voided: true` and they are skipped).
 */
export interface RateEvent {
  serviceDate: string;
  kind: ServiceEventKind;
  addedOz: number;
  recoveredOz: number;
  returnedOz: number;
  verificationPassed: boolean | null;
  voided?: boolean;
}

/** §2.2: refrigerant that went in and was not previously recovered from this appliance. */
export function eventLeakOz(e: Pick<RateEvent, "addedOz" | "returnedOz">): number {
  return e.addedOz - e.returnedOz;
}

/**
 * §2.2 / 84.106(b): a rate is calculated for every addition except one made
 * immediately after an installation or a retrofit, and a seasonal return of
 * what was seasonally removed (leak = 0).
 */
export function isCalculatedAddition(e: Pick<RateEvent, "kind" | "addedOz" | "returnedOz">): boolean {
  return eventLeakOz(e) > 0 && e.kind !== "installation" && e.kind !== "retrofit";
}

function live(prior: readonly RateEvent[]): RateEvent[] {
  return prior.filter((e) => !e.voided);
}

/** The held-refrigerant window: "within one consecutive 12-month period" (84.102, *Seasonal variance*). */
export const HELD_WINDOW_DAYS = 365;

/**
 * §2.2: the refrigerant recovered from this appliance and still held for
 * return to it on `serviceDate` — recovered in the 365 days up to that date,
 * minus what has already been returned (drawn oldest first). The same event's
 * own `recoveredOz` counts: an evacuate-repair-recharge visit can be one row.
 */
export function heldBalanceOz(
  prior: readonly RateEvent[],
  serviceDate: string,
  ownRecoveredOz = 0,
): number {
  const lots: { date: string; oz: number }[] = [];
  const expire = (on: string): void => {
    while (lots.length > 0 && daysBetween(lots[0]!.date, on) > HELD_WINDOW_DAYS) lots.shift();
  };
  const draw = (oz: number): void => {
    let rest = oz;
    while (rest > 0 && lots.length > 0) {
      const lot = lots[0]!;
      const take = Math.min(rest, lot.oz);
      lot.oz -= take;
      rest -= take;
      if (lot.oz === 0) lots.shift();
    }
  };
  for (const e of live(prior)) {
    if (e.serviceDate > serviceDate) continue;
    expire(e.serviceDate);
    if (e.recoveredOz > 0) lots.push({ date: e.serviceDate, oz: e.recoveredOz });
    if (e.returnedOz > 0) draw(e.returnedOz);
  }
  expire(serviceDate);
  return lots.reduce((sum, lot) => sum + lot.oz, 0) + ownRecoveredOz;
}

// ── The calculation ─────────────────────────────────────────

export interface LeakRateInput {
  appliance: RateAppliance;
  /** The site's method (84.102: one method per operating facility). */
  method: LeakRateMethod;
  /** Earlier events on this appliance, in log order. Events dated after `event` are ignored. */
  prior: readonly RateEvent[];
  /** The event being logged. */
  event: RateEvent;
}

export interface LeakRateResult {
  /** This event's own leak: addedOz − returnedOz. */
  leakOz: number;
  /** Whether a rate is calculated for this event (§2.2). */
  calculated: boolean;
  /** The remaining fields are null unless `calculated`. */
  method: LeakRateMethod | null;
  /** The ounces the rate is computed on: the day's merged additions, or the window's sum. */
  rateOz: number | null;
  /** Annualizing `d` (1…365); null for the rolling average. */
  rateDays: number | null;
  /** Hundredths of a percent, rounded half up. 4056 = 40.56 %. */
  leakRateBp: number | null;
  regime: LeakRegime | null;
  thresholdPct: number | null;
  /** Strictly over the threshold (84.106(c)(1) "over"); null when the appliance is not subject. */
  exceedsThreshold: boolean | null;
}

/**
 * LB-C (1): the 84.106(b)(1) 365-day substitution applies when no earlier
 * addition is on record, or when the only earlier additions predate
 * 2026-01-01 and this is the appliance's first rate under 84.106. Otherwise
 * the actual days since the last addition, capped at 365.
 */
export function annualizingDays(
  regime: LeakRegime | null,
  prior: readonly RateEvent[],
  serviceDate: string,
): number {
  const earlier = live(prior).filter((e) => e.serviceDate < serviceDate);
  const lastAddition = [...earlier].reverse().find((e) => e.addedOz > 0);
  if (!lastAddition) return 365;
  // Every calculated addition is itself an addition, so when the last one
  // predates 2026 no rate under 84.106 has been calculated yet.
  if (regime === "84.106" && lastAddition.serviceDate < HFC_RULE_START) return 365;
  return Math.min(daysBetween(lastAddition.serviceDate, serviceDate), 365);
}

/**
 * §2.3 Step 1, "whether in one addition or in multiple additions related to
 * same leak": the additions on one service date are one addition (LB-E: on
 * different days they are not merged).
 */
export function annualizingLeakOz(prior: readonly RateEvent[], event: RateEvent): number {
  const sameDay = live(prior).filter((e) => e.serviceDate === event.serviceDate && isCalculatedAddition(e));
  return sameDay.reduce((sum, e) => sum + eventLeakOz(e), eventLeakOz(event));
}

/**
 * §2.4: the window for the rolling average — the 365 days ending on this
 * event's date (the date itself included, the day 365 days earlier excluded),
 * after the latest passing follow-up verification test, and — under 84.106 —
 * not before 2026-01-01 (84.106(b)(2)).
 */
export function rollingWindowLeakOz(
  regime: LeakRegime | null,
  prior: readonly RateEvent[],
  event: RateEvent,
): number {
  const upTo = live(prior).filter((e) => e.serviceDate <= event.serviceDate);
  let start = 0;
  upTo.forEach((e, i) => {
    if (e.kind === "verification_followup" && e.verificationPassed === true) start = i + 1;
  });
  const opens = addCalendarDays(event.serviceDate, -365);
  const inWindow = upTo
    .slice(start)
    .filter((e) => e.serviceDate > opens)
    .filter((e) => regime !== "84.106" || e.serviceDate >= HFC_RULE_START)
    .filter(isCalculatedAddition);
  const own = isCalculatedAddition(event) ? eventLeakOz(event) : 0;
  return inWindow.reduce((sum, e) => sum + eventLeakOz(e), own);
}

/** ⌊(2N + D) / (2D)⌋ — the exact rational N/D rounded half up. */
function roundHalfUp(n: bigint, d: bigint): number {
  return Number((2n * n + d) / (2n * d));
}

/** LB-C (3): "over the applicable leak rate" is strictly greater. */
export function exceedsAnnualizing(leakOz: number, fullChargeOz: number, days: number, thresholdPct: number): boolean {
  return BigInt(leakOz) * 365n * 100n > BigInt(thresholdPct) * BigInt(fullChargeOz) * BigInt(days);
}

/** LB-C (3), rolling average: Σ × 100 > T × F. */
export function exceedsRolling(sumOz: number, fullChargeOz: number, thresholdPct: number): boolean {
  return BigInt(sumOz) * 100n > BigInt(thresholdPct) * BigInt(fullChargeOz);
}

export function annualizingRateBp(leakOz: number, fullChargeOz: number, days: number): number {
  return roundHalfUp(BigInt(leakOz) * 365n * 10000n, BigInt(fullChargeOz) * BigInt(days));
}

export function rollingRateBp(sumOz: number, fullChargeOz: number): number {
  return roundHalfUp(BigInt(sumOz) * 10000n, BigInt(fullChargeOz));
}

export function calculateLeakRate(input: LeakRateInput): LeakRateResult {
  const { appliance, method, event } = input;
  const leakOz = eventLeakOz(event);
  const notCalculated: LeakRateResult = {
    leakOz,
    calculated: false,
    method: null,
    rateOz: null,
    rateDays: null,
    leakRateBp: null,
    regime: null,
    thresholdPct: null,
    exceedsThreshold: null,
  };
  if (!isCalculatedAddition(event)) return notCalculated;

  const prior = input.prior.filter((e) => e.serviceDate <= event.serviceDate);
  const { regime, thresholdPct } = applicability(appliance);
  const F = appliance.fullChargeOz;

  if (method === "rolling_average") {
    const sum = rollingWindowLeakOz(regime, prior, event);
    return {
      leakOz,
      calculated: true,
      method,
      rateOz: sum,
      rateDays: null,
      leakRateBp: rollingRateBp(sum, F),
      regime,
      thresholdPct,
      exceedsThreshold: thresholdPct === null ? null : exceedsRolling(sum, F, thresholdPct),
    };
  }

  const merged = annualizingLeakOz(prior, event);
  const d = annualizingDays(regime, prior, event.serviceDate);
  return {
    leakOz,
    calculated: true,
    method: "annualizing",
    rateOz: merged,
    rateDays: d,
    leakRateBp: annualizingRateBp(merged, F, d),
    regime,
    thresholdPct,
    exceedsThreshold: thresholdPct === null ? null : exceedsAnnualizing(merged, F, d, thresholdPct),
  };
}

// ── Chronic leakers (84.106(j)) ─────────────────────────────

export interface ChronicLeakResult {
  year: number;
  leakOz: number;
  fullChargeOz: number;
  /** Σ leak ÷ full charge in hundredths of a percent, rounded half up. */
  percentBp: number;
  /** LB-C (3): "125 percent or more" — ≥, where the threshold is strictly >. */
  chronic: boolean;
}

/** Σ leak of the calculated additions in one calendar year × 100 ≥ 125 × full charge. */
export function chronicLeak(events: readonly RateEvent[], year: number, fullChargeOz: number): ChronicLeakResult {
  const prefix = `${String(year).padStart(4, "0")}-`;
  const leakOz = live(events)
    .filter((e) => e.serviceDate.startsWith(prefix) && isCalculatedAddition(e))
    .reduce((sum, e) => sum + eventLeakOz(e), 0);
  return {
    year,
    leakOz,
    fullChargeOz,
    percentBp: rollingRateBp(leakOz, fullChargeOz),
    chronic: BigInt(leakOz) * 100n >= BigInt(CHRONIC_LEAK_PCT) * BigInt(fullChargeOz),
  };
}

/** 4056 → "40.56 %". */
export function formatRateBp(bp: number): string {
  const whole = Math.trunc(bp / 100);
  const frac = String(Math.abs(bp % 100)).padStart(2, "0");
  return `${whole}.${frac} %`;
}
