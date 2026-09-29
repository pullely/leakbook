# leakbook-refrigerant-log (LB) — Implementation status

As-built ≠ intent. This file records what actually shipped, and every place
the code departed from `design.md`.

| Milestone | State | PR |
|---|---|---|
| LB0 — the spec | ✅ Landed; `orun spec push` @7383fcf6 | #9 |
| LB1 — the phone-first log | ✅ Landed; deploy run 35893919231 fully green (attempt 3, 66/66); stage smoke 33/33, prod 401s | #10 |
| LB2 — the leak-rate engine | ✅ Landed; deploy run 36619373153 fully green (24/24, first attempt); stage smoke 18/18 (W1 → 4056 bp exceeds, W3 → 2000 bp does not, 409, 422) | #11 |
| LB3 — the repair clock, reminders and the PDF | ✅ Landed. Deploy runs 36622072596 (34/34) and 36623957173 (8/8, the admin-recipient fix) fully green; stage smoke all green; the cron `0 14 * * *` is registered on stage and prod | #12, #13 |
| Hardening + shipped record | identity-worker's public hostname closed (trap 37) | (this PR) |

## Departures from the design

### LB1 — a token-addressed write lane for the phone page

The design listed `GET /v1/qr/{token}` only. LB1 also ships
`POST /v1/qr/{token}/events`, so the phone page can log a visit without first
learning the organization and appliance ids. It is authorized exactly like the
read: `leak.write` on the token's own organization. Its events are stamped
`loggedVia: "qr"` whatever the body says. Design §3.3 lists it.

### LB1 — appliance status follows the log

A `mothball` event mothballs the appliance. A `retirement` event retires it,
and a retired appliance refuses further events (409). Refrigerant added to a
mothballed appliance returns it to service (84.106(d)(3)). The design implied
this; LB1 makes it explicit and tests it.

### LB2 — the preview reads a compact history the API returns

The design says the console's live preview runs the same module as the
server. To do that without a second round trip, `GET …/appliances/{apl}` and
`GET /v1/qr/{token}` also return `rateHistory`: the appliance's non-voided
events from the last 400 days, in log order (the arithmetic never reaches
further back than 365 days). The preview is advisory; the rate stored on
save is the record, and the form shows it once the server answers.

### LB2 — what the server reads, and when a method is locked

- `POST …/events` reads the appliance's events from `service_date − 366 days`
  up to the new event's date, in log order. Nothing older can change the
  answer: `d` is capped at 365, and the rolling window and held balance are
  both 365 days. An event dated before later rows is computed from the rows up
  to its own date.
- The held balance (§2.2) counts the same event's own `recoveredOz`, so an
  evacuate, repair and recharge visit can be logged as one row. The 422 names
  the ounces still held and the excess to log as added.
- The site's method is locked by a **non-voided** calculated rate (the
  partial index `idx_leak_events_site_rated`). A site whose only rate was
  voided as a mistake can still change its method.
- `GET …/leak-rate` returns the chronic flag for this calendar year and the
  last one, because the 84.106(j) report for a year is due by 1 March of the
  next.
- `210_leak_rates` backfills `leak_oz` for LB1's rows. Their rate columns stay
  null, because they were never computed at insert, and history is not
  rewritten.
- The rate columns also carry `CHECK`s: `rate_days` 1…365, `leak_rate_bp ≥ 0`,
  and `regime`/`rate_method` in their enums.

### LB3 — the clock's readings of 84.106(d)–(e)

- **A shutdown means 120 days, not 30 + 120.** Design §1.5 wrote "+120 if
  shutdown_required". 84.106(d)(1) gives 120 days *instead of* 30 when an
  industrial process shutdown is needed, so `repair_due_on = opened_on + 120`.
  Only an `industrial_process_refrigeration` appliance can set it (`PATCH
  …/repair-clocks/{rpc}`, 422 otherwise).
- **The follow-up gets the same ladder.** After a passing initial
  verification, the clock counts down to `followup_due_on` (+10 days). The
  same 14 / 7 / 3 / 1 / 0 rungs and the overdue escalation apply to it, keyed
  `followup-N` and `overdue-followup`.
- **Only a follow-up after a passing initial test closes the clock.** A
  failed test changes nothing. A retirement also closes the clock
  (`closed_reason = 'retired'`).
- **One rung per tick, the most urgent one reached.** A clock opened late,
  for example 2 days before its deadline, sends the 3-day rung once. It does
  not send the 14-, 7- and 3-day rungs together.
- **Claim, send, and give the claim back on failure.** Each rung is claimed
  with `INSERT … ON CONFLICT DO NOTHING RETURNING` before the send, as
  designed. When the enqueue fails, the claim row is deleted so that the next
  tick retries the rung, and the notification idempotency key
  (`leak.clock:<rpc>:<rung>:<recipient>`) keeps a retry from sending twice.
- **Recipients.** "The org's admins" are active members with the `owner` or
  `admin` role (at most 10). The escalation goes to the site's
  `owner_contact_email` only, and is skipped when none is on file.
- **The "opened" email goes out in the logging request**, best-effort, and
  the daily sweep sends it if that attempt did not land. Opening the clock is
  also best-effort after the event insert, because D1 has no transaction
  across the two. If it fails, a warning is logged and the event keeps
  `exceeds_threshold = 1` without a clock. See risk LB-L.

### LB3 — surfaces the design did not list

- `POST /v1/organizations/{org}/repair-clocks/sweep` (`leak.write`) runs
  today's pass for one organization now, as "Send due reminders now" on the
  Repair clocks page. It is idempotent by the same claims, and it is how
  stage verifies the ladder without waiting for 14:00 UTC.
- `POST …/events` returns `repairClock` (the clock after the event).
  `GET …/appliances/{apl}` and `GET /v1/qr/{token}` return the running
  clock, for the banner.
- Extra audit types: `leak.clock.suspended`, `leak.clock.resumed` and
  `leak.clock.updated` (the design listed opened/verified/closed/overdue).
- Export keys use public ids: `orgs/org_…/exports/exp_….pdf`. R2 is also
  handed the SHA-256 on `put`, so it verifies the bytes it stores.
- The CSV is streamed one appliance at a time. A cell that starts with
  `= + - @` gets a leading `'`, so a spreadsheet does not run it as a formula.

### LB3 — the admins' addresses (fixed in #13)

The LB3 stage smoke found the sweep reaching only the site's owner contact.
On D1, membership stores the subject as the public id `usr_<32 hex>`, while
`identity_users.id` is the UUID, so the join to the admins' email addresses
matched nothing. The LB3 tests had seeded UUIDs on both sides. #13 matches
both forms, and the test seed now stores `usr_` subjects as D1 does.

### What was verified live

- **Stage (LB2):** W1 returns `leakRateBp 4056`, `thresholdPct 20`,
  `exceedsThreshold true` (d = 90). W3 returns 2000 bp and `false`. A method
  change after a rate is 409. Returning more than is held is 422.
- **Stage (LB3):** W1's addition opens a clock due 2026-06-29. Two sweeps on
  one day: the first sends the overdue notice to the owner, the escalation to
  the site contact and a 14-day rung for a second clock, and the second
  sends nothing. `leak_reminders` has one row per rung and recipient, each
  with its notification id. Passing initial and follow-up verifications close
  the clock. A PDF round-trips through R2 with its SHA-256 in
  `x-content-sha256`, and the CSV lists every event.
- **Prod:** `/health` 200, and every LB2/LB3 route answers 401
  unauthenticated. Nobody can sign in to prod until a sending domain exists
  (LB-H), so nothing authenticated was run there.
- **Cloudflare:** the schedules API shows `0 14 * * *` on
  `leakbook-leak-worker-stage` and `-prod`. The buckets
  `stg-leakbook-exports-stage` and `prod-leakbook-exports-prod` exist.

## Departures from the baseline

- **identity-worker's public hostname is closed** (`"workers_dev": false` on
  stage and prod, runbook trap 37). The cirrus template left it on, and some
  of its routes trust that api-edge already authenticated the caller.
- **Found, not changed: the D1 database names are swapped.** Every stage
  worker binds the database named `prod-leakbook-prod`, and every prod worker
  binds `stg-leakbook-stage`, db-migrate included. The two environments' data
  are still isolated from each other. Only the names mislead, so anyone
  querying D1 by name must use the other one. This is baseline wiring and is
  left for the owner.

- **The trap-16 D1 fix** (`factory/patches/cirrus-d1-fix.patch`, first landed
  in chaseid) is applied in LB1. The baseline's `appendEventWithAudit` and
  membership organization-create / invitation-accept were Postgres-only SQL
  that D1 cannot run, so organization create answered 503. The patch also
  brings the SQLite schema test harness to `tests/db`.
- **Every worker's `component.yaml`** carries an `orun: redeploy LB1` marker
  (trap 17): `packages/db`, `packages/policy-engine` and `packages/contracts`
  changed, and a worker only redeploys when its own `component.yaml` changes.
- **Solo profile off** (api-edge, identity-worker, membership-worker, console):
  a contractor has several technicians in one organization.
- **`tests/db/src/integrations-migration.test.ts`** pinned the integrations
  migrations to the tail of the manifest. `200_leak_core` is the next
  migration, so the pin now asserts adjacency and order instead.
