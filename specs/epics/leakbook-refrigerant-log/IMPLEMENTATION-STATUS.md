# leakbook-refrigerant-log (LB) — Implementation status

As-built ≠ intent. This file records what actually shipped, and every place
the code departed from `design.md`.

| Milestone | State | PR |
|---|---|---|
| LB0 — the spec | ✅ Landed; `orun spec push` @7383fcf6 | #9 |
| LB1 — the phone-first log | In review | (this PR) |
| LB2 — the leak-rate engine | | |
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
