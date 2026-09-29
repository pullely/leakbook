-- 220_leak_repair_clocks
-- The repair clock (LB3) — one row per exceedance that starts a 30-day repair
-- deadline (40 CFR 84.106(d)), carried through its verification tests
-- (84.106(e)); the reminder rungs claimed before each email; and the PDF
-- exports written to R2
-- Bounded context: leak

CREATE TABLE IF NOT EXISTS leak_repair_clocks (
  id                    TEXT PRIMARY KEY,
  org_id                TEXT NOT NULL,
  site_id               TEXT NOT NULL REFERENCES leak_sites (id) ON DELETE RESTRICT,
  appliance_id          TEXT NOT NULL REFERENCES leak_appliances (id) ON DELETE RESTRICT,
  opened_by_event_id    TEXT NOT NULL REFERENCES leak_service_events (id) ON DELETE RESTRICT,
  opened_on             TEXT NOT NULL,
  leak_rate_bp          INTEGER NOT NULL CHECK (leak_rate_bp >= 0),
  threshold_pct         INTEGER NOT NULL,
  regime                TEXT NOT NULL CHECK (regime IN ('84.106','82.157')),
  shutdown_required     INTEGER NOT NULL DEFAULT 0 CHECK (shutdown_required IN (0, 1)),
  repair_due_on         TEXT NOT NULL,
  initial_verified_on   TEXT,
  initial_event_id      TEXT,
  followup_due_on       TEXT,
  closed_on             TEXT,
  closed_by_event_id    TEXT,
  closed_reason         TEXT CHECK (closed_reason IS NULL OR closed_reason IN ('verified','retired')),
  status                TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','overdue','suspended','closed')),
  suspended_on          TEXT,
  suspended_days        INTEGER NOT NULL DEFAULT 0 CHECK (suspended_days >= 0),
  notes                 TEXT NOT NULL DEFAULT '',
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK ((status = 'closed') = (closed_on IS NOT NULL)),
  CHECK ((status = 'suspended') = (suspended_on IS NOT NULL)),
  CHECK ((initial_verified_on IS NULL) = (followup_due_on IS NULL))
);

-- table leak_repair_clocks: A repair deadline opened by an addition over the leak-rate threshold (40 CFR 84.106(d)). At most one running clock per appliance; a later exceedance joins it. Every query must scope by org_id.
-- column leak_repair_clocks.repair_due_on: opened_on + 30 days (+120 instead with an industrial process shutdown) + days suspended.
-- column leak_repair_clocks.followup_due_on: initial_verified_on + 10 days (84.106(e)(2)).
-- column leak_repair_clocks.suspended_days: Days spent mothballed; added to the deadlines on resume (84.106(d)(3)).

-- At most one running clock per appliance: the 30 days run from the first exceedance.
CREATE UNIQUE INDEX IF NOT EXISTS uq_leak_clocks_running
  ON leak_repair_clocks (appliance_id) WHERE status IN ('open','overdue','suspended');
CREATE INDEX IF NOT EXISTS idx_leak_clocks_org_status ON leak_repair_clocks (org_id, status, repair_due_on);
CREATE INDEX IF NOT EXISTS idx_leak_clocks_running_due
  ON leak_repair_clocks (status, repair_due_on) WHERE status IN ('open','overdue');

CREATE TABLE IF NOT EXISTS leak_reminders (
  id               TEXT PRIMARY KEY,
  org_id           TEXT NOT NULL,
  clock_id         TEXT NOT NULL REFERENCES leak_repair_clocks (id) ON DELETE RESTRICT,
  rung             TEXT NOT NULL,
  sent_to          TEXT NOT NULL,
  sent_at          TEXT NOT NULL,
  notification_id  TEXT
);

-- table leak_reminders: One row per reminder rung and recipient, claimed with INSERT ... ON CONFLICT DO NOTHING RETURNING before the email is sent, so two cron ticks never send a rung twice.
-- column leak_reminders.rung: repair-14 | repair-7 | repair-3 | repair-1 | repair-0 | followup-N | overdue-repair | escalation-repair | opened ...

CREATE UNIQUE INDEX IF NOT EXISTS uq_leak_reminders_rung ON leak_reminders (clock_id, rung, sent_to);

CREATE TABLE IF NOT EXISTS leak_exports (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,
  site_id       TEXT NOT NULL REFERENCES leak_sites (id) ON DELETE RESTRICT,
  object_key    TEXT NOT NULL,
  sha256        TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL CHECK (size_bytes > 0),
  created_by    TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- table leak_exports: An inspection PDF of one site's record, stored in R2 at object_key (orgs/{org}/exports/{id}.pdf). Every query must scope by org_id.
-- column leak_exports.sha256: Hex SHA-256 of the stored bytes; served as x-content-sha256.

CREATE INDEX IF NOT EXISTS idx_leak_exports_site ON leak_exports (org_id, site_id, created_at DESC);
