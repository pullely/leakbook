-- 200_leak_core
-- Refrigerant log foundation — a contractor's customer sites, the
-- refrigerant-containing appliances at each (one row per independent circuit),
-- and the immutable log of service events against them
-- Bounded context: leak
-- schema leak: Refrigerant log bounded context — owns the site (the regulation's
-- "operating facility", which fixes the leak-rate method), the appliance (refrigerant,
-- class, category, full charge in integer ounces, QR token) and every service event
-- (refrigerant added, recovered and returned, in integer ounces). Events are never
-- edited or deleted; a mistake is voided with a reason.

CREATE TABLE IF NOT EXISTS leak_sites (
  id                   TEXT PRIMARY KEY,
  org_id               TEXT NOT NULL,
  name                 TEXT NOT NULL,
  customer_name        TEXT NOT NULL,
  address_line1        TEXT NOT NULL,
  address_line2        TEXT,
  city                 TEXT NOT NULL DEFAULT '',
  region               TEXT NOT NULL DEFAULT '',
  postal_code          TEXT NOT NULL DEFAULT '',
  country              TEXT NOT NULL DEFAULT 'US',
  owner_contact_name   TEXT,
  owner_contact_email  TEXT,
  leak_rate_method     TEXT NOT NULL DEFAULT 'annualizing'
                       CHECK (leak_rate_method IN ('annualizing','rolling_average')),
  status               TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  notes                TEXT NOT NULL DEFAULT '',
  created_by           TEXT,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- table leak_sites: A customer location a contractor services — the regulation's operating facility. Every query must scope by org_id.
-- column leak_sites.customer_name: The owner or operator of the appliances (40 CFR 84.106(l)(1)(i)).
-- column leak_sites.leak_rate_method: One method for every appliance at the facility (40 CFR 84.102, Leak rate).
-- column leak_sites.owner_contact_email: The customer's contact; overdue repair clocks escalate here (LB3).

CREATE INDEX IF NOT EXISTS idx_leak_sites_org_status ON leak_sites (org_id, status, name);

CREATE TABLE IF NOT EXISTS leak_appliances (
  id                         TEXT PRIMARY KEY,
  org_id                     TEXT NOT NULL,
  site_id                    TEXT NOT NULL REFERENCES leak_sites (id) ON DELETE RESTRICT,
  name                       TEXT NOT NULL,
  location                   TEXT NOT NULL DEFAULT '',
  category                   TEXT NOT NULL CHECK (category IN (
                               'commercial_refrigeration','industrial_process_refrigeration',
                               'comfort_cooling','refrigerated_transport',
                               'residential_light_commercial_ac','other')),
  refrigerant                TEXT NOT NULL,
  refrigerant_class          TEXT NOT NULL CHECK (refrigerant_class IN ('hfc','ods_hfc_blend','ods','low_gwp')),
  full_charge_oz             INTEGER NOT NULL CHECK (full_charge_oz > 0),
  full_charge_method         TEXT NOT NULL CHECK (full_charge_method IN (
                               'manufacturer','calculation','measurement','range_midpoint')),
  full_charge_range_low_oz   INTEGER,
  full_charge_range_high_oz  INTEGER,
  installed_on               TEXT,
  manufacturer               TEXT NOT NULL DEFAULT '',
  model                      TEXT NOT NULL DEFAULT '',
  serial_number              TEXT NOT NULL DEFAULT '',
  status                     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','mothballed','retired')),
  qr_token                   TEXT NOT NULL,
  qr_token_rotated_at        TEXT,
  created_by                 TEXT,
  created_at                 TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at                 TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK ((full_charge_method = 'range_midpoint') =
         (full_charge_range_low_oz IS NOT NULL AND full_charge_range_high_oz IS NOT NULL)),
  CHECK (full_charge_range_low_oz IS NULL OR full_charge_range_high_oz IS NULL
         OR (full_charge_range_low_oz > 0 AND full_charge_range_high_oz >= full_charge_range_low_oz))
);

-- table leak_appliances: One refrigerant circuit (40 CFR 84.102: each independent circuit is a separate appliance). Every query must scope by org_id.
-- column leak_appliances.full_charge_oz: Full charge in integer ounces (16 oz = 1 lb). Never a float.
-- column leak_appliances.refrigerant_class: hfc / ods_hfc_blend (40 CFR 84.106, >= 15 lb), ods (40 CFR 82.157, >= 50 lb), low_gwp (not subject).
-- column leak_appliances.qr_token: 160-bit base32 token printed on the QR label; not an id. Resolving it requires membership.

CREATE INDEX IF NOT EXISTS idx_leak_appliances_site ON leak_appliances (org_id, site_id, name);
CREATE UNIQUE INDEX IF NOT EXISTS uq_leak_appliances_qr_token ON leak_appliances (qr_token);

CREATE TABLE IF NOT EXISTS leak_service_events (
  id                    TEXT PRIMARY KEY,
  org_id                TEXT NOT NULL,
  site_id               TEXT NOT NULL REFERENCES leak_sites (id) ON DELETE RESTRICT,
  appliance_id          TEXT NOT NULL REFERENCES leak_appliances (id) ON DELETE RESTRICT,
  service_date          TEXT NOT NULL,
  kind                  TEXT NOT NULL CHECK (kind IN (
                          'installation','service','leak_inspection','repair',
                          'verification_initial','verification_followup',
                          'seasonal_adjustment','retrofit','mothball','retirement')),
  technician_name       TEXT NOT NULL,
  component             TEXT NOT NULL DEFAULT '',
  work_performed        TEXT NOT NULL DEFAULT '',
  added_oz              INTEGER NOT NULL DEFAULT 0 CHECK (added_oz >= 0),
  recovered_oz          INTEGER NOT NULL DEFAULT 0 CHECK (recovered_oz >= 0),
  returned_oz           INTEGER NOT NULL DEFAULT 0 CHECK (returned_oz >= 0),
  full_charge_oz        INTEGER NOT NULL CHECK (full_charge_oz > 0),
  verification_passed   INTEGER CHECK (verification_passed IS NULL OR verification_passed IN (0, 1)),
  notes                 TEXT NOT NULL DEFAULT '',
  logged_by             TEXT,
  logged_via            TEXT NOT NULL DEFAULT 'console' CHECK (logged_via IN ('console','qr')),
  voided_at             TEXT,
  void_reason           TEXT,
  voided_by             TEXT,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (returned_oz <= added_oz),
  CHECK ((kind IN ('verification_initial','verification_followup')) = (verification_passed IS NOT NULL)),
  CHECK ((voided_at IS NULL) = (void_reason IS NULL))
);

-- table leak_service_events: One service visit's work on one appliance. Immutable compliance record (kept >= 3 years, 40 CFR 84.106(l)); a mistake is voided, never edited or deleted.
-- column leak_service_events.service_date: The calendar day the work was done, YYYY-MM-DD, as the technician states it.
-- column leak_service_events.added_oz: Refrigerant charged into the appliance, integer ounces.
-- column leak_service_events.recovered_oz: Refrigerant removed from the appliance and held for return to it (repair evacuation, seasonal removal).
-- column leak_service_events.returned_oz: The part of added_oz that is previously recovered refrigerant going back in; added_oz - returned_oz is the leak.
-- column leak_service_events.full_charge_oz: The appliance's full charge when the event was logged (40 CFR 84.106(l)(2)(vii)).

CREATE INDEX IF NOT EXISTS idx_leak_events_appliance_date
  ON leak_service_events (org_id, appliance_id, service_date DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_leak_events_site_date ON leak_service_events (org_id, site_id, service_date DESC);
