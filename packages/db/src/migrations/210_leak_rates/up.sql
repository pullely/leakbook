-- 210_leak_rates
-- The leak-rate engine (LB2) — the rate computed on each refrigerant addition,
-- stored on the service event at insert, from the rows already in the log
-- Bounded context: leak
-- Additive only: SQLite has no ADD COLUMN IF NOT EXISTS; re-run safety is the
-- runner's applied-ledger. The verdict is computed once and never rewritten:
-- voiding an event does not silently change earlier verdicts.

ALTER TABLE leak_service_events ADD COLUMN leak_oz INTEGER;
ALTER TABLE leak_service_events ADD COLUMN rate_method TEXT
  CHECK (rate_method IS NULL OR rate_method IN ('annualizing','rolling_average'));
ALTER TABLE leak_service_events ADD COLUMN rate_days INTEGER
  CHECK (rate_days IS NULL OR (rate_days >= 1 AND rate_days <= 365));
ALTER TABLE leak_service_events ADD COLUMN leak_rate_bp INTEGER
  CHECK (leak_rate_bp IS NULL OR leak_rate_bp >= 0);
ALTER TABLE leak_service_events ADD COLUMN regime TEXT
  CHECK (regime IS NULL OR regime IN ('84.106','82.157'));
ALTER TABLE leak_service_events ADD COLUMN threshold_pct INTEGER;
ALTER TABLE leak_service_events ADD COLUMN exceeds_threshold INTEGER
  CHECK (exceeds_threshold IS NULL OR exceeds_threshold IN (0, 1));

-- column leak_service_events.leak_oz: added_oz - returned_oz: refrigerant lost and replaced (40 CFR 84.102, Leak rate).
-- column leak_service_events.rate_method: The site's method when the rate was calculated; null when no rate was calculated (84.106(b) exceptions).
-- column leak_service_events.rate_days: Annualizing d = min(days since the last addition, 365); null for the rolling average.
-- column leak_service_events.leak_rate_bp: The leak rate in hundredths of a percent, rounded half up for display. The verdict never reads it.
-- column leak_service_events.regime: 84.106 or 82.157 when the appliance was subject at logging time, else null.
-- column leak_service_events.threshold_pct: The applicable leak rate (84.106(c)(2) / 82.157(c)(2)); null when not subject.
-- column leak_service_events.exceeds_threshold: 1 when the rate is strictly over the threshold (exact integer comparison); null when not subject.

-- Events logged before LB2 get their leak_oz; their rates stay null (never computed at insert).
UPDATE leak_service_events SET leak_oz = added_oz - returned_oz WHERE leak_oz IS NULL;

CREATE INDEX IF NOT EXISTS idx_leak_events_site_rated
  ON leak_service_events (org_id, site_id) WHERE leak_rate_bp IS NOT NULL AND voided_at IS NULL;
