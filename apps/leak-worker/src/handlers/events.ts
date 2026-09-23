import { SERVICE_EVENT_KIND_LABELS } from "@saas/contracts/leak";
import type { Appliance, ApplianceFields } from "@saas/db/leak";
import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { allowed } from "../authz.js";
import { recordAudit } from "../audit.js";
import { nowIso, openDb, todayUtc, type Db } from "../context.js";
import { errorResponse, notFound, pagedResponse, successResponse, unavailable, validationError } from "../http.js";
import { actorSubjectUuid, appliancePublicId, eventPublicId, sitePublicId } from "../ids.js";
import { toPublicEvent } from "../present.js";
import { statusAfterEvent, validateServiceEvent, validateVoid } from "../validate.js";
import { readJson } from "./json.js";

const PAGE_SIZE = 50;

function applianceFields(a: Appliance): ApplianceFields {
  return {
    name: a.name,
    location: a.location,
    category: a.category,
    refrigerant: a.refrigerant,
    refrigerantClass: a.refrigerantClass,
    fullChargeOz: a.fullChargeOz,
    fullChargeMethod: a.fullChargeMethod,
    fullChargeRangeLowOz: a.fullChargeRangeLowOz,
    fullChargeRangeHighOz: a.fullChargeRangeHighOz,
    installedOn: a.installedOn,
    manufacturer: a.manufacturer,
    model: a.model,
    serialNumber: a.serialNumber,
    status: a.status,
  };
}

interface Cursor {
  serviceDate: string;
  createdAt: string;
  id: string;
}

function encodeCursor(c: Cursor): string {
  return btoa(JSON.stringify([c.serviceDate, c.createdAt, c.id])).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeCursor(raw: string): Cursor | null {
  try {
    const padded = raw.replace(/-/g, "+").replace(/_/g, "/");
    const parsed = JSON.parse(atob(padded + "===".slice((padded.length + 3) % 4))) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 3 || !parsed.every((v) => typeof v === "string")) return null;
    const [serviceDate, createdAt, id] = parsed as [string, string, string];
    return { serviceDate, createdAt, id };
  } catch {
    return null;
  }
}

export async function handleListEvents(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  applianceId: string,
): Promise<Response> {
  const rawCursor = new URL(request.url).searchParams.get("cursor");
  const before = rawCursor ? decodeCursor(rawCursor) : null;
  if (rawCursor && !before) return validationError(requestId, { cursor: ["Not a cursor this API issued"] });
  if (!(await allowed(env, actor, orgId, "leak.read", requestId))) return notFound(requestId);
  const db = openDb(env);
  if (!db) return unavailable(requestId);
  try {
    const appliance = await db.leak.getAppliance(orgId, applianceId);
    if (!appliance) return notFound(requestId);
    const rows = await db.leak.listServiceEvents(orgId, applianceId, { before, limit: PAGE_SIZE + 1 });
    const page = rows.slice(0, PAGE_SIZE);
    const last = page[page.length - 1];
    const next = rows.length > PAGE_SIZE && last ? encodeCursor(last) : null;
    return pagedResponse({ events: page.map(toPublicEvent) }, requestId, next);
  } catch {
    return unavailable(requestId);
  } finally {
    await db.dispose();
  }
}

/**
 * Log a service event against an appliance the caller may write. Shared by the
 * console route and the QR route: the QR route has already resolved the token
 * to `appliance` and authorized the caller against its organization.
 */
export async function logEvent(
  body: unknown,
  db: Db,
  requestId: string,
  actor: ActorContext,
  appliance: Appliance,
): Promise<Response> {
  if (appliance.status === "retired") {
    return errorResponse("conflict", "The appliance is retired; it accepts no further service events", 409, requestId);
  }
  const validation = validateServiceEvent(body, appliance, todayUtc());
  if (!validation.valid) return validationError(requestId, validation.fields);
  const v = validation.value;
  const now = nowIso();
  const orgId = appliance.orgId;

  const event = await db.leak.createServiceEvent({
    id: crypto.randomUUID(),
    orgId,
    siteId: appliance.siteId,
    applianceId: appliance.id,
    ...v,
    fullChargeOz: appliance.fullChargeOz,
    loggedBy: actorSubjectUuid(actor.subjectId),
    now,
  });

  const nextStatus = statusAfterEvent(appliance.status, v.kind, v.addedOz);
  if (nextStatus !== appliance.status) {
    await db.leak.updateAppliance(orgId, appliance.id, { ...applianceFields(appliance), status: nextStatus }, now);
  }

  const leakOz = event.addedOz - event.returnedOz;
  await recordAudit(db.executor, {
    type: "leak.event.logged",
    orgId,
    actor: { type: actor.subjectType, id: actor.subjectId },
    requestId,
    subjectKind: "leak_service_event",
    subjectId: event.id,
    subjectName: `${appliance.name} — ${event.serviceDate}`,
    description: `Logged ${SERVICE_EVENT_KIND_LABELS[v.kind].toLowerCase()} on "${appliance.name}" for ${event.serviceDate}${
      event.addedOz > 0 ? ` (+${event.addedOz} oz${event.returnedOz > 0 ? `, ${event.returnedOz} oz returned` : ""})` : ""
    }`,
    payload: {
      eventId: eventPublicId(event.id),
      applianceId: appliancePublicId(appliance.id),
      siteId: sitePublicId(appliance.siteId),
      kind: event.kind,
      serviceDate: event.serviceDate,
      addedOz: event.addedOz,
      recoveredOz: event.recoveredOz,
      returnedOz: event.returnedOz,
      leakOz,
      fullChargeOz: event.fullChargeOz,
      loggedVia: event.loggedVia,
      applianceStatus: nextStatus,
    },
    occurredAt: now,
  });
  return successResponse({ event: toPublicEvent(event) }, requestId, 201);
}

export async function handleCreateEvent(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  applianceId: string,
): Promise<Response> {
  const parsed = await readJson(request);
  if (!parsed.ok) return validationError(requestId, { body: ["Invalid JSON"] });
  if (!(await allowed(env, actor, orgId, "leak.write", requestId))) return notFound(requestId);
  const db = openDb(env);
  if (!db) return unavailable(requestId);
  try {
    const appliance = await db.leak.getAppliance(orgId, applianceId);
    if (!appliance) return notFound(requestId);
    return await logEvent(parsed.body, db, requestId, actor, appliance);
  } catch {
    return unavailable(requestId);
  } finally {
    await db.dispose();
  }
}

export async function handleVoidEvent(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  applianceId: string,
  eventId: string,
): Promise<Response> {
  const parsed = await readJson(request);
  if (!parsed.ok) return validationError(requestId, { body: ["Invalid JSON"] });
  const validation = validateVoid(parsed.body);
  if (!validation.valid) return validationError(requestId, validation.fields);
  if (!(await allowed(env, actor, orgId, "leak.write", requestId))) return notFound(requestId);
  const db = openDb(env);
  if (!db) return unavailable(requestId);
  const now = nowIso();
  try {
    const voided = await db.leak.voidServiceEvent(
      orgId,
      applianceId,
      eventId,
      validation.value.reason,
      actorSubjectUuid(actor.subjectId),
      now,
    );
    if (!voided) {
      const existing = await db.leak.getServiceEvent(orgId, applianceId, eventId);
      if (!existing) return notFound(requestId);
      return errorResponse("conflict", "The event is already voided", 409, requestId);
    }
    await recordAudit(db.executor, {
      type: "leak.event.voided",
      orgId,
      actor: { type: actor.subjectType, id: actor.subjectId },
      requestId,
      subjectKind: "leak_service_event",
      subjectId: voided.id,
      subjectName: voided.serviceDate,
      description: `Voided the ${voided.serviceDate} ${voided.kind} event: ${validation.value.reason}`,
      payload: {
        eventId: eventPublicId(voided.id),
        applianceId: appliancePublicId(voided.applianceId),
        reason: validation.value.reason,
        addedOz: voided.addedOz,
        returnedOz: voided.returnedOz,
      },
      occurredAt: now,
    });
    return successResponse({ event: toPublicEvent(voided) }, requestId);
  } catch {
    return unavailable(requestId);
  } finally {
    await db.dispose();
  }
}
