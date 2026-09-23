"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { OrgScope } from "@/components/shell/org-scope";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { useToast } from "@/components/ui/toast";
import { wrap } from "@/lib/api";
import {
  APPLIANCE_CATEGORY_LABELS,
  FULL_CHARGE_METHOD_LABELS,
  REFRIGERANT_CLASS_LABELS,
  formatOunces,
} from "@saas/contracts/leak";
import { QrLabel, labelUrl } from "@/components/leak/qr-label";
import { LogForm } from "@/components/leak/log-form";
import { EventList, toFormResult } from "@/components/leak/event-list";

export default function AppliancePage() {
  const params = useParams<{ orgSlug: string; applianceId: string }>();
  const slug = params?.orgSlug ?? "";
  const applianceId = params?.applianceId ?? "";
  return (
    <OrgScope slug={slug}>{(org) => <Inner orgId={org.id} orgSlug={slug} applianceId={applianceId} />}</OrgScope>
  );
}

function Inner({ orgId, orgSlug, applianceId }: { orgId: string; orgSlug: string; applianceId: string }) {
  const { client } = useSession();
  const { toast } = useToast();
  const q = useApiQuery(qk.leakAppliance(orgId, applianceId), () =>
    wrap(() => client.leak.getAppliance(orgId, applianceId)),
  );

  if (q.loading) return <Skeleton className="h-40 w-full" />;
  if (q.error || !q.data) return <p className="text-sm text-destructive">{q.error?.message ?? "Unit not found"}</p>;
  const { appliance, site, events } = q.data;

  async function rotate() {
    if (!window.confirm("Replace this unit's label? The printed label stops working at once.")) return;
    const r = await wrap(() => client.leak.rotateQrToken(orgId, applianceId));
    if (!r.ok) {
      toast({ kind: "error", title: "Could not replace the label", description: r.error.message });
      return;
    }
    toast({ kind: "success", title: "New label issued", description: "Print it and replace the old one." });
    q.reload();
  }

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{appliance.name}</h1>
          <p className="text-sm text-muted-foreground">
            <Link className="underline" href={`/orgs/${orgSlug}/sites/${site.id}`}>
              {site.name}
            </Link>
            {appliance.location ? ` · ${appliance.location}` : ""}
          </p>
        </div>
        <Badge variant={appliance.status === "active" ? "default" : "secondary"}>{appliance.status}</Badge>
      </header>

      <div className="grid gap-5 lg:grid-cols-[1fr_auto]">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">The unit</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
              <Fact label="Category" value={APPLIANCE_CATEGORY_LABELS[appliance.category]} />
              <Fact label="Refrigerant" value={`${appliance.refrigerant} — ${REFRIGERANT_CLASS_LABELS[appliance.refrigerantClass]}`} />
              <Fact label="Full charge" value={formatOunces(appliance.fullChargeOz)} />
              <Fact label="Determined by" value={FULL_CHARGE_METHOD_LABELS[appliance.fullChargeMethod]} />
              {appliance.fullChargeRangeLowOz !== null && appliance.fullChargeRangeHighOz !== null && (
                <Fact
                  label="Range"
                  value={`${formatOunces(appliance.fullChargeRangeLowOz)} – ${formatOunces(appliance.fullChargeRangeHighOz)}`}
                />
              )}
              <Fact label="Installed" value={appliance.installedOn ?? "—"} />
              <Fact label="Manufacturer" value={appliance.manufacturer || "—"} />
              <Fact label="Model" value={appliance.model || "—"} />
              <Fact label="Serial" value={appliance.serialNumber || "—"} />
              <Fact label="Last service" value={appliance.lastServiceDate ?? "—"} />
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">QR label</CardTitle>
            <CardDescription>Scanning opens this unit&apos;s log on a phone.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <QrLabel appliance={appliance} site={site} />
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" asChild>
                <Link href={`/q/${appliance.qrToken}`}>Open the phone page</Link>
              </Button>
              <Button variant="ghost" size="sm" onClick={() => void navigator.clipboard?.writeText(labelUrl(appliance.qrToken))}>
                Copy link
              </Button>
              <Button variant="ghost" size="sm" onClick={() => void rotate()}>
                Replace label…
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      {appliance.status !== "retired" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Log a visit</CardTitle>
            <CardDescription>Refrigerant in pounds and ounces. Entries cannot be edited later — only voided with a reason.</CardDescription>
          </CardHeader>
          <CardContent>
            <LogForm
              onSubmit={async (body) => {
                const r = await wrap(() => client.leak.logEvent(orgId, applianceId, { ...body, loggedVia: "console" }));
                if (r.ok) {
                  toast({ kind: "success", title: "Visit logged" });
                  q.reload();
                }
                return toFormResult(r);
              }}
            />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Service log</CardTitle>
          <CardDescription>Newest first. Kept at least three years (40 CFR 84.106(l)).</CardDescription>
        </CardHeader>
        <CardContent>
          <EventList
            events={events}
            onVoid={async (e, reason) => {
              const r = await wrap(() => client.leak.voidEvent(orgId, applianceId, e.id, { reason }));
              if (!r.ok) {
                toast({ kind: "error", title: "Could not void the entry", description: r.error.message });
                return false;
              }
              toast({ kind: "success", title: "Entry voided" });
              q.reload();
              return true;
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
