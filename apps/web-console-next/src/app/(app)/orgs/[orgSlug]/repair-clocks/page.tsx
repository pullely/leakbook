"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { OrgScope } from "@/components/shell/org-scope";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { useToast } from "@/components/ui/toast";
import { wrap } from "@/lib/api";
import { formatRateBp } from "@saas/contracts/leak-rate";
import { ClockStatus, daysPhrase } from "@/components/leak/clock";

type Filter = "running" | "closed";

export default function RepairClocksPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return <OrgScope slug={slug}>{(org) => <Inner orgId={org.id} orgSlug={slug} />}</OrgScope>;
}

/**
 * The office's list of repair deadlines (LB3): overdue first, then by days
 * left. A clock opens when a logged addition is over the appliance's threshold
 * and closes when the follow-up verification test passes.
 */
function Inner({ orgId, orgSlug }: { orgId: string; orgSlug: string }) {
  const { client } = useSession();
  const { toast } = useToast();
  const [filter, setFilter] = React.useState<Filter>("running");
  const q = useApiQuery(qk.leakClocks(orgId, filter), () =>
    wrap(() => client.leak.listRepairClocks(orgId, filter === "closed" ? { status: "closed" } : {})),
  );
  const [busy, setBusy] = React.useState(false);

  const clocks = (q.data?.clocks ?? []).filter((c) => (filter === "closed" ? c.status === "closed" : c.status !== "closed"));

  async function sendNow() {
    setBusy(true);
    const r = await wrap(() => client.leak.runRepairClockSweep(orgId));
    setBusy(false);
    if (!r.ok) {
      toast({ kind: "error", title: "Could not send reminders", description: r.error.message });
      return;
    }
    const { sent, alreadySent } = r.data.report;
    toast({ kind: "success", title: `${sent} reminder${sent === 1 ? "" : "s"} sent`, description: `${alreadySent} already sent earlier` });
    q.reload();
  }

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Repair clocks</h1>
          <p className="text-sm text-muted-foreground">
            Leaks over the threshold must be repaired within 30 days and verified (40 CFR 84.106(d)–(e)). Reminders go out
            daily at 14:00 UTC, 14, 7, 3, 1 and 0 days before each deadline.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant={filter === "running" ? "default" : "outline"} size="sm" onClick={() => setFilter("running")}>
            Running
          </Button>
          <Button variant={filter === "closed" ? "default" : "outline"} size="sm" onClick={() => setFilter("closed")}>
            Closed
          </Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void sendNow()}>
            {busy ? "Sending…" : "Send due reminders now"}
          </Button>
        </div>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{filter === "running" ? "Open, overdue and suspended" : "Closed"}</CardTitle>
          <CardDescription>Overdue first, then by days left.</CardDescription>
        </CardHeader>
        <CardContent>
          {q.loading ? (
            <Skeleton className="h-24 w-full" />
          ) : q.error ? (
            <p className="text-sm text-destructive">{q.error.message}</p>
          ) : clocks.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {filter === "running" ? "No repair is due. Every logged addition is under its threshold." : "No closed clocks yet."}
            </p>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Unit</TH>
                  <TH>Opened</TH>
                  <TH>Rate</TH>
                  <TH>Next deadline</TH>
                  <TH>Status</TH>
                </TR>
              </THead>
              <TBody>
                {clocks.map((c) => (
                  <TR key={c.id}>
                    <TD>
                      <Link className="font-medium underline" href={`/orgs/${orgSlug}/appliances/${c.applianceId}`}>
                        {c.applianceName}
                      </Link>
                      <div className="text-xs text-muted-foreground">{c.siteName}</div>
                    </TD>
                    <TD className="tabular-nums">{c.openedOn}</TD>
                    <TD className="tabular-nums">
                      {formatRateBp(c.leakRateBp)} <span className="text-xs text-muted-foreground">/ {c.thresholdPct} %</span>
                    </TD>
                    <TD>
                      {c.deadline ? (
                        <>
                          <span className="tabular-nums">{c.deadline.dueOn}</span>{" "}
                          <span className={`text-xs ${c.deadline.daysLeft < 0 ? "text-destructive" : "text-muted-foreground"}`}>
                            {c.deadline.kind === "repair" ? "repair" : "follow-up test"}, {daysPhrase(c.deadline.daysLeft)}
                          </span>
                        </>
                      ) : (
                        <span className="text-xs text-muted-foreground">{c.closedOn ? `closed ${c.closedOn}` : "—"}</span>
                      )}
                    </TD>
                    <TD>
                      <ClockStatus clock={c} />
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
