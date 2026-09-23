/* eslint-disable @typescript-eslint/no-explicit-any -- test payloads are asserted field by field */
import { route } from "@leak-worker/router";
import { orgPublicId } from "@leak-worker/ids";
import { OWNER, STRANGER, TECH, VIEWER, as, json, world, type TestWorld } from "./harness";

const ORG_UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG = orgPublicId(ORG_UUID);
const OTHER_ORG = orgPublicId("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
const BASE = "https://leak.internal";

function call(w: TestWorld, path: string, init: RequestInit = {}): Promise<Response> {
  return route(new Request(`${BASE}${path}`, init), w.env);
}

function get(w: TestWorld, path: string, who: string): Promise<Response> {
  return call(w, path, { headers: as(who) });
}

function send(w: TestWorld, path: string, who: string, body: unknown, method = "POST"): Promise<Response> {
  return call(w, path, {
    method,
    headers: { ...as(who), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function createSite(w: TestWorld, overrides: Record<string, unknown> = {}): Promise<Record<string, any>> {
  const res = await send(w, `/v1/organizations/${ORG}/sites`, OWNER, {
    name: "Rosa's Market — Main St",
    customerName: "Rosa's Market LLC",
    addressLine1: "12 Main St",
    city: "Springfield",
    region: "IL",
    postalCode: "62701",
    ownerContactName: "Rosa Diaz",
    ownerContactEmail: "Rosa@RosasMarket.example",
    ...overrides,
  });
  expect(res.status).toBe(201);
  return (await json(res)).data.site;
}

async function createAppliance(
  w: TestWorld,
  siteId: string,
  overrides: Record<string, unknown> = {},
): Promise<Record<string, any>> {
  const res = await send(w, `/v1/organizations/${ORG}/sites/${siteId}/appliances`, OWNER, {
    name: "Walk-in cooler",
    location: "Back room",
    category: "commercial_refrigeration",
    refrigerant: "R-404A",
    fullChargeOz: 640,
    fullChargeMethod: "manufacturer",
    installedOn: "2024-05-01",
    ...overrides,
  });
  expect(res.status).toBe(201);
  return (await json(res)).data.appliance;
}

function logEvent(w: TestWorld, applianceId: string, body: Record<string, unknown>, who = TECH): Promise<Response> {
  return send(w, `/v1/organizations/${ORG}/appliances/${applianceId}/events`, who, {
    serviceDate: "2026-05-30",
    kind: "service",
    technicianName: "Sam Ortiz",
    ...body,
  });
}

function auditTypes(w: TestWorld): string[] {
  return (
    w.db.prepare("SELECT event_type FROM events_audit_entries ORDER BY occurred_at, rowid").all() as { event_type: string }[]
  ).map((r) => r.event_type);
}

describe("sites", () => {
  it("creates, lists, reads and patches a site, auditing each write", async () => {
    const w = world(ORG_UUID);
    const site = await createSite(w);
    expect(site.id).toMatch(/^ste_[0-9a-f]{32}$/);
    expect(site.orgId).toBe(ORG);
    expect(site.leakRateMethod).toBe("annualizing");
    expect(site.country).toBe("US");
    expect(site.ownerContactEmail).toBe("rosa@rosasmarket.example");
    expect(site.applianceCount).toBe(0);

    const patched = await json(
      await send(w, `/v1/organizations/${ORG}/sites/${site.id}`, TECH, { notes: "Gate code 4411", status: "active" }, "PATCH"),
    );
    expect(patched.data.site.notes).toBe("Gate code 4411");
    expect(patched.data.site.name).toBe("Rosa's Market — Main St"); // absent fields keep their value

    const list = await json(await get(w, `/v1/organizations/${ORG}/sites?status=active`, VIEWER));
    expect(list.data.sites).toHaveLength(1);
    expect(auditTypes(w)).toEqual(["leak.site.created", "leak.site.updated"]);
  });

  it("requires the address the record needs, and validates contact and country", async () => {
    const w = world(ORG_UUID);
    const res = await send(w, `/v1/organizations/${ORG}/sites`, OWNER, {
      name: "X",
      customerName: "",
      ownerContactEmail: "not-an-email",
      country: "usa",
      leakRateMethod: "monthly",
    });
    expect(res.status).toBe(422);
    const fields = (await json(res)).error.details.fields;
    expect(Object.keys(fields).sort()).toEqual(
      ["addressLine1", "city", "country", "customerName", "leakRateMethod", "ownerContactEmail"].sort(),
    );
  });
});

describe("appliances", () => {
  it("classifies a known refrigerant from the built-in table and counts it on the site", async () => {
    const w = world(ORG_UUID);
    const site = await createSite(w);
    const apl = await createAppliance(w, site.id, { refrigerant: "r 404a" });
    expect(apl.id).toMatch(/^apl_[0-9a-f]{32}$/);
    expect(apl.refrigerant).toBe("R-404A");
    expect(apl.refrigerantClass).toBe("hfc");
    expect(apl.fullChargeOz).toBe(640);
    expect(apl.status).toBe("active");
    expect(apl.qrToken).toMatch(/^[a-z2-7]{32}$/);
    expect(apl.lastServiceDate).toBeNull();

    const got = await json(await get(w, `/v1/organizations/${ORG}/sites/${site.id}`, VIEWER));
    expect(got.data.site.applianceCount).toBe(1);
    expect(got.data.appliances.map((a: any) => a.id)).toEqual([apl.id]);
  });

  it("refuses a class that contradicts the table, and demands one for an unknown refrigerant", async () => {
    const w = world(ORG_UUID);
    const site = await createSite(w);
    const path = `/v1/organizations/${ORG}/sites/${site.id}/appliances`;
    const base = { name: "RTU-1", category: "comfort_cooling", fullChargeOz: 320, fullChargeMethod: "manufacturer" };

    const wrong = await send(w, path, OWNER, { ...base, refrigerant: "R-22", refrigerantClass: "hfc" });
    expect(wrong.status).toBe(422);
    expect((await json(wrong)).error.details.fields.refrigerantClass[0]).toContain("ods");

    const unknown = await send(w, path, OWNER, { ...base, refrigerant: "R-999X" });
    expect(unknown.status).toBe(422);
    expect(Object.keys((await json(unknown)).error.details.fields)).toEqual(["refrigerantClass"]);

    const classified = await send(w, path, OWNER, { ...base, refrigerant: "R-999X", refrigerantClass: "low_gwp" });
    expect(classified.status).toBe(201);
    expect((await json(classified)).data.appliance.refrigerantClass).toBe("low_gwp");
  });

  it("derives the full charge from an established range (method 4) and refuses a charge that is not its midpoint", async () => {
    const w = world(ORG_UUID);
    const site = await createSite(w);
    const path = `/v1/organizations/${ORG}/sites/${site.id}/appliances`;
    const base = { name: "Case line", category: "commercial_refrigeration", refrigerant: "R-448A", fullChargeMethod: "range_midpoint" };

    const derived = await send(w, path, OWNER, { ...base, fullChargeRangeLowOz: 600, fullChargeRangeHighOz: 681 });
    expect(derived.status).toBe(201);
    expect((await json(derived)).data.appliance.fullChargeOz).toBe(641); // (600 + 681) / 2 = 640.5, half up

    const mismatch = await send(w, path, OWNER, { ...base, fullChargeOz: 700, fullChargeRangeLowOz: 600, fullChargeRangeHighOz: 680 });
    expect(mismatch.status).toBe(422);

    const missing = await send(w, path, OWNER, { ...base, fullChargeOz: 640 });
    expect(missing.status).toBe(422);
  });

  it("rejects fractional ounces and a future installation date", async () => {
    const w = world(ORG_UUID);
    const site = await createSite(w);
    const res = await send(w, `/v1/organizations/${ORG}/sites/${site.id}/appliances`, OWNER, {
      name: "Reach-in",
      category: "commercial_refrigeration",
      refrigerant: "R-404A",
      fullChargeOz: 14.5,
      fullChargeMethod: "manufacturer",
      installedOn: "2999-01-01",
    });
    expect(res.status).toBe(422);
    expect(Object.keys((await json(res)).error.details.fields).sort()).toEqual(["fullChargeOz", "installedOn"]);
  });

  it("records a full-charge revision with its old value, new value and method", async () => {
    const w = world(ORG_UUID);
    const site = await createSite(w);
    const apl = await createAppliance(w, site.id);
    const res = await send(
      w,
      `/v1/organizations/${ORG}/appliances/${apl.id}`,
      OWNER,
      { fullChargeOz: 656, fullChargeMethod: "measurement" },
      "PATCH",
    );
    expect(res.status).toBe(200);
    expect((await json(res)).data.appliance.fullChargeOz).toBe(656);
    const row = w.db
      .prepare("SELECT payload FROM events_audit_entries WHERE event_type = 'leak.appliance.updated'")
      .get() as { payload: string };
    expect(JSON.parse(row.payload).fullChargeRevision).toEqual({
      fromOz: 640,
      toOz: 656,
      fromMethod: "manufacturer",
      toMethod: "measurement",
    });
  });
});

describe("the QR label", () => {
  it("resolves for a member of the owning organization and 404s for anyone else", async () => {
    const w = world(ORG_UUID);
    const site = await createSite(w);
    const apl = await createAppliance(w, site.id);

    const resolved = await get(w, `/v1/qr/${apl.qrToken}`, TECH);
    expect(resolved.status).toBe(200);
    const body = (await json(resolved)).data;
    expect(body.organization.id).toBe(ORG);
    expect(body.appliance.id).toBe(apl.id);
    expect(body.site.id).toBe(site.id);
    expect(body.events).toEqual([]);

    expect((await get(w, `/v1/qr/${apl.qrToken}`, STRANGER)).status).toBe(404);
    expect((await get(w, `/v1/qr/${"a".repeat(32)}`, TECH)).status).toBe(404); // well-formed, unknown
    expect((await get(w, `/v1/qr/not-a-token`, TECH)).status).toBe(404);
    expect((await call(w, `/v1/qr/${apl.qrToken}`)).status).toBe(401);
  });

  it("logs from the phone page, marked as logged via the label", async () => {
    const w = world(ORG_UUID);
    const site = await createSite(w);
    const apl = await createAppliance(w, site.id);

    const res = await send(w, `/v1/qr/${apl.qrToken}/events`, TECH, {
      serviceDate: "2026-05-30",
      kind: "service",
      technicianName: "Sam Ortiz",
      addedOz: 64,
      component: "Condenser coil braze joint",
      loggedVia: "console", // overridden: this lane is the label
    });
    expect(res.status).toBe(201);
    const event = (await json(res)).data.event;
    expect(event.id).toMatch(/^sev_[0-9a-f]{32}$/);
    expect(event.loggedVia).toBe("qr");
    expect(event.leakOz).toBe(64);
    expect(event.fullChargeOz).toBe(640);

    const again = (await json(await get(w, `/v1/qr/${apl.qrToken}`, TECH))).data;
    expect(again.events.map((e: any) => e.id)).toEqual([event.id]);
    expect(again.appliance.lastServiceDate).toBe("2026-05-30");

    expect((await send(w, `/v1/qr/${apl.qrToken}/events`, VIEWER, { serviceDate: "2026-05-30", kind: "service", technicianName: "V" })).status).toBe(404);
    expect((await send(w, `/v1/qr/${apl.qrToken}/events`, STRANGER, { serviceDate: "2026-05-30", kind: "service", technicianName: "S" })).status).toBe(404);
  });

  it("a rotated label kills the old token at once", async () => {
    const w = world(ORG_UUID);
    const site = await createSite(w);
    const apl = await createAppliance(w, site.id);
    const rotated = await json(await send(w, `/v1/organizations/${ORG}/appliances/${apl.id}/qr-token`, OWNER, {}));
    const token = rotated.data.appliance.qrToken as string;
    expect(token).not.toBe(apl.qrToken);
    expect(rotated.data.appliance.qrTokenRotatedAt).not.toBeNull();
    expect((await get(w, `/v1/qr/${apl.qrToken}`, TECH)).status).toBe(404);
    expect((await get(w, `/v1/qr/${token}`, TECH)).status).toBe(200);
    expect(auditTypes(w)).toContain("leak.appliance.qr_rotated");
  });
});

describe("the service log", () => {
  it("logs events, lists them newest first, and snapshots the full charge", async () => {
    const w = world(ORG_UUID);
    const site = await createSite(w);
    const apl = await createAppliance(w, site.id);

    expect((await logEvent(w, apl.id, { serviceDate: "2026-03-01", addedOz: 32 })).status).toBe(201);
    expect((await logEvent(w, apl.id, { serviceDate: "2026-05-30", addedOz: 64 })).status).toBe(201);
    expect(
      (await logEvent(w, apl.id, { serviceDate: "2026-04-01", kind: "repair", recoveredOz: 600, workPerformed: "Evacuated, replaced TXV" })).status,
    ).toBe(201);

    const list = await json(await get(w, `/v1/organizations/${ORG}/appliances/${apl.id}/events`, VIEWER));
    expect(list.data.events.map((e: any) => e.serviceDate)).toEqual(["2026-05-30", "2026-04-01", "2026-03-01"]);
    expect(list.meta.cursor).toBeNull();

    const page = await json(await get(w, `/v1/organizations/${ORG}/appliances/${apl.id}`, VIEWER));
    expect(page.data.appliance.lastServiceDate).toBe("2026-05-30");
    expect(page.data.site.id).toBe(site.id);
    expect(page.data.events).toHaveLength(3);
    expect(auditTypes(w).filter((t) => t === "leak.event.logged")).toHaveLength(3);
  });

  it("validates quantities, dates and verification results", async () => {
    const w = world(ORG_UUID);
    const site = await createSite(w);
    const apl = await createAppliance(w, site.id);

    const over = await logEvent(w, apl.id, { addedOz: 80, returnedOz: 96 });
    expect(over.status).toBe(422);
    expect(Object.keys((await json(over)).error.details.fields)).toEqual(["returnedOz"]);

    const fractional = await logEvent(w, apl.id, { addedOz: 1.5, recoveredOz: -1 });
    expect(Object.keys((await json(fractional)).error.details.fields).sort()).toEqual(["addedOz", "recoveredOz"]);

    const verification = await logEvent(w, apl.id, { kind: "verification_initial" });
    expect((await json(verification)).error.details.fields.verificationPassed).toEqual(["Required for a verification test"]);

    const stray = await logEvent(w, apl.id, { kind: "service", verificationPassed: true });
    expect((await json(stray)).error.details.fields.verificationPassed).toEqual(["Only for a verification test"]);

    const future = await logEvent(w, apl.id, { serviceDate: "2999-01-01" });
    expect(Object.keys((await json(future)).error.details.fields)).toEqual(["serviceDate"]);

    const beforeInstall = await logEvent(w, apl.id, { serviceDate: "2024-04-30" });
    expect((await json(beforeInstall)).error.details.fields.serviceDate[0]).toContain("2024-05-01");

    const badDate = await logEvent(w, apl.id, { serviceDate: "2026-02-30" });
    expect(badDate.status).toBe(422);

    const passed = await logEvent(w, apl.id, { kind: "verification_followup", verificationPassed: true });
    expect(passed.status).toBe(201);
    expect((await json(passed)).data.event.verificationPassed).toBe(true);
  });

  it("voids with a reason, once, and keeps the row", async () => {
    const w = world(ORG_UUID);
    const site = await createSite(w);
    const apl = await createAppliance(w, site.id);
    const event = (await json(await logEvent(w, apl.id, { addedOz: 64 }))).data.event;
    const path = `/v1/organizations/${ORG}/appliances/${apl.id}/events/${event.id}/void`;

    expect((await send(w, path, TECH, {})).status).toBe(422);
    expect((await send(w, path, STRANGER, { reason: "typo" })).status).toBe(404);

    const voided = await json(await send(w, path, TECH, { reason: "Logged against the wrong unit" }));
    expect(voided.data.event.voided).toBe(true);
    expect(voided.data.event.voidReason).toBe("Logged against the wrong unit");
    expect((await send(w, path, TECH, { reason: "again" })).status).toBe(409);

    const list = await json(await get(w, `/v1/organizations/${ORG}/appliances/${apl.id}/events`, VIEWER));
    expect(list.data.events).toHaveLength(1); // voided, not deleted
    const page = await json(await get(w, `/v1/organizations/${ORG}/appliances/${apl.id}`, VIEWER));
    expect(page.data.appliance.lastServiceDate).toBeNull(); // a voided visit is not the last service
    expect(auditTypes(w)).toContain("leak.event.voided");
  });

  it("mothball, return to service and retirement move the appliance's status", async () => {
    const w = world(ORG_UUID);
    const site = await createSite(w);
    const apl = await createAppliance(w, site.id);
    const status = async (): Promise<string> =>
      (await json(await get(w, `/v1/organizations/${ORG}/appliances/${apl.id}`, VIEWER))).data.appliance.status;

    await logEvent(w, apl.id, { serviceDate: "2026-01-10", kind: "mothball", recoveredOz: 620 });
    expect(await status()).toBe("mothballed");
    await logEvent(w, apl.id, { serviceDate: "2026-02-10", kind: "service", addedOz: 640, returnedOz: 620 });
    expect(await status()).toBe("active"); // 84.106(d)(3): time resumes when refrigerant is added
    await logEvent(w, apl.id, { serviceDate: "2026-03-10", kind: "retirement", recoveredOz: 630 });
    expect(await status()).toBe("retired");

    const refused = await logEvent(w, apl.id, { serviceDate: "2026-03-11" });
    expect(refused.status).toBe(409);
    const site2 = (await json(await get(w, `/v1/organizations/${ORG}/sites/${site.id}`, VIEWER))).data.site;
    expect(site2.applianceCount).toBe(0); // retired appliances are not counted
  });

  it("pages 50 at a time with an opaque cursor", async () => {
    const w = world(ORG_UUID);
    const site = await createSite(w);
    const apl = await createAppliance(w, site.id);
    for (let i = 0; i < 55; i++) {
      const day = String((i % 28) + 1).padStart(2, "0");
      const month = i < 28 ? "01" : "02";
      expect((await logEvent(w, apl.id, { serviceDate: `2026-${month}-${day}`, kind: "leak_inspection" })).status).toBe(201);
    }
    const first = await json(await get(w, `/v1/organizations/${ORG}/appliances/${apl.id}/events`, TECH));
    expect(first.data.events).toHaveLength(50);
    expect(first.meta.cursor).toEqual(expect.any(String));
    const second = await json(
      await get(w, `/v1/organizations/${ORG}/appliances/${apl.id}/events?cursor=${first.meta.cursor}`, TECH),
    );
    expect(second.data.events).toHaveLength(5);
    expect(second.meta.cursor).toBeNull();
    const ids = new Set([...first.data.events, ...second.data.events].map((e: any) => e.id));
    expect(ids.size).toBe(55);
    expect((await get(w, `/v1/organizations/${ORG}/appliances/${apl.id}/events?cursor=%%%`, TECH)).status).toBe(422);
  });
});

describe("authorization", () => {
  it("a viewer reads but cannot write; a stranger and another org's path see nothing", async () => {
    const w = world(ORG_UUID);
    const site = await createSite(w);
    const apl = await createAppliance(w, site.id);

    expect((await get(w, `/v1/organizations/${ORG}/appliances/${apl.id}`, VIEWER)).status).toBe(200);
    expect((await logEvent(w, apl.id, {}, VIEWER)).status).toBe(404);
    expect((await send(w, `/v1/organizations/${ORG}/sites`, VIEWER, { name: "x" })).status).toBe(422); // validated first
    expect(
      (
        await send(w, `/v1/organizations/${ORG}/sites`, VIEWER, {
          name: "X", customerName: "Y", addressLine1: "Z", city: "C",
        })
      ).status,
    ).toBe(404);

    expect((await get(w, `/v1/organizations/${ORG}/sites/${site.id}`, STRANGER)).status).toBe(404);
    expect((await get(w, `/v1/organizations/${ORG}/appliances/${apl.id}`, STRANGER)).status).toBe(404);
    // OWNER is not a member of OTHER_ORG, and the site is not in it either.
    expect((await get(w, `/v1/organizations/${OTHER_ORG}/sites/${site.id}`, OWNER)).status).toBe(404);
  });

  it("answers 401 without an actor and 404 for a malformed id", async () => {
    const w = world(ORG_UUID);
    expect((await call(w, `/v1/organizations/${ORG}/sites`)).status).toBe(401);
    expect((await get(w, `/v1/organizations/${ORG}/sites/grt_123`, OWNER)).status).toBe(404);
    expect((await call(w, `/v1/organizations/${ORG}/sites`, { method: "DELETE", headers: as(OWNER) })).status).toBe(405);
    const health = await json(await call(w, "/health"));
    expect(health.data.service).toBe("leak-worker");
  });
});
