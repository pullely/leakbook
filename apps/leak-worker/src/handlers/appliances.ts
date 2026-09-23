import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { allowed } from "../authz.js";
import { recordAudit } from "../audit.js";
import { nowIso, openDb, todayUtc } from "../context.js";
import { errorResponse, notFound, successResponse, unavailable, validationError } from "../http.js";
import { actorSubjectUuid, appliancePublicId, generateQrToken, sitePublicId } from "../ids.js";
import { toPublicAppliance, toPublicEvent, toPublicSite } from "../present.js";
import { validateApplianceBody } from "../validate.js";
import { readJson } from "./json.js";

/** How many service events the appliance page carries inline, newest first. */
export const APPLIANCE_EVENTS_INLINE = 50;

export async function handleCreateAppliance(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  siteId: string,
): Promise<Response> {
  const parsed = await readJson(request);
  if (!parsed.ok) return validationError(requestId, { body: ["Invalid JSON"] });
  const validation = validateApplianceBody(parsed.body, null, todayUtc());
  if (!validation.valid) return validationError(requestId, validation.fields);
  if (!(await allowed(env, actor, orgId, "leak.write", requestId))) return notFound(requestId);

  const db = openDb(env);
  if (!db) return unavailable(requestId);
  const now = nowIso();
  try {
    const site = await db.leak.getSite(orgId, siteId);
    if (!site) return notFound(requestId);
    if (site.status === "archived") {
      return errorResponse("conflict", "The site is archived; restore it before adding appliances", 409, requestId);
    }
    const appliance = await db.leak.createAppliance({
      id: crypto.randomUUID(),
      orgId,
      siteId,
      ...validation.value,
      qrToken: generateQrToken(),
      createdBy: actorSubjectUuid(actor.subjectId),
      now,
    });
    await recordAudit(db.executor, {
      type: "leak.appliance.created",
      orgId,
      actor: { type: actor.subjectType, id: actor.subjectId },
      requestId,
      subjectKind: "leak_appliance",
      subjectId: appliance.id,
      subjectName: appliance.name,
      description: `Registered "${appliance.name}" (${appliance.refrigerant}, ${appliance.fullChargeOz} oz) at ${site.name}`,
      payload: {
        applianceId: appliancePublicId(appliance.id),
        siteId: sitePublicId(site.id),
        category: appliance.category,
        refrigerant: appliance.refrigerant,
        refrigerantClass: appliance.refrigerantClass,
        fullChargeOz: appliance.fullChargeOz,
        fullChargeMethod: appliance.fullChargeMethod,
      },
      occurredAt: now,
    });
    return successResponse({ appliance: toPublicAppliance(appliance) }, requestId, 201);
  } catch {
    return unavailable(requestId);
  } finally {
    await db.dispose();
  }
}

export async function handleGetAppliance(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  applianceId: string,
): Promise<Response> {
  if (!(await allowed(env, actor, orgId, "leak.read", requestId))) return notFound(requestId);
  const db = openDb(env);
  if (!db) return unavailable(requestId);
  try {
    const appliance = await db.leak.getAppliance(orgId, applianceId);
    if (!appliance) return notFound(requestId);
    const [site, events] = await Promise.all([
      db.leak.getSite(orgId, appliance.siteId),
      db.leak.listServiceEvents(orgId, applianceId, { limit: APPLIANCE_EVENTS_INLINE }),
    ]);
    if (!site) return notFound(requestId);
    return successResponse(
      { appliance: toPublicAppliance(appliance), site: toPublicSite(site), events: events.map(toPublicEvent) },
      requestId,
    );
  } catch {
    return unavailable(requestId);
  } finally {
    await db.dispose();
  }
}

export async function handleUpdateAppliance(
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
  const now = nowIso();
  try {
    const current = await db.leak.getAppliance(orgId, applianceId);
    if (!current) return notFound(requestId);
    const validation = validateApplianceBody(parsed.body, current, todayUtc());
    if (!validation.valid) return validationError(requestId, validation.fields);
    const appliance = await db.leak.updateAppliance(orgId, applianceId, validation.value, now);
    if (!appliance) return notFound(requestId);

    const changed = (Object.keys(validation.value) as (keyof typeof validation.value)[]).filter(
      (k) => validation.value[k] !== current[k],
    );
    // A full-charge revision is a record the rule requires: old value, new value,
    // how it was determined, and when (40 CFR 84.106(l)(1)(v)).
    const fullChargeRevision =
      current.fullChargeOz !== appliance.fullChargeOz || current.fullChargeMethod !== appliance.fullChargeMethod
        ? {
            fromOz: current.fullChargeOz,
            toOz: appliance.fullChargeOz,
            fromMethod: current.fullChargeMethod,
            toMethod: appliance.fullChargeMethod,
          }
        : null;
    const classChange =
      current.refrigerantClass !== appliance.refrigerantClass || current.refrigerant !== appliance.refrigerant
        ? { from: `${current.refrigerant} (${current.refrigerantClass})`, to: `${appliance.refrigerant} (${appliance.refrigerantClass})` }
        : null;
    await recordAudit(db.executor, {
      type: "leak.appliance.updated",
      orgId,
      actor: { type: actor.subjectType, id: actor.subjectId },
      requestId,
      subjectKind: "leak_appliance",
      subjectId: appliance.id,
      subjectName: appliance.name,
      description: `Updated "${appliance.name}"${changed.length ? ` (${changed.join(", ")})` : ""}`,
      payload: {
        applianceId: appliancePublicId(appliance.id),
        changed,
        status: appliance.status,
        fullChargeRevision,
        refrigerantChange: classChange,
      },
      occurredAt: now,
    });
    return successResponse({ appliance: toPublicAppliance(appliance) }, requestId);
  } catch {
    return unavailable(requestId);
  } finally {
    await db.dispose();
  }
}

export async function handleRotateQrToken(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  applianceId: string,
): Promise<Response> {
  if (!(await allowed(env, actor, orgId, "leak.write", requestId))) return notFound(requestId);
  const db = openDb(env);
  if (!db) return unavailable(requestId);
  const now = nowIso();
  try {
    const appliance = await db.leak.rotateQrToken(orgId, applianceId, generateQrToken(), now);
    if (!appliance) return notFound(requestId);
    await recordAudit(db.executor, {
      type: "leak.appliance.qr_rotated",
      orgId,
      actor: { type: actor.subjectType, id: actor.subjectId },
      requestId,
      subjectKind: "leak_appliance",
      subjectId: appliance.id,
      subjectName: appliance.name,
      description: `Replaced the QR label of "${appliance.name}"; the old label no longer resolves`,
      payload: { applianceId: appliancePublicId(appliance.id) },
      occurredAt: now,
    });
    return successResponse({ appliance: toPublicAppliance(appliance) }, requestId);
  } catch {
    return unavailable(requestId);
  } finally {
    await db.dispose();
  }
}
