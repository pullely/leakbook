/* eslint-disable @typescript-eslint/no-explicit-any -- test payloads are asserted field by field */
// LB2 end to end: the worked examples W1, W6, W8, W18–W19 and W23 of design
// §2.7, through the router, over a real SQLite engine with every migration
// (200_leak_core + 210_leak_rates) applied.
import { route } from "@leak-worker/router";
import { orgPublicId } from "@leak-worker/ids";
import { OWNER, TECH, VIEWER, as, json, world, type TestWorld } from "./harness";

const ORG_UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG = orgPublicId(ORG_UUID);
const BASE = "https://leak.internal";

function call(w: TestWorld, path: string, init: RequestInit = {}): Promise<Response> {
  return route(new Request(`${BASE}${path}`, init), w.env);
}

function send(w: TestWorld, path: string, who: string, body: unknown, method = "POST"): Promise<Response> {
  return call(w, path, {
    method,
    headers: { ...as(who), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function setup(
  w: TestWorld,
  opts: { method?: string; fullChargeOz?: number; category?: string } = {},
): Promise<{ site: Record<string, any>; appliance: Record<string, any> }> {
  const siteRes = await send(w, `/v1/organizations/${ORG}/sites`, OWNER, {
    name: "Rosa's Market — Main St",
    customerName: "Rosa's Market LLC",
    addressLine1: "12 Main St",
    city: "Springfield",
    region: "IL",
    postalCode: "62701",
    leakRateMethod: opts.method ?? "annualizing",
  });
  expect(siteRes.status).toBe(201);
  const site = (await json(siteRes)).data.site;
  const aplRes = await send(w, `/v1/organizations/${ORG}/sites/${site.id}/appliances`, OWNER, {
    name: "Walk-in cooler",
    category: opts.category ?? "commercial_refrigeration",
    refrigerant: "R-404A",
    fullChargeOz: opts.fullChargeOz ?? 640,
    fullChargeMethod: "manufacturer",
  });
  expect(aplRes.status).toBe(201);
  return { site, appliance: (await json(aplRes)).data.appliance };
}

async function log(
  w: TestWorld,
  applianceId: string,
  serviceDate: string,
  addedOz: number,
  extra: Record<string, unknown> = {},
): Promise<Record<string, any>> {
  const res = await send(w, `/v1/organizations/${ORG}/appliances/${applianceId}/events`, TECH, {
    serviceDate,
    kind: "service",
    technicianName: "Sam Ortiz",
    addedOz,
    ...extra,
  });
  const body = await json(res);
  if (res.status !== 201) throw new Error(`log ${serviceDate} → ${res.status} ${JSON.stringify(body)}`);
  return body.data.event;
}

function auditTypes(w: TestWorld): string[] {
  return (
    w.db.prepare("SELECT event_type FROM events_audit_entries ORDER BY occurred_at, rowid").all() as { event_type: string }[]
  ).map((r) => r.event_type);
}

describe("LB2 — the leak rate on every addition", () => {
  it("W1: +64 oz 90 days after the last addition returns 40.56 % against 20 %, stored and audited", async () => {
    const w = world(ORG_UUID);
    const { site, appliance } = await setup(w);
    const first = await log(w, appliance.id, "2026-03-01", 64);
    // Nothing on record before it: 84.106(b)(1) substitutes 365 days → 10.00 %.
    expect(first).toMatchObject({ rateDays: 365, leakRateBp: 1000, exceedsThreshold: false });
    const w1 = await log(w, appliance.id, "2026-05-30", 64);
    expect(w1).toMatchObject({
      leakOz: 64,
      rateMethod: "annualizing",
      rateDays: 90,
      leakRateBp: 4056,
      regime: "84.106",
      thresholdPct: 20,
      exceedsThreshold: true,
    });

    const row = w.db
      .prepare("SELECT leak_oz, rate_days, leak_rate_bp, exceeds_threshold FROM leak_service_events WHERE leak_rate_bp = 4056")
      .get() as Record<string, number>;
    expect(row).toEqual({ leak_oz: 64, rate_days: 90, leak_rate_bp: 4056, exceeds_threshold: 1 });
    expect(auditTypes(w).filter((t) => t === "leak.threshold.exceeded")).toHaveLength(1);

    const rate = await json(
      await call(w, `/v1/organizations/${ORG}/appliances/${appliance.id}/leak-rate`, { headers: as(VIEWER) }),
    );
    expect(rate.data.applicability).toMatchObject({ regime: "84.106", thresholdPct: 20 });
    expect(rate.data.method).toBe("annualizing");
    expect(rate.data.latest).toMatchObject({ id: w1.id, leakRateBp: 4056 });
    expect(rate.data.chronic[0]).toMatchObject({ leakOz: 128, fullChargeOz: 640, chronic: false });

    // The appliance page carries the preview's history, log order.
    const page = await json(
      await call(w, `/v1/organizations/${ORG}/appliances/${appliance.id}`, { headers: as(TECH) }),
    );
    expect(page.data.rateHistory.map((e: any) => e.serviceDate)).toEqual(["2026-03-01", "2026-05-30"]);

    // A rate exists at the site: its method is fixed (409); other edits still work.
    const change = await send(w, `/v1/organizations/${ORG}/sites/${site.id}`, OWNER, { leakRateMethod: "rolling_average" }, "PATCH");
    expect(change.status).toBe(409);
    const rename = await send(w, `/v1/organizations/${ORG}/sites/${site.id}`, OWNER, { notes: "Back door code 1234" }, "PATCH");
    expect(rename.status).toBe(200);
  });

  it("a site with no calculated rate may still change its method", async () => {
    const w = world(ORG_UUID);
    const { site, appliance } = await setup(w);
    await log(w, appliance.id, "2026-01-10", 640, { kind: "installation" });
    const change = await send(w, `/v1/organizations/${ORG}/sites/${site.id}`, OWNER, { leakRateMethod: "rolling_average" }, "PATCH");
    expect(change.status).toBe(200);
    expect((await json(change)).data.site.leakRateMethod).toBe("rolling_average");
  });

  it("W6: the installation charge has no rate; +32 oz 60 days later → 30.42 %", async () => {
    const w = world(ORG_UUID);
    const { appliance } = await setup(w);
    const install = await log(w, appliance.id, "2026-01-10", 640, { kind: "installation" });
    expect(install).toMatchObject({ leakOz: 640, leakRateBp: null, rateMethod: null, exceedsThreshold: null });
    expect(await log(w, appliance.id, "2026-03-11", 32)).toMatchObject({
      rateDays: 60,
      leakRateBp: 3042,
      exceedsThreshold: true,
    });
  });

  it("W8 + W11: a post-repair recharge counts only the lost 40 oz (38.02 %); returning more than is held is 422", async () => {
    const w = world(ORG_UUID);
    const { appliance } = await setup(w);
    await log(w, appliance.id, "2026-02-01", 64);
    await log(w, appliance.id, "2026-04-01", 0, { kind: "repair", recoveredOz: 600 });

    const over = await send(w, `/v1/organizations/${ORG}/appliances/${appliance.id}/events`, TECH, {
      serviceDate: "2026-04-02",
      kind: "service",
      technicianName: "Sam Ortiz",
      addedOz: 700,
      returnedOz: 700,
    });
    expect(over.status).toBe(422);
    expect((await json(over)).error.details.fields.returnedOz[0]).toMatch(/600 oz .* 100 oz as refrigerant added/);

    expect(await log(w, appliance.id, "2026-04-02", 640, { returnedOz: 600 })).toMatchObject({
      leakOz: 40,
      rateDays: 60,
      leakRateBp: 3802,
      exceedsThreshold: true,
    });
  });

  it("W18–W19: the rolling average reaches 23.00 %, then resets at a passing follow-up verification → 3.00 %", async () => {
    const w = world(ORG_UUID);
    const { appliance } = await setup(w, { method: "rolling_average", fullChargeOz: 1600 });
    const bps: (number | null)[] = [];
    for (const [date, oz] of [
      ["2026-02-10", 160],
      ["2026-05-10", 128],
      ["2026-07-01", 80],
    ] as const) {
      bps.push((await log(w, appliance.id, date, oz)).leakRateBp);
    }
    expect(bps).toEqual([1000, 1800, 2300]);
    await log(w, appliance.id, "2026-07-20", 0, { kind: "verification_followup", verificationPassed: true });
    expect(await log(w, appliance.id, "2026-09-15", 48)).toMatchObject({
      rateMethod: "rolling_average",
      rateDays: null,
      leakRateBp: 300,
      exceedsThreshold: false,
    });
  });

  it("W23: a voided addition is ignored by the next calculation (d = 91 → 40.11 %)", async () => {
    const w = world(ORG_UUID);
    const { appliance } = await setup(w);
    await log(w, appliance.id, "2026-03-01", 64);
    const mistaken = await log(w, appliance.id, "2026-05-30", 64);
    const voided = await send(
      w,
      `/v1/organizations/${ORG}/appliances/${appliance.id}/events/${mistaken.id}/void`,
      OWNER,
      { reason: "Wrong date" },
    );
    expect(voided.status).toBe(200);
    // The voided row keeps the verdict it was computed with (never rewritten).
    expect((await json(voided)).data.event).toMatchObject({ voided: true, leakRateBp: 4056 });
    expect(await log(w, appliance.id, "2026-05-31", 64)).toMatchObject({ rateDays: 91, leakRateBp: 4011 });
  });

  it("the QR lane computes the same rate", async () => {
    const w = world(ORG_UUID);
    const { appliance } = await setup(w);
    await log(w, appliance.id, "2026-03-01", 64);
    const res = await send(w, `/v1/qr/${appliance.qrToken}/events`, TECH, {
      serviceDate: "2026-05-30",
      kind: "service",
      technicianName: "Sam Ortiz",
      addedOz: 64,
    });
    expect(res.status).toBe(201);
    expect((await json(res)).data.event).toMatchObject({ loggedVia: "qr", leakRateBp: 4056, exceedsThreshold: true });
    const resolved = await json(await call(w, `/v1/qr/${appliance.qrToken}`, { headers: as(TECH) }));
    expect(resolved.data.rateHistory).toHaveLength(2);
  });
});
