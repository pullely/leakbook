import type { Env } from "./env.js";
import { errorResponse, withEdgeTimings } from "./http.js";
import { replayOrExecute } from "./idempotency.js";
import { resolveActor } from "./resolve-actor.js";
import { createTimings } from "@saas/contracts/timing";

// The refrigerant log (leak-worker). Two authenticated lanes:
//   /v1/organizations/{org}/sites…, /v1/organizations/{org}/appliances… — the register and the log;
//   /v1/qr/{token}[/events] — what a scanned QR label opens (the org is found from the token).
// resolveActor → actor headers over the LEAK_WORKER binding, like every other
// org route; the worker runs membership + policy itself.

const LEAK_ORG_RE =
  /^\/v1\/organizations\/[^/]+\/(?:sites(?:\/[^/]+(?:\/appliances)?)?|appliances\/[^/]+(?:\/(?:qr-token|events(?:\/[^/]+\/void)?))?)$/;
const LEAK_QR_RE = /^\/v1\/qr\/[^/]+(?:\/events)?$/;

const FORWARDED_HEADERS = ["content-type", "content-length", "traceparent", "idempotency-key"];
const BODY_METHODS = new Set(["POST", "PATCH", "PUT"]);

export function isLeakRoute(pathname: string): boolean {
  return LEAK_ORG_RE.test(pathname) || LEAK_QR_RE.test(pathname);
}

export async function handleLeakRoute(
  request: Request,
  env: Env,
  requestId: string,
  pathname: string,
): Promise<Response> {
  return replayOrExecute(request, requestId, env, "leak", async () => {
    if (!env.LEAK_WORKER) {
      return errorResponse("internal_error", "Refrigerant log service unavailable", 503, requestId);
    }
    if (!env.IDENTITY_WORKER) {
      return errorResponse("internal_error", "Authentication service unavailable", 503, requestId);
    }
    const timings = createTimings();
    const endTotal = timings.start("edge_total");
    const session = await timings.measure("edge_auth", () => resolveActor(request, env, requestId));
    if ("error" in session) return session.error;

    const headers = new Headers();
    headers.set("x-request-id", requestId);
    headers.set("x-actor-subject-id", session.subjectId);
    headers.set("x-actor-subject-type", session.subjectType);
    headers.set("x-actor-email", session.email);
    for (const name of FORWARDED_HEADERS) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    const url = new URL(request.url);
    const target = new URL(pathname + url.search, "https://leak.internal");
    const init: RequestInit = { method: request.method, headers };
    if (BODY_METHODS.has(request.method)) init.body = request.body;

    try {
      const downstream = await timings.measure("edge_downstream", () =>
        env.LEAK_WORKER!.fetch(target.toString(), init),
      );
      const res = new Response(downstream.body, { status: downstream.status, headers: downstream.headers });
      endTotal();
      return withEdgeTimings(res, requestId, "edge.leak", timings);
    } catch {
      return errorResponse("internal_error", "Refrigerant log service unavailable", 503, requestId);
    }
  });
}
