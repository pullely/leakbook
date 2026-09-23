import { DatabaseSync } from "node:sqlite";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { D1ApiAdapter } from "@saas/db/runner";
import type { Env } from "@leak-worker/env";

// A real SQLite engine under the worker, not a mocked executor: D1 is SQLite,
// so a statement node:sqlite runs is a statement D1 runs — including the
// RETURNING-based writes this context relies on (runbook trap 22).

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_ROOT = resolve(__dirname, "../../..", "packages/db/src/migrations");

export function migratedDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const dirs = readdirSync(MIGRATIONS_ROOT)
    .filter((d) => existsSync(join(MIGRATIONS_ROOT, d, "up.sql")))
    .sort();
  for (const dir of dirs) {
    const sql = readFileSync(join(MIGRATIONS_ROOT, dir, "up.sql"), "utf8");
    for (const statement of D1ApiAdapter.splitStatements(sql)) db.exec(statement);
  }
  return db;
}

export function d1Over(db: DatabaseSync): D1Database {
  return {
    prepare(query: string) {
      let bound: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) {
          bound = values;
          return statement;
        },
        all<T>() {
          const rows = db.prepare(query).all(...(bound as never[])) as T[];
          return Promise.resolve({ results: rows, success: true, meta: {} });
        },
      };
      return statement;
    },
  } as unknown as D1Database;
}

export const OWNER = "11111111-1111-4111-8111-111111111111";
export const TECH = "22222222-2222-4222-8222-222222222222";
export const VIEWER = "33333333-3333-4333-8333-333333333333";
export const STRANGER = "99999999-9999-4999-8999-999999999999";

/**
 * membership-worker + policy-worker stand-ins, mirroring the policy engine:
 * OWNER is an org owner and TECH a builder (both read and write the log);
 * VIEWER only reads; STRANGER belongs to another organization entirely — the
 * membership context for THIS org is empty.
 */
const ROLE: Record<string, string> = { [OWNER]: "owner", [TECH]: "builder", [VIEWER]: "viewer" };
const ROLE_ACTIONS: Record<string, ReadonlySet<string>> = {
  owner: new Set(["leak.read", "leak.write"]),
  builder: new Set(["leak.read", "leak.write"]),
  viewer: new Set(["leak.read"]),
};

export function fakeFleet(memberOrg: string): { MEMBERSHIP_WORKER: Fetcher; POLICY_WORKER: Fetcher } {
  const membership = {
    async fetch(_url: string, init: RequestInit) {
      const body = JSON.parse(String(init.body)) as { subject: { id: string }; orgId: string };
      const role = body.orgId === memberOrg ? (ROLE[body.subject.id] ?? null) : null;
      return Response.json({ data: { memberships: role ? [{ kind: "organization", orgId: body.orgId, role }] : [] } });
    },
  };
  const policy = {
    async fetch(_url: string, init: RequestInit) {
      const body = JSON.parse(String(init.body)) as {
        action: string;
        context: { memberships: { role: string }[] };
      };
      const role = body.context.memberships[0]?.role;
      const allow = role !== undefined && (ROLE_ACTIONS[role]?.has(body.action) ?? false);
      return Response.json({ data: { allow } });
    },
  };
  return {
    MEMBERSHIP_WORKER: membership as unknown as Fetcher,
    POLICY_WORKER: policy as unknown as Fetcher,
  };
}

export interface TestWorld {
  env: Env;
  db: DatabaseSync;
}

/** A world in which OWNER, TECH and VIEWER are members of `memberOrg` (a UUID) and nobody else is. */
export function world(memberOrg: string): TestWorld {
  const db = migratedDatabase();
  const fleet = fakeFleet(memberOrg);
  const env = {
    ENVIRONMENT: "test",
    PLATFORM_DB: d1Over(db),
    MEMBERSHIP_WORKER: fleet.MEMBERSHIP_WORKER,
    POLICY_WORKER: fleet.POLICY_WORKER,
  } as Env;
  return { env, db };
}

export function as(subjectId: string): Record<string, string> {
  return { "x-actor-subject-id": subjectId, "x-actor-subject-type": "user" };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test payloads are asserted field by field
export async function json(res: Response): Promise<Record<string, any>> {
  return (await res.json()) as Record<string, any>;
}
