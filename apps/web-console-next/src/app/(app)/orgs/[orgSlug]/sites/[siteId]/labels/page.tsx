"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { OrgScope } from "@/components/shell/org-scope";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { wrap } from "@/lib/api";
import { QrLabel } from "@/components/leak/qr-label";

/** Every active unit's label on one sheet, laid out for printing on 3 × 2 in label stock. */
export default function SiteLabelsPage() {
  const params = useParams<{ orgSlug: string; siteId: string }>();
  const slug = params?.orgSlug ?? "";
  const siteId = params?.siteId ?? "";
  return <OrgScope slug={slug}>{(org) => <Inner orgId={org.id} orgSlug={slug} siteId={siteId} />}</OrgScope>;
}

function Inner({ orgId, orgSlug, siteId }: { orgId: string; orgSlug: string; siteId: string }) {
  const { client } = useSession();
  const q = useApiQuery(qk.leakSite(orgId, siteId), () => wrap(() => client.leak.getSite(orgId, siteId)));
  if (q.loading) return <Skeleton className="h-40 w-full" />;
  if (q.error || !q.data) return <p className="text-sm text-destructive">{q.error?.message ?? "Site not found"}</p>;
  const { site, appliances } = q.data;
  const printable = appliances.filter((a) => a.status !== "retired");

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Labels — {site.name}</h1>
          <p className="text-sm text-muted-foreground">
            Stick each label on its unit. A scan opens that unit&apos;s service log on the technician&apos;s phone.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" asChild>
            <Link href={`/orgs/${orgSlug}/sites/${site.id}`}>Back to site</Link>
          </Button>
          <Button onClick={() => window.print()}>Print</Button>
        </div>
      </header>
      <div className="flex flex-wrap gap-4">
        {printable.map((a) => (
          <QrLabel key={a.id} appliance={a} site={site} />
        ))}
      </div>
    </div>
  );
}
