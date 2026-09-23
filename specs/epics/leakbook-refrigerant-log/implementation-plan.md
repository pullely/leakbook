# leakbook-refrigerant-log — implementation plan

Milestones land in order. Each is one or more tasks, each task one pull
request, each pull request landed with `orun pr land`. A milestone is marked
✅ here when its "done when" list is true **and the deploy run of its last
merge on `main` is fully green** (runbook trap 25), and recorded in
`IMPLEMENTATION-STATUS.md`.

Budget: each workspace mints at most 200 brokered credentials per rolling 24
hours, and every CI job that reads a brokered Cloudflare secret spends one.
Day 1 is the bootstrap, LB0 and LB1; LB2 and LB3 land on day 2. Local tests
are green before every `orun pr open`.

## LB0 — the spec

This doc set, merged to `main` and attached to the epic with `orun spec push`.

**Done when**
- the five documents are on `main`
- `orun spec list --epic leakbook-refrigerant-log` shows them

## LB1 — the phone-first log

The register and the log, reachable from a QR label. Migration
`200_leak_core` (`leak_sites`, `leak_appliances`, `leak_service_events` —
design §1.1–1.3, the verification kinds included so LB3 never rebuilds the
table). A new worker `apps/leak-worker` (sites, appliances, QR tokens, the
service log, void, `GET /v1/qr/{token}`), its repository in
`packages/db/src/leak` (every write `RETURNING`, trap 22), wire types and the
refrigerant table in `packages/contracts/src/leak.ts`, an SDK `LeakClient`,
the api-edge facade + binding + a `leak` rate-limit family, policy actions
`leak.read` (every role) / `leak.write` (owner, admin, builder),
events-worker subject prefixes, `leak-worker` on the notifications
internal-actor allow-list (for LB3), and the console: Sites, Site, Appliance
(with the printable QR label) and the phone page `/q/{token}`. The Solo
profile is turned off (a contractor has several technicians).

Carried from the runbook: the trap-16 D1 patch
(`cirrus-d1-fix.patch` — `appendEventWithAudit`, membership org-create and
invitation-accept) so a customer can sign up at all; trap-17 `component.yaml`
markers on every worker that bundles a changed shared package; `db-migrate`
as a dependency of `leak-worker` (trap 21).

**Done when**
- `200_leak_core` is applied on stage and prod (the deploy run's `db-migrate` jobs green)
- `https://leakbook-leak-worker-…` is reachable only through api-edge; api-edge `/health` 200 on both
- on stage, scripted: magic-link sign-in → `POST /v1/organizations` **201** → a site → an appliance (R-404A, 640 oz) → `GET /v1/qr/{token}` returns it → a service event with +64 oz logged, listed newest first on the appliance → a void with a reason is audited
- a second user who is not a member gets **404** for the site, the appliance and the QR token
- on prod: `/health` 200, the new routes answer **401** unauthenticated
- `tests/leak-worker` passes on real `node:sqlite` (flow + the trap-22 `RETURNING` pins)

## LB2 — the leak-rate engine

The compliance answer. The pure module `packages/contracts/src/leak-rate.ts`
(design §2: applicability and thresholds, the annualizing and rolling-average
methods, same-day merging, the 2026 substitutions, the held balance for
returned refrigerant, exact integer comparison, rounding for display, the
chronic flag). Migration `210_leak_rates` adds the computed columns to
`leak_service_events`. `POST …/events` computes and stores the rate in the same
request and returns it; `leak.threshold.exceeded` is audited; the site's
method becomes changeable only until the first rate exists (409). Console: the
rate on every addition, the threshold line on the appliance, the live preview
on the phone form.

**Done when**
- every worked example W1–W23 in design §2.7 is a named passing test in `tests/contracts` (pure) and the W1/W6/W8/W18–W19 sequences also pass end-to-end in `tests/leak-worker` on real SQLite
- on stage: the W1 sequence returns `leakRateBp: 4056`, `thresholdPct: 20`, `exceedsThreshold: true`; the W3 sequence returns `false`
- a site with a calculated rate refuses a method change with 409

## LB3 — the repair clock, reminders and the PDF

What makes a missed repair hard to miss, and the record an inspector reads.
Migration `220_leak_repair_clocks` (design §1.5). An exceeding addition opens a
clock (`repair_due_on = service_date + 30`, +120 with a shutdown); a passing
`verification_initial` sets `followup_due_on = +10 days`; a passing
`verification_followup` closes it; a `mothball` suspends it. A daily cron in
leak-worker sends the ladder (14 / 7 / 3 / 1 / 0 days before `repair_due_on`)
to the org's admins, and on overdue escalates to the site's owner contact,
each rung claimed with `INSERT … ON CONFLICT DO NOTHING RETURNING`. The R2
bucket `leakbook-exports-<env>` (bound as `stg-…`/`prod-…`, trap 26) holds the
site's inspection PDF; a CSV streams without storage. Templates in
notifications-worker.

**Done when**
- on stage: the W1 addition opens a clock due 2026-06-29-equivalent (+30 days from its date); an initial and a follow-up verification close it
- two cron ticks on one day send each rung exactly once (`leak_reminders` has one row per rung and recipient)
- an overdue clock emails the site's owner contact once
- a PDF export round-trips through R2 with its SHA-256 (`x-content-sha256`)
- the deploy log shows the cron schedule on leak-worker

## Sequencing note

LB1 is the record; nothing else is meaningful without it, and it carries the
baseline's D1 fixes that every later write depends on. LB2 needs only LB1's
rows (it adds columns, never rebuilds a table). LB3 needs LB2's
`exceeds_threshold` to open a clock and adds the only new infrastructure (R2,
cron), so it goes last and carries the only new brokered secret. SMS, the
owner portal and cylinder tracking follow when their credentials and
decisions exist.
