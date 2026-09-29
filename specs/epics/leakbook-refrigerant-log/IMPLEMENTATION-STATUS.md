# leakbook-refrigerant-log (LB) — Implementation status

As-built ≠ intent. This file records what actually shipped, and every place
the code departed from `design.md`.

| Milestone | State | PR |
|---|---|---|
| LB0 — the spec | ✅ Landed; `orun spec push` @7383fcf6 | #9 |
| LB1 — the phone-first log | ✅ Landed; deploy run 35893919231 fully green (attempt 3, 66/66); stage smoke 33/33, prod 401s | #10 |
| LB2 — the leak-rate engine | In review | (this PR) |
| LB3 — the repair clock, reminders and the PDF | | |

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

## Departures from the baseline

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
