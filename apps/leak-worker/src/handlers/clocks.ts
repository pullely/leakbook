import { REPAIR_CLOCK_STATUSES, repairDueOn } from "@saas/contracts/leak-clock";
import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { allowed } from "../authz.js";
import { recordAudit } from "../audit.js";
import { clockDeps, nowIso, openDb, todayUtc } from "../context.js";
import { runClockSweep } from "../clock.js";
import { errorResponse, notFound, successResponse, unavailable, validationError } from "../http.js";
import { appliancePublicId, clockPublicId } from "../ids.js";
import { toPublicClock } from "../present.js";
import { readJson } from "./json.js";

/** GET /v1/organizations/{org}/repair-clocks?status= — overdue first, then by the nearest deadline. */
export async function handleListClocks(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
): Promise<Response> {
  const status = new URL(request.url).searchParams.get("status");
  if (status !== null && !(REPAIR_CLOCK_STATUSES as readonly string[]).includes(status)) {
    return validationError(requestId, { status: [`Must be one of ${REPAIR_CLOCK_STATUSES.join(", ")}`] });
  }
  if (!(await allowed(env, actor, orgId, "leak.read", requestId))) return notFound(requestId);
  const db = openDb(env);
  if (!db) return unavailable(requestId);
  try {
    const clocks = await db.clocks.listClocks(orgId, status ?? undefined);
    const today = todayUtc();
    return successResponse({ clocks: clocks.map((c) => toPublicClock(c, today)) }, requestId);
  } catch {
    return unavailable(requestId);
  } finally {
    await db.dispose();
  }
}

/**
 * PATCH /v1/organizations/{org}/repair-clocks/{rpc} — `shutdownRequired`
 * (industrial process refrigeration only: 120 days instead of 30,
 * 84.106(d)(1)) and `notes`. A deadline moved back into the future takes an
 * overdue clock back to open.
 */
export async function handleUpdateClock(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  clockId: string,
): Promise<Response> {
  const parsed = await readJson(request);
  if (!parsed.ok) return validationError(requestId, { body: ["Invalid JSON"] });
  const body = parsed.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return validationError(requestId, { body: ["Must be a JSON object"] });
  }
  const b = body as Record<string, unknown>;
  const fields: Record<string, string[]> = {};
  if ("shutdownRequired" in b && typeof b.shutdownRequired !== "boolean") fields.shutdownRequired = ["Must be true or false"];
  if ("notes" in b && (typeof b.notes !== "string" || b.notes.length > 5000)) fields.notes = ["Text up to 5000 characters"];
  if (Object.keys(fields).length) return validationError(requestId, fields);
  if (!(await allowed(env, actor, orgId, "leak.write", requestId))) return notFound(requestId);
  const db = openDb(env);
  if (!db) return unavailable(requestId);
  const now = nowIso();
  try {
    const clock = await db.clocks.getClock(orgId, clockId);
    if (!clock) return notFound(requestId);
    if (clock.status === "closed") return errorResponse("conflict", "The repair clock is closed", 409, requestId);
    const shutdownRequired = typeof b.shutdownRequired === "boolean" ? b.shutdownRequired : clock.shutdownRequired;
    if (shutdownRequired && !clock.shutdownRequired) {
      const appliance = await db.leak.getAppliance(orgId, clock.applianceId);
      if (appliance?.category !== "industrial_process_refrigeration") {
        return validationError(requestId, {
          shutdownRequired: ["Only an industrial process refrigeration appliance can need a shutdown (84.106(d)(1))"],
        });
      }
    }
    const notes = typeof b.notes === "string" ? b.notes.trim() : clock.notes;
    const due = repairDueOn(clock.openedOn, shutdownRequired, clock.suspendedDays);
    const today = todayUtc();
    let status = clock.status;
    if (status === "overdue" && clock.initialVerifiedOn === null && due >= today) status = "open";
    const updated = await db.clocks.updateClock(orgId, clockId, { shutdownRequired, notes, repairDueOn: due, status }, now);
    if (!updated) return notFound(requestId);
    await recordAudit(db.executor, {
      type: "leak.clock.updated",
      orgId,
      actor: { type: actor.subjectType, id: actor.subjectId },
      requestId,
      subjectKind: "leak_repair_clock",
      subjectId: updated.id,
      subjectName: `${updated.applianceName} — opened ${updated.openedOn}`,
      description: `Updated the repair clock on "${updated.applianceName}"${
        shutdownRequired !== clock.shutdownRequired ? ` (shutdown ${shutdownRequired ? "needed" : "not needed"}; due ${due})` : ""
      }`,
      payload: {
        clockId: clockPublicId(updated.id),
        applianceId: appliancePublicId(updated.applianceId),
        shutdownRequired,
        repairDueOn: due,
        previousRepairDueOn: clock.repairDueOn,
        status,
      },
      occurredAt: now,
    });
    return successResponse({ clock: toPublicClock(updated, today) }, requestId);
  } catch {
    return unavailable(requestId);
  } finally {
    await db.dispose();
  }
}

/**
 * POST /v1/organizations/{org}/repair-clocks/sweep — run today's reminder pass
 * for this organization now, exactly as the daily cron does. Idempotent: every
 * rung is claimed before it is sent, so a rung the cron already sent is not
 * sent again.
 */
export async function handleRunSweep(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
): Promise<Response> {
  if (!(await allowed(env, actor, orgId, "leak.write", requestId))) return notFound(requestId);
  const db = openDb(env);
  if (!db) return unavailable(requestId);
  try {
    const report = await runClockSweep(clockDeps(env, db), todayUtc(), nowIso(), { orgId, requestId });
    return successResponse({ report }, requestId);
  } catch {
    return unavailable(requestId);
  } finally {
    await db.dispose();
  }
}
