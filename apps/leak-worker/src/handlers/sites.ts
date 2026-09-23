import { LEAK_SITE_STATUSES } from "@saas/contracts/leak";
import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { allowed } from "../authz.js";
import { recordAudit } from "../audit.js";
import { nowIso, openDb } from "../context.js";
import { notFound, successResponse, unavailable, validationError } from "../http.js";
import { actorSubjectUuid, sitePublicId } from "../ids.js";
import { toPublicAppliance, toPublicSite } from "../present.js";
import { validateSiteBody } from "../validate.js";
import { readJson } from "./json.js";

export async function handleListSites(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
): Promise<Response> {
  const status = new URL(request.url).searchParams.get("status") ?? undefined;
  if (status !== undefined && !(LEAK_SITE_STATUSES as readonly string[]).includes(status)) {
    return validationError(requestId, { status: [`One of ${LEAK_SITE_STATUSES.join(", ")}`] });
  }
  if (!(await allowed(env, actor, orgId, "leak.read", requestId))) return notFound(requestId);
  const db = openDb(env);
  if (!db) return unavailable(requestId);
  try {
    const sites = await db.leak.listSites(orgId, status);
    return successResponse({ sites: sites.map(toPublicSite) }, requestId);
  } catch {
    return unavailable(requestId);
  } finally {
    await db.dispose();
  }
}

export async function handleCreateSite(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
): Promise<Response> {
  const parsed = await readJson(request);
  if (!parsed.ok) return validationError(requestId, { body: ["Invalid JSON"] });
  const validation = validateSiteBody(parsed.body, null);
  if (!validation.valid) return validationError(requestId, validation.fields);
  if (!(await allowed(env, actor, orgId, "leak.write", requestId))) return notFound(requestId);

  const db = openDb(env);
  if (!db) return unavailable(requestId);
  const now = nowIso();
  try {
    const site = await db.leak.createSite({
      id: crypto.randomUUID(),
      orgId,
      ...validation.value,
      createdBy: actorSubjectUuid(actor.subjectId),
      now,
    });
    await recordAudit(db.executor, {
      type: "leak.site.created",
      orgId,
      actor: { type: actor.subjectType, id: actor.subjectId },
      requestId,
      subjectKind: "leak_site",
      subjectId: site.id,
      subjectName: site.name,
      description: `Added the site "${site.name}" for ${site.customerName}`,
      payload: { siteId: sitePublicId(site.id), customerName: site.customerName, leakRateMethod: site.leakRateMethod },
      occurredAt: now,
    });
    return successResponse({ site: toPublicSite(site) }, requestId, 201);
  } catch {
    return unavailable(requestId);
  } finally {
    await db.dispose();
  }
}

export async function handleGetSite(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  siteId: string,
): Promise<Response> {
  if (!(await allowed(env, actor, orgId, "leak.read", requestId))) return notFound(requestId);
  const db = openDb(env);
  if (!db) return unavailable(requestId);
  try {
    const site = await db.leak.getSite(orgId, siteId);
    if (!site) return notFound(requestId);
    const appliances = await db.leak.listAppliancesForSite(orgId, siteId);
    return successResponse({ site: toPublicSite(site), appliances: appliances.map(toPublicAppliance) }, requestId);
  } catch {
    return unavailable(requestId);
  } finally {
    await db.dispose();
  }
}

export async function handleUpdateSite(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  siteId: string,
): Promise<Response> {
  const parsed = await readJson(request);
  if (!parsed.ok) return validationError(requestId, { body: ["Invalid JSON"] });
  if (!(await allowed(env, actor, orgId, "leak.write", requestId))) return notFound(requestId);
  const db = openDb(env);
  if (!db) return unavailable(requestId);
  const now = nowIso();
  try {
    const current = await db.leak.getSite(orgId, siteId);
    if (!current) return notFound(requestId);
    const validation = validateSiteBody(parsed.body, current);
    if (!validation.valid) return validationError(requestId, validation.fields);
    const site = await db.leak.updateSite(orgId, siteId, validation.value, now);
    if (!site) return notFound(requestId);

    const changed = (Object.keys(validation.value) as (keyof typeof validation.value)[]).filter(
      (k) => validation.value[k] !== current[k],
    );
    await recordAudit(db.executor, {
      type: "leak.site.updated",
      orgId,
      actor: { type: actor.subjectType, id: actor.subjectId },
      requestId,
      subjectKind: "leak_site",
      subjectId: site.id,
      subjectName: site.name,
      description: `Updated the site "${site.name}"${changed.length ? ` (${changed.join(", ")})` : ""}`,
      payload: { siteId: sitePublicId(site.id), changed, status: site.status, leakRateMethod: site.leakRateMethod },
      occurredAt: now,
    });
    return successResponse({ site: toPublicSite(site) }, requestId);
  } catch {
    return unavailable(requestId);
  } finally {
    await db.dispose();
  }
}
