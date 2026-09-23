import type { Env } from "./env.js";
import { handleHealth } from "./handlers/health.js";
import { handleCreateSite, handleGetSite, handleListSites, handleUpdateSite } from "./handlers/sites.js";
import {
  handleCreateAppliance,
  handleGetAppliance,
  handleRotateQrToken,
  handleUpdateAppliance,
} from "./handlers/appliances.js";
import { handleCreateEvent, handleListEvents, handleVoidEvent } from "./handlers/events.js";
import { handleQrLogEvent, handleResolveQr } from "./handlers/qr.js";
import { errorResponse, methodNotAllowed, notFound } from "./http.js";
import {
  generateRequestId,
  parseAppliancePublicId,
  parseEventPublicId,
  parseOrgPublicId,
  parseSitePublicId,
} from "./ids.js";

const REQUEST_ID_RE = /^[\w-]{1,128}$/;

export interface ActorContext {
  subjectId: string;
  subjectType: string;
}

function resolveRequestId(request: Request): string {
  const header = request.headers.get("x-request-id");
  return header && REQUEST_ID_RE.test(header) ? header : generateRequestId();
}

/**
 * This worker is unreachable except over a service binding from api-edge, so
 * the actor arrives as headers the edge resolved and set — never as a token.
 */
function resolveActor(request: Request): ActorContext | null {
  const subjectId = request.headers.get("x-actor-subject-id");
  const subjectType = request.headers.get("x-actor-subject-type");
  if (!subjectId || !subjectType) return null;
  return { subjectId, subjectType };
}

// Org-scoped routes: /v1/organizations/{org}/…
const SITES_RE = /^\/v1\/organizations\/([^/]+)\/sites$/;
const SITE_RE = /^\/v1\/organizations\/([^/]+)\/sites\/([^/]+)$/;
const SITE_APPLIANCES_RE = /^\/v1\/organizations\/([^/]+)\/sites\/([^/]+)\/appliances$/;
const APPLIANCE_RE = /^\/v1\/organizations\/([^/]+)\/appliances\/([^/]+)$/;
const APPLIANCE_QR_RE = /^\/v1\/organizations\/([^/]+)\/appliances\/([^/]+)\/qr-token$/;
const APPLIANCE_EVENTS_RE = /^\/v1\/organizations\/([^/]+)\/appliances\/([^/]+)\/events$/;
const APPLIANCE_EVENT_VOID_RE = /^\/v1\/organizations\/([^/]+)\/appliances\/([^/]+)\/events\/([^/]+)\/void$/;
// The label lane: the token is the key, the org is found from it.
const QR_RE = /^\/v1\/qr\/([^/]+)$/;
const QR_EVENTS_RE = /^\/v1\/qr\/([^/]+)\/events$/;

function unauthenticated(requestId: string): Response {
  return errorResponse("unauthenticated", "Authentication required", 401, requestId);
}

async function routeApi(request: Request, env: Env, requestId: string, path: string): Promise<Response | null> {
  let m: RegExpMatchArray | null;
  const method = request.method;
  const actor = resolveActor(request);

  if ((m = path.match(QR_EVENTS_RE))) {
    if (method !== "POST") return methodNotAllowed(requestId);
    if (!actor) return unauthenticated(requestId);
    return handleQrLogEvent(request, env, requestId, actor, m[1]!);
  }
  if ((m = path.match(QR_RE))) {
    if (method !== "GET") return methodNotAllowed(requestId);
    if (!actor) return unauthenticated(requestId);
    return handleResolveQr(env, requestId, actor, m[1]!);
  }
  if ((m = path.match(APPLIANCE_EVENT_VOID_RE))) {
    const org = parseOrgPublicId(m[1]!);
    const apl = parseAppliancePublicId(m[2]!);
    const sev = parseEventPublicId(m[3]!);
    if (!org || !apl || !sev) return notFound(requestId);
    if (method !== "POST") return methodNotAllowed(requestId);
    if (!actor) return unauthenticated(requestId);
    return handleVoidEvent(request, env, requestId, actor, org, apl, sev);
  }
  if ((m = path.match(APPLIANCE_EVENTS_RE))) {
    const org = parseOrgPublicId(m[1]!);
    const apl = parseAppliancePublicId(m[2]!);
    if (!org || !apl) return notFound(requestId);
    if (method !== "GET" && method !== "POST") return methodNotAllowed(requestId);
    if (!actor) return unauthenticated(requestId);
    return method === "GET"
      ? handleListEvents(request, env, requestId, actor, org, apl)
      : handleCreateEvent(request, env, requestId, actor, org, apl);
  }
  if ((m = path.match(APPLIANCE_QR_RE))) {
    const org = parseOrgPublicId(m[1]!);
    const apl = parseAppliancePublicId(m[2]!);
    if (!org || !apl) return notFound(requestId);
    if (method !== "POST") return methodNotAllowed(requestId);
    if (!actor) return unauthenticated(requestId);
    return handleRotateQrToken(env, requestId, actor, org, apl);
  }
  if ((m = path.match(APPLIANCE_RE))) {
    const org = parseOrgPublicId(m[1]!);
    const apl = parseAppliancePublicId(m[2]!);
    if (!org || !apl) return notFound(requestId);
    if (method !== "GET" && method !== "PATCH") return methodNotAllowed(requestId);
    if (!actor) return unauthenticated(requestId);
    return method === "GET"
      ? handleGetAppliance(env, requestId, actor, org, apl)
      : handleUpdateAppliance(request, env, requestId, actor, org, apl);
  }
  if ((m = path.match(SITE_APPLIANCES_RE))) {
    const org = parseOrgPublicId(m[1]!);
    const site = parseSitePublicId(m[2]!);
    if (!org || !site) return notFound(requestId);
    if (method !== "POST") return methodNotAllowed(requestId);
    if (!actor) return unauthenticated(requestId);
    return handleCreateAppliance(request, env, requestId, actor, org, site);
  }
  if ((m = path.match(SITE_RE))) {
    const org = parseOrgPublicId(m[1]!);
    const site = parseSitePublicId(m[2]!);
    if (!org || !site) return notFound(requestId);
    if (method !== "GET" && method !== "PATCH") return methodNotAllowed(requestId);
    if (!actor) return unauthenticated(requestId);
    return method === "GET"
      ? handleGetSite(env, requestId, actor, org, site)
      : handleUpdateSite(request, env, requestId, actor, org, site);
  }
  if ((m = path.match(SITES_RE))) {
    const org = parseOrgPublicId(m[1]!);
    if (!org) return notFound(requestId);
    if (method !== "GET" && method !== "POST") return methodNotAllowed(requestId);
    if (!actor) return unauthenticated(requestId);
    return method === "GET"
      ? handleListSites(request, env, requestId, actor, org)
      : handleCreateSite(request, env, requestId, actor, org);
  }
  return null;
}

export async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const requestId = resolveRequestId(request);
  try {
    if (url.pathname === "/health" && request.method === "GET") return handleHealth(env, requestId);
    const response = await routeApi(request, env, requestId, url.pathname);
    return response ?? notFound(requestId, url.pathname);
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  }
}
