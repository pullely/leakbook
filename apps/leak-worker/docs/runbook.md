# leak-worker — runbook

- **Health:** `GET /health` on the worker (via a service binding) reports which
  bindings are configured: database, membership, policy.
- **Every route answers 404 for a member:** policy-worker is running an old
  action table without `leak.read`/`leak.write`. A change to
  `packages/policy-engine` does not redeploy policy-worker by itself: touch its
  `component.yaml` and merge.
- **A scanned label answers 404 for a technician:** the technician is not a
  member of the contractor's organization, or the label's token was rotated.
  Reprint the label from the appliance page.
- **Writes answer 503:** the `PLATFORM_DB` binding is missing or the
  `200_leak_core` migration has not been applied in that environment — check
  the `db-migrate` job of the deploy run.
