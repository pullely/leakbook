# cloudflare-r2 — architecture

A `terraform` component rooted at `infra/terraform/cloudflare-r2/terraform`.

- **State** lives in the platform's HTTP state backend (run-token auth) —
  no local state, no cloud-vendor state buckets.
- **Credentials are brokered per run** from the workspace's Cloudflare
  connection; no long-lived provider secrets exist anywhere in CI.
- **Outputs are published as job-output secrets** on the environment
  rungs: `WIRING_CLOUDFLARE_R2` (bucket name for deploy-time binding). Downstream deploy lanes resolve them by name.
- **Self-healing adoption** (`adopt.tf`): a bucket that exists in
  Cloudflare but not in state is looked up at plan time and imported
  instead of failing the create.
