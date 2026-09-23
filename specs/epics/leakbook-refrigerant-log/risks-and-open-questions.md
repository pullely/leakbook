# leakbook-refrigerant-log — risks and open questions

Each entry is a letter, a title, and a state: **RISK** (open, with a
mitigation), **RESOLVED** (decided; say what and why), **ACCEPTED** (a cost we
carry knowingly), **SETTLED** (decided for now; revisit on a stated cadence).

## LB-A — The baseline's audited writes do not run on D1 (RESOLVED)

The cirrus baseline ships Postgres-only SQL: `appendEventWithAudit` is a
data-modifying CTE, and membership's organization-create and
invitation-accept have the same class of bug, so on D1 **no customer can
create an organization** (503). Found portfolio-wide (runbook trap 16).
Resolved in LB1 by applying the tested `cirrus-d1-fix.patch` (landed first in
chaseid) and touching the `component.yaml` of every worker that bundles
`packages/db` so they redeploy (trap 17). leak-worker's own audit writer uses
the portable `appendEvent` + `INSERT … SELECT` path and does not depend on the
patched method. Recorded as a departure from the baseline in
`IMPLEMENTATION-STATUS.md`.

## LB-B — SMS alerts need a provider credential (RISK, open)

The pitch lists "optional SMS" and "email/SMS alerts". No SMS provider
credential (Twilio or other) exists for this workspace, and none may be
invented. Email carries every reminder in LB3. Mitigation: the reminder
ladder is channel-agnostic (a rung row per recipient and channel), so SMS is
a later milestone that adds a channel, not a redesign. Owner's decision:
which provider, who pays.

## LB-C — Interpretive choices in the leak-rate arithmetic (RISK, needs the EPA 608 advisor)

The formula is the regulation's (design §2) and is not a judgement call.
Four application choices are, and each is conservative or literal:
1. **The 365-day substitution** (84.106(b)(1)) is applied only when no
   earlier addition is on record or the earlier ones predate 2026 — an
   appliance installed in 2026 uses its actual days since the installation
   charge (shorter, so a higher, more conservative rate).
2. **Returned refrigerant** (recovered from the same appliance, held,
   recharged) is subtracted from the addition; a seasonal addition larger than
   the seasonal removal counts the excess as a leak rather than disqualifying
   the whole addition from the seasonal-variance exception.
3. **Threshold comparison** is strictly greater ("over the applicable leak
   rate"); the chronic flag is `≥ 125 %` ("125 percent or more").
4. **A day is the technician's stated calendar day**, not a UTC instant.
Mitigation: every choice is one named function with a worked-example test,
so the advisor's answer is a one-line change plus a test. The pitch is
already looking for an EPA 608-certified technician advisor; these four
questions are the first agenda.

## LB-D — The technician's phone and sign-in (SETTLED)

A scanned label opens a web page, not an app. The first scan on a device
needs a magic-link sign-in (email round-trip); the session then persists on
the device. Acceptable for "under 90 seconds per logged visit" after the
first visit. A shared "truck login" is not offered: the record must name the
person who did the work (84.106(l)(2)(v)). Revisit if field feedback says
the first sign-in is the drop-off point.

## LB-E — Multiple additions for one leak on different days (RISK, open)

The annualizing method's Step 1 counts "multiple additions related to same
leak" as one. LB2 merges additions on the same `service_date` only. A
technician who returns the next day to finish charging produces two
calculations, the second with `d = 1` and a very high rate — conservative
(it can only over-report). Mitigation: a later "continues the previous
addition" flag on the event; until then the log shows both and the office
can void and re-log as one.

## LB-F — The D1 executor's `rowCount` after a write (RESOLVED)

The D1 executor reports `rowCount = rows.length`, so an `UPDATE`/`INSERT`/
`DELETE` without `RETURNING` always reports 0 (runbook trap 22). Every
leak-worker write the code branches on uses `RETURNING`; `tests/leak-worker`
pins it on real `node:sqlite`.

## LB-G — Email is advisory; the record is D1 (ACCEPTED)

A reminder that fails to send does not fail the write that caused it, and a
repair clock's state is never inferred from email. The console and the export
are the record; email is a nudge. The cost: a silent send failure is visible
only in the notifications log.

## LB-H — Prod sign-in needs a sending domain (ACCEPTED)

`leakbook.app` is not held, so prod cannot send magic-link email and nobody
can sign in to prod (runbook trap 27). Stage works with `DEBUG_DELIVERY=true`,
which hands the link back in the response; prod keeps it `false`. Real use
needs the domain and a verified sending setup — the owner's decision.

## LB-I — Mint budget for CI (ACCEPTED)

200 brokered-credential mints per workspace per rolling 24 hours; the
bootstrap alone uses about 72. LB2 and LB3 land on day 2. On
`broker: limit_reached` the run is recorded and rerun after the oldest mints
age out, never retried in a loop.

## LB-J — The QR token is a bearer of location, not of access (SETTLED)

A label photographed in a store reveals a 160-bit token and nothing else;
resolving it needs a signed-in member of the owning organization, and a
stranger gets the same 404 as a nonexistent token. Rotation invalidates a
label at once. Revisit if the owner portal (brief M3) wants unauthenticated
read-only labels for inspectors — that would be a separate, scoped,
expiring token, not this one.

## LB-K — Refrigerant classification table (RISK, mitigated)

Applicability depends on the refrigerant's class (HFC / ODS / ODS+HFC blend /
low-GWP). The built-in table covers the common designations; anything else
must be classified by the office when the appliance is created (422 without
it). A wrong class on a record means a wrong regime. Mitigation: the class is
shown beside the refrigerant everywhere, and a class change is audited with
old and new values.
