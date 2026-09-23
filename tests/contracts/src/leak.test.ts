import {
  KNOWN_REFRIGERANTS,
  classifyRefrigerant,
  formatOunces,
  normalizeRefrigerant,
  splitOunces,
  toOunces,
} from "@saas/contracts/leak";

describe("leak contracts — refrigerants", () => {
  it("normalizes spelling variants to one designation", () => {
    expect(normalizeRefrigerant("r404a")).toBe("R-404A");
    expect(normalizeRefrigerant("R 404A")).toBe("R-404A");
    expect(normalizeRefrigerant(" R-134A ")).toBe("R-134a");
    expect(normalizeRefrigerant("r1234ze(e)")).toBe("R-1234ze(E)");
    expect(normalizeRefrigerant("R-999X")).toBe("R-999X");
  });

  it("classifies by the rule's categories: HFC, ODS, ODS blend with an HFC, low-GWP", () => {
    expect(classifyRefrigerant("R-404A")).toBe("hfc");
    expect(classifyRefrigerant("R-454B")).toBe("hfc"); // an HFO blend, GWP 466 > 53
    expect(classifyRefrigerant("R-22")).toBe("ods");
    expect(classifyRefrigerant("R-401A")).toBe("ods_hfc_blend");
    expect(classifyRefrigerant("R-290")).toBe("low_gwp");
    expect(classifyRefrigerant("R-744")).toBe("low_gwp");
    expect(classifyRefrigerant("R-999X")).toBeNull();
  });

  it("every built-in designation round-trips through normalization", () => {
    for (const code of Object.keys(KNOWN_REFRIGERANTS)) {
      expect(normalizeRefrigerant(code.toLowerCase())).toBe(code);
    }
  });
});

describe("leak contracts — ounces", () => {
  it("splits and formats integer ounces as pounds and ounces", () => {
    expect(splitOunces(646)).toEqual({ lb: 40, oz: 6 });
    expect(formatOunces(640)).toBe("40 lb");
    expect(formatOunces(646)).toBe("40 lb 6 oz");
    expect(formatOunces(6)).toBe("6 oz");
    expect(formatOunces(0)).toBe("0 oz");
  });

  it("converts form input to ounces, refusing fractions and negatives", () => {
    expect(toOunces(15, 0)).toBe(240); // the 84.106 applicability threshold, 15 lb
    expect(toOunces(50, 0)).toBe(800); // the 82.157 threshold, 50 lb
    expect(toOunces(40, 6)).toBe(646);
    expect(toOunces(1.5, 0)).toBeNull();
    expect(toOunces(-1, 0)).toBeNull();
  });
});
