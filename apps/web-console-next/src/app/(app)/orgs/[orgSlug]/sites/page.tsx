"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Store } from "lucide-react";
import { OrgScope } from "@/components/shell/org-scope";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Input, Textarea } from "@/components/ui/input";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { useToast } from "@/components/ui/toast";
import { wrap } from "@/lib/api";
import type { CreateLeakSiteRequest, LeakRateMethod, PublicLeakSite } from "@saas/contracts/leak";
import { LEAK_RATE_METHODS, LEAK_RATE_METHOD_LABELS } from "@saas/contracts/leak";

export default function SitesPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return <OrgScope slug={slug}>{(org) => <Inner orgId={org.id} orgSlug={slug} />}</OrgScope>;
}

function Inner({ orgId, orgSlug }: { orgId: string; orgSlug: string }) {
  const { client } = useSession();
  const sites = useApiQuery(qk.leakSites(orgId), () => wrap(async () => (await client.leak.listSites(orgId)).sites));
  const [creating, setCreating] = React.useState(false);

  return (
    <div className="space-y-5">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Sites</h1>
          <p className="text-sm text-muted-foreground">
            Your customers&apos; locations and the refrigeration and air-conditioning units at each — every unit with
            its own QR label and service log.
          </p>
        </div>
        {!creating && <Button onClick={() => setCreating(true)}>New site</Button>}
      </header>

      {creating && (
        <SiteForm
          orgId={orgId}
          onDone={() => {
            setCreating(false);
            sites.reload();
          }}
          onCancel={() => setCreating(false)}
        />
      )}

      <Card>
        <CardContent className="pt-6">
          {sites.loading ? (
            <Skeleton className="h-24 w-full" />
          ) : sites.error ? (
            <p className="text-sm text-destructive">{sites.error.message}</p>
          ) : (sites.data ?? []).length === 0 ? (
            <div className="flex flex-col items-center py-10 text-center text-sm text-muted-foreground">
              <Store className="mb-3 h-8 w-8 text-primary" />
              No sites yet. Add a customer location, then register its units and print their labels.
            </div>
          ) : (
            <SitesTable orgSlug={orgSlug} sites={sites.data ?? []} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function SitesTable({ orgSlug, sites }: { orgSlug: string; sites: PublicLeakSite[] }) {
  return (
    <Table>
      <THead>
        <TR>
          <TH>Site</TH>
          <TH>Address</TH>
          <TH>Units</TH>
          <TH>Method</TH>
          <TH>Status</TH>
        </TR>
      </THead>
      <TBody>
        {sites.map((s) => (
          <TR key={s.id}>
            <TD>
              <Link className="font-medium underline" href={`/orgs/${orgSlug}/sites/${s.id}`}>
                {s.name}
              </Link>
              <div className="text-xs text-muted-foreground">{s.customerName}</div>
            </TD>
            <TD className="text-sm">
              {s.addressLine1}
              <div className="text-xs text-muted-foreground">{[s.city, s.region, s.postalCode].filter(Boolean).join(", ")}</div>
            </TD>
            <TD className="text-sm">{s.applianceCount}</TD>
            <TD className="text-xs text-muted-foreground">{LEAK_RATE_METHOD_LABELS[s.leakRateMethod]}</TD>
            <TD>
              <Badge variant={s.status === "active" ? "default" : "secondary"}>{s.status}</Badge>
            </TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}

function SiteForm({ orgId, onDone, onCancel }: { orgId: string; onDone: () => void; onCancel: () => void }) {
  const { client } = useSession();
  const { toast } = useToast();
  const [form, setForm] = React.useState({
    name: "",
    customerName: "",
    addressLine1: "",
    addressLine2: "",
    city: "",
    region: "",
    postalCode: "",
    ownerContactName: "",
    ownerContactEmail: "",
    leakRateMethod: "annualizing" as LeakRateMethod,
    notes: "",
  });
  const [busy, setBusy] = React.useState(false);
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const body: CreateLeakSiteRequest = {
      name: form.name,
      customerName: form.customerName,
      addressLine1: form.addressLine1,
      addressLine2: form.addressLine2 || null,
      city: form.city,
      region: form.region,
      postalCode: form.postalCode,
      ownerContactName: form.ownerContactName || null,
      ownerContactEmail: form.ownerContactEmail || null,
      leakRateMethod: form.leakRateMethod,
      notes: form.notes,
    };
    setBusy(true);
    const r = await wrap(async () => (await client.leak.createSite(orgId, body)).site);
    setBusy(false);
    if (!r.ok) {
      toast({ kind: "error", title: "Could not save the site", description: r.error.message });
      return;
    }
    toast({ kind: "success", title: "Site added", description: "Now register its units." });
    onDone();
  }

  const field = "block text-sm font-medium mt-3 mb-1";
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">New site</CardTitle>
        <CardDescription>
          The address is part of the record the rule requires for every unit (40 CFR 84.106(l)). The leak-rate method
          applies to every unit at the site.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={save} className="grid max-w-2xl gap-x-4 sm:grid-cols-2">
          <div>
            <label className={field} htmlFor="s-name">Site name</label>
            <Input id="s-name" value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="Rosa's Market — Main St" required />
          </div>
          <div>
            <label className={field} htmlFor="s-customer">Owner / operator</label>
            <Input id="s-customer" value={form.customerName} onChange={(e) => set("customerName", e.target.value)} required />
          </div>
          <div className="sm:col-span-2">
            <label className={field} htmlFor="s-a1">Street address</label>
            <Input id="s-a1" value={form.addressLine1} onChange={(e) => set("addressLine1", e.target.value)} required />
          </div>
          <div className="sm:col-span-2">
            <label className={field} htmlFor="s-a2">Address line 2</label>
            <Input id="s-a2" value={form.addressLine2} onChange={(e) => set("addressLine2", e.target.value)} />
          </div>
          <div>
            <label className={field} htmlFor="s-city">City</label>
            <Input id="s-city" value={form.city} onChange={(e) => set("city", e.target.value)} required />
          </div>
          <div className="grid grid-cols-2 gap-x-4">
            <div>
              <label className={field} htmlFor="s-region">State</label>
              <Input id="s-region" value={form.region} onChange={(e) => set("region", e.target.value)} />
            </div>
            <div>
              <label className={field} htmlFor="s-zip">ZIP</label>
              <Input id="s-zip" value={form.postalCode} onChange={(e) => set("postalCode", e.target.value)} />
            </div>
          </div>
          <div>
            <label className={field} htmlFor="s-contact">Customer contact</label>
            <Input id="s-contact" value={form.ownerContactName} onChange={(e) => set("ownerContactName", e.target.value)} />
          </div>
          <div>
            <label className={field} htmlFor="s-contact-email">Contact email</label>
            <Input id="s-contact-email" type="email" value={form.ownerContactEmail} onChange={(e) => set("ownerContactEmail", e.target.value)} />
          </div>
          <div className="sm:col-span-2">
            <label className={field} htmlFor="s-method">Leak-rate method</label>
            <select
              id="s-method"
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              value={form.leakRateMethod}
              onChange={(e) => set("leakRateMethod", e.target.value)}
            >
              {LEAK_RATE_METHODS.map((m) => (
                <option key={m} value={m}>
                  {LEAK_RATE_METHOD_LABELS[m]}
                </option>
              ))}
            </select>
          </div>
          <div className="sm:col-span-2">
            <label className={field} htmlFor="s-notes">Notes</label>
            <Textarea id="s-notes" rows={2} value={form.notes} onChange={(e) => set("notes", e.target.value)} placeholder="Access, gate codes, who to ask for" />
          </div>
          <div className="mt-5 flex gap-2 sm:col-span-2">
            <Button type="submit" disabled={busy}>{busy ? "Saving…" : "Save site"}</Button>
            <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
