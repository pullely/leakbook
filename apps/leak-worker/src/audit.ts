import type { SqlExecutor } from "@saas/db/d1";
import { createEventsRepository } from "@saas/db/events";

export interface AuditActor {
  type: string;
  id: string;
}

export interface AuditInput {
  type: string;
  orgId: string;
  actor: AuditActor;
  requestId: string;
  subjectKind: "leak_site" | "leak_appliance" | "leak_service_event";
  subjectId: string;
  subjectName: string;
  description: string;
  payload: Record<string, unknown>;
  occurredAt: string;
}

/**
 * Append a domain event and its audit row, as two plain statements.
 *
 * Deliberately NOT `EventsRepository.appendEventWithAudit`: in the cirrus
 * baseline that method is one Postgres statement (`WITH … INSERT … RETURNING`, `row_to_json`, `FULL JOIN`)
 * inherited from the Postgres baseline, and SQLite — so D1 — rejects DML
 * inside a CTE. LB1 applies the tested fix to it (runbook trap 16), but this
 * worker does not depend on the patched path either way. Here the event goes in through
 * `appendEvent` (portable) and the audit row is copied from it with an
 * `INSERT … SELECT`, which SQLite runs.
 *
 * Best-effort by design: the write it describes has already committed (D1 has
 * no interactive transactions), so a failure is logged and swallowed rather
 * than turned into a 5xx that would tempt a client to retry a write that
 * succeeded.
 */
export async function recordAudit(executor: SqlExecutor, input: AuditInput): Promise<boolean> {
  const eventId = crypto.randomUUID();
  try {
    const appended = await createEventsRepository(executor).appendEvent({
      id: eventId,
      type: input.type,
      version: 1,
      source: "leak-worker",
      occurredAt: new Date(input.occurredAt),
      actorType: input.actor.type,
      actorId: input.actor.id,
      orgId: input.orgId,
      subjectKind: input.subjectKind,
      subjectId: input.subjectId,
      subjectName: input.subjectName,
      requestId: input.requestId,
      payload: input.payload,
    });
    if (!appended.ok) {
      warn("leak event append failed", input);
      return false;
    }
    await executor.execute(
      `INSERT INTO events_audit_entries
         (id, event_id, org_id, project_id, environment_id, actor_type, actor_id,
          event_type, event_version, source, subject_kind, subject_id, subject_name,
          category, description, occurred_at, request_id, correlation_id, payload, redact_paths)
       SELECT $2, id, org_id, project_id, environment_id, actor_type, actor_id,
              type, version, source, subject_kind, subject_id, subject_name,
              'leak', $3, occurred_at, request_id, correlation_id, payload, redact_paths
         FROM events_event_log WHERE id = $1`,
      [eventId, crypto.randomUUID(), input.description],
    );
    return true;
  } catch {
    warn("leak audit append threw", input);
    return false;
  }
}

function warn(msg: string, input: AuditInput): void {
  console.warn(JSON.stringify({ level: "warn", msg, type: input.type, requestId: input.requestId }));
}
