// The worked examples of design §2.7, one named test each (LB2 "done when").
// Quantities in ounces (16 oz = 1 lb).
import type { ApplianceCategory, LeakRateMethod, RefrigerantClass } from "@saas/contracts/leak";
import {
  addCalendarDays,
  annualizingDays,
  applicability,
  calculateLeakRate,
  chronicLeak,
  daysBetween,
  formatRateBp,
  heldBalanceOz,
  type RateAppliance,
  type RateEvent,
} from "@saas/contracts/leak-rate";

function appliance(
  fullChargeOz: number,
  category: ApplianceCategory = "commercial_refrigeration",
  refrigerantClass: RefrigerantClass = "hfc",
): RateAppliance {
  return { fullChargeOz, category, refrigerantClass };
}

function ev(serviceDate: string, addedOz: number, over: Partial<RateEvent> = {}): RateEvent {
  return {
    serviceDate,
    kind: "service",
    addedOz,
    recoveredOz: 0,
    returnedOz: 0,
    verificationPassed: null,
    ...over,
  };
}

/** Log `events` in order, computing each one against the ones before it, as the worker does. */
function run(app: RateAppliance, events: RateEvent[], method: LeakRateMethod = "annualizing") {
  const prior: RateEvent[] = [];
  return events.map((event) => {
    const result = calculateLeakRate({ appliance: app, method, prior, event });
    prior.push(event);
    return result;
  });
}

function last<T>(xs: T[]): T {
  return xs[xs.length - 1]!;
}

const WALK_IN = appliance(640);

describe("calendar days", () => {
  it("counts calendar days across month ends and leap years", () => {
    expect(daysBetween("2026-03-01", "2026-05-30")).toBe(90);
    expect(daysBetween("2026-01-10", "2026-03-11")).toBe(60);
    expect(daysBetween("2028-02-28", "2028-03-01")).toBe(2);
    expect(addCalendarDays("2026-05-30", 30)).toBe("2026-06-29");
    expect(addCalendarDays("2027-01-10", -365)).toBe("2026-01-10");
  });
});

describe("design §2.7 worked examples", () => {
  it("W1 — annualizing, commercial: 64/640 × 365/90 = 40.56 %, exceeds 20 %", () => {
    const r = last(run(WALK_IN, [ev("2026-03-01", 64), ev("2026-05-30", 64)]));
    expect(r).toMatchObject({
      calculated: true,
      method: "annualizing",
      leakOz: 64,
      rateOz: 64,
      rateDays: 90,
      leakRateBp: 4056,
      regime: "84.106",
      thresholdPct: 20,
      exceedsThreshold: true,
    });
    expect(formatRateBp(r.leakRateBp!)).toBe("40.56 %");
    // The repair clock (LB3) runs 30 days from the exceeding addition.
    expect(addCalendarDays("2026-05-30", 30)).toBe("2026-06-29");
  });

  it("W2 — the 365-day cap: 400 days since the last addition counts as 365 → 10.00 %", () => {
    const prev = addCalendarDays("2027-03-01", -400);
    const r = last(run(WALK_IN, [ev(prev, 64), ev("2027-03-01", 64)]));
    expect(r.rateDays).toBe(365);
    expect(r.leakRateBp).toBe(1000);
    expect(r.exceedsThreshold).toBe(false);
  });

  it("W3 — exactly at the threshold does not exceed (strictly greater): +128 at d = 365 → 20.00 %", () => {
    const r = last(run(WALK_IN, [ev("2026-01-01", 64), ev("2027-01-01", 128)]));
    expect(r.rateDays).toBe(365);
    expect(r.leakRateBp).toBe(2000);
    expect(r.exceedsThreshold).toBe(false);
  });

  it("W4 — one ounce over: +129 at d = 365 → 20.16 %, exceeds", () => {
    const r = last(run(WALK_IN, [ev("2026-01-01", 64), ev("2027-01-01", 129)]));
    expect(r.leakRateBp).toBe(2016);
    expect(r.exceedsThreshold).toBe(true);
  });

  it("W5 — first calculation with nothing on record substitutes 365 days (84.106(b)(1)) → 7.50 %", () => {
    const r = last(run(WALK_IN, [ev("2026-02-10", 48)]));
    expect(r.rateDays).toBe(365);
    expect(r.leakRateBp).toBe(750);
    expect(r.exceedsThreshold).toBe(false);
  });

  it("W5 — an addition before 2026 is replaced by 365 days for the first 84.106 calculation", () => {
    expect(annualizingDays("84.106", [ev("2025-12-15", 64)], "2026-01-10")).toBe(365);
    // Not under 82.157, and not once 2026 has an addition on record.
    expect(annualizingDays("82.157", [ev("2025-12-15", 64)], "2026-01-10")).toBe(26);
    expect(annualizingDays("84.106", [ev("2025-12-15", 64), ev("2026-01-05", 16)], "2026-01-10")).toBe(5);
  });

  it("W6 — the installation charge is not a rate, but it is the last addition: +32 at d = 60 → 30.42 %", () => {
    const [install, next] = run(WALK_IN, [ev("2026-01-10", 640, { kind: "installation" }), ev("2026-03-11", 32)]);
    expect(install!.calculated).toBe(false);
    expect(install!.leakRateBp).toBeNull();
    expect(next).toMatchObject({ rateDays: 60, leakRateBp: 3042, exceedsThreshold: true });
  });

  it("W7 — two additions on one day are one addition: 15.21 % then (merged 32) 30.42 %", () => {
    const [, first, second] = run(WALK_IN, [ev("2026-01-15", 64), ev("2026-03-16", 16), ev("2026-03-16", 16)]);
    expect(first).toMatchObject({ rateOz: 16, rateDays: 60, leakRateBp: 1521, exceedsThreshold: false });
    expect(second).toMatchObject({ leakOz: 16, rateOz: 32, rateDays: 60, leakRateBp: 3042, exceedsThreshold: true });
  });

  it("W8 — a recharge after a repair counts only the ounces lost: 640 in, 600 returned → leak 40 → 38.02 %", () => {
    const events = [
      ev("2026-02-01", 64),
      ev("2026-04-01", 0, { kind: "repair", recoveredOz: 600 }),
      ev("2026-04-02", 640, { returnedOz: 600 }),
    ];
    expect(heldBalanceOz(events.slice(0, 2), "2026-04-02")).toBe(600);
    const [, repair, recharge] = run(WALK_IN, events);
    expect(repair!.calculated).toBe(false);
    expect(recharge).toMatchObject({ leakOz: 40, rateDays: 60, leakRateBp: 3802, exceedsThreshold: true });
  });

  it("W9 — a recharge that returns everything is not a rate", () => {
    const [, recharge] = run(WALK_IN, [
      ev("2026-04-01", 0, { kind: "repair", recoveredOz: 640 }),
      ev("2026-04-02", 640, { returnedOz: 640 }),
    ]);
    expect(recharge).toMatchObject({ leakOz: 0, calculated: false, leakRateBp: null, exceedsThreshold: null });
  });

  it("W10 — a seasonal return of what was seasonally removed is not a rate (seasonal variance)", () => {
    const events = [
      ev("2026-04-15", 0, { kind: "seasonal_adjustment", recoveredOz: 80 }),
      ev("2026-10-15", 80, { kind: "seasonal_adjustment", returnedOz: 80 }),
    ];
    expect(heldBalanceOz(events.slice(0, 1), "2026-10-15")).toBe(80);
    expect(last(run(WALK_IN, events)).calculated).toBe(false);
  });

  it("W11 — returning more than is held is refused (the worker answers 422)", () => {
    const prior = [ev("2026-04-15", 0, { kind: "seasonal_adjustment", recoveredOz: 80 })];
    const held = heldBalanceOz(prior, "2026-10-15");
    expect(held).toBe(80);
    expect(96 > held).toBe(true);
    // Held refrigerant expires after 365 days and is drawn oldest first.
    expect(heldBalanceOz(prior, "2027-04-16")).toBe(0);
    expect(heldBalanceOz([...prior, ev("2026-05-01", 50, { returnedOz: 50 })], "2026-10-15")).toBe(30);
  });

  it("W12 — size threshold, HFC: 14 lb is not subject, exactly 15 lb is", () => {
    expect(applicability(appliance(224))).toMatchObject({ regime: null, thresholdPct: null });
    expect(applicability(appliance(240))).toMatchObject({ regime: "84.106", thresholdPct: 20 });
  });

  it("W13 — ODS: under 50 lb not subject, 50 lb is subject to 82.157", () => {
    expect(applicability(appliance(640, "commercial_refrigeration", "ods")).regime).toBeNull();
    expect(applicability(appliance(800, "commercial_refrigeration", "ods"))).toMatchObject({
      regime: "82.157",
      thresholdPct: 20,
    });
    // An ODS blend that also contains an HFC is 84.106 at 15 lb.
    expect(applicability(appliance(240, "commercial_refrigeration", "ods_hfc_blend")).regime).toBe("84.106");
  });

  it("W14 — low-GWP: the rate is computed, never subject", () => {
    const big = appliance(100_000, "commercial_refrigeration", "low_gwp");
    expect(applicability(big).regime).toBeNull();
    const r = last(run(big, [ev("2026-03-01", 64), ev("2026-05-30", 64_000)]));
    expect(r.calculated).toBe(true);
    expect(r.leakRateBp).not.toBeNull();
    expect(r).toMatchObject({ regime: null, thresholdPct: null, exceedsThreshold: null });
  });

  it("W15 — comfort cooling at 10 %: +16 on 320 oz at d = 200 → 9.13 % (no), at d = 180 → 10.14 % (exceeds)", () => {
    const rooftop = appliance(320, "comfort_cooling");
    const at200 = last(run(rooftop, [ev("2026-01-01", 16), ev(addCalendarDays("2026-01-01", 200), 16)]));
    expect(at200).toMatchObject({ rateDays: 200, leakRateBp: 913, thresholdPct: 10, exceedsThreshold: false });
    const at180 = last(run(rooftop, [ev("2026-01-01", 16), ev(addCalendarDays("2026-01-01", 180), 16)]));
    expect(at180).toMatchObject({ rateDays: 180, leakRateBp: 1014, exceedsThreshold: true });
  });

  it("W16 — residential / light commercial AC is excluded from 84.106 (84.106(a)(3)(ii))", () => {
    const split = appliance(320, "residential_light_commercial_ac");
    expect(applicability(split).regime).toBeNull();
    const r = last(run(split, [ev("2026-03-01", 64), ev("2026-05-30", 64)]));
    expect(r.calculated).toBe(true);
    expect(r.exceedsThreshold).toBeNull();
  });

  it("W17 — industrial process refrigeration at 30 %: +1 600 on 12 800 oz at d = 120 → 38.02 %", () => {
    const plant = appliance(12_800, "industrial_process_refrigeration");
    const r = last(run(plant, [ev("2026-01-01", 1_600), ev(addCalendarDays("2026-01-01", 120), 1_600)]));
    expect(r).toMatchObject({ rateDays: 120, leakRateBp: 3802, thresholdPct: 30, exceedsThreshold: true });
  });

  const RACK = appliance(1_600);

  it("W18 — rolling average: 18.00 % then 23.00 %", () => {
    const results = run(RACK, [ev("2026-02-10", 160), ev("2026-05-10", 128), ev("2026-07-01", 80)], "rolling_average");
    expect(results.map((r) => r.leakRateBp)).toEqual([1000, 1800, 2300]);
    expect(results.map((r) => r.exceedsThreshold)).toEqual([false, false, true]);
    expect(last(results)).toMatchObject({ method: "rolling_average", rateOz: 368, rateDays: null });
  });

  it("W19 — rolling average resets at a passing follow-up verification: 3.00 % (26.00 % without)", () => {
    const events = [
      ev("2026-02-10", 160),
      ev("2026-05-10", 128),
      ev("2026-07-01", 80),
      ev("2026-07-20", 0, { kind: "verification_followup", verificationPassed: true }),
      ev("2026-09-15", 48),
    ];
    expect(last(run(RACK, events, "rolling_average"))).toMatchObject({ leakRateBp: 300, exceedsThreshold: false });
    const failed = events.map((e, i) => (i === 3 ? { ...e, verificationPassed: false } : e));
    expect(last(run(RACK, failed, "rolling_average")).leakRateBp).toBe(2600);
  });

  it("W20 — rolling average under 84.106 counts only additions since 2026-01-01: 6.00 % (21.00 % without)", () => {
    const events = [ev("2025-12-15", 240), ev("2026-03-01", 96)];
    expect(last(run(RACK, events, "rolling_average"))).toMatchObject({ leakRateBp: 600, exceedsThreshold: false });
    const ods = appliance(1_600, "commercial_refrigeration", "ods");
    expect(last(run(ods, events, "rolling_average")).leakRateBp).toBe(2100);
  });

  it("W21 — the rolling window is 365 days: 2026-01-05 falls out on 2027-01-10 → 6.00 %", () => {
    const r = last(run(RACK, [ev("2026-01-05", 160), ev("2027-01-10", 96)], "rolling_average"));
    expect(r.leakRateBp).toBe(600);
  });

  it("W22 — chronic leaker: 800 oz in a year on 640 oz is 125.00 % (chronic), 799 is 124.84 % (not)", () => {
    const chronic = chronicLeak([ev("2026-02-01", 400), ev("2026-08-01", 400)], 2026, 640);
    expect(chronic).toMatchObject({ leakOz: 800, percentBp: 12500, chronic: true });
    const not = chronicLeak([ev("2026-02-01", 400), ev("2026-08-01", 399)], 2026, 640);
    expect(not).toMatchObject({ leakOz: 799, percentBp: 12484, chronic: false });
    // Another year, an installation charge and a voided event do not count.
    const mixed = chronicLeak(
      [
        ev("2025-12-31", 400),
        ev("2026-01-10", 640, { kind: "installation" }),
        ev("2026-02-01", 400, { voided: true }),
        ev("2026-03-01", 16),
      ],
      2026,
      640,
    );
    expect(mixed.leakOz).toBe(16);
  });

  it("W23 — a voided addition is ignored: re-logged +64 on 2026-05-31 → d = 91 → 40.11 %", () => {
    const voided = ev("2026-05-30", 64, { voided: true });
    const r = calculateLeakRate({
      appliance: WALK_IN,
      method: "annualizing",
      prior: [ev("2026-03-01", 64), voided],
      event: ev("2026-05-31", 64),
    });
    expect(r).toMatchObject({ rateDays: 91, rateOz: 64, leakRateBp: 4011, exceedsThreshold: true });
  });
});

describe("leak-rate edges", () => {
  it("an event dated before later rows is computed only from the rows up to its date", () => {
    const r = calculateLeakRate({
      appliance: WALK_IN,
      method: "annualizing",
      prior: [ev("2026-03-01", 64), ev("2026-06-01", 64)],
      event: ev("2026-05-30", 64),
    });
    expect(r.rateDays).toBe(90);
  });

  it("a retrofit charge is not a rate", () => {
    expect(last(run(WALK_IN, [ev("2026-03-01", 64), ev("2026-05-30", 64, { kind: "retrofit" })])).calculated).toBe(
      false,
    );
  });

  it("formats basis points", () => {
    expect(formatRateBp(4056)).toBe("40.56 %");
    expect(formatRateBp(600)).toBe("6.00 %");
    expect(formatRateBp(5)).toBe("0.05 %");
  });
});
