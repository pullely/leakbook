# leakbook-refrigerant-log — design

Leakbook adds one bounded context, `leak`, owned by one new worker,
`apps/leak-worker`, reached only through `apps/api-edge` over a service
binding. Everything else is the cirrus baseline, reused as is: an
organization is a **contractor**, its members are technicians (`builder`) and
office staff (`admin`/`owner`), a customer's read-only person is a `viewer`,
the policy engine decides who may read and write, magic-link sign-in is how a
technician's phone gets a session, `notifications-worker` sends email (LB3),
and `events-worker` keeps the audit trail.

Every table is scoped by `org_id` and every query filters on it. Every write
that the code branches on uses `RETURNING` and counts the returned rows,
because the D1 executor reports `rowCount = rows.length` (runbook trap 22).

## 1. The resource

Ids are UUIDs in D1 and `<prefix>_<32 hex>` on the wire, the baseline's
convention (`org_…`, `usr_…`).

### 1.1 `leak_sites` (LB1) — `ste_`

A customer location the contractor services — "Rosa's Market, 12 Main St".
The regulation's "operating facility" (40 CFR 84.102, *Leak rate*: "the same
method must be used for all appliances … located at an operating facility"),
so the leak-rate method lives here.

```
leak_sites
  id                    text  pk
  org_id                text  the contractor (cirrus organization)
  name                  text  "Rosa's Market — Main St"
  customer_name         text  the owner or operator of the appliances (84.106(l)(1)(i))
  address_line1         text  required: the address where the appliances are (84.106(l)(1)(ii))
  address_line2         text  nullable
  city, region, postal_code, country   text  country defaults 'US'
  owner_contact_name    text  nullable — the customer's person
  owner_contact_email   text  nullable — LB3 escalates overdue repair clocks here
  leak_rate_method      text  'annualizing' | 'rolling_average', default 'annualizing' (§2.3)
  status                text  'active' | 'archived'
  notes                 text  default ''
  created_by            text  usr uuid
  created_at, updated_at text ISO-8601
```

### 1.2 `leak_appliances` (LB1) — `apl_`

One refrigerant circuit. The regulation's unit is the circuit, not the
cabinet: "For such devices with multiple circuits, each independent circuit is
considered a separate appliance" (84.102, *Refrigerant-containing appliance*),
so a rack with two independent circuits is two rows, named "Rack A — circuit 1"
and "… circuit 2".

```
leak_appliances
  id                      text  pk
  org_id                  text
  site_id                 text  → leak_sites.id
  name                    text  "Walk-in cooler"
  location                text  "back room", default ''
  category                text  'commercial_refrigeration' | 'industrial_process_refrigeration'
                                | 'comfort_cooling' | 'refrigerated_transport'
                                | 'residential_light_commercial_ac' | 'other'      (84.106(c)(2), (a)(3)(ii))
  refrigerant             text  ASHRAE designation, "R-404A"
  refrigerant_class       text  'hfc' | 'ods' | 'ods_hfc_blend' | 'low_gwp'       (§2.1)
  full_charge_oz          int   > 0 — integer ounces (16 oz = 1 lb)
  full_charge_method      text  'manufacturer' | 'calculation' | 'measurement' | 'range_midpoint'
                                (the four methods of 84.102, *Full charge*)
  full_charge_range_low_oz, full_charge_range_high_oz   int  required iff method = 'range_midpoint';
                                full_charge_oz must then equal their midpoint, rounded half up (84.106(l)(1)(iv))
  installed_on            text  YYYY-MM-DD, nullable (84.106(l)(1)(vi))
  manufacturer, model, serial_number   text  default ''
  status                  text  'active' | 'mothballed' | 'retired'
  qr_token                text  unique — 32 chars of base32 from 20 random bytes (§1.4)
  qr_token_rotated_at     text
  created_by, created_at, updated_at
```

A change to `full_charge_oz` is an audited `leak.appliance.updated` event whose
payload carries the old value, the new value and the method — the "revisions of
the full charge, how they were determined, and the dates" record of
84.106(l)(1)(v).

### 1.3 `leak_service_events` (LB1) — `sev_`

One visit's work on one appliance. Immutable: a mistake is **voided** (with a
reason, audited) and re-logged, never edited or deleted — this is a
compliance record kept at least three years (84.106(l)).

```
leak_service_events
  id                   text  pk
  org_id, site_id, appliance_id   text
  service_date         text  YYYY-MM-DD — the calendar day the work was done, as the technician states it
  kind                 text  'installation' | 'service' | 'leak_inspection' | 'repair'
                             | 'verification_initial' | 'verification_followup'
                             | 'seasonal_adjustment' | 'retrofit' | 'mothball' | 'retirement'
  technician_name      text  the person performing the work (84.106(l)(2)(v))
  component            text  the part(s) serviced (84.106(l)(2)(iii)), default ''
  work_performed       text  what was done (84.106(l)(2)(iv)), default ''
  added_oz             int   ≥ 0 — refrigerant charged into the appliance
  recovered_oz         int   ≥ 0 — refrigerant removed and HELD for return to this appliance
                             (repair evacuation, seasonal removal)
  returned_oz          int   ≥ 0, ≤ added_oz — the part of added_oz that is refrigerant previously
                             recovered from this appliance going back in (§2.2)
  full_charge_oz       int   snapshot of the appliance's full charge at logging time (84.106(l)(2)(vii))
  verification_passed  int   0/1, required iff kind is a verification test, else null (LB3 reads it)
  notes                text  default ''
  logged_by            text  usr uuid of the signed-in member
  logged_via           text  'console' | 'qr'
  voided_at, void_reason, voided_by   text  nullable; a voided event is ignored by every calculation
  created_at           text  ISO-8601 — ties on service_date are ordered by this
```

The verification kinds and `verification_passed` are in the LB1 table so LB3
never has to rebuild it: SQLite cannot alter a `CHECK` constraint in place.

LB2 adds the computed columns (`210_leak_rates`), LB3 the clock tables
(`220_leak_repair_clocks`); see §2.6 and §1.5.

### 1.4 The QR label

Each appliance has a `qr_token`: 20 bytes from `crypto.getRandomValues`,
base32 (RFC 4648, lowercase, no padding) — 160 bits, not an id, so a label on a
cabinet in a public store reveals nothing and cannot be enumerated. The label
encodes `https://<console>/q/<token>`. Resolving a token (`GET /v1/qr/{token}`)
requires a signed-in member of the owning organization with `leak.read`;
anyone else — including a member of another organization — gets **404**, the
same as a token that does not exist. A lost or photographed label is
neutralised by rotating the token (`POST …/qr-token`), which invalidates the
old label at once.

The console renders the QR code client-side as SVG from the label URL
(`qrcode-generator`, MIT, no dependencies) and lays it out for a 2 × 3 in
label with the appliance name, site, refrigerant and full charge in lb and oz.

### 1.5 The repair clock (LB3) — `rpc_`

```
leak_repair_clocks
  id, org_id, site_id, appliance_id
  opened_by_event_id       text  the addition whose rate exceeded the threshold
  opened_on                text  that addition's service_date
  leak_rate_bp             int   the triggering rate, hundredths of a percent
  threshold_pct            int
  regime                   text  '84.106' | '82.157'
  shutdown_required        int   0/1 — industrial process shutdown needed (120-day clock)
  repair_due_on            text  opened_on + 30 days (+120 if shutdown_required)   (84.106(d))
  initial_verified_on      text  nullable — first passing 'verification_initial'   (84.106(e)(1))
  followup_due_on          text  nullable — initial_verified_on + 10 days          (84.106(e)(2))
  closed_on                text  nullable — first passing 'verification_followup' after the initial
  status                   text  'open' | 'closed' | 'overdue' | 'suspended' (mothballed, 84.106(d)(3))
  suspended_days           int   days the clock spent mothballed; added to the due dates on resume

leak_reminders
  clock_id, rung, sent_to, sent_at  — unique (clock_id, rung, sent_to);
  a rung is claimed with INSERT … ON CONFLICT DO NOTHING RETURNING before it is sent
```

At most one open clock per appliance: an exceedance while a clock is open is
recorded on the event (`exceeds_threshold = 1`) but joins the open clock
rather than resetting its deadline — the 30 days run from the first
exceedance.

### 1.6 The export bucket (LB3)

One private R2 bucket per environment, declared as
`leakbook-exports-<env>` in `infra/terraform/cloudflare-r2` and bound by its
**prefixed** name `stg-leakbook-exports-stage` / `prod-leakbook-exports-prod`
(runbook trap 26). Keys: `orgs/{org}/exports/{export_id}.pdf`. The PDF is
written by a small hand-rolled PDF 1.4 writer in the worker (standard-14
Helvetica, text and rules only) — no dependency, no headless browser.

## 2. The leak-rate arithmetic

This is regulatory arithmetic. It implements the definition of **Leak rate**
in **40 CFR 84.102** and the calculation duty of **40 CFR 84.106(b)** — the
EPA's AIM Act *Emissions Reduction and Reclamation* rule (42 U.S.C. 7675(h)),
the "HFC Management Rule" of the pitch, applicable from 1 January 2026 — and
the same definition in **40 CFR 82.152** / duty in **82.157(b)** (Clean Air Act
§ 608) for appliances that hold only an ozone-depleting refrigerant. It lives
in one pure module, `packages/contracts/src/leak-rate.ts` (no I/O, no clock),
so the worker, the console's live preview and the tests run the same code.

### 2.1 Which regime applies, and at which threshold

| Refrigerant class | Examples | Regime | Subject when full charge ≥ |
|---|---|---|---|
| `hfc` — contains a regulated substance (HFC), or a substitute with GWP > 53 | R-404A, R-507A, R-410A, R-134a, R-407A/C, R-448A, R-449A, R-513A, R-32, R-454B | **40 CFR 84.106** (84.106(a)(1)–(2)) | **15 lb = 240 oz** |
| `ods_hfc_blend` — ODS blend that also contains an HFC (not "solely" ODS) | R-401A, R-402A | **40 CFR 84.106** | 15 lb = 240 oz |
| `ods` — solely class I/II (CFC/HCFC) | R-22, R-409A | **40 CFR 82.157** (84.106(a)(3)(i) excludes these) | **50 lb = 800 oz** |
| `low_gwp` — not a regulated substance, GWP ≤ 53 | R-290, R-600a, R-744, R-717, R-1234yf, R-1234ze(E) | none | — |

Also excluded from 84.106: the `residential_light_commercial_ac` category
(84.106(a)(3)(ii)). The comparison is `full_charge_oz >= 240` (or `>= 800`):
the rule says "15 or more pounds", so exactly 15 lb is in.

The class is looked up from a built-in table in `packages/contracts/src/leak.ts`
for the refrigerants above; for any other designation the office must supply
it. A subject appliance's threshold (84.106(c)(2); identically 82.157(c)(2)):

| Category | Threshold |
|---|---|
| `commercial_refrigeration` | **20 %** |
| `industrial_process_refrigeration` | **30 %** |
| `comfort_cooling`, `refrigerated_transport`, `other` | **10 %** |
| `residential_light_commercial_ac` | 10 % (only reachable under 82.157, ODS ≥ 50 lb) |

The rate is computed for every appliance — a trend is useful below the
threshold too — but only a subject appliance gets a threshold, an
`exceedsThreshold` verdict and a repair clock.

### 2.2 When a rate is calculated, and on how many ounces

84.106(b): "The owner or operator must calculate the leak rate every time
refrigerant is added to an appliance unless the addition is made immediately
following a retrofit, installation of a new refrigerant-containing appliance,
or qualifies as a seasonal variance."

Per non-voided event:

```
leak_oz = added_oz − returned_oz
```

`returned_oz` is refrigerant that came **out of this same appliance** and was
held (a repair evacuation, a seasonal removal) and is now going back in; it
was never lost, so it is not a leak. It must not exceed the **held balance**:
the sum of `recovered_oz` over the appliance's events in the 365 days before
this one, minus the `returned_oz` already drawn against it (FIFO). The
365-day limit is the seasonal-variance definition's "within one consecutive
12-month period" (84.102, *Seasonal variance*). An over-draw is a **422** that
tells the technician to log the excess as ordinary refrigerant added.

A rate is calculated for an event iff

```
leak_oz > 0  AND  kind NOT IN ('installation', 'retrofit')
```

— so an installation charge, the first charge after a retrofit, and a
seasonal addition that only returns what was seasonally removed
(`leak_oz = 0`) are exactly the three exceptions of 84.106(b), and a recharge
after a repair counts only the ounces that were actually lost.

### 2.3 Method 1 — annualizing (the default)

84.102, *Leak rate* (1): Step 1, pounds added to return the appliance to full
charge "whether in one addition or in multiple additions related to same
leak" ÷ full charge; Step 2, "the shorter of the number of days that have
passed since the last day refrigerant was added or 365 days" ÷ 365; Step 3,
Step 1 ÷ Step 2; Step 4, × 100.

```
                  leak_oz          365
leak rate (%) = ─────────────  ×  ─────  ×  100,     d = min(days, 365)
                full_charge_oz      d
```

- **leak_oz** — this addition's `leak_oz` plus that of every earlier
  non-voided event on the **same `service_date`**: additions on one day are
  one addition (the rule's "multiple additions related to same leak"; see LB-E
  for additions on different days).
- **days** — calendar days from the latest earlier `service_date` on which
  refrigerant was added (`added_oz > 0`, any kind — an installation charge, a
  seasonal return and a post-repair recharge are all "the last day
  refrigerant was added") to this event's `service_date`. Always ≥ 1, because
  same-day additions are merged.
- **No previous addition** — 84.106(b)(1): "Where an owner or operator is
  using the annualizing method … for the first time after January 1, 2026,
  the calculation should substitute 365 days." Applied when no earlier
  addition is on record, or when the only earlier additions predate
  2026-01-01 and this is the appliance's first calculated rate under 84.106.
  For an 82.157 appliance with no earlier addition on record, 365 is also
  used (the record cannot say otherwise); see LB-C.

### 2.4 Method 2 — rolling average

84.102, *Leak rate* (2): the sum of pounds added "over the previous 365-day
period (or over the period that has passed since the last successful
follow-up verification test showing all identified leaks in the appliance
were repaired, if that period is less than one year)" ÷ full charge × 100.

```
                Σ leak_oz in window
leak rate (%) = ───────────────────  ×  100
                  full_charge_oz

window = events with service_date in (this date − 365 days, this date], this event included,
         AND after the latest passing 'verification_followup' (in log order),
         AND, under 84.106, service_date ≥ 2026-01-01 (84.106(b)(2): "substitute pounds of
         refrigerant added since January 1, 2026")
```

Events that are not calculated additions (installation, retrofit,
`leak_oz = 0`) contribute nothing to the sum.

The method is a property of the **site** (84.102: one method for all
appliances at an operating facility). It can be changed only while no rate
has been calculated at that site; after that a change is a **409** —
84.106(b)(3) permits a switch only on acquiring a facility, which the office
records by creating a new site.

### 2.5 Exactness: integers in, rationals out

No floating point decides anything. With integers `leak_oz`, `F =
full_charge_oz`, `d`, `T = threshold_pct`:

```
annualizing:     exceeds  ⇔  leak_oz × 365 × 100  >  T × F × d
rolling average: exceeds  ⇔  Σleak_oz × 100      >  T × F
```

"Over the applicable leak rate" (84.106(c)(1)) is **strictly greater**: a rate
of exactly 20.00 % on a commercial appliance does not exceed. The displayed
rate is stored as `leak_rate_bp`, hundredths of a percent, from the exact
rational rounded half up: `bp = ⌊(2·N + D) / (2·D)⌋` with `N = leak_oz × 365 ×
10000`, `D = F × d` (annualizing) or `N = Σ × 10000`, `D = F` (rolling). The
verdict never reads the rounded value.

### 2.6 What LB2 stores on each calculated addition

`210_leak_rates` adds to `leak_service_events`: `leak_oz`, `rate_method`,
`rate_days` (annualizing `d`, else null), `leak_rate_bp`, `regime`
(`'84.106' | '82.157' | null`), `threshold_pct` (null when not subject),
`exceeds_threshold` (0/1, null when not subject). Computed once, at insert,
from the rows already in the log; the appliance's calculated history is
immutable, so voiding an event does not silently rewrite earlier verdicts —
the void is audited and the next addition is computed without it.

A **chronically leaking** flag is computed per appliance per calendar year:
`Σ leak_oz in the year × 100 ≥ 125 × F` — "leak 125 percent or more of the
full charge in a calendar year", reportable to EPA by 1 March of the next year
(84.106(j)). Note `≥` here, against `>` for the threshold: the rule's words
differ ("125 percent or more" vs "over").

### 2.7 Worked examples (every one is an LB2 test)

Quantities in ounces (16 oz = 1 lb). "prev" is the previous addition's date.

| # | Case | Appliance | Log | Rate | Threshold | Verdict |
|---|---|---|---|---|---|---|
| W1 | annualizing, commercial | R-404A walk-in, 640 oz | prev 2026-03-01; +64 on 2026-05-30 (d = 90) | 64/640 × 365/90 = **40.56 %** (365/9) | 20 % | exceeds; repair due **2026-06-29** |
| W2 | 365-day cap | same | prev 400 days earlier; +64 (d = min(400, 365) = 365) | **10.00 %** | 20 % | no |
| W3 | exactly at threshold | same | d = 365; +128 | **20.00 %** | 20 % | **no** (strictly greater) |
| W4 | one ounce over | same | d = 365; +129 | **20.16 %** (645/32) | 20 % | exceeds |
| W5 | first calculation, nothing on record | same, pre-2026 unit | no earlier addition; +48 on 2026-02-10 | 48/640 × 365/365 = **7.50 %** | 20 % | no (84.106(b)(1)) |
| W6 | first charge | same | `installation` 2026-01-10 +640 → **no rate**; +32 on 2026-03-11 (d = 60) | **30.42 %** (365/12) | 20 % | exceeds |
| W7 | two additions, one day | same | prev 2026-01-15; 2026-03-16 +16 then +16 (d = 60) | first **15.21 %**, second (merged 32) **30.42 %** | 20 % | first no, second exceeds |
| W8 | top-up after repair | same | prev 2026-02-01; `repair` 2026-04-01 recovered 600 (held); recharge 2026-04-02 +640 returned 600 → leak 40 (d = 60) | **38.02 %** (1825/48) | 20 % | exceeds (joins the open clock, §1.5) |
| W9 | recharge returns everything | same | recovered 640, then +640 returned 640 | leak 0 → **no rate** | — | — |
| W10 | seasonal variance | same | `seasonal_adjustment` 2026-04-15 recovered 80; 2026-10-15 +80 returned 80 | leak 0 → **no rate** | — | — |
| W11 | returned > held | same | held 80; +96 returned 96 | **422** — log the 16 as refrigerant added | — | — |
| W12 | size threshold, HFC | R-404A reach-in 224 oz (14 lb) / 240 oz (15 lb) | — | — | none / 20 % | 224: not subject; **240: subject** (≥ 15 lb) |
| W13 | ODS | R-22, 640 oz / 800 oz | — | — | none / 20 % | 640: not subject; **800: 82.157** |
| W14 | low-GWP | R-290 or R-744, any size | — | computed | none | never subject |
| W15 | comfort cooling | R-410A rooftop, 320 oz | +16 at d = 200 / at d = 180 | **9.13 %** (73/8) / **10.14 %** (365/36) | 10 % | no / exceeds |
| W16 | residential / light commercial AC | R-410A, 320 oz | — | computed | none | not subject (84.106(a)(3)(ii)) |
| W17 | industrial process | 12 800 oz (800 lb) | +1 600 at d = 120 | **38.02 %** | 30 % | exceeds; due +30 days, +120 with a shutdown |
| W18 | rolling average | commercial, 1 600 oz | 2026-02-10 +160; 2026-05-10 +128 → **18.00 %**; 2026-07-01 +80 → **23.00 %** | | 20 % | no, then exceeds |
| W19 | rolling, reset by verification | same | passing `verification_followup` 2026-07-20; 2026-09-15 +48 | **3.00 %** (26.00 % without the reset) | 20 % | no |
| W20 | rolling, 2026 floor | same, 84.106 | 2025-12-15 +240; 2026-03-01 +96 | **6.00 %** (21.00 % without the floor) | 20 % | no (84.106(b)(2)) |
| W21 | rolling, 365-day window | same | 2026-01-05 +160; 2027-01-10 +96 (window opens after 2026-01-10) | **6.00 %** | 20 % | no |
| W22 | chronic leaker | 640 oz | calendar-year leak Σ = 800 / 799 | 125.00 % / 124.84 % | — | chronic / not |
| W23 | voided event | same as W1 | the +64 is voided; +64 again 2026-05-31 (prev still 2026-03-01, d = 91) | **40.11 %** | 20 % | exceeds; the void is ignored |

W23: 64/640 × 365/91 = 365/9.1 = 40.1099 → **40.11 %**.

## 3. The API

Envelopes are the baseline's: `{ data, meta: { requestId, cursor } }` and
`{ error: { code, message, details, requestId } }`. Every route is behind
api-edge, which resolves the session and passes the actor to leak-worker as
headers. Authorization is membership-context → policy-authorize, deny by
default, and a denial is **404**, never 403, so a stranger cannot probe
whether a site exists.

### 3.1 Sites (LB1)

```
GET    /v1/organizations/{org}/sites                 leak.read    ?status=active|archived
POST   /v1/organizations/{org}/sites                 leak.write   201 { site }
GET    /v1/organizations/{org}/sites/{ste}           leak.read    { site, appliances[] }
PATCH  /v1/organizations/{org}/sites/{ste}           leak.write   { site }  (method change: 409 once a rate exists — LB2)
```

### 3.2 Appliances (LB1)

```
POST   /v1/organizations/{org}/sites/{ste}/appliances      leak.write   201 { appliance }
GET    /v1/organizations/{org}/appliances/{apl}            leak.read    { appliance, site, events[] (newest first, 50) }
PATCH  /v1/organizations/{org}/appliances/{apl}            leak.write   { appliance }
POST   /v1/organizations/{org}/appliances/{apl}/qr-token   leak.write   { appliance }  new token, old label dead
```

`appliance.qrUrl` is not returned by the API (it does not know the console
origin); the console builds it from `qrToken`.

### 3.3 The service log (LB1)

```
GET    /v1/organizations/{org}/appliances/{apl}/events            leak.read   ?cursor= (50 per page)
POST   /v1/organizations/{org}/appliances/{apl}/events            leak.write  201 { event }  (LB2: + leakRate)
POST   /v1/organizations/{org}/appliances/{apl}/events/{sev}/void leak.write  { event }  reason required
GET    /v1/qr/{token}                                             leak.read on the owning org
                                                                  { organization: {id}, site, appliance, events[5] }
POST   /v1/qr/{token}/events                                      leak.write on the owning org
                                                                  201 { event } — the phone page logs by token, loggedVia 'qr'
```

Validation (422 with `details.fields`): `service_date` a real date, not after
today (UTC + 1 day of grace for time zones), not before `installed_on`;
quantities integers 0…1 000 000; `returned_oz ≤ added_oz`;
`verification_passed` present iff a verification kind; a retired appliance
accepts no events (409). LB2 adds the held-balance check (§2.2).

### 3.4 Rates (LB2) and clocks (LB3)

```
GET    /v1/organizations/{org}/appliances/{apl}/leak-rate          leak.read   the latest calculation + chronic flag
GET    /v1/organizations/{org}/repair-clocks                       leak.read   ?status=open|overdue|closed
PATCH  /v1/organizations/{org}/repair-clocks/{rpc}                 leak.write  shutdownRequired, notes
POST   /v1/organizations/{org}/sites/{ste}/exports                 leak.write  201 { export } — PDF to R2
GET    /v1/organizations/{org}/exports/{exp}                       leak.read   the PDF, x-content-sha256
GET    /v1/organizations/{org}/sites/{ste}/export.csv              leak.read   streamed CSV
```

## 4. The console

- **Sites** (`/orgs/{org}/sites`, LB1): the contractor's customer sites, a
  create form, appliance counts. The first item in the org nav.
- **Site** (`/orgs/{org}/sites/{ste}`, LB1): address, customer contact, the
  site's appliances with refrigerant and full charge in lb + oz, an
  add-appliance form, "print labels" for all appliances.
- **Appliance** (`/orgs/{org}/appliances/{apl}`, LB1): the record, the QR
  label (print view, rotate token), the service log newest first, a log form,
  void with reason. LB2 adds the rate column and the threshold line; LB3 the
  clock banner.
- **Phone page** (`/q/{token}`, LB1): what a scanned label opens. Mobile-first,
  one column, large touch targets: the appliance header (site, refrigerant,
  full charge), a one-screen log form — kind (chips), technician (remembered
  on the device), added / recovered / returned in lb + oz, notes — and the
  last five visits. Not signed in → the baseline's magic-link sign-in, then
  back to the same label. LB2 shows the computed rate the moment the event is
  saved.
- **Repair clocks** (`/orgs/{org}/repair-clocks`, LB3): open clocks by days
  left, overdue first.

## 5. Events, secrets, and integrations

Audit events (events-worker, subject prefixes `ste_`, `apl_`, `sev_`,
`rpc_`): `leak.site.created|updated`, `leak.appliance.created|updated`
(full-charge revisions carry old/new/method), `leak.appliance.qr_rotated`,
`leak.event.logged`, `leak.event.voided`; LB2 adds the rate to
`leak.event.logged`'s payload and emits `leak.threshold.exceeded`; LB3 emits
`leak.clock.opened|verified|closed|overdue` and `leak.export.created`.

Email (LB3), through `notifications-worker` with `leak-worker` on its
internal-actor allow-list (added in LB1 so LB3 does not have to remember):
`leak.clock.opened` to the org's admins, the reminder ladder (repair due in
14 / 7 / 3 / 1 / 0 days), and on overdue an escalation to the site's
`owner_contact_email`. Idempotency key per clock, rung and recipient.

Secrets: none new in LB1 or LB2. LB3's R2 bucket needs the brokered
`CLOUDFLARE_R2_TOKEN` (template `r2-data`, with the `buckets` param —
runbook trap 20). SMS has no provider credential and is out (LB-B).

## 6. Out of scope

- **SMS alerts** — no provider credential (Twilio or other); a later
  milestone once one exists (LB-B).
- **The owner portal and shareable owner reports** — the brief's M3; the
  data model supports it (a customer is a `viewer`), the surface is later.
- **Cylinder and reclaim tracking** — the brief's M4. `recovered_oz` records
  what was held for return to the same appliance; where other recovered
  refrigerant went (reclaimer, cylinder serials) is M4.
- **Field-service integrations** (ServiceTitan, Jobber) — no credentials.
- **Automatic leak detection systems** (84.108) and **leak inspection
  schedules** (84.106(g)) as reminders — logged as events now, scheduled
  later.
- **EPA electronic reporting** (extension requests, chronic-leaker reports)
  — Leakbook computes and flags; the owner files.
- **Retrofit/retirement plans** (84.106(h)) — recorded as notes and
  events; no plan workflow.
- **Billing plans** ($29 per contractor) — the baseline's Polar integration is
  left untouched until pricing is decided.
- **The custom domain** `leakbook.app` — not held; workers.dev URLs only, so
  prod sign-in email cannot be sent (runbook trap 27).
