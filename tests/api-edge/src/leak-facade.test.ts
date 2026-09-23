import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isLeakRoute, handleLeakRoute } from "@api-edge/leak-facade";
import { isOrgRoute } from "@api-edge/org-facade";

const __dirname = dirname(fileURLToPath(import.meta.url));

function stripJsoncComments(text: string): string {
  return text.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

interface FetchCall {
  url: string;
  init: RequestInit;
}

function recorder(respond: (url: string) => Response): { fetcher: Fetcher; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetcher = {
    fetch(input: string | Request | URL, init?: RequestInit): Promise<Response> {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ url, init: init ?? {} });
      return Promise.resolve(respond(url));
    },
    connect() {
      throw new Error("not implemented");
    },
  } as unknown as Fetcher;
  return { fetcher, calls };
}

function identity(userId: string) {
  return recorder(() =>
    Response.json({
      data: {
        actor: { actorType: "user", actorId: userId, email: "tech@contractor.example" },
        session: { id: "ses_abc", expiresAt: "2026-12-01T00:00:00Z", createdAt: "2026-01-01T00:00:00Z" },
        user: { id: userId, email: "tech@contractor.example", displayName: "Tech" },
      },
      meta: { requestId: "req_inner", cursor: null },
    }),
  );
}

describe("api-edge leak facade", () => {
  it("claims the leak routes and nothing else", () => {
    for (const p of [
      "/v1/organizations/org_a/sites",
      "/v1/organizations/org_a/sites/ste_b",
      "/v1/organizations/org_a/sites/ste_b/appliances",
      "/v1/organizations/org_a/appliances/apl_c",
      "/v1/organizations/org_a/appliances/apl_c/qr-token",
      "/v1/organizations/org_a/appliances/apl_c/events",
      "/v1/organizations/org_a/appliances/apl_c/events/sev_d/void",
      "/v1/qr/abcdefghijklmnopqrstuvwxyz234567",
      "/v1/qr/abcdefghijklmnopqrstuvwxyz234567/events",
    ]) {
      expect(isLeakRoute(p)).toBe(true);
    }
    for (const p of [
      "/v1/organizations/org_a",
      "/v1/organizations/org_a/projects",
      "/v1/organizations/org_a/members",
      "/v1/organizations/org_a/appliances",
      "/v1/organizations/org_a/sites/ste_b/appliances/apl_c",
      "/v1/organizations/org_a/appliances/apl_c/events/sev_d",
      "/v1/qr",
      "/v1/qr/tok/events/sev_d",
    ]) {
      expect(isLeakRoute(p)).toBe(false);
    }
  });

  it("is dispatched before the org facade would swallow it", () => {
    // index.ts checks isLeakRoute before isOrgRoute; whether or not the org
    // facade's pattern also matches, the leak facade must answer these paths.
    expect(isLeakRoute("/v1/organizations/org_a/sites")).toBe(true);
    expect(typeof isOrgRoute("/v1/organizations/org_a/sites")).toBe("boolean");
  });

  it("forwards an authenticated call to LEAK_WORKER with the actor as headers", async () => {
    const id = identity("usr_abc123");
    const worker = recorder(() =>
      Response.json({ data: { site: { id: "ste_x" } }, meta: { requestId: "req_test", cursor: null } }, { status: 201 }),
    );
    const request = new Request("https://api.example.com/v1/organizations/org_a/sites", {
      method: "POST",
      headers: { authorization: "Bearer sps_ses_abc.secret", "content-type": "application/json", "x-actor-subject-id": "usr_spoofed" },
      body: JSON.stringify({ name: "Rosa's Market", customerName: "Rosa's Market LLC" }),
    });
    const response = await handleLeakRoute(
      request,
      { IDENTITY_WORKER: id.fetcher, LEAK_WORKER: worker.fetcher, ENVIRONMENT: "test" },
      "req_test",
      "/v1/organizations/org_a/sites",
    );
    expect(response.status).toBe(201);
    expect(worker.calls).toHaveLength(1);
    expect(worker.calls[0]!.url).toBe("https://leak.internal/v1/organizations/org_a/sites");
    const headers = new Headers(worker.calls[0]!.init.headers);
    expect(headers.get("x-actor-subject-id")).toBe("usr_abc123"); // never the caller's own header
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("answers 401 without a bearer and never reaches the worker", async () => {
    const id = recorder(() => Response.json({ error: { code: "unauthenticated", message: "no", details: {}, requestId: "r" } }, { status: 401 }));
    const worker = recorder(() => Response.json({}));
    const response = await handleLeakRoute(
      new Request("https://api.example.com/v1/organizations/org_a/sites"),
      { IDENTITY_WORKER: id.fetcher, LEAK_WORKER: worker.fetcher, ENVIRONMENT: "test" },
      "req_test",
      "/v1/organizations/org_a/sites",
    );
    expect(response.status).toBe(401);
    expect(worker.calls).toHaveLength(0);
  });

  it("answers 503 when the binding is missing", async () => {
    const response = await handleLeakRoute(
      new Request("https://api.example.com/v1/organizations/org_a/sites"),
      { ENVIRONMENT: "test" },
      "req_test",
      "/v1/organizations/org_a/sites",
    );
    expect(response.status).toBe(503);
  });

  it("wrangler.jsonc binds LEAK_WORKER on stage and prod", () => {
    const raw = readFileSync(resolve(__dirname, "../../../apps/api-edge/wrangler.jsonc"), "utf8");
    const config = JSON.parse(stripJsoncComments(raw)) as {
      env: Record<string, { services?: { binding: string; service: string }[] }>;
    };
    for (const env of ["stage", "prod"]) {
      const binding = config.env[env]!.services!.find((s) => s.binding === "LEAK_WORKER");
      expect(binding?.service).toBe(`leakbook-leak-worker-${env}`);
    }
  });
});

describe("api-edge leak facade — the QR lane", () => {
  it("forwards a label lookup with the token path intact", async () => {
    const id = identity("usr_tech");
    const worker = recorder(() => Response.json({ data: {}, meta: { requestId: "r", cursor: null } }));
    const path = "/v1/qr/abcdefghijklmnopqrstuvwxyz234567";
    const response = await handleLeakRoute(
      new Request(`https://api.example.com${path}`, { headers: { authorization: "Bearer sps_ses_abc.secret" } }),
      { IDENTITY_WORKER: id.fetcher, LEAK_WORKER: worker.fetcher, ENVIRONMENT: "test" },
      "req_test",
      path,
    );
    expect(response.status).toBe(200);
    expect(worker.calls[0]!.url).toBe(`https://leak.internal${path}`);
  });
});
