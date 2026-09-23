import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { allowed } from "../authz.js";
import { openDb } from "../context.js";
import { notFound, successResponse, unavailable, validationError } from "../http.js";
import { isQrToken, orgPublicId } from "../ids.js";
import { toPublicAppliance, toPublicEvent, toPublicSite } from "../present.js";
import { logEvent } from "./events.js";
import { readJson } from "./json.js";

/** The phone page shows the last few visits under the form. */
const QR_RECENT_EVENTS = 5;

/**
 * GET /v1/qr/{token} — what a scanned label opens. The token is the only key,
 * so the lookup is cross-org; the caller is then authorized against the
 * appliance's own organization. A stranger — signed in to another
 * organization, or holding a dead token — gets the same 404.
 */
export async function handleResolveQr(
  env: Env,
  requestId: string,
  actor: ActorContext,
  token: string,
): Promise<Response> {
  if (!isQrToken(token)) return notFound(requestId);
  const db = openDb(env);
  if (!db) return unavailable(requestId);
  try {
    const appliance = await db.leak.findApplianceByQrToken(token);
    if (!appliance) return notFound(requestId);
    if (!(await allowed(env, actor, appliance.orgId, "leak.read", requestId))) return notFound(requestId);
    const [site, events] = await Promise.all([
      db.leak.getSite(appliance.orgId, appliance.siteId),
      db.leak.listServiceEvents(appliance.orgId, appliance.id, { limit: QR_RECENT_EVENTS }),
    ]);
    if (!site) return notFound(requestId);
    return successResponse(
      {
        organization: { id: orgPublicId(appliance.orgId) },
        site: toPublicSite(site),
        appliance: toPublicAppliance(appliance),
        events: events.map(toPublicEvent),
      },
      requestId,
    );
  } catch {
    return unavailable(requestId);
  } finally {
    await db.dispose();
  }
}

/** POST /v1/qr/{token}/events — log from the phone page without knowing the org or appliance id. */
export async function handleQrLogEvent(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  token: string,
): Promise<Response> {
  const parsed = await readJson(request);
  if (!parsed.ok) return validationError(requestId, { body: ["Invalid JSON"] });
  if (!isQrToken(token)) return notFound(requestId);
  const db = openDb(env);
  if (!db) return unavailable(requestId);
  try {
    const appliance = await db.leak.findApplianceByQrToken(token);
    if (!appliance) return notFound(requestId);
    if (!(await allowed(env, actor, appliance.orgId, "leak.write", requestId))) return notFound(requestId);
    const body =
      parsed.body && typeof parsed.body === "object" && !Array.isArray(parsed.body)
        ? { ...(parsed.body as Record<string, unknown>), loggedVia: "qr" }
        : parsed.body;
    return await logEvent(body, db, requestId, actor, appliance);
  } catch {
    return unavailable(requestId);
  } finally {
    await db.dispose();
  }
}
