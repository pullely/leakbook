import type {
  LeakExportResponse,
  ListRepairClocksResponse,
  RepairClockResponse,
  RepairClockSweepResponse,
  UpdateRepairClockRequest,
  LeakRateResponse,
  ApplianceResponse,
  CreateApplianceRequest,
  CreateLeakSiteRequest,
  GetApplianceResponse,
  GetLeakSiteResponse,
  LeakSiteResponse,
  ListLeakSitesResponse,
  ListServiceEventsResponse,
  LogServiceEventRequest,
  ResolveQrResponse,
  ServiceEventResponse,
  UpdateApplianceRequest,
  UpdateLeakSiteRequest,
  VoidServiceEventRequest,
} from "@saas/contracts/leak";

import type { RequestOptions, Transport } from "./transport.js";

const org = (orgId: string): string => `/v1/organizations/${encodeURIComponent(orgId)}`;
const site = (orgId: string, siteId: string): string => `${org(orgId)}/sites/${encodeURIComponent(siteId)}`;
const appliance = (orgId: string, applianceId: string): string =>
  `${org(orgId)}/appliances/${encodeURIComponent(applianceId)}`;
const qr = (token: string): string => `/v1/qr/${encodeURIComponent(token)}`;

/**
 * Refrigerant log client — a contractor's customer sites, the appliances at
 * each, their QR labels and the service log. Maps to `apps/leak-worker`
 * through the api-edge leak facade. Quantities are integer ounces.
 */
export class LeakClient {
  constructor(private readonly transport: Transport) {}

  /** GET /v1/organizations/:orgId/sites */
  listSites(orgId: string, query: { status?: string } = {}, opts: RequestOptions = {}): Promise<ListLeakSitesResponse> {
    return this.transport.request<ListLeakSitesResponse>(
      { method: "GET", path: `${org(orgId)}/sites`, query: { status: query.status } },
      opts,
    );
  }

  /** POST /v1/organizations/:orgId/sites */
  createSite(orgId: string, body: CreateLeakSiteRequest, opts: RequestOptions = {}): Promise<LeakSiteResponse> {
    return this.transport.request<LeakSiteResponse>({ method: "POST", path: `${org(orgId)}/sites`, body }, opts);
  }

  /** GET /v1/organizations/:orgId/sites/:siteId — the site with its appliances. */
  getSite(orgId: string, siteId: string, opts: RequestOptions = {}): Promise<GetLeakSiteResponse> {
    return this.transport.request<GetLeakSiteResponse>({ method: "GET", path: site(orgId, siteId) }, opts);
  }

  /** PATCH /v1/organizations/:orgId/sites/:siteId */
  updateSite(orgId: string, siteId: string, body: UpdateLeakSiteRequest, opts: RequestOptions = {}): Promise<LeakSiteResponse> {
    return this.transport.request<LeakSiteResponse>({ method: "PATCH", path: site(orgId, siteId), body }, opts);
  }

  /** POST /v1/organizations/:orgId/sites/:siteId/appliances */
  createAppliance(
    orgId: string,
    siteId: string,
    body: CreateApplianceRequest,
    opts: RequestOptions = {},
  ): Promise<ApplianceResponse> {
    return this.transport.request<ApplianceResponse>(
      { method: "POST", path: `${site(orgId, siteId)}/appliances`, body },
      opts,
    );
  }

  /** GET /v1/organizations/:orgId/appliances/:applianceId — the appliance, its site and the latest 50 events. */
  getAppliance(orgId: string, applianceId: string, opts: RequestOptions = {}): Promise<GetApplianceResponse> {
    return this.transport.request<GetApplianceResponse>({ method: "GET", path: appliance(orgId, applianceId) }, opts);
  }

  /** PATCH /v1/organizations/:orgId/appliances/:applianceId */
  updateAppliance(
    orgId: string,
    applianceId: string,
    body: UpdateApplianceRequest,
    opts: RequestOptions = {},
  ): Promise<ApplianceResponse> {
    return this.transport.request<ApplianceResponse>(
      { method: "PATCH", path: appliance(orgId, applianceId), body },
      opts,
    );
  }

  /** POST /v1/organizations/:orgId/appliances/:applianceId/qr-token — a new label; the old one stops resolving. */
  rotateQrToken(orgId: string, applianceId: string, opts: RequestOptions = {}): Promise<ApplianceResponse> {
    return this.transport.request<ApplianceResponse>(
      { method: "POST", path: `${appliance(orgId, applianceId)}/qr-token`, body: {} },
      opts,
    );
  }

  /** GET /v1/organizations/:orgId/appliances/:applianceId/events — newest first, 50 per page. */
  listEvents(
    orgId: string,
    applianceId: string,
    query: { cursor?: string } = {},
    opts: RequestOptions = {},
  ): Promise<ListServiceEventsResponse> {
    return this.transport.request<ListServiceEventsResponse>(
      { method: "GET", path: `${appliance(orgId, applianceId)}/events`, query: { cursor: query.cursor } },
      opts,
    );
  }

  /** POST /v1/organizations/:orgId/appliances/:applianceId/events */
  logEvent(
    orgId: string,
    applianceId: string,
    body: LogServiceEventRequest,
    opts: RequestOptions = {},
  ): Promise<ServiceEventResponse> {
    return this.transport.request<ServiceEventResponse>(
      { method: "POST", path: `${appliance(orgId, applianceId)}/events`, body },
      opts,
    );
  }

  /** POST /v1/organizations/:orgId/appliances/:applianceId/events/:eventId/void */
  voidEvent(
    orgId: string,
    applianceId: string,
    eventId: string,
    body: VoidServiceEventRequest,
    opts: RequestOptions = {},
  ): Promise<ServiceEventResponse> {
    return this.transport.request<ServiceEventResponse>(
      { method: "POST", path: `${appliance(orgId, applianceId)}/events/${encodeURIComponent(eventId)}/void`, body },
      opts,
    );
  }

  /** GET /v1/organizations/:orgId/appliances/:applianceId/leak-rate — applicability, latest rate, chronic flag (LB2). */
  getLeakRate(orgId: string, applianceId: string, opts: RequestOptions = {}): Promise<LeakRateResponse> {
    return this.transport.request<LeakRateResponse>(
      { method: "GET", path: `${appliance(orgId, applianceId)}/leak-rate` },
      opts,
    );
  }

  /** GET /v1/organizations/:orgId/repair-clocks — overdue first, then by the nearest deadline (LB3). */
  listRepairClocks(
    orgId: string,
    query: { status?: "open" | "overdue" | "suspended" | "closed" } = {},
    opts: RequestOptions = {},
  ): Promise<ListRepairClocksResponse> {
    return this.transport.request<ListRepairClocksResponse>(
      { method: "GET", path: `/v1/organizations/${encodeURIComponent(orgId)}/repair-clocks`, query: { status: query.status } },
      opts,
    );
  }

  /** PATCH /v1/organizations/:orgId/repair-clocks/:clockId — shutdownRequired, notes. */
  updateRepairClock(
    orgId: string,
    clockId: string,
    body: UpdateRepairClockRequest,
    opts: RequestOptions = {},
  ): Promise<RepairClockResponse> {
    return this.transport.request<RepairClockResponse>(
      {
        method: "PATCH",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/repair-clocks/${encodeURIComponent(clockId)}`,
        body,
      },
      opts,
    );
  }

  /** POST /v1/organizations/:orgId/repair-clocks/sweep — run today's reminder pass now (idempotent). */
  runRepairClockSweep(orgId: string, opts: RequestOptions = {}): Promise<RepairClockSweepResponse> {
    return this.transport.request<RepairClockSweepResponse>(
      { method: "POST", path: `/v1/organizations/${encodeURIComponent(orgId)}/repair-clocks/sweep`, body: {} },
      opts,
    );
  }

  /** POST /v1/organizations/:orgId/sites/:siteId/exports — the site's inspection PDF, stored in R2. */
  createSiteExport(orgId: string, siteId: string, opts: RequestOptions = {}): Promise<LeakExportResponse> {
    return this.transport.request<LeakExportResponse>(
      {
        method: "POST",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/sites/${encodeURIComponent(siteId)}/exports`,
        body: {},
      },
      opts,
    );
  }

  /** GET /v1/qr/:token — what a scanned label opens. 404 unless the caller is a member of the owning organization. */
  resolveQr(token: string, opts: RequestOptions = {}): Promise<ResolveQrResponse> {
    return this.transport.request<ResolveQrResponse>({ method: "GET", path: qr(token) }, opts);
  }

  /** POST /v1/qr/:token/events — log from the phone page. */
  logEventByQr(token: string, body: LogServiceEventRequest, opts: RequestOptions = {}): Promise<ServiceEventResponse> {
    return this.transport.request<ServiceEventResponse>({ method: "POST", path: `${qr(token)}/events`, body }, opts);
  }
}
