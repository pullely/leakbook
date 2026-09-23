import { createLeakRepository } from "@saas/db/leak";
import { createSqlExecutor } from "@saas/db/d1";
import { d1Over, migratedDatabase } from "./harness";

// Runbook trap 22: the D1 executor reports rowCount = rows.length, so a write
// without RETURNING always reports 0 on D1, whatever it changed. These run the
// real executor over a real SQLite engine — the combination a mocked executor
// hides — and pin that the leak repository decides "did my write happen?" from
// RETURNING rows, never from rowCount.

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NOW = "2026-09-23T10:00:00.000Z";

const SITE = {
  name: "Rosa's Market",
  customerName: "Rosa's Market LLC",
  addressLine1: "12 Main St",
  addressLine2: null,
  city: "Springfield",
  region: "IL",
  postalCode: "62701",
  country: "US",
  ownerContactName: null,
  ownerContactEmail: null,
  leakRateMethod: "annualizing",
  status: "active",
  notes: "",
};

const APPLIANCE = {
  name: "Walk-in",
  location: "",
  category: "commercial_refrigeration",
  refrigerant: "R-404A",
  refrigerantClass: "hfc",
  fullChargeOz: 640,
  fullChargeMethod: "manufacturer",
  fullChargeRangeLowOz: null,
  fullChargeRangeHighOz: null,
  installedOn: null,
  manufacturer: "",
  model: "",
  serialNumber: "",
  status: "active",
};

async function seed() {
  const db = migratedDatabase();
  const executor = createSqlExecutor(d1Over(db));
  const repo = createLeakRepository(executor);
  const site = await repo.createSite({ id: crypto.randomUUID(), orgId: ORG, ...SITE, createdBy: null, now: NOW });
  const appliance = await repo.createAppliance({
    id: crypto.randomUUID(),
    orgId: ORG,
    siteId: site.id,
    ...APPLIANCE,
    qrToken: "abcdefghijklmnopqrstuvwxyz234567",
    createdBy: null,
    now: NOW,
  });
  return { db, executor, repo, site, appliance };
}

describe("trap 22: rowCount after a write on D1", () => {
  it("is 0 for an UPDATE without RETURNING even though the row changed", async () => {
    const { executor, repo, site } = await seed();
    const bare = await executor.execute(`UPDATE leak_sites SET name = $2 WHERE id = $1`, [site.id, "Renamed"]);
    expect(bare.rowCount).toBe(0); // the trap: the row DID change
    expect((await repo.getSite(ORG, site.id))?.name).toBe("Renamed");

    const returning = await executor.execute(`UPDATE leak_sites SET name = $2 WHERE id = $1 RETURNING id`, [site.id, "Back"]);
    expect(returning.rowCount).toBe(1);
  });

  it("the repository's updates report their outcome through RETURNING, scoped by org", async () => {
    const { repo, site, appliance } = await seed();
    expect(await repo.updateSite(OTHER, site.id, SITE, NOW)).toBeNull();
    expect((await repo.updateSite(ORG, site.id, { ...SITE, status: "archived" }, NOW))?.status).toBe("archived");

    expect(await repo.updateAppliance(OTHER, appliance.id, APPLIANCE, NOW)).toBeNull();
    expect((await repo.updateAppliance(ORG, appliance.id, { ...APPLIANCE, status: "mothballed" }, NOW))?.status).toBe("mothballed");

    expect(await repo.rotateQrToken(OTHER, appliance.id, "b".repeat(32), NOW)).toBeNull();
    expect((await repo.rotateQrToken(ORG, appliance.id, "c".repeat(32), NOW))?.qrToken).toBe("c".repeat(32));
  });

  it("a void happens once: the second attempt changes nothing and says so", async () => {
    const { repo, site, appliance } = await seed();
    const event = await repo.createServiceEvent({
      id: crypto.randomUUID(),
      orgId: ORG,
      siteId: site.id,
      applianceId: appliance.id,
      serviceDate: "2026-05-30",
      kind: "service",
      technicianName: "Sam",
      component: "",
      workPerformed: "",
      addedOz: 64,
      recoveredOz: 0,
      returnedOz: 0,
      fullChargeOz: 640,
      verificationPassed: null,
      notes: "",
      loggedBy: null,
      loggedVia: "console",
      now: NOW,
    });
    expect(await repo.voidServiceEvent(OTHER, appliance.id, event.id, "x", null, NOW)).toBeNull();
    const first = await repo.voidServiceEvent(ORG, appliance.id, event.id, "wrong unit", null, NOW);
    expect(first?.voidReason).toBe("wrong unit");
    expect(await repo.voidServiceEvent(ORG, appliance.id, event.id, "again", null, NOW)).toBeNull();
    expect((await repo.getServiceEvent(ORG, appliance.id, event.id))?.voidReason).toBe("wrong unit");
  });

  it("the schema holds the record's invariants", async () => {
    const { db, site, appliance } = await seed();
    const insert = (cols: Record<string, unknown>) => {
      const row = {
        id: crypto.randomUUID(),
        org_id: ORG,
        site_id: site.id,
        appliance_id: appliance.id,
        service_date: "2026-05-30",
        kind: "service",
        technician_name: "Sam",
        full_charge_oz: 640,
        ...cols,
      };
      const keys = Object.keys(row);
      db.prepare(`INSERT INTO leak_service_events (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).run(
        ...(Object.values(row) as never[]),
      );
    };
    expect(() => insert({ added_oz: 10, returned_oz: 11 })).toThrow(); // returned ≤ added
    expect(() => insert({ added_oz: -1 })).toThrow();
    expect(() => insert({ kind: "verification_initial" })).toThrow(); // a verification needs its result
    expect(() => insert({ kind: "service", verification_passed: 1 })).toThrow();
    expect(() => insert({ voided_at: NOW })).toThrow(); // a void needs its reason
    expect(() => insert({ kind: "top_up" })).toThrow();
    expect(() => insert({ added_oz: 64 })).not.toThrow();
    expect(() =>
      db.prepare("UPDATE leak_appliances SET full_charge_method = 'range_midpoint' WHERE id = ?").run(appliance.id),
    ).toThrow(); // method 4 needs its range
    expect(() => db.prepare("UPDATE leak_appliances SET full_charge_oz = 0 WHERE id = ?").run(appliance.id)).toThrow();
  });
});
