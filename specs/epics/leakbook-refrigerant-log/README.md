# Epic: leakbook-refrigerant-log (LB)

**The EPA's HFC leak-repair rule (40 CFR 84.106, in force since 1 January 2026)
pulled every commercial refrigeration and air-conditioning appliance holding 15
lb or more of HFC refrigerant into a regime that used to start at 50 lb: the
owner must calculate a leak rate every time refrigerant is added, and an
appliance over its threshold must be repaired and verified within 30 days.
The small contractors who service independent grocers and restaurants keep
that record on paper, and the arithmetic — pounds added over full charge,
annualised over the days since the last addition — is done in someone's head
on a roof, if at all. This epic makes the appliance the unit of record: every
unit carries a QR label that opens a phone form with no app to install, every
service visit is a dated row with the pounds added and recovered, the leak
rate is computed by the server from those rows exactly as the regulation
defines it, and an appliance over its threshold starts a 30-day repair clock
that reminds, escalates, and exports an inspection-ready PDF. The one design
idea: refrigerant quantities are integer ounces and the leak rate is a
rational number compared to its threshold by cross-multiplication, so "over
the threshold" is an exact fact of the log, never a rounded float or a
technician's memory.**

Leakbook is for small commercial HVAC/R contractors (one to ten technicians)
and the independent grocers and restaurants they service. A contractor is a
cirrus organization, and its technicians and office staff are members. The
office records each customer site and its appliances (refrigerant, full
charge, category), prints a QR label for each unit, and sticks it on the
cabinet. A technician on site scans the label, signs in once by magic link,
and logs the visit in under 90 seconds: what was done, how much refrigerant
went in, how much came out. From LB2 the log answers the compliance question
on the spot — this addition puts the walk-in at 40.6 % a year against a 20 %
threshold — and from LB3 the repair clock carries the appliance to a verified
repair, with the record exportable for an inspector.

## Status

| Field | Value |
|-------|-------|
| Status | In progress — LB0 landed (#9); LB1 in review |
| Cluster | **LB** (LB0–LB3) |
| Owner(s) | `apps/leak-worker` (sites, appliances, QR labels, the service log, the leak-rate engine, the repair clock and its cron, PDF export) · `apps/api-edge` (the facade) · `packages/db` (migrations `200`–`220`, bounded context `leak`) · `packages/contracts` + `packages/sdk` (the wire) · `infra/terraform/cloudflare-r2` (the export bucket, LB3) · `apps/notifications-worker` (the reminder templates, LB3) · `apps/web-console-next` (the register and the phone pages) |
| Builds on | `cirrus baseline-v12` — organizations as contractors, members as technicians and office staff, the policy engine for who may edit, magic-link sign-in for the phone pages, `notifications-worker` for email, the audit trail in `events-worker`, api-edge rate limiting |
| Changes | Adds one bounded context (`leak`), one worker, one R2 bucket per environment (LB3) and one cron trigger (LB3); turns the Solo profile off (several technicians per contractor); every baseline context is reused, none is modified beyond new actions, templates and subject prefixes |
| Decisions locked | (1) A contractor is a cirrus organization; a customer site is a `leak_sites` row inside it, not a second tenancy axis. (2) Refrigerant quantities are integer ounces; the leak rate is computed from the service-event rows by the server, never typed, and compared to its threshold exactly (design §2). (3) The applicable regime and threshold come from the appliance's refrigerant class, full charge and category, per 40 CFR 84.106(a) and (c)(2) (and 82.157 for ODS-only appliances ≥ 50 lb). (4) A QR label carries an unguessable token, not an id; resolving it requires a signed-in member of the owning organization. (5) The repair clock is a row created when an addition exceeds the threshold; its 30-day deadline is `addition date + 30` (120 with an industrial-process shutdown) and every reminder rung is claimed with `INSERT … RETURNING` before it is sent. |
| Gate | LB1 is the first user-visible change (the register and the phone log). LB2 is the compliance answer. LB3 is what makes a missed repair hard to miss, and the export an inspector reads. |
| Shipped as | |

## Read order

1. `design.md` — the resource, the leak-rate arithmetic and the rule it implements, the routes, the surfaces, what is out of scope
2. `implementation-plan.md` — the milestones and what "done" means for each
3. `risks-and-open-questions.md` — what could go wrong and what was decided
4. `IMPLEMENTATION-STATUS.md` — what actually shipped (kept distinct from intent)

## Milestones at a glance

| Milestone | What it lands | Done when |
|---|---|---|
| LB0 — the spec | this doc set | merged and pushed with `orun spec push` |
| LB1 — the phone-first log | `200_leak_core`, `leak-worker` (sites, appliances, QR tokens, service events, audit), policy `leak.read`/`leak.write`, console register + QR labels + the `/q/{token}` phone page, Solo off, trap-16 D1 patch | on stage: org create 201, a site, an appliance, its QR token resolves for a member and 404s for a stranger, a service event logged from the phone page is listed on the appliance |
| LB2 — the leak-rate engine | `210_leak_rates`, the pure leak-rate module (annualizing + rolling-average), applicability and thresholds, the rate stored on each addition, the site's method choice, chronic-leaker flag | every worked example in design §2.7 is a passing test; on stage an addition returns its rate, threshold and `exceedsThreshold` |
| LB3 — the repair clock, reminders and the PDF | `220_leak_repair_clocks`, clocks opened by an exceedance, verification tests, daily cron reminder ladder (email) escalating to the site's owner contact, PDF (and CSV) export stored in R2 | a 20 %+ addition opens a clock due +30 days; each rung sends once across two ticks; a follow-up verification closes it; the PDF round-trips through R2 with its SHA-256 |
