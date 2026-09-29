import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { allowed } from "../authz.js";
import { recordAudit } from "../audit.js";
import { nowIso, openDb, todayUtc, type Db } from "../context.js";
import { CSV_HEADER, csvCell, csvRows, renderSiteRecordPdf, sha256Hex, type SiteRecord } from "../export.js";
import { errorResponse, notFound, successResponse, unavailable } from "../http.js";
import { actorSubjectUuid, exportPublicId, orgPublicId, sitePublicId } from "../ids.js";
import { toPublicExport } from "../present.js";

async function loadSiteRecord(db: Db, orgId: string, siteId: string): Promise<SiteRecord | null> {
  const site = await db.leak.getSite(orgId, siteId);
  if (!site) return null;
  const [appliances, clocks] = await Promise.all([
    db.leak.listAppliancesForSite(orgId, siteId),
    db.clocks.listClocksForSite(orgId, siteId),
  ]);
  const withEvents = [];
  for (const appliance of appliances) {
    withEvents.push({
      appliance,
      events: await db.leak.listEventsInLogOrder(orgId, appliance.id),
      clocks: clocks.filter((c) => c.applianceId === appliance.id),
    });
  }
  return { site, appliances: withEvents };
}

/**
 * POST /v1/organizations/{org}/sites/{ste}/exports — render the site's
 * inspection PDF, store it in R2 at orgs/{org}/exports/{exp}.pdf, and record
 * its SHA-256. 201 { export }.
 */
export async function handleCreateExport(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  siteId: string,
): Promise<Response> {
  if (!(await allowed(env, actor, orgId, "leak.write", requestId))) return notFound(requestId);
  if (!env.EXPORTS) return errorResponse("internal_error", "Export storage unavailable", 503, requestId);
  const db = openDb(env);
  if (!db) return unavailable(requestId);
  const now = nowIso();
  try {
    const record = await loadSiteRecord(db, orgId, siteId);
    if (!record) return notFound(requestId);
    const bytes = renderSiteRecordPdf(record, todayUtc());
    const sha256 = await sha256Hex(bytes);
    const id = crypto.randomUUID();
    const objectKey = `orgs/${orgPublicId(orgId)}/exports/${exportPublicId(id)}.pdf`;
    await env.EXPORTS.put(objectKey, bytes, {
      httpMetadata: { contentType: "application/pdf" },
      customMetadata: { sha256, siteId: sitePublicId(siteId) },
      sha256,
    });
    const created = await db.clocks.createExport({
      id,
      orgId,
      siteId,
      objectKey,
      sha256,
      sizeBytes: bytes.byteLength,
      createdBy: actorSubjectUuid(actor.subjectId),
      createdAt: now,
    });
    await recordAudit(db.executor, {
      type: "leak.export.created",
      orgId,
      actor: { type: actor.subjectType, id: actor.subjectId },
      requestId,
      subjectKind: "leak_export",
      subjectId: created.id,
      subjectName: `${record.site.name} — ${now.slice(0, 10)}`,
      description: `Exported the leak-repair record of "${record.site.name}" as a PDF`,
      payload: {
        exportId: exportPublicId(created.id),
        siteId: sitePublicId(siteId),
        sha256,
        sizeBytes: created.sizeBytes,
        appliances: record.appliances.length,
      },
      occurredAt: now,
    });
    return successResponse({ export: toPublicExport(created) }, requestId, 201);
  } catch {
    return unavailable(requestId);
  } finally {
    await db.dispose();
  }
}

/** GET /v1/organizations/{org}/exports/{exp} — the stored PDF, with x-content-sha256. */
export async function handleGetExport(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  exportId: string,
): Promise<Response> {
  if (!(await allowed(env, actor, orgId, "leak.read", requestId))) return notFound(requestId);
  if (!env.EXPORTS) return errorResponse("internal_error", "Export storage unavailable", 503, requestId);
  const db = openDb(env);
  if (!db) return unavailable(requestId);
  try {
    const row = await db.clocks.getExport(orgId, exportId);
    if (!row) return notFound(requestId);
    const object = await env.EXPORTS.get(row.objectKey);
    if (!object) return notFound(requestId);
    return new Response(object.body, {
      status: 200,
      headers: {
        "content-type": "application/pdf",
        "content-length": String(row.sizeBytes),
        "content-disposition": `attachment; filename="leakbook-${exportPublicId(row.id)}.pdf"`,
        "x-content-sha256": row.sha256,
        "cache-control": "private, no-store",
        "x-request-id": requestId,
      },
    });
  } catch {
    return unavailable(requestId);
  } finally {
    await db.dispose();
  }
}

/** GET /v1/organizations/{org}/sites/{ste}/export.csv — every service event at the site, streamed one appliance at a time. */
export async function handleExportCsv(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  siteId: string,
): Promise<Response> {
  if (!(await allowed(env, actor, orgId, "leak.read", requestId))) return notFound(requestId);
  const db = openDb(env);
  if (!db) return unavailable(requestId);
  let site;
  let appliances;
  try {
    site = await db.leak.getSite(orgId, siteId);
    if (!site) {
      await db.dispose();
      return notFound(requestId);
    }
    appliances = await db.leak.listAppliancesForSite(orgId, siteId);
  } catch {
    await db.dispose();
    return unavailable(requestId);
  }
  const encoder = new TextEncoder();
  const theSite = site;
  const list = appliances;
  let i = -1;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (i === -1) {
          controller.enqueue(encoder.encode(`${CSV_HEADER.map(csvCell).join(",")}\r\n`));
          i = 0;
          return;
        }
        const appliance = list[i];
        if (!appliance) {
          controller.close();
          await db.dispose();
          return;
        }
        i += 1;
        const events = await db.leak.listEventsInLogOrder(orgId, appliance.id);
        if (events.length) controller.enqueue(encoder.encode(csvRows(theSite, appliance, events)));
      } catch (err) {
        controller.error(err);
        await db.dispose();
      }
    },
  });
  const slug = theSite.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "site";
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="leakbook-${slug}.csv"`,
      "cache-control": "private, no-store",
      "x-request-id": requestId,
    },
  });
}
