"use client";

import * as React from "react";
import { useParams } from "next/navigation";
import { useSession, readStoredToken } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { wrap } from "@/lib/api";
import { rememberReturnTo } from "@/lib/return-to";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/ui/toast";
import { APPLIANCE_CATEGORY_LABELS, formatOunces } from "@saas/contracts/leak";
import { LogForm } from "@/components/leak/log-form";
import { EventList, toFormResult } from "@/components/leak/event-list";

/**
 * What a scanned QR label opens: one column, big touch targets, no console
 * chrome. A phone that has never signed in is sent to the email-code sign-in
 * and brought back here afterwards (lib/return-to). The token is the only key;
 * a label for a unit the signed-in person's organization does not own answers
 * "not found", the same as a label that was replaced.
 */
export default function QrPage() {
  const params = useParams<{ token: string }>();
  const token = params?.token ?? "";
  const { token: session } = useSession();
  const [ready, setReady] = React.useState(false);

  React.useEffect(() => {
    setReady(true);
    if (!session && !readStoredToken()) {
      rememberReturnTo(`/q/${token}`);
      window.location.href = "/login";
    }
  }, [session, token]);

  if (!ready || !session) {
    return (
      <Shell>
        <Skeleton className="h-24 w-full" />
      </Shell>
    );
  }
  return (
    <Shell>
      <Label token={token} />
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto min-h-dvh w-full max-w-lg space-y-5 px-4 pb-[calc(env(safe-area-inset-bottom)+2rem)] pt-[calc(env(safe-area-inset-top)+1rem)]">
      {children}
    </main>
  );
}

function Label({ token }: { token: string }) {
  const { client } = useSession();
  const { toast } = useToast();
  const q = useApiQuery(qk.leakQr(token), () => wrap(() => client.leak.resolveQr(token)));

  if (q.loading) return <Skeleton className="h-40 w-full" />;
  if (q.error || !q.data) {
    return (
      <div className="space-y-2 pt-10 text-center">
        <h1 className="text-lg font-semibold">This label isn&apos;t one of yours</h1>
        <p className="text-sm text-muted-foreground">
          It belongs to a unit your organization doesn&apos;t service, or it has been replaced. Ask the office for a new
          label.
        </p>
      </div>
    );
  }
  const { appliance, site, events } = q.data;

  return (
    <>
      <header className="space-y-1">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">{site.name}</div>
        <h1 className="text-2xl font-semibold leading-tight">{appliance.name}</h1>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Badge>{appliance.refrigerant}</Badge>
          <span>{formatOunces(appliance.fullChargeOz)} full charge</span>
          <span className="text-muted-foreground">· {APPLIANCE_CATEGORY_LABELS[appliance.category]}</span>
          {appliance.status !== "active" && <Badge variant="secondary">{appliance.status}</Badge>}
        </div>
        {appliance.location && <div className="text-sm text-muted-foreground">{appliance.location}</div>}
      </header>

      {appliance.status === "retired" ? (
        <p className="rounded-md border p-3 text-sm">This unit is retired; it takes no more service entries.</p>
      ) : (
        <section className="rounded-lg border p-4">
          <h2 className="mb-3 text-base font-semibold">Log this visit</h2>
          <LogForm
            compact
            onSubmit={async (body) => {
              const r = await wrap(() => client.leak.logEventByQr(token, body));
              if (r.ok) {
                toast({ kind: "success", title: "Visit logged", description: `${appliance.name}, ${body.serviceDate}` });
                q.reload();
              }
              return toFormResult(r);
            }}
          />
        </section>
      )}

      <section className="space-y-2">
        <h2 className="text-base font-semibold">Recent visits</h2>
        <EventList events={events} />
      </section>
    </>
  );
}
