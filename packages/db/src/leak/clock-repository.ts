import type { SqlExecutor, SqlRow } from "../d1/executor.js";

// LB3 — the repair clock, its reminder rungs and the PDF exports (220_leak_repair_clocks).
// Runbook trap 22: every write whose outcome a caller branches on uses
// RETURNING and reads the returned rows, never rowCount.

type Row = SqlRow & Record<string, unknown>;

export interface RepairClock {
  id: string;
  orgId: string;
  siteId: string;
  applianceId: string;
  openedByEventId: string;
  openedOn: string;
  leakRateBp: number;
  thresholdPct: number;
  regime: string;
  shutdownRequired: boolean;
  repairDueOn: string;
  initialVerifiedOn: string | null;
  initialEventId: string | null;
  followupDueOn: string | null;
  closedOn: string | null;
  closedByEventId: string | null;
  closedReason: string | null;
  status: string;
  suspendedOn: string | null;
  suspendedDays: number;
  notes: string;
  createdAt: string;
  updatedAt: string;
  /** Joined for lists, reminders and the PDF. */
  applianceName: string;
  siteName: string;
  ownerContactEmail: string | null;
}

export interface OpenClockInput {
  id: string;
  orgId: string;
  siteId: string;
  applianceId: string;
  openedByEventId: string;
  openedOn: string;
  leakRateBp: number;
  thresholdPct: number;
  regime: string;
  repairDueOn: string;
  now: string;
}

export interface LeakExport {
  id: string;
  orgId: string;
  siteId: string;
  objectKey: string;
  sha256: string;
  sizeBytes: number;
  createdBy: string | null;
  createdAt: string;
}

export interface LeakClockRepository {
  /** Null when a running clock already exists for the appliance (the new exceedance joins it). */
  openClock(input: OpenClockInput): Promise<RepairClock | null>;
  getClock(orgId: string, clockId: string): Promise<RepairClock | null>;
  /** The appliance's running clock (open, overdue or suspended), if any. */
  getRunningClock(orgId: string, applianceId: string): Promise<RepairClock | null>;
  listClocks(orgId: string, status?: string): Promise<RepairClock[]>;
  listClocksForSite(orgId: string, siteId: string): Promise<RepairClock[]>;
  /** Open and overdue clocks across every organization (the cron), or one organization's. */
  listRunningClocks(limit: number, orgId?: string): Promise<RepairClock[]>;
  /** A passing initial verification: sets the follow-up deadline. Null unless the clock was running and unverified. */
  recordInitialVerification(orgId: string, clockId: string, on: string, eventId: string, followupDueOn: string, now: string): Promise<RepairClock | null>;
  /** A passing follow-up verification (or retirement) closes the clock. Null unless it was running. */
  closeClock(orgId: string, clockId: string, on: string, eventId: string, reason: "verified" | "retired", now: string): Promise<RepairClock | null>;
  suspendClock(orgId: string, clockId: string, on: string, now: string): Promise<RepairClock | null>;
  /** Resume a suspended clock, shifting its deadlines by the days it was suspended. */
  resumeClock(orgId: string, clockId: string, days: number, repairDueOn: string, followupDueOn: string | null, now: string): Promise<RepairClock | null>;
  /** open → overdue, once. Null when it was not open (already overdue, or no longer running). */
  markOverdue(clockId: string, now: string): Promise<RepairClock | null>;
  /** overdue → open when a changed deadline is back in the future. */
  updateClock(orgId: string, clockId: string, fields: { shutdownRequired: boolean; notes: string; repairDueOn: string; status: string }, now: string): Promise<RepairClock | null>;

  /** Claim a rung for a recipient: the row id, or null when it was already claimed (sent). */
  claimReminder(input: { id: string; orgId: string; clockId: string; rung: string; sentTo: string; now: string }): Promise<string | null>;
  /** Give a claim back when the send did not land, so the next tick retries it. */
  releaseReminder(id: string): Promise<boolean>;
  recordReminderNotification(id: string, notificationId: string): Promise<boolean>;
  listReminders(orgId: string, clockId: string): Promise<{ rung: string; sentTo: string; sentAt: string }[]>;
  /** Owner and admin email addresses of an organization's active members. */
  listAdminEmails(orgId: string): Promise<string[]>;

  createExport(input: LeakExport): Promise<LeakExport>;
  getExport(orgId: string, exportId: string): Promise<LeakExport | null>;
}

function str(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function mapClock(row: Row): RepairClock {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    siteId: row.site_id as string,
    applianceId: row.appliance_id as string,
    openedByEventId: row.opened_by_event_id as string,
    openedOn: row.opened_on as string,
    leakRateBp: Number(row.leak_rate_bp),
    thresholdPct: Number(row.threshold_pct),
    regime: row.regime as string,
    shutdownRequired: Number(row.shutdown_required) === 1,
    repairDueOn: row.repair_due_on as string,
    initialVerifiedOn: str(row.initial_verified_on),
    initialEventId: str(row.initial_event_id),
    followupDueOn: str(row.followup_due_on),
    closedOn: str(row.closed_on),
    closedByEventId: str(row.closed_by_event_id),
    closedReason: str(row.closed_reason),
    status: row.status as string,
    suspendedOn: str(row.suspended_on),
    suspendedDays: Number(row.suspended_days ?? 0),
    notes: (row.notes as string) ?? "",
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    applianceName: (row.appliance_name as string) ?? "",
    siteName: (row.site_name as string) ?? "",
    ownerContactEmail: str(row.owner_contact_email),
  };
}

function mapExport(row: Row): LeakExport {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    siteId: row.site_id as string,
    objectKey: row.object_key as string,
    sha256: row.sha256 as string,
    sizeBytes: Number(row.size_bytes),
    createdBy: str(row.created_by),
    createdAt: row.created_at as string,
  };
}

const CLOCK_SELECT = `SELECT c.id, c.org_id, c.site_id, c.appliance_id, c.opened_by_event_id, c.opened_on,
    c.leak_rate_bp, c.threshold_pct, c.regime, c.shutdown_required, c.repair_due_on, c.initial_verified_on,
    c.initial_event_id, c.followup_due_on, c.closed_on, c.closed_by_event_id, c.closed_reason, c.status,
    c.suspended_on, c.suspended_days, c.notes, c.created_at, c.updated_at,
    a.name AS appliance_name, s.name AS site_name, s.owner_contact_email AS owner_contact_email
  FROM leak_repair_clocks c
  JOIN leak_appliances a ON a.id = c.appliance_id AND a.org_id = c.org_id
  JOIN leak_sites s ON s.id = c.site_id AND s.org_id = c.org_id`;

const RUNNING = `('open','overdue','suspended')`;

const EXPORT_COLUMNS = "id, org_id, site_id, object_key, sha256, size_bytes, created_by, created_at";

export function createLeakClockRepository(executor: SqlExecutor): LeakClockRepository {
  async function one(sql: string, params: unknown[]): Promise<Row | null> {
    const result = await executor.execute<Row>(sql, params);
    return result.rows[0] ?? null;
  }

  async function getClock(orgId: string, clockId: string): Promise<RepairClock | null> {
    const row = await one(`${CLOCK_SELECT} WHERE c.org_id = $1 AND c.id = $2`, [orgId, clockId]);
    return row ? mapClock(row) : null;
  }

  /** Run an UPDATE … RETURNING id and re-read the joined row when it changed something. */
  async function updated(orgId: string, sql: string, params: unknown[]): Promise<RepairClock | null> {
    const row = await one(sql, params);
    return row ? getClock(orgId, row.id as string) : null;
  }

  return {
    async openClock(input) {
      // The partial unique index uq_leak_clocks_running makes a second running
      // clock for the appliance a conflict: DO NOTHING returns no row.
      const row = await one(
        `INSERT INTO leak_repair_clocks
           (id, org_id, site_id, appliance_id, opened_by_event_id, opened_on, leak_rate_bp, threshold_pct,
            regime, repair_due_on, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'open', $11, $11)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [
          input.id,
          input.orgId,
          input.siteId,
          input.applianceId,
          input.openedByEventId,
          input.openedOn,
          input.leakRateBp,
          input.thresholdPct,
          input.regime,
          input.repairDueOn,
          input.now,
        ],
      );
      return row ? getClock(input.orgId, row.id as string) : null;
    },

    getClock,

    async getRunningClock(orgId, applianceId) {
      const row = await one(
        `${CLOCK_SELECT} WHERE c.org_id = $1 AND c.appliance_id = $2 AND c.status IN ${RUNNING} LIMIT 1`,
        [orgId, applianceId],
      );
      return row ? mapClock(row) : null;
    },

    async listClocks(orgId, status) {
      const params: unknown[] = [orgId];
      let where = "c.org_id = $1";
      if (status) {
        params.push(status);
        where += " AND c.status = $2";
      }
      // Overdue first, then by the nearest deadline.
      const result = await executor.execute<Row>(
        `${CLOCK_SELECT} WHERE ${where}
          ORDER BY CASE c.status WHEN 'overdue' THEN 0 WHEN 'open' THEN 1 WHEN 'suspended' THEN 2 ELSE 3 END,
                   COALESCE(c.followup_due_on, c.repair_due_on) ASC, c.id ASC
          LIMIT 1000`,
        params,
      );
      return result.rows.map(mapClock);
    },

    async listClocksForSite(orgId, siteId) {
      const result = await executor.execute<Row>(
        `${CLOCK_SELECT} WHERE c.org_id = $1 AND c.site_id = $2 ORDER BY c.opened_on ASC, c.id ASC LIMIT 1000`,
        [orgId, siteId],
      );
      return result.rows.map(mapClock);
    },

    async listRunningClocks(limit, orgId) {
      const params: unknown[] = [];
      let where = "c.status IN ('open','overdue')";
      if (orgId) {
        params.push(orgId);
        where += " AND c.org_id = $1";
      }
      params.push(limit);
      const result = await executor.execute<Row>(
        `${CLOCK_SELECT} WHERE ${where} ORDER BY c.repair_due_on ASC, c.id ASC LIMIT $${params.length}`,
        params,
      );
      return result.rows.map(mapClock);
    },

    recordInitialVerification(orgId, clockId, on, eventId, followupDueOn, now) {
      return updated(
        orgId,
        `UPDATE leak_repair_clocks
            SET initial_verified_on = $3, initial_event_id = $4, followup_due_on = $5, updated_at = $6
          WHERE org_id = $1 AND id = $2 AND status IN ('open','overdue') AND initial_verified_on IS NULL
          RETURNING id`,
        [orgId, clockId, on, eventId, followupDueOn, now],
      );
    },

    closeClock(orgId, clockId, on, eventId, reason, now) {
      return updated(
        orgId,
        `UPDATE leak_repair_clocks
            SET status = 'closed', closed_on = $3, closed_by_event_id = $4, closed_reason = $5,
                suspended_on = NULL, updated_at = $6
          WHERE org_id = $1 AND id = $2 AND status IN ${RUNNING}
          RETURNING id`,
        [orgId, clockId, on, eventId, reason, now],
      );
    },

    suspendClock(orgId, clockId, on, now) {
      return updated(
        orgId,
        `UPDATE leak_repair_clocks SET status = 'suspended', suspended_on = $3, updated_at = $4
          WHERE org_id = $1 AND id = $2 AND status IN ('open','overdue')
          RETURNING id`,
        [orgId, clockId, on, now],
      );
    },

    resumeClock(orgId, clockId, days, repairDue, followupDue, now) {
      return updated(
        orgId,
        `UPDATE leak_repair_clocks
            SET status = 'open', suspended_on = NULL, suspended_days = suspended_days + $3,
                repair_due_on = $4, followup_due_on = $5, updated_at = $6
          WHERE org_id = $1 AND id = $2 AND status = 'suspended'
          RETURNING id`,
        [orgId, clockId, days, repairDue, followupDue, now],
      );
    },

    async markOverdue(clockId, now) {
      const row = await one(
        `UPDATE leak_repair_clocks SET status = 'overdue', updated_at = $2
          WHERE id = $1 AND status = 'open'
          RETURNING id, org_id`,
        [clockId, now],
      );
      return row ? getClock(row.org_id as string, row.id as string) : null;
    },

    updateClock(orgId, clockId, fields, now) {
      return updated(
        orgId,
        `UPDATE leak_repair_clocks
            SET shutdown_required = $3, notes = $4, repair_due_on = $5, status = $6, updated_at = $7
          WHERE org_id = $1 AND id = $2
          RETURNING id`,
        [orgId, clockId, fields.shutdownRequired ? 1 : 0, fields.notes, fields.repairDueOn, fields.status, now],
      );
    },

    async claimReminder(input) {
      const row = await one(
        `INSERT INTO leak_reminders (id, org_id, clock_id, rung, sent_to, sent_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (clock_id, rung, sent_to) DO NOTHING
         RETURNING id`,
        [input.id, input.orgId, input.clockId, input.rung, input.sentTo, input.now],
      );
      return row ? (row.id as string) : null;
    },

    async releaseReminder(id) {
      const row = await one(`DELETE FROM leak_reminders WHERE id = $1 AND notification_id IS NULL RETURNING id`, [id]);
      return row !== null;
    },

    async recordReminderNotification(id, notificationId) {
      const row = await one(`UPDATE leak_reminders SET notification_id = $2 WHERE id = $1 RETURNING id`, [
        id,
        notificationId,
      ]);
      return row !== null;
    },

    async listReminders(orgId, clockId) {
      const result = await executor.execute<Row>(
        `SELECT rung, sent_to, sent_at FROM leak_reminders WHERE org_id = $1 AND clock_id = $2
          ORDER BY sent_at ASC, rung ASC LIMIT 500`,
        [orgId, clockId],
      );
      return result.rows.map((r) => ({ rung: r.rung as string, sentTo: r.sent_to as string, sentAt: r.sent_at as string }));
    },

    async listAdminEmails(orgId) {
      const result = await executor.execute<Row>(
        `SELECT u.email_lower AS email
           FROM membership_role_assignments ra
           JOIN membership_organization_members m
             ON m.org_id = ra.org_id AND m.subject_id = ra.subject_id AND m.status = 'active'
           JOIN identity_users u ON u.id = ra.subject_id AND u.status = 'active'
          WHERE ra.org_id = $1 AND ra.role IN ('owner','admin') AND ra.scope_kind = 'organization'
            AND ra.revoked_at IS NULL
          ORDER BY ra.created_at ASC, ra.id ASC
          LIMIT 10`,
        [orgId],
      );
      const emails = result.rows.map((r) => str(r.email)).filter((e): e is string => !!e);
      return [...new Set(emails)];
    },

    async createExport(input) {
      const row = await one(
        `INSERT INTO leak_exports (id, org_id, site_id, object_key, sha256, size_bytes, created_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING ${EXPORT_COLUMNS}`,
        [input.id, input.orgId, input.siteId, input.objectKey, input.sha256, input.sizeBytes, input.createdBy, input.createdAt],
      );
      if (!row) throw new Error("leak: export insert returned no row");
      return mapExport(row);
    },

    async getExport(orgId, exportId) {
      const row = await one(`SELECT ${EXPORT_COLUMNS} FROM leak_exports WHERE org_id = $1 AND id = $2`, [orgId, exportId]);
      return row ? mapExport(row) : null;
    },
  };
}
