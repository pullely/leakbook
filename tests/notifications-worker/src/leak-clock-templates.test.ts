// LB3: the four repair-clock emails leak-worker sends.
import { renderEmailTemplate } from "@notifications-worker/templates/index";

const DATA = {
  applianceName: "Walk-in cooler",
  siteName: "Rosa's Market <Main St>",
  leakRate: "40.56 %",
  thresholdPct: 20,
  regime: "84.106",
  openedOn: "2026-05-30",
  deadlineKind: "repair",
  dueOn: "2026-06-29",
  daysLeft: 9,
};

describe("leak repair-clock templates", () => {
  it("renders every key with the dates, the rate and the rule", () => {
    for (const key of ["leak.clock.opened", "leak.clock.reminder", "leak.clock.overdue", "leak.clock.escalation"]) {
      const r = renderEmailTemplate(key, DATA, { brandName: "Leakbook" });
      expect(r).not.toBeNull();
      expect(r!.subject.startsWith("[Leakbook] ")).toBe(true);
      expect(r!.text).toContain("2026-06-29");
      expect(r!.text).toContain("40.56 %");
    }
  });

  it("counts down in the reminder and says overdue once past", () => {
    expect(renderEmailTemplate("leak.clock.reminder", DATA)!.subject).toBe("Repair due in 9 days: Walk-in cooler at Rosa's Market <Main St>");
    expect(renderEmailTemplate("leak.clock.reminder", { ...DATA, daysLeft: 0, deadlineKind: "followup" })!.subject).toContain(
      "Follow-up test due today",
    );
    expect(renderEmailTemplate("leak.clock.overdue", DATA)!.text).toContain("40 CFR 84.106");
  });

  it("addresses the escalation to the owner or operator", () => {
    const r = renderEmailTemplate("leak.clock.escalation", DATA)!;
    expect(r.text).toContain("As the owner or operator you are responsible");
  });

  it("escapes every substitution in the HTML body", () => {
    const r = renderEmailTemplate("leak.clock.opened", DATA)!;
    expect(r.html).toContain("Rosa&#39;s Market &lt;Main St&gt;");
    expect(r.html).not.toContain("<Main St>");
  });
});
