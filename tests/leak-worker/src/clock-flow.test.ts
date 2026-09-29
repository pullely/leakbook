/* eslint-disable @typescript-eslint/no-explicit-any -- test payloads are asserted field by field */
// LB3 end to end over real SQLite: the repair clock opened by an exceedance,
// carried by verification tests, suspended while mothballed; the daily sweep's
// rungs claimed exactly once across ticks; the overdue escalation; and the PDF
// and CSV exports (R2 is an in-memory fake).
import { createHash } from "node:crypto";
import { route } from "@leak-worker/router";
import { orgPublicId } from "@leak-worker/ids";
import { clockDeps, openDb } from "@leak-worker/context";
import { runClockSweep } from "@leak-worker/clock";
import { OWNER, TECH, VIEWER, as, json, world, type TestWorld } from "./harness";

const ORG_UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG = orgPublicId(ORG_UUID);
const BASE = "https://leak.internal";
const OWNER_EMAIL = "owner@contractor.example";
const TECH_EMAIL = "tech@contractor.example";
const SITE_CONTACT = "rosa@rosasmarket.example";

interface Sent {
  templateKey: string;
  to: string;
  idempotencyKey: string;
  data: Record<string, unknown>;
}

function fakeNotifications(sent: Sent[]): Fetcher {
  return {
    async fetch(_url: string, init: RequestInit) {
      const body = JSON.parse(String(init.body)) as any;
      sent.push({
        templateKey: body.templateKey,
        to: body.recipient.address,
        idempotencyKey: body.idempotencyKey,
        data: body.templateData,
      });
      return Response.json({ data: { notification: { id: `ntf_${sent.length}` } } }, { status: 201 });
    },
  } as unknown as Fetcher;
}

function fakeR2(): { bucket: R2Bucket; objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>();
  const bucket = {
    async put(key: string, value: Uint8Array) {
      objects.set(key, new Uint8Array(value));
      return { key };
    },
    async get(key: string) {
      const bytes = objects.get(key);
      return bytes ? { body: new Blob([bytes]).stream() } : null;
    },
  };
  return { bucket: bucket as unknown as R2Bucket, objects };
}

function seedPeople(w: TestWorld): void {
  const person = (id: string, email: string, role: string) => {
    w.db.prepare("INSERT INTO identity_users (id, email, email_lower) VALUES (?, ?, ?)").run(id, email, email);
    w.db
      .prepare("INSERT INTO membership_organization_members (id, org_id, subject_id) VALUES (?, ?, ?)")
      .run(crypto.randomUUID(), ORG_UUID, id);
    w.db
      .prepare("INSERT INTO membership_role_assignments (id, org_id, subject_id, role) VALUES (?, ?, ?, ?)")
      .run(crypto.randomUUID(), ORG_UUID, id, role);
  };
  person(OWNER, OWNER_EMAIL, "owner");
  person(TECH, TECH_EMAIL, "builder");
}

function setupWorld(): { w: TestWorld; sent: Sent[]; objects: Map<string, Uint8Array> } {
  const w = world(ORG_UUID);
  const sent: Sent[] = [];
  const r2 = fakeR2();
  w.env.NOTIFICATIONS_WORKER = fakeNotifications(sent);
  w.env.EXPORTS = r2.bucket;
  seedPeople(w);
  return { w, sent, objects: r2.objects };
}

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
  category = "commercial_refrigeration",
): Promise<{ site: Record<string, any>; appliance: Record<string, any> }> {
  const siteRes = await send(w, `/v1/organizations/${ORG}/sites`, OWNER, {
    name: "Rosa's Market — Main St",
    customerName: "Rosa's Market LLC",
    addressLine1: "12 Main St",
    city: "Springfield",
    region: "IL",
    postalCode: "62701",
    ownerContactEmail: SITE_CONTACT,
  });
  const site = (await json(siteRes)).data.site;
  const aplRes = await send(w, `/v1/organizations/${ORG}/sites/${site.id}/appliances`, OWNER, {
    name: "Walk-in cooler",
    category,
    refrigerant: "R-404A",
    fullChargeOz: 640,
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
  return body.data;
}

/** W1: +64 on 2026-03-01, then +64 on 2026-05-30 → 40.56 %, a clock due 2026-06-29. */
async function openW1(w: TestWorld, applianceId: string): Promise<Record<string, any>> {
  await log(w, applianceId, "2026-03-01", 64);
  const logged = await log(w, applianceId, "2026-05-30", 64);
  expect(logged.event.exceedsThreshold).toBe(true);
  return logged.repairClock;
}

async function sweep(w: TestWorld, today: string) {
  const db = openDb(w.env)!;
  try {
    return await runClockSweep(clockDeps(w.env, db), today, `${today}T14:00:00.000Z`);
  } finally {
    await db.dispose();
  }
}

function reminderRows(w: TestWorld): { rung: string; sent_to: string }[] {
  return w.db.prepare("SELECT rung, sent_to FROM leak_reminders ORDER BY rung, sent_to").all() as any[];
}

function auditCount(w: TestWorld, type: string): number {
  return (w.db.prepare("SELECT COUNT(*) AS n FROM events_audit_entries WHERE event_type = ?").get(type) as any).n;
}

describe("LB3 — the repair clock", () => {
  it("W1 opens a clock due +30 days; a later exceedance joins it; initial then follow-up verification close it", async () => {
    const { w, sent } = setupWorld();
    const { appliance } = await setup(w);
    const clock = await openW1(w, appliance.id);
    expect(clock).toMatchObject({
      status: "open",
      openedOn: "2026-05-30",
      repairDueOn: "2026-06-29",
      leakRateBp: 4056,
      thresholdPct: 20,
      regime: "84.106",
    });
    expect(clock.id).toMatch(/^rpc_/);
    expect(auditCount(w, "leak.clock.opened")).toBe(1);
    // The "opened" email went to the admins (the owner), not the technician.
    expect(sent.map((s) => [s.templateKey, s.to])).toEqual([["leak.clock.opened", OWNER_EMAIL]]);

    const again = await log(w, appliance.id, "2026-06-01", 64);
    expect(again.event.exceedsThreshold).toBe(true);
    expect(again.repairClock).toMatchObject({ id: clock.id, repairDueOn: "2026-06-29" });

    const initial = await log(w, appliance.id, "2026-06-10", 0, { kind: "verification_initial", verificationPassed: true });
    expect(initial.repairClock).toMatchObject({ initialVerifiedOn: "2026-06-10", followupDueOn: "2026-06-20", status: "open" });
    const failed = await log(w, appliance.id, "2026-06-12", 0, { kind: "verification_followup", verificationPassed: false });
    expect(failed.repairClock.status).toBe("open");
    const followup = await log(w, appliance.id, "2026-06-15", 0, { kind: "verification_followup", verificationPassed: true });
    expect(followup.repairClock).toMatchObject({ status: "closed", closedOn: "2026-06-15", closedReason: "verified", deadline: null });

    const page = await json(await call(w, `/v1/organizations/${ORG}/appliances/${appliance.id}`, { headers: as(TECH) }));
    expect(page.data.repairClock).toBeNull();
    const closed = await json(await call(w, `/v1/organizations/${ORG}/repair-clocks?status=closed`, { headers: as(VIEWER) }));
    expect(closed.data.clocks).toHaveLength(1);
    expect(auditCount(w, "leak.clock.verified")).toBe(1);
    expect(auditCount(w, "leak.clock.closed")).toBe(1);
  });

  it("two sweeps on one day send each rung exactly once", async () => {
    const { w, sent } = setupWorld();
    const { appliance } = await setup(w);
    await openW1(w, appliance.id);
    sent.length = 0;

    const first = await sweep(w, "2026-06-20"); // 9 days left → the 14-day rung
    const second = await sweep(w, "2026-06-20");
    expect(first).toMatchObject({ clocks: 1, sent: 1 });
    expect(second).toMatchObject({ clocks: 1, sent: 0 });
    expect(sent.map((s) => [s.templateKey, s.to, s.data.daysLeft])).toEqual([["leak.clock.reminder", OWNER_EMAIL, 9]]);
    expect(sent[0]!.idempotencyKey).toMatch(/^leak\.clock:rpc_[0-9a-f]+:repair-14:owner@contractor\.example$/);

    await sweep(w, "2026-06-26"); // 3 days left
    await sweep(w, "2026-06-26");
    expect(reminderRows(w)).toEqual([
      { rung: "opened", sent_to: OWNER_EMAIL },
      { rung: "repair-14", sent_to: OWNER_EMAIL },
      { rung: "repair-3", sent_to: OWNER_EMAIL },
    ]);
  });

  it("an overdue clock is flagged once and escalates to the site's owner contact once", async () => {
    const { w, sent } = setupWorld();
    const { appliance } = await setup(w);
    await openW1(w, appliance.id);
    sent.length = 0;

    const first = await sweep(w, "2026-07-01");
    const second = await sweep(w, "2026-07-02");
    expect(first).toMatchObject({ overdue: 1, sent: 2 });
    expect(second).toMatchObject({ overdue: 0, sent: 0 });
    expect(sent.map((s) => [s.templateKey, s.to])).toEqual([
      ["leak.clock.overdue", OWNER_EMAIL],
      ["leak.clock.escalation", SITE_CONTACT],
    ]);
    expect(auditCount(w, "leak.clock.overdue")).toBe(1);
    const overdue = await json(await call(w, `/v1/organizations/${ORG}/repair-clocks`, { headers: as(TECH) }));
    expect(overdue.data.clocks[0]).toMatchObject({ status: "overdue", deadline: { kind: "repair", daysLeft: expect.any(Number) } });
  });

  it("a send that fails is given back and retried on the next tick", async () => {
    const { w, sent } = setupWorld();
    const { appliance } = await setup(w);
    await openW1(w, appliance.id);
    const working = w.env.NOTIFICATIONS_WORKER;
    w.env.NOTIFICATIONS_WORKER = { fetch: async () => new Response("no", { status: 503 }) } as unknown as Fetcher;
    expect(await sweep(w, "2026-06-20")).toMatchObject({ sent: 0, deferred: 1 });
    expect(reminderRows(w).map((r) => r.rung)).toEqual(["opened"]);
    w.env.NOTIFICATIONS_WORKER = working!;
    sent.length = 0;
    expect(await sweep(w, "2026-06-20")).toMatchObject({ sent: 1 });
  });

  it("a mothballed unit suspends the clock; refrigerant added resumes it with the days added", async () => {
    const { w } = setupWorld();
    const { appliance } = await setup(w);
    await openW1(w, appliance.id);
    const mothball = await log(w, appliance.id, "2026-06-01", 0, { kind: "mothball" });
    expect(mothball.repairClock).toMatchObject({ status: "suspended", deadline: null });
    expect((await sweep(w, "2026-07-05")).clocks).toBe(0);
    const resumed = await log(w, appliance.id, "2026-06-11", 16);
    expect(resumed.repairClock).toMatchObject({ status: "open", suspendedDays: 10, repairDueOn: "2026-07-09" });
  });

  it("a shutdown extends the deadline to 120 days, and only for industrial process refrigeration", async () => {
    const { w } = setupWorld();
    const commercial = await setup(w);
    const clock = await openW1(w, commercial.appliance.id);
    const refused = await send(w, `/v1/organizations/${ORG}/repair-clocks/${clock.id}`, OWNER, { shutdownRequired: true }, "PATCH");
    expect(refused.status).toBe(422);

    const { w: w2 } = setupWorld();
    const plant = await setup(w2, "industrial_process_refrigeration");
    await log(w2, plant.appliance.id, "2026-03-01", 64);
    const opened = (await log(w2, plant.appliance.id, "2026-04-15", 128)).repairClock;
    expect(opened.repairDueOn).toBe("2026-05-15");
    const patched = await send(w2, `/v1/organizations/${ORG}/repair-clocks/${opened.id}`, OWNER, { shutdownRequired: true, notes: "Compressor on order" }, "PATCH");
    expect(patched.status).toBe(200);
    expect((await json(patched)).data.clock).toMatchObject({ shutdownRequired: true, repairDueOn: "2026-08-13", status: "open" });
  });

  it("the sweep route runs one organization's pass and is closed to a viewer", async () => {
    const { w } = setupWorld();
    const { appliance } = await setup(w);
    await openW1(w, appliance.id);
    expect((await send(w, `/v1/organizations/${ORG}/repair-clocks/sweep`, VIEWER, {})).status).toBe(404);
    const res = await send(w, `/v1/organizations/${ORG}/repair-clocks/sweep`, OWNER, {});
    expect(res.status).toBe(200);
    expect((await json(res)).data.report).toMatchObject({ clocks: 1 });
  });
});

describe("LB3 — exports", () => {
  it("a site's PDF round-trips through R2 with its SHA-256", async () => {
    const { w, objects } = setupWorld();
    const { site, appliance } = await setup(w);
    await openW1(w, appliance.id);
    await log(w, appliance.id, "2026-06-02", 0, { kind: "repair", component: "=cmd|' /C calc'!A0", workPerformed: "Brazed the suction line" });

    const created = await send(w, `/v1/organizations/${ORG}/sites/${site.id}/exports`, OWNER, {});
    expect(created.status).toBe(201);
    const exp = (await json(created)).data.export;
    expect(exp.id).toMatch(/^exp_/);
    expect(objects.size).toBe(1);
    const [key] = [...objects.keys()];
    expect(key).toBe(`orgs/${ORG}/exports/${exp.id}.pdf`);

    const res = await call(w, `/v1/organizations/${ORG}/exports/${exp.id}`, { headers: as(VIEWER) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    const bytes = new Uint8Array(await res.arrayBuffer());
    const sha = createHash("sha256").update(bytes).digest("hex");
    expect(res.headers.get("x-content-sha256")).toBe(sha);
    expect(sha).toBe(exp.sha256);
    expect(bytes.byteLength).toBe(exp.sizeBytes);
    const text = new TextDecoder().decode(bytes);
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(text).toContain("(Walk-in cooler)");
    expect(text).toContain("leak rate 40.56 %");
    expect(auditCount(w, "leak.export.created")).toBe(1);

    // Another organization's member cannot read it.
    expect((await call(w, `/v1/organizations/${ORG}/exports/${exp.id}`, { headers: as("99999999-9999-4999-8999-999999999999") })).status).toBe(404);
  });

  it("the CSV streams every event at the site and defuses spreadsheet formulas", async () => {
    const { w } = setupWorld();
    const { site, appliance } = await setup(w);
    await openW1(w, appliance.id);
    await log(w, appliance.id, "2026-06-02", 0, { kind: "repair", component: "=cmd|' /C calc'!A0" });
    const res = await call(w, `/v1/organizations/${ORG}/sites/${site.id}/export.csv`, { headers: as(VIEWER) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    const lines = (await res.text()).trimEnd().split("\r\n");
    expect(lines[0]).toMatch(/^site,appliance,refrigerant,full_charge_oz,service_date,kind/);
    expect(lines).toHaveLength(4);
    expect(lines[2]).toContain(",40.56,20,true,84.106,");
    expect(lines[3]).toContain(`'=cmd|' /C calc'!A0`);
  });
});
