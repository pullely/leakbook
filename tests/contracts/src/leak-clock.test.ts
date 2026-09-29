// LB3: the repair clock's date arithmetic (design §1.5), pure.
import {
  REMINDER_RUNGS,
  clockDeadline,
  daysLeft,
  dueRung,
  followupDueOn,
  isOverdue,
  repairDueOn,
  rungKey,
} from "@saas/contracts/leak-clock";

describe("repair clock deadlines", () => {
  it("W1: an exceedance on 2026-05-30 is due 2026-06-29 (30 days, 84.106(d))", () => {
    expect(repairDueOn("2026-05-30", false)).toBe("2026-06-29");
  });

  it("W17: with an industrial process shutdown the repair is due in 120 days instead", () => {
    expect(repairDueOn("2026-05-01", true)).toBe("2026-08-29");
  });

  it("days spent mothballed push the deadline out (84.106(d)(3))", () => {
    expect(repairDueOn("2026-05-30", false, 10)).toBe("2026-07-09");
  });

  it("the follow-up verification test is due 10 days after the initial one passes", () => {
    expect(followupDueOn("2026-06-10")).toBe("2026-06-20");
  });

  it("counts down to the repair, then to the follow-up, then to nothing", () => {
    const open = { status: "open" as const, repairDueOn: "2026-06-29", initialVerifiedOn: null, followupDueOn: null };
    expect(clockDeadline(open)).toEqual({ kind: "repair", dueOn: "2026-06-29" });
    expect(clockDeadline({ ...open, initialVerifiedOn: "2026-06-10", followupDueOn: "2026-06-20" })).toEqual({
      kind: "followup",
      dueOn: "2026-06-20",
    });
    expect(clockDeadline({ ...open, status: "closed" })).toBeNull();
    expect(clockDeadline({ ...open, status: "suspended" })).toBeNull();
  });

  it("is overdue the day after the deadline, not on it", () => {
    const open = { status: "open" as const, repairDueOn: "2026-06-29", initialVerifiedOn: null, followupDueOn: null };
    expect(daysLeft("2026-06-29", "2026-06-29")).toBe(0);
    expect(isOverdue(open, "2026-06-29")).toBe(false);
    expect(isOverdue(open, "2026-06-30")).toBe(true);
  });
});

describe("the reminder ladder", () => {
  it("is 14 / 7 / 3 / 1 / 0 days before the deadline", () => {
    expect([...REMINDER_RUNGS]).toEqual([14, 7, 3, 1, 0]);
  });

  it("sends the most urgent rung reached, once — a late clock does not send the earlier rungs together", () => {
    expect(dueRung(30)).toBeNull();
    expect(dueRung(15)).toBeNull();
    expect(dueRung(14)).toBe(14);
    expect(dueRung(9)).toBe(14);
    expect(dueRung(7)).toBe(7);
    expect(dueRung(2)).toBe(3);
    expect(dueRung(1)).toBe(1);
    expect(dueRung(0)).toBe(0);
    expect(dueRung(-1)).toBeNull();
  });

  it("keys rungs without a colon (they become part of a notification idempotency key)", () => {
    expect(rungKey("repair", 14)).toBe("repair-14");
    expect(rungKey("followup", 0)).toBe("followup-0");
    expect(rungKey("repair", "overdue")).toBe("overdue-repair");
    expect(rungKey("repair", "escalation")).toBe("escalation-repair");
  });
});
