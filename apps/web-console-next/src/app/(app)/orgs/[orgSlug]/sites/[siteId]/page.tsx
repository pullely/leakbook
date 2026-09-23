"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { OrgScope } from "@/components/shell/org-scope";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { useToast } from "@/components/ui/toast";
import { wrap } from "@/lib/api";
import type {
  ApplianceCategory,
  CreateApplianceRequest,
  FullChargeMethod,
  PublicAppliance,
  RefrigerantClass,
} from "@saas/contracts/leak";
import {
  APPLIANCE_CATEGORIES,
  APPLIANCE_CATEGORY_LABELS,
  FULL_CHARGE_METHODS,
  FULL_CHARGE_METHOD_LABELS,
  KNOWN_REFRIGERANTS,
  LEAK_RATE_METHOD_LABELS,
  REFRIGERANT_CLASSES,
  REFRIGERANT_CLASS_LABELS,
  classifyRefrigerant,
  formatOunces,
} from "@saas/contracts/leak";
import { quantityToOunces } from "@/components/leak/log-form";

export default function SitePage() {
  const params = useParams<{ orgSlug: string; siteId: string }>();
  const slug = params?.orgSlug ?? "";
  const siteId = params?.siteId ?? "";
  return <OrgScope slug={slug}>{(org) => <Inner orgId={org.id} orgSlug={slug} siteId={siteId} />}</OrgScope>;
}

function Inner({ orgId, orgSlug, siteId }: { orgId: string; orgSlug: string; siteId: string }) {
  const { client } = useSession();
  const q = useApiQuery(qk.leakSite(orgId, siteId), () => wrap(() => client.leak.getSite(orgId, siteId)));
  const [adding, setAdding] = React.useState(false);

  if (q.loading) return <Skeleton className="h-40 w-full" />;
  if (q.error || !q.data) return <p className="text-sm text-destructive">{q.error?.message ?? "Site not found"}</p>;
  const { site, appliances } = q.data;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{site.name}</h1>
          <p className="text-sm text-muted-foreground">
            {site.customerName} · {site.addressLine1}
            {site.addressLine2 ? `, ${site.addressLine2}` : ""}, {[site.city, site.region, site.postalCode].filter(Boolean).join(", ")}
          </p>
          <p className="text-xs text-muted-foreground">
            {LEAK_RATE_METHOD_LABELS[site.leakRateMethod]}
            {site.ownerContactName || site.ownerContactEmail
              ? ` · contact ${[site.ownerContactName, site.ownerContactEmail].filter(Boolean).join(", ")}`
              : ""}
          </p>
        </div>
        <div className="flex gap-2">
          {appliances.length > 0 && (
            <Button variant="outline" asChild>
              <Link href={`/orgs/${orgSlug}/sites/${site.id}/labels`}>Print labels</Link>
            </Button>
          )}
          {!adding && <Button onClick={() => setAdding(true)}>Add unit</Button>}
        </div>
      </header>

      {adding && (
        <ApplianceForm
          orgId={orgId}
          siteId={site.id}
          onDone={() => {
            setAdding(false);
            q.reload();
          }}
          onCancel={() => setAdding(false)}
        />
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Units</CardTitle>
          <CardDescription>One row per independent refrigerant circuit — the rule treats each circuit as an appliance.</CardDescription>
        </CardHeader>
        <CardContent>
          {appliances.length === 0 ? (
            <p className="text-sm text-muted-foreground">No units yet.</p>
          ) : (
            <AppliancesTable orgSlug={orgSlug} appliances={appliances} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function AppliancesTable({ orgSlug, appliances }: { orgSlug: string; appliances: PublicAppliance[] }) {
  return (
    <Table>
      <THead>
        <TR>
          <TH>Unit</TH>
          <TH>Refrigerant</TH>
          <TH>Full charge</TH>
          <TH>Last service</TH>
          <TH>Status</TH>
        </TR>
      </THead>
      <TBody>
        {appliances.map((a) => (
          <TR key={a.id}>
            <TD>
              <Link className="font-medium underline" href={`/orgs/${orgSlug}/appliances/${a.id}`}>
                {a.name}
              </Link>
              <div className="text-xs text-muted-foreground">
                {APPLIANCE_CATEGORY_LABELS[a.category]}
                {a.location ? ` · ${a.location}` : ""}
              </div>
            </TD>
            <TD className="text-sm">
              {a.refrigerant}
              <div className="text-xs text-muted-foreground">{REFRIGERANT_CLASS_LABELS[a.refrigerantClass]}</div>
            </TD>
            <TD className="text-sm">{formatOunces(a.fullChargeOz)}</TD>
            <TD className="text-sm">{a.lastServiceDate ?? <span className="text-muted-foreground">—</span>}</TD>
            <TD>
              <Badge variant={a.status === "active" ? "default" : "secondary"}>{a.status}</Badge>
            </TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}

function ApplianceForm({
  orgId,
  siteId,
  onDone,
  onCancel,
}: {
  orgId: string;
  siteId: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { client } = useSession();
  const { toast } = useToast();
  const [form, setForm] = React.useState({
    name: "",
    location: "",
    category: "commercial_refrigeration" as ApplianceCategory,
    refrigerant: "R-404A",
    refrigerantClass: "" as RefrigerantClass | "",
    chargeLb: "",
    chargeOz: "",
    fullChargeMethod: "manufacturer" as FullChargeMethod,
    lowLb: "",
    highLb: "",
    installedOn: "",
    manufacturer: "",
    model: "",
    serialNumber: "",
  });
  const [busy, setBusy] = React.useState(false);
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const known = classifyRefrigerant(form.refrigerant);
  const isRange = form.fullChargeMethod === "range_midpoint";

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const charge = quantityToOunces({ lb: form.chargeLb, oz: form.chargeOz });
    const low = quantityToOunces({ lb: form.lowLb, oz: "" });
    const high = quantityToOunces({ lb: form.highLb, oz: "" });
    if (!isRange && (!charge || charge <= 0)) {
      toast({ kind: "error", title: "Enter the full charge in whole pounds and ounces" });
      return;
    }
    if (isRange && (!low || !high)) {
      toast({ kind: "error", title: "Enter the range's low and high charge in pounds" });
      return;
    }
    const body: CreateApplianceRequest = {
      name: form.name,
      location: form.location,
      category: form.category,
      refrigerant: form.refrigerant,
      ...(known ? {} : form.refrigerantClass ? { refrigerantClass: form.refrigerantClass } : {}),
      fullChargeMethod: form.fullChargeMethod,
      ...(isRange ? { fullChargeRangeLowOz: low!, fullChargeRangeHighOz: high! } : { fullChargeOz: charge! }),
      installedOn: form.installedOn || null,
      manufacturer: form.manufacturer,
      model: form.model,
      serialNumber: form.serialNumber,
    };
    setBusy(true);
    const r = await wrap(async () => (await client.leak.createAppliance(orgId, siteId, body)).appliance);
    setBusy(false);
    if (!r.ok) {
      const fields = r.error.details?.fields as Record<string, string[]> | undefined;
      toast({
        kind: "error",
        title: "Could not register the unit",
        description: fields ? Object.entries(fields).map(([k, v]) => `${k}: ${v.join(" ")}`).join("; ") : r.error.message,
      });
      return;
    }
    toast({ kind: "success", title: "Unit registered", description: "Print its label from the site page." });
    onDone();
  }

  const field = "block text-sm font-medium mt-3 mb-1";
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Add a unit</CardTitle>
        <CardDescription>
          Refrigerant, category and full charge decide whether the leak-repair rule applies (15 lb or more of an HFC;
          50 lb or more of an ozone-depleting refrigerant).
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={save} className="grid max-w-2xl gap-x-4 sm:grid-cols-2">
          <div>
            <label className={field} htmlFor="a-name">Unit name</label>
            <Input id="a-name" value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="Walk-in cooler" required />
          </div>
          <div>
            <label className={field} htmlFor="a-location">Location</label>
            <Input id="a-location" value={form.location} onChange={(e) => set("location", e.target.value)} placeholder="Back room" />
          </div>
          <div>
            <label className={field} htmlFor="a-category">Category</label>
            <select
              id="a-category"
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              value={form.category}
              onChange={(e) => set("category", e.target.value)}
            >
              {APPLIANCE_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {APPLIANCE_CATEGORY_LABELS[c]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={field} htmlFor="a-refrigerant">Refrigerant</label>
            <Input
              id="a-refrigerant"
              list="a-refrigerants"
              value={form.refrigerant}
              onChange={(e) => set("refrigerant", e.target.value)}
              required
            />
            <datalist id="a-refrigerants">
              {Object.keys(KNOWN_REFRIGERANTS).map((r) => (
                <option key={r} value={r} />
              ))}
            </datalist>
            <p className="mt-1 text-xs text-muted-foreground">
              {known ? REFRIGERANT_CLASS_LABELS[known] : "Not in the built-in list — classify it below."}
            </p>
          </div>
          {!known && (
            <div className="sm:col-span-2">
              <label className={field} htmlFor="a-class">Refrigerant class</label>
              <select
                id="a-class"
                className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                value={form.refrigerantClass}
                onChange={(e) => set("refrigerantClass", e.target.value)}
                required
              >
                <option value="">Choose…</option>
                {REFRIGERANT_CLASSES.map((c) => (
                  <option key={c} value={c}>
                    {REFRIGERANT_CLASS_LABELS[c]}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div>
            <label className={field} htmlFor="a-method">How the full charge was determined</label>
            <select
              id="a-method"
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              value={form.fullChargeMethod}
              onChange={(e) => set("fullChargeMethod", e.target.value)}
            >
              {FULL_CHARGE_METHODS.map((m) => (
                <option key={m} value={m}>
                  {FULL_CHARGE_METHOD_LABELS[m]}
                </option>
              ))}
            </select>
          </div>
          {isRange ? (
            <div className="grid grid-cols-2 gap-x-4">
              <div>
                <label className={field} htmlFor="a-low">Range low (lb)</label>
                <Input id="a-low" inputMode="numeric" value={form.lowLb} onChange={(e) => set("lowLb", e.target.value)} />
              </div>
              <div>
                <label className={field} htmlFor="a-high">Range high (lb)</label>
                <Input id="a-high" inputMode="numeric" value={form.highLb} onChange={(e) => set("highLb", e.target.value)} />
              </div>
            </div>
          ) : (
            <div>
              <span className={field}>Full charge</span>
              <div className="flex items-center gap-2">
                <Input aria-label="Full charge, pounds" inputMode="numeric" className="w-24" value={form.chargeLb} onChange={(e) => set("chargeLb", e.target.value)} />
                <span className="text-sm text-muted-foreground">lb</span>
                <Input aria-label="Full charge, ounces" inputMode="numeric" className="w-20" value={form.chargeOz} onChange={(e) => set("chargeOz", e.target.value)} />
                <span className="text-sm text-muted-foreground">oz</span>
              </div>
            </div>
          )}
          <div>
            <label className={field} htmlFor="a-installed">Installed on</label>
            <Input id="a-installed" type="date" value={form.installedOn} onChange={(e) => set("installedOn", e.target.value)} />
          </div>
          <div>
            <label className={field} htmlFor="a-mfr">Manufacturer</label>
            <Input id="a-mfr" value={form.manufacturer} onChange={(e) => set("manufacturer", e.target.value)} />
          </div>
          <div>
            <label className={field} htmlFor="a-model">Model</label>
            <Input id="a-model" value={form.model} onChange={(e) => set("model", e.target.value)} />
          </div>
          <div>
            <label className={field} htmlFor="a-serial">Serial number</label>
            <Input id="a-serial" value={form.serialNumber} onChange={(e) => set("serialNumber", e.target.value)} />
          </div>
          <div className="mt-5 flex gap-2 sm:col-span-2">
            <Button type="submit" disabled={busy}>{busy ? "Saving…" : "Register unit"}</Button>
            <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
