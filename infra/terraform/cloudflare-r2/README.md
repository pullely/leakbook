# cloudflare-r2

Provisions the private R2 bucket that holds Leakbook's inspection-record PDF
exports (LB3), one per environment. The runner injects `namespacePrefix`, so
the buckets are `stg-leakbook-exports-stage` and `prod-leakbook-exports-prod`
(runbook trap 26).

Nothing reads the bucket directly. `apps/leak-worker` binds it as `EXPORTS` by
that prefixed name and is its only reader and writer. Every read is authorized
by organization membership (`leak.read`) through api-edge.

Objects are keyed `orgs/{org_…}/exports/{exp_…}.pdf` and written once. Each
object's SHA-256 is recorded in `leak_exports` and served as
`x-content-sha256`. A new export is a new object, never an overwrite.

The job's credential is the brokered `CLOUDFLARE_R2_TOKEN` (scope template
`r2-data`, created with a `buckets` param, runbook trap 20). The deploy token
cannot touch storage, and this token cannot deploy code.
