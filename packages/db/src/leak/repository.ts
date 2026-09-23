import type { SqlExecutor, SqlRow } from "../d1/executor.js";
import type {
  Appliance,
  ApplianceFields,
  CreateApplianceInput,
  CreateLeakSiteInput,
  CreateServiceEventInput,
  LeakRepository,
  LeakSite,
  LeakSiteFields,
  ListEventsPage,
  ServiceEvent,
} from "./types.js";

type Row = SqlRow & Record<string, unknown>;

// Runbook trap 22: the D1 executor reports rowCount = rows.length, so every
// write here whose outcome the caller branches on uses RETURNING and reads the
// returned row — never rowCount.

function str(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function num(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function mapSite(row: Row): LeakSite {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    name: row.name as string,
    customerName: row.customer_name as string,
    addressLine1: row.address_line1 as string,
    addressLine2: str(row.address_line2),
    city: (row.city as string) ?? "",
    region: (row.region as string) ?? "",
    postalCode: (row.postal_code as string) ?? "",
    country: (row.country as string) ?? "US",
    ownerContactName: str(row.owner_contact_name),
    ownerContactEmail: str(row.owner_contact_email),
    leakRateMethod: row.leak_rate_method as string,
    status: row.status as string,
    notes: (row.notes as string) ?? "",
    applianceCount: Number(row.appliance_count ?? 0),
    createdBy: str(row.created_by),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function mapAppliance(row: Row): Appliance {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    siteId: row.site_id as string,
    name: row.name as string,
    location: (row.location as string) ?? "",
    category: row.category as string,
    refrigerant: row.refrigerant as string,
    refrigerantClass: row.refrigerant_class as string,
    fullChargeOz: Number(row.full_charge_oz),
    fullChargeMethod: row.full_charge_method as string,
    fullChargeRangeLowOz: num(row.full_charge_range_low_oz),
    fullChargeRangeHighOz: num(row.full_charge_range_high_oz),
    installedOn: str(row.installed_on),
    manufacturer: (row.manufacturer as string) ?? "",
    model: (row.model as string) ?? "",
    serialNumber: (row.serial_number as string) ?? "",
    status: row.status as string,
    qrToken: row.qr_token as string,
    qrTokenRotatedAt: str(row.qr_token_rotated_at),
    lastServiceDate: str(row.last_service_date),
    createdBy: str(row.created_by),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function mapEvent(row: Row): ServiceEvent {
  const passed = num(row.verification_passed);
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    siteId: row.site_id as string,
    applianceId: row.appliance_id as string,
    serviceDate: row.service_date as string,
    kind: row.kind as string,
    technicianName: row.technician_name as string,
    component: (row.component as string) ?? "",
    workPerformed: (row.work_performed as string) ?? "",
    addedOz: Number(row.added_oz),
    recoveredOz: Number(row.recovered_oz),
    returnedOz: Number(row.returned_oz),
    fullChargeOz: Number(row.full_charge_oz),
    verificationPassed: passed === null ? null : passed === 1,
    notes: (row.notes as string) ?? "",
    loggedBy: str(row.logged_by),
    loggedVia: row.logged_via as string,
    voidedAt: str(row.voided_at),
    voidReason: str(row.void_reason),
    voidedBy: str(row.voided_by),
    createdAt: row.created_at as string,
  };
}

const SITE_COLUMNS = `id, org_id, name, customer_name, address_line1, address_line2, city, region,
  postal_code, country, owner_contact_name, owner_contact_email, leak_rate_method, status, notes,
  created_by, created_at, updated_at`;

// The appliance count is derived, never stored: appliances at the site that are not retired.
const SITE_SELECT = `SELECT s.id, s.org_id, s.name, s.customer_name, s.address_line1, s.address_line2,
    s.city, s.region, s.postal_code, s.country, s.owner_contact_name, s.owner_contact_email,
    s.leak_rate_method, s.status, s.notes, s.created_by, s.created_at, s.updated_at,
    (SELECT COUNT(*) FROM leak_appliances a
      WHERE a.org_id = s.org_id AND a.site_id = s.id AND a.status <> 'retired') AS appliance_count
  FROM leak_sites s`;

const APPLIANCE_COLUMNS = `id, org_id, site_id, name, location, category, refrigerant, refrigerant_class,
  full_charge_oz, full_charge_method, full_charge_range_low_oz, full_charge_range_high_oz, installed_on,
  manufacturer, model, serial_number, status, qr_token, qr_token_rotated_at, created_by, created_at, updated_at`;

const APPLIANCE_SELECT = `SELECT a.id, a.org_id, a.site_id, a.name, a.location, a.category, a.refrigerant,
    a.refrigerant_class, a.full_charge_oz, a.full_charge_method, a.full_charge_range_low_oz,
    a.full_charge_range_high_oz, a.installed_on, a.manufacturer, a.model, a.serial_number, a.status,
    a.qr_token, a.qr_token_rotated_at, a.created_by, a.created_at, a.updated_at,
    (SELECT MAX(e.service_date) FROM leak_service_events e
      WHERE e.org_id = a.org_id AND e.appliance_id = a.id AND e.voided_at IS NULL) AS last_service_date
  FROM leak_appliances a`;

const EVENT_COLUMNS = `id, org_id, site_id, appliance_id, service_date, kind, technician_name, component,
  work_performed, added_oz, recovered_oz, returned_oz, full_charge_oz, verification_passed, notes,
  logged_by, logged_via, voided_at, void_reason, voided_by, created_at`;

export function createLeakRepository(executor: SqlExecutor): LeakRepository {
  async function one(sql: string, params: unknown[]): Promise<Row | null> {
    const result = await executor.execute<Row>(sql, params);
    return result.rows[0] ?? null;
  }

  function siteParams(f: LeakSiteFields): unknown[] {
    return [
      f.name,
      f.customerName,
      f.addressLine1,
      f.addressLine2,
      f.city,
      f.region,
      f.postalCode,
      f.country,
      f.ownerContactName,
      f.ownerContactEmail,
      f.leakRateMethod,
      f.status,
      f.notes,
    ];
  }

  function applianceParams(f: ApplianceFields): unknown[] {
    return [
      f.name,
      f.location,
      f.category,
      f.refrigerant,
      f.refrigerantClass,
      f.fullChargeOz,
      f.fullChargeMethod,
      f.fullChargeRangeLowOz,
      f.fullChargeRangeHighOz,
      f.installedOn,
      f.manufacturer,
      f.model,
      f.serialNumber,
      f.status,
    ];
  }

  async function getSite(orgId: string, siteId: string): Promise<LeakSite | null> {
    const row = await one(`${SITE_SELECT} WHERE s.org_id = $1 AND s.id = $2`, [orgId, siteId]);
    return row ? mapSite(row) : null;
  }

  async function getAppliance(orgId: string, applianceId: string): Promise<Appliance | null> {
    const row = await one(`${APPLIANCE_SELECT} WHERE a.org_id = $1 AND a.id = $2`, [orgId, applianceId]);
    return row ? mapAppliance(row) : null;
  }

  return {
    async createSite(input: CreateLeakSiteInput) {
      const row = await one(
        `INSERT INTO leak_sites
           (id, org_id, name, customer_name, address_line1, address_line2, city, region, postal_code,
            country, owner_contact_name, owner_contact_email, leak_rate_method, status, notes,
            created_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $17)
         RETURNING ${SITE_COLUMNS}`,
        [input.id, input.orgId, ...siteParams(input), input.createdBy, input.now],
      );
      if (!row) throw new Error("leak: site insert returned no row");
      return mapSite({ ...row, appliance_count: 0 });
    },

    getSite,

    async listSites(orgId, status) {
      const params: unknown[] = [orgId];
      let where = "s.org_id = $1";
      if (status) {
        params.push(status);
        where += " AND s.status = $2";
      }
      const result = await executor.execute<Row>(
        `${SITE_SELECT} WHERE ${where} ORDER BY s.name ASC, s.id ASC LIMIT 1000`,
        params,
      );
      return result.rows.map(mapSite);
    },

    async updateSite(orgId, siteId, fields: LeakSiteFields, now) {
      const row = await one(
        `UPDATE leak_sites SET
           name = $3, customer_name = $4, address_line1 = $5, address_line2 = $6, city = $7,
           region = $8, postal_code = $9, country = $10, owner_contact_name = $11,
           owner_contact_email = $12, leak_rate_method = $13, status = $14, notes = $15, updated_at = $16
         WHERE org_id = $1 AND id = $2
         RETURNING id`,
        [orgId, siteId, ...siteParams(fields), now],
      );
      return row ? getSite(orgId, siteId) : null;
    },

    async createAppliance(input: CreateApplianceInput) {
      const row = await one(
        `INSERT INTO leak_appliances
           (id, org_id, site_id, name, location, category, refrigerant, refrigerant_class,
            full_charge_oz, full_charge_method, full_charge_range_low_oz, full_charge_range_high_oz,
            installed_on, manufacturer, model, serial_number, status, qr_token,
            created_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $20)
         RETURNING ${APPLIANCE_COLUMNS}`,
        [input.id, input.orgId, input.siteId, ...applianceParams(input), input.qrToken, input.createdBy, input.now],
      );
      if (!row) throw new Error("leak: appliance insert returned no row");
      return mapAppliance({ ...row, last_service_date: null });
    },

    getAppliance,

    async findApplianceByQrToken(qrToken) {
      const row = await one(`${APPLIANCE_SELECT} WHERE a.qr_token = $1`, [qrToken]);
      return row ? mapAppliance(row) : null;
    },

    async listAppliancesForSite(orgId, siteId) {
      const result = await executor.execute<Row>(
        `${APPLIANCE_SELECT} WHERE a.org_id = $1 AND a.site_id = $2 ORDER BY a.name ASC, a.id ASC LIMIT 1000`,
        [orgId, siteId],
      );
      return result.rows.map(mapAppliance);
    },

    async updateAppliance(orgId, applianceId, fields: ApplianceFields, now) {
      const row = await one(
        `UPDATE leak_appliances SET
           name = $3, location = $4, category = $5, refrigerant = $6, refrigerant_class = $7,
           full_charge_oz = $8, full_charge_method = $9, full_charge_range_low_oz = $10,
           full_charge_range_high_oz = $11, installed_on = $12, manufacturer = $13, model = $14,
           serial_number = $15, status = $16, updated_at = $17
         WHERE org_id = $1 AND id = $2
         RETURNING id`,
        [orgId, applianceId, ...applianceParams(fields), now],
      );
      return row ? getAppliance(orgId, applianceId) : null;
    },

    async rotateQrToken(orgId, applianceId, qrToken, now) {
      const row = await one(
        `UPDATE leak_appliances SET qr_token = $3, qr_token_rotated_at = $4, updated_at = $4
          WHERE org_id = $1 AND id = $2
          RETURNING id`,
        [orgId, applianceId, qrToken, now],
      );
      return row ? getAppliance(orgId, applianceId) : null;
    },

    async createServiceEvent(input: CreateServiceEventInput) {
      const row = await one(
        `INSERT INTO leak_service_events
           (id, org_id, site_id, appliance_id, service_date, kind, technician_name, component,
            work_performed, added_oz, recovered_oz, returned_oz, full_charge_oz, verification_passed,
            notes, logged_by, logged_via, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
         RETURNING ${EVENT_COLUMNS}`,
        [
          input.id,
          input.orgId,
          input.siteId,
          input.applianceId,
          input.serviceDate,
          input.kind,
          input.technicianName,
          input.component,
          input.workPerformed,
          input.addedOz,
          input.recoveredOz,
          input.returnedOz,
          input.fullChargeOz,
          input.verificationPassed === null ? null : input.verificationPassed ? 1 : 0,
          input.notes,
          input.loggedBy,
          input.loggedVia,
          input.now,
        ],
      );
      if (!row) throw new Error("leak: service event insert returned no row");
      return mapEvent(row);
    },

    async getServiceEvent(orgId, applianceId, eventId) {
      const row = await one(
        `SELECT ${EVENT_COLUMNS} FROM leak_service_events WHERE org_id = $1 AND appliance_id = $2 AND id = $3`,
        [orgId, applianceId, eventId],
      );
      return row ? mapEvent(row) : null;
    },

    async listServiceEvents(orgId, applianceId, page: ListEventsPage) {
      const params: unknown[] = [orgId, applianceId];
      let where = "org_id = $1 AND appliance_id = $2";
      if (page.before) {
        params.push(page.before.serviceDate, page.before.createdAt, page.before.id);
        where +=
          " AND (service_date < $3 OR (service_date = $3 AND (created_at < $4 OR (created_at = $4 AND id < $5))))";
      }
      params.push(page.limit);
      const result = await executor.execute<Row>(
        `SELECT ${EVENT_COLUMNS} FROM leak_service_events WHERE ${where}
          ORDER BY service_date DESC, created_at DESC, id DESC
          LIMIT $${params.length}`,
        params,
      );
      return result.rows.map(mapEvent);
    },

    async voidServiceEvent(orgId, applianceId, eventId, reason, voidedBy, now) {
      const row = await one(
        `UPDATE leak_service_events SET voided_at = $4, void_reason = $5, voided_by = $6
          WHERE org_id = $1 AND appliance_id = $2 AND id = $3 AND voided_at IS NULL
          RETURNING ${EVENT_COLUMNS}`,
        [orgId, applianceId, eventId, now, reason, voidedBy],
      );
      return row ? mapEvent(row) : null;
    },
  };
}
